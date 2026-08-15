export const runtime = 'nodejs';
export const maxDuration = 60; // Allow up to 60 seconds for AI streaming on Vercel

import { NextRequest, NextResponse } from 'next/server';
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';
import { generateEmbedding } from '@/utils/embeddings';
import { prisma } from '@/lib/db';

// Explicitly initialize Anthropic with API key to ensure it's always picked up
const anthropic = createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
});

// Helper function to strip out bold stars, header hashes, and list dashes so output remains clean plain text
function cleanMarkdownText(rawText: string): string {
    return rawText
        .replace(/[*_#`~]/g, '') // Removes *, _, #, `, ~
        .replace(/^\s*[-*+]\s+/gm, '') // Removes list bullets at the start of lines
        .replace(/\n{3,}/g, '\n\n'); // Cleans up excessive blank lines
}

export async function POST(req: NextRequest) {
    try {
        if (!process.env.ANTHROPIC_API_KEY) {
            console.error('[Anthropic Error]: ANTHROPIC_API_KEY is missing from environment variables (.env)');
            return NextResponse.json({
                error: 'Anthropic API key missing',
                details: 'ANTHROPIC_API_KEY is not configured in the server environment variables (.env).'
            }, { status: 500 });
        }

        const body = await req.json();
        const { message, sessionId: inputSessionId, userId } = body;

        if (!message || typeof message !== 'string') {
            return NextResponse.json({ error: 'Message text is required' }, { status: 400 });
        }

        let sessionId = inputSessionId;

        // Ensure session exists in Postgres & link to userId
        if (!sessionId) {
            const newSession = await prisma.chatSession.create({
                data: {
                    title: message.substring(0, 35) || 'Financial Chat',
                    userId: userId || undefined,
                }
            });
            sessionId = newSession.id;
        } else {
            const existing = await prisma.chatSession.findUnique({ where: { id: sessionId } });
            if (!existing) {
                await prisma.chatSession.create({
                    data: {
                        id: sessionId,
                        title: message.substring(0, 35) || 'Financial Chat',
                        userId: userId || undefined,
                    }
                });
            } else if (userId && !existing.userId) {
                await prisma.chatSession.update({
                    where: { id: sessionId },
                    data: { userId: userId }
                });
            }
        }

        // Save User Message to database
        await prisma.message.create({
            data: {
                sessionId: sessionId,
                sender: 'USER',
                text: message,
            }
        });

        // 1. Perform RAG: Get Voyage AI vector embedding for user query
        let ragContext = '';
        try {
            const queryEmbedding = await generateEmbedding(message, 'query');
            const embeddingVectorString = `[${queryEmbedding.join(',')}]`;

            // Query top 5 most relevant document chunks using pgvector cosine distance
            const relevantChunks: Array<{ content: string }> = await prisma.$queryRaw`
                SELECT content
                FROM "DocumentChunk"
                WHERE "sessionId" = ${sessionId}
                ORDER BY embedding <=> ${embeddingVectorString}::vector
                LIMIT 5;
            `;

            if (relevantChunks && relevantChunks.length > 0) {
                ragContext = relevantChunks.map(c => `- ${c.content}`).join('\n');
            }
        } catch (vectorErr) {
            console.warn('Vector retrieval notice (proceeding without document context):', vectorErr);
        }

        // 2. Perform Universal Exact Keyword Matching from Database
        let exactMatchContext = '';
        try {
            const queryWords = message
                .toLowerCase()
                .replace(/[^\w\s]/gi, '')
                .split(' ')
                .filter(word => word.length > 2); // Filter out tiny words

            if (sessionId && queryWords.length > 0) {
                const matchedTransactions = await prisma.transaction.findMany({
                    where: {
                        sessionId: sessionId,
                        OR: queryWords.map(word => ({
                            description: { contains: word, mode: 'insensitive' }
                        }))
                    },
                    orderBy: { date: 'asc' },
                    take: 20,
                });

                if (matchedTransactions.length > 0) {
                    const totalMatchedSum = matchedTransactions.reduce((sum, tx) => sum + tx.amount, 0);
                    exactMatchContext = `
Exact Database Keyword Matches for User Query ("${message}"):
- Total Matched Amount: ₦${totalMatchedSum.toLocaleString()}
- Matching Transactions Found:
${matchedTransactions.map(tx => `  * Date: ${tx.date} | Description: ${tx.description} | Amount: ₦${tx.amount.toLocaleString()} (${tx.type})`).join('\n')}
                    `.trim();
                }
            }
        } catch (keywordErr) {
            console.warn('Keyword search notice:', keywordErr);
        }

        // 3. Fetch financial summary if available
        let summaryContext = '';
        const summary = await prisma.financialSummary.findUnique({ where: { sessionId: sessionId } });
        if (summary) {
            summaryContext = `
Financial Summary Overview:
- Total Inflow: ₦${summary.totalInflow.toLocaleString()}
- Total Outflow: ₦${summary.totalOutflow.toLocaleString()}
- Net Savings: ₦${summary.netSavings.toLocaleString()}
- Savings Rate: ${summary.savingsRatePercent}%
- Expense Breakdown: ${JSON.stringify(summary.categories)}
            `.trim();
        }

        // 4. Build System Prompt for Anthropic Claude
        const systemPrompt = `You are Finance AI, an expert professional financial advisor assistant.
Your job is to assist users with personalized financial advice, bank statement breakdown, budgeting strategies, and expense management.

${exactMatchContext ? `### ${exactMatchContext}\n` : ''}
${summaryContext ? `### User's Financial Statement Summary:\n${summaryContext}\n` : ''}
${ragContext ? `### Relevant Line Items from User's Bank Statement (Vector RAG):\n${ragContext}\n` : ''}

Instructions:
- Currency: ALWAYS use Nigerian Naira (₦) for all monetary values, prices, amounts, and figures. Never use dollars ($) or other currency symbols.
- Output Style: Format all responses strictly as plain, clean text paragraphs. Do NOT use markdown bold stars (**), italics (*), bullet list dashes (- or *), or hash headers (#). Write in clear, structured conversational blocks without any markdown symbols.
- Provide clear, actionable, and accurate financial insights.
- If exact database keyword matches are provided above, use those exact figures and items to answer the user's question directly with absolute precision.
- Keep responses professional, encouraging, and concise.
- If no bank statement is attached or context is missing for a question, provide best-practice financial guidance.`;

        // 5. Retrieve recent message history from DB (up to 10 previous messages)
        const pastMessages = await prisma.message.findMany({
            where: { sessionId: sessionId },
            orderBy: { createdAt: 'asc' },
            take: 10,
        });

        const formattedMessages = pastMessages.map((msg: { sender: string; text: string }) => ({
            role: (msg.sender === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: msg.text,
        }));

        // Fallback to current message if formattedMessages is empty
        if (formattedMessages.length === 0) {
            formattedMessages.push({ role: 'user', content: message });
        }

        console.log(`[Anthropic API]: Requesting streaming completion from Claude for session: ${sessionId}`);

        // 6. Stream Claude AI response using Vercel AI SDK & Anthropic Provider
        const result = streamText({
            model: anthropic('claude-sonnet-5'),
            system: systemPrompt,
            messages: formattedMessages,
            onError: (err) => {
                console.error('[Anthropic Stream Execution Error]:', err);
            },
            onFinish: async ({ text }) => {
                if (!text || text.trim() === '') {
                    console.warn('[Anthropic Warning]: Model stream finished with empty text response.');
                }
                if (sessionId && text) {
                    try {
                        const cleanedText = cleanMarkdownText(text);
                        await prisma.message.create({
                            data: {
                                sessionId: sessionId,
                                sender: 'AI',
                                text: cleanedText,
                            }
                        });
                    } catch (dbErr) {
                        console.error('Failed to save AI response message to DB:', dbErr);
                    }
                }
            }
        });

        // Return native Vercel AI SDK response helper with x-session-id header
        const toResponse = (result as any).toDataStreamResponse
            ? (result as any).toDataStreamResponse.bind(result)
            : result.toTextStreamResponse.bind(result);

        return toResponse({
            headers: {
                'x-session-id': sessionId ?? '',
                'Access-Control-Expose-Headers': 'x-session-id',
            }
        });

    } catch (error) {
        console.error("[Anthropic Chat API Error]:", error);
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[Anthropic Chat API Details]:", detail);

        const fallbackResponse = 'I am having a bad day today. Try again later.';
        return new Response(fallbackResponse, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
            }
        });
    }
}