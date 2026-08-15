export const runtime = 'nodejs';
export const maxDuration = 60; // Allow up to 60s for PDF vectorization & Claude completions

import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { extractText } from 'unpdf';
import { prisma } from '@/lib/db';
import { generateEmbedding, generateBatchEmbeddings } from '@/utils/embeddings';
import { analyzeTransactions, Transaction as ParsedTransaction } from '@/utils/financialRules';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const BOT_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format text into clean paragraph text without raw markdown asterisks or bullet dashes. */
function formatCleanText(text: string): string {
  return text
    // Remove markdown bold/italic asterisks
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    // Remove markdown headers (# Title -> Title)
    .replace(/^#{1,6}\s+/gm, '')
    // Replace bullet dashes/asterisks at start of lines with clean indentation
    .replace(/^[-*]\s+/gm, '')
    .replace(/^[•]\s+/gm, '')
    // Remove markdown code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Remove any remaining stray asterisks
    .replace(/\*/g, '')
    // Normalize excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Send a clean text reply back to a Telegram chat. */
async function sendMessage(chatId: number | string, text: string) {
  const clean = formatCleanText(text);
  try {
    await axios.post(`${BOT_API}/sendMessage`, {
      chat_id: chatId,
      text: clean,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Telegram sendMessage Error for chatId=${chatId}]:`, errorMsg);
  }
}

// ─── Webhook Entry Point ───────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const message = body.message;

    // Ignore non-message updates (e.g. edited_message, channel_post, etc.)
    if (!message) return NextResponse.json({ ok: true });

    const chatId: number = message.chat.id;
    const text: string | undefined = message.text;
    const document = message.document;

    // ── 1. /start command — link chatId to the registered web username ──────
    if (text && text.startsWith('/start')) {
      return await handleStart(chatId, text);
    }

    // ── 2. Document upload (Bank Statement PDF) ────────────────────────────
    if (document) {
      return await handleDocument(chatId, document);
    }

    // ── 3. Regular text message (Financial advisory query) ─────────────────
    if (text) {
      return await handleTextMessage(chatId, text);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[Telegram Webhook] Unhandled error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// ─── /start Handler ───────────────────────────────────────────────────────────

async function handleStart(chatId: number, text: string) {
  // Telegram delivers the deep-link payload as "/start <payload>"
  const parts = text.split(' ');
  const payload = parts[1]?.trim().toLowerCase();

  // If payload (username) provided in the start link:
  if (payload) {
    // Look up the user by their web-registered username
    let user = await prisma.user.findUnique({
      where: { username: payload },
    });

    // If user not registered yet, auto-create the account with this username
    if (!user) {
      user = await prisma.user.create({
        data: {
          username: payload,
          name: payload,
          telegramChatId: String(chatId),
        },
      });
    } else {
      // Link this Telegram chatId to the user record
      await prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: String(chatId) },
      });
    }

    await sendMessage(
      chatId,
      `Welcome to Finance AI, ${user.username}! 🎉\n\nYour Telegram account is now connected.\n\nYou can now:\n1. Ask any financial questions, budgeting advice, or expense queries.\n2. Send your bank statement (PDF) directly here to analyze your income, expenses, and savings.\n\nAll your data is secure and linked to your profile.`
    );
    return NextResponse.json({ ok: true });
  }

  // If no payload provided, check if this chatId is already linked
  const existingUser = await prisma.user.findUnique({
    where: { telegramChatId: String(chatId) },
  });

  if (existingUser) {
    await sendMessage(
      chatId,
      `Welcome back, ${existingUser.username}! 👋\n\nI am your AI financial advisor. How can I assist you with your finances today? You can ask any question or upload a bank statement PDF.`
    );
    return NextResponse.json({ ok: true });
  }

  // If not linked and no username passed:
  await sendMessage(
    chatId,
    'Welcome to Finance AI! 👋\n\nPlease visit the web app, enter your username, and click "Continue to Telegram" to link your account.\n\nAlternatively, send /start <your_username> here to connect.'
  );
  return NextResponse.json({ ok: true });
}

// ─── Text Message Handler ──────────────────────────────────────────────────────

async function handleTextMessage(chatId: number, text: string) {
  const chatIdStr = String(chatId);

  // Look up the user by their linked Telegram chatId
  let user = await prisma.user.findUnique({
    where: { telegramChatId: chatIdStr },
  });

  if (!user) {
    await sendMessage(
      chatId,
      'Your Telegram account is not linked yet.\n\nPlease visit our web app, enter your username, and click Continue to Telegram, or send /start <your_username>.'
    );
    return NextResponse.json({ ok: true });
  }

  // ── Persist the user's incoming message ─────────────────────────────────
  await prisma.telegramMessage.create({
    data: {
      userId: user.id,
      role: 'USER',
      text,
    },
  });

  // ── Generate AI response with full financial context & RAG ──────────────
  const botReply = await generateBotResponse(user.id, text);

  // ── Persist the bot's reply ──────────────────────────────────────────────
  await prisma.telegramMessage.create({
    data: {
      userId: user.id,
      role: 'BOT',
      text: botReply,
    },
  });

  await sendMessage(chatId, botReply);
  return NextResponse.json({ ok: true });
}

// ─── Document Handler (PDF Bank Statements) ───────────────────────────────────

async function handleDocument(chatId: number, document: { file_id: string; file_name?: string }) {
  const chatIdStr = String(chatId);

  // Verify the user is linked before accepting uploads
  const user = await prisma.user.findUnique({
    where: { telegramChatId: chatIdStr },
  });

  if (!user) {
    await sendMessage(
      chatId,
      'Please link your account first by registering on the web app or typing /start <your_username>.'
    );
    return NextResponse.json({ ok: true });
  }

  const fileName = document.file_name ?? 'Bank_Statement.pdf';

  if (!fileName.toLowerCase().endsWith('.pdf')) {
    await sendMessage(chatId, 'Please upload a PDF bank statement file.');
    return NextResponse.json({ ok: true });
  }

  await sendMessage(chatId, `Analyzing statement "${fileName}"... Please give me a few moments.`);

  try {
    // 1. Retrieve the downloadable file URL from Telegram Bot API
    const fileRes = await axios.get(`${BOT_API}/getFile?file_id=${document.file_id}`);
    const filePath: string = fileRes.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    // 2. Download the PDF file buffer
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const buffer = new Uint8Array(response.data);

    // 3. Extract text using unpdf
    const { text: rawText } = await extractText(buffer, { mergePages: true });
    const lines = (rawText ?? '')
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 5);

    if (lines.length === 0) {
      await sendMessage(
        chatId,
        'Could not extract text from the PDF. Please ensure it is a text-based digital bank statement, not a scanned image.'
      );
      return NextResponse.json({ ok: true });
    }

    // 4. Detect transactions from the document
    const detectedTransactions: ParsedTransaction[] = [];
    for (const line of lines) {
      const amountMatch = line.match(/(\d{1,3}(,\d{3})*(\.\d{2})?)/);
      if (amountMatch) {
        const amount = parseFloat(amountMatch[0].replace(/,/g, ''));
        const isDebit = line.toLowerCase().includes('debit') || line.includes('-');

        detectedTransactions.push({
          date: new Date().toISOString().split('T')[0],
          description: line.substring(0, 60).trim(),
          amount: amount,
          type: isDebit ? 'debit' : 'credit',
        });
      }
    }

    // 5. Create or get user's session for this statement
    const session = await prisma.chatSession.create({
      data: {
        title: `Telegram: ${fileName}`,
        userId: user.id,
      },
    });

    // 6. Save detected transactions to database
    if (detectedTransactions.length > 0) {
      await prisma.transaction.createMany({
        data: detectedTransactions.slice(0, 100).map((t) => ({
          sessionId: session.id,
          date: t.date,
          description: t.description,
          amount: t.amount,
          type: t.type === 'debit' ? 'DEBIT' : 'CREDIT',
        })),
      });
    }

    // 7. Generate vector embeddings in batch via Voyage AI
    const batchSize = 50;
    for (let i = 0; i < lines.length; i += batchSize) {
      const chunkLines = lines.slice(i, i + batchSize);
      try {
        const embeddings = await generateBatchEmbeddings(chunkLines, 'document');
        for (let j = 0; j < chunkLines.length; j++) {
          const lineText = chunkLines[j];
          const vector = embeddings[j];
          if (vector && vector.length > 0) {
            const embeddingVectorString = `[${vector.join(',')}]`;
            await prisma.$executeRaw`
              INSERT INTO "DocumentChunk" (id, "sessionId", content, embedding)
              VALUES (
                gen_random_uuid(), 
                ${session.id}, 
                ${lineText}, 
                ${embeddingVectorString}::vector
              );
            `;
          }
        }
      } catch (batchErr) {
        console.warn(`[Voyage AI Batch Embedding Notice for Telegram]:`, batchErr);
      }
    }

    // 8. Calculate financial summary
    const summary = analyzeTransactions(detectedTransactions);

    // Save summary to database
    await prisma.financialSummary.create({
      data: {
        sessionId: session.id,
        totalInflow: summary.totalInflow,
        totalOutflow: summary.totalOutflow,
        netSavings: summary.netSavings,
        savingsRatePercent: summary.savingsRatePercent,
        categories: summary.categories,
      },
    });

    // 9. Send detailed summary message back to user on Telegram
    const summaryMessage = `Statement analysis complete for "${fileName}"! 📊

Total Inflow: ₦${summary.totalInflow.toLocaleString()}
Total Outflow: ₦${summary.totalOutflow.toLocaleString()}
Net Savings: ₦${summary.netSavings.toLocaleString()}
Savings Rate: ${summary.savingsRatePercent}%

Expense Breakdown:
Transport: ₦${(summary.categories['Transport'] || 0).toLocaleString()}
Food: ₦${(summary.categories['Food'] || 0).toLocaleString()}
Utilities: ₦${(summary.categories['Utilities'] || 0).toLocaleString()}
Shopping: ₦${(summary.categories['Shopping'] || 0).toLocaleString()}
Other: ₦${(summary.categories['Uncategorized'] || 0).toLocaleString()}

You can now ask me any questions about your transactions, spending habits, or how to optimize your savings!`;

    await sendMessage(chatId, summaryMessage);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    console.error('[Telegram Document Processing Error]:', error);
    await sendMessage(
      chatId,
      'There was an issue processing your bank statement. Please make sure it is a valid text-based PDF statement.'
    );
    return NextResponse.json({ ok: true });
  }
}

// ─── Claude AI Full Context Response ──────────────────────────────────────────

/**
 * Generates an expert financial response using Claude claude-3-5-haiku-20241022.
 * Integrates:
 *  1. Vector RAG Search on user's statement chunks via Voyage AI
 *  2. Database exact keyword transaction search
 *  3. Financial summary metrics (Inflow, Outflow, Savings)
 *  4. Clean conversation history
 */
async function generateBotResponse(userId: string, userQuery: string): Promise<string> {
  // 1. Perform RAG Vector Search across all sessions belonging to this user
  let ragContext = '';
  try {
    const queryEmbedding = await generateEmbedding(userQuery, 'query');
    const embeddingVectorString = `[${queryEmbedding.join(',')}]`;

    const relevantChunks: Array<{ content: string }> = await prisma.$queryRaw`
      SELECT dc.content
      FROM "DocumentChunk" dc
      JOIN "ChatSession" cs ON cs.id = dc."sessionId"
      WHERE cs."userId" = ${userId}
      ORDER BY dc.embedding <=> ${embeddingVectorString}::vector
      LIMIT 5;
    `;

    if (relevantChunks && relevantChunks.length > 0) {
      ragContext = relevantChunks.map((c) => c.content).join('\n');
    }
  } catch (vectorErr) {
    console.warn('[Telegram RAG Notice]:', vectorErr);
  }

  // 2. Perform Database Keyword Matching on user's transactions
  let exactMatchContext = '';
  try {
    const queryWords = userQuery
      .toLowerCase()
      .replace(/[^\w\s]/gi, '')
      .split(' ')
      .filter((word) => word.length > 2);

    if (queryWords.length > 0) {
      const matchedTransactions = await prisma.transaction.findMany({
        where: {
          session: { userId },
          OR: queryWords.map((word) => ({
            description: { contains: word, mode: 'insensitive' },
          })),
        },
        orderBy: { date: 'asc' },
        take: 15,
      });

      if (matchedTransactions.length > 0) {
        const totalSum = matchedTransactions.reduce((sum, tx) => sum + tx.amount, 0);
        exactMatchContext = `Database Matches for "${userQuery}":
Total Matched Amount: ₦${totalSum.toLocaleString()}
Matching Transactions:
${matchedTransactions.map((tx) => `${tx.date}: ${tx.description} — ₦${tx.amount.toLocaleString()} (${tx.type})`).join('\n')}`;
      }
    }
  } catch (keywordErr) {
    console.warn('[Telegram Keyword Search Notice]:', keywordErr);
  }

  // 3. Retrieve user's latest financial summary
  let summaryContext = '';
  try {
    const summary = await prisma.financialSummary.findFirst({
      where: { session: { userId } },
      orderBy: { createdAt: 'desc' },
    });

    if (summary) {
      summaryContext = `User Financial Overview:
Total Inflow: ₦${summary.totalInflow.toLocaleString()}
Total Outflow: ₦${summary.totalOutflow.toLocaleString()}
Net Savings: ₦${summary.netSavings.toLocaleString()}
Savings Rate: ${summary.savingsRatePercent}%
Expense Categories: ${JSON.stringify(summary.categories)}`;
    }
  } catch (summaryErr) {
    console.warn('[Telegram Summary Notice]:', summaryErr);
  }

  // 4. Fetch recent chat history
  const history = await prisma.telegramMessage.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  const priorMessages = history.slice(0, -1);
  const messages: { role: 'user' | 'assistant'; content: string }[] = priorMessages.map((m) => ({
    role: m.role === 'USER' ? 'user' : 'assistant',
    content: m.text,
  }));
  messages.push({ role: 'user', content: userQuery });

  // 5. Build Comprehensive System Prompt
  const systemPrompt = `You are Finance AI, an expert professional financial advisor.
You assist users with personalized financial advice, bank statement breakdown, budgeting strategies, and expense management.

${exactMatchContext ? `### Exact Database Transaction Matches:\n${exactMatchContext}\n` : ''}
${summaryContext ? `### User's Financial Statement Summary:\n${summaryContext}\n` : ''}
${ragContext ? `### Relevant Line Items from User's Bank Statement:\n${ragContext}\n` : ''}

Rules:
1. Currency: ALWAYS use Nigerian Naira (₦) for all amounts, figures, and calculations. Never use dollar ($) or other currencies.
2. Formatting: Write in clean, modern conversational paragraphs with clear line breaks. DO NOT use markdown bold asterisks (no ** or *) and DO NOT use bullet list dashes (no - or * list items). If listing points or steps, use clean numbering or separate paragraph blocks.
3. Accuracy: If exact database transaction matches or statement summaries are provided above, use those exact figures to answer user queries with precision.
4. Professionalism: Keep responses professional, encouraging, practical, and clear.
5. If no bank statement context is available, provide general best-practice financial guidance.`;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const rawResponse = textBlock?.text ?? "I'm sorry, I couldn't generate a response. Please try again.";
    return formatCleanText(rawResponse);
  } catch (err) {
    console.error('[Claude API Error in Telegram Handler]:', err);
    return "I am having trouble connecting to my AI service right now. Please try again in a moment.";
  }
}