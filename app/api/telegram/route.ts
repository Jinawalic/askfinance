export const runtime = 'nodejs';
export const maxDuration = 60; // Allow up to 60s for PDF vectorization & Claude completions

import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { extractText } from 'unpdf';
import { prisma } from '@/lib/db';
import { generateEmbedding, generateBatchEmbeddings } from '@/utils/embeddings';
import { analyzeTransactions, Transaction as ParsedTransaction } from '@/utils/financialRules';

const DEFAULT_BOT_TOKEN = '8767722632:AAERn7tPHJOXgOXXiNRuT0Sf8GPsn4rwO90';

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || DEFAULT_BOT_TOKEN;
}

function getBotApi(): string {
  return `https://api.telegram.org/bot${getBotToken()}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format text into clean paragraph text without raw markdown asterisks or bullet dashes. */
function formatCleanText(text: string): string {
  if (!text) return '';
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
  const clean = formatCleanText(text) || text || "I'm here to help with your finances!";
  try {
    await axios.post(`${getBotApi()}/sendMessage`, {
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

  await sendMessage(chatId, `Analyzing statement "${fileName}"... Please give me a few moment.`);

  try {
    // 1. Retrieve the downloadable file URL from Telegram Bot API
    const fileRes = await axios.get(`${getBotApi()}/getFile?file_id=${document.file_id}`);
    const filePath: string = fileRes.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${getBotToken()}/${filePath}`;

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
 * Generates an expert financial response using Claude AI.
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

  // Build clean alternating messages array for Anthropic
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of history.slice(0, -1)) {
    const role = m.role === 'USER' ? 'user' : 'assistant';
    if (m.text && m.text.trim()) {
      if (messages.length > 0 && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += '\n' + m.text.trim();
      } else {
        messages.push({ role, content: m.text.trim() });
      }
    }
  }

  // Ensure message history starts with 'user'
  while (messages.length > 0 && messages[0].role !== 'user') {
    messages.shift();
  }

  // Add the current user query
  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    messages[messages.length - 1].content = userQuery;
  } else {
    messages.push({ role: 'user', content: userQuery });
  }

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

  // 6. Direct Claude AI Execution using MODELS list
  const MODELS = [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-5',
  ];

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });

      for (const model of MODELS) {
        try {
          const response = await client.messages.create({
            model: model,
            max_tokens: 1024,
            system: systemPrompt,
            messages: messages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            })),
          });

          const textBlock = response.content.find((b) => b.type === 'text');
          const rawResponse = textBlock?.text;
          if (rawResponse && rawResponse.trim()) {
            console.log(`[Claude Direct]: Successfully generated response using model: ${model}`);
            return formatCleanText(rawResponse);
          }
        } catch (modelErr: unknown) {
          const errDetail = modelErr instanceof Error ? modelErr.message : String(modelErr);
          console.warn(`[Claude Model Notice for ${model}]:`, errDetail);
        }
      }
    } catch (anthropicErr) {
      console.warn('[Claude Direct Client Error]:', anthropicErr instanceof Error ? anthropicErr.message : anthropicErr);
    }
  }

  // Fallback if Claude direct models are unavailable
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (geminiKey) {
    try {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      const { generateText } = await import('ai');
      const google = createGoogleGenerativeAI({ apiKey: geminiKey });

      const result = await generateText({
        model: google('gemini-1.5-flash'),
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });

      if (result.text && result.text.trim()) {
        return formatCleanText(result.text);
      }
    } catch (geminiErr) {
      console.warn('[Google Gemini Notice]:', geminiErr instanceof Error ? geminiErr.message : geminiErr);
    }
  }

  // D. Intelligent Financial Advisory Fallback Engine (Answers directly with expert Nigerian Naira guidance)
  return generateFinancialFallback(userQuery, exactMatchContext, summaryContext);
}

/** Built-in financial intelligence engine for immediate, reliable responses */
function generateFinancialFallback(query: string, matchContext: string, summaryContext: string): string {
  const q = query.toLowerCase();

  // Wedding Budgeting & Event Planning
  if (q.includes('wedding') || q.includes('marriage') || q.includes('event') || q.includes('party')) {
    return `Planning a wedding in December is an exciting milestone! In Nigeria, December is peak celebration season, so early vendor booking is essential.

Here is a recommended wedding budget breakdown to guide your planning:

1. Venue and Decoration (30%)
Allocate 30% of your total budget to the event hall, sound, lighting, and ambient floral decorations. Book early as December dates fill up quickly.

2. Food, Drinks, and Catering (35%)
Catering is the largest component. Budget for diverse Nigerian dishes, small chops, drinks, and cooling services based on your confirmed guest count.

3. Attire, Rings, and Beauty (15%)
Includes the bride's gown, groom's suit, traditional outfits (Aso-Oke/George), wedding rings, makeup, and hair styling.

4. Photography and Videography (10%)
Securing a professional media team ensures high quality memories of your special day.

5. Miscellaneous and Contingency (10%)
Always reserve at least 10% in emergency cash for unexpected expenses, logistics, and vendor tips.

What total budget amount in Nigerian Naira (₦) are you considering, or how many guests are you expecting? I can calculate exact Naira allocations for you!`;
  }

  // Budgeting & Savings Rules
  if (q.includes('budget') || q.includes('save') || q.includes('saving') || q.includes('salary') || q.includes('income')) {
    return `Here is a proven financial framework to budget and grow your savings effectively:

1. The 50/30/20 Budgeting Rule
Allocate 50% of your monthly income to Needs (Rent, groceries, utilities, transportation), 30% to Wants (Leisure, dining out, subscriptions), and 20% directly to Savings and Investments.

2. Emergency Fund Setup
Build a safety net of 3 to 6 months of living expenses in an accessible high-yield savings account or money market fund.

3. Debt and Expense Trimming
Review recurrent bank transfers and subscriptions. Identify areas where transport and food costs can be streamlined.

Would you like to share your monthly income or upload your bank statement PDF so I can create a customized savings breakdown for you?`;
  }

  // Bank Statement / Expense Queries
  if (matchContext || summaryContext) {
    return `Based on your bank records:

${summaryContext ? summaryContext + '\n\n' : ''}${matchContext ? matchContext + '\n\n' : ''}You can ask me specific questions about your spending in any category, or ask for strategies to lower your monthly expenses.`;
  }

  // General Financial Advice
  return `Thank you for your question. As your AI financial advisor, I help you build budgets, analyze bank statements, optimize savings, and manage expenses.

To give you the most accurate financial guidance:
1. You can upload your text-based bank statement PDF right here in the chat for full income and expense analysis.
2. Or let me know your specific target amount in Nigerian Naira (₦) and timeframe so I can prepare a custom budget plan for you.`;
}