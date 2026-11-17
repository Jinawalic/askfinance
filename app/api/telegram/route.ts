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
  return (process.env.TELEGRAM_BOT_TOKEN || DEFAULT_BOT_TOKEN).trim();
}

function getBotApi(): string {
  return `https://api.telegram.org/bot${getBotToken()}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Send native Telegram typing indicator (animated 3 dots) */
async function sendTyping(chatId: number | string) {
  try {
    await axios.post(`${getBotApi()}/sendChatAction`, {
      chat_id: chatId,
      action: 'typing',
    });
  } catch {
    // Ignore typing indicator errors silently
  }
}

/** Format text into clean, concise structured text with bullet points. */
function formatCleanText(text: string): string {
  if (!text) return '';
  return text
    // Replace markdown bold/italic asterisks with clean text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    // Remove markdown headers (# Title -> Title)
    .replace(/^#{1,6}\s+/gm, '')
    // Normalize bullet dashes/asterisks at start of lines into clean round bullet dots
    .replace(/^[-*]\s+/gm, '• ')
    // Remove markdown code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Remove any remaining stray asterisks
    .replace(/\*/g, '')
    // Normalize excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Send a clean text reply back to a Telegram chat, automatically splitting long messages. */
async function sendMessage(chatId: number | string, text: string) {
  const clean = formatCleanText(text) || text || "I'm here to help with your finances!";
  
  // Telegram has a max message length limit of 4096 characters
  const MAX_CHUNK = 4000;
  const chunks: string[] = [];
  if (clean.length > MAX_CHUNK) {
    for (let i = 0; i < clean.length; i += MAX_CHUNK) {
      chunks.push(clean.substring(i, i + MAX_CHUNK));
    }
  } else {
    chunks.push(clean);
  }

  for (const chunk of chunks) {
    try {
      await axios.post(`${getBotApi()}/sendMessage`, {
        chat_id: chatId,
        text: chunk,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Telegram sendMessage Error for chatId=${chatId}]:`, errorMsg);
    }
  }
}

// ─── Webhook Entry Points ──────────────────────────────────────────────────────

// GET: Healthcheck for webhook verification
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'Finance AI Telegram Webhook',
    timestamp: new Date().toISOString(),
  });
}

// POST: Main Telegram update receiver
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const message = body.message || body.edited_message;

    // Ignore non-message updates (e.g. channel_post, my_chat_member, etc.)
    if (!message) return NextResponse.json({ ok: true });

    const chatId: number = message.chat.id;
    const text: string | undefined = message.text;
    const document = message.document;
    const from = message.from;

    // Send typing indicator immediately
    sendTyping(chatId);

    // ── 1. /start command ───────────────────────────────────────────────────
    if (text && text.startsWith('/start')) {
      return await handleStart(chatId, text, from);
    }

    // ── 2. Document upload (Bank Statement PDF) ────────────────────────────
    if (document) {
      return await handleDocument(chatId, document, from);
    }

    // ── 3. Regular text message (Financial advisory query) ─────────────────
    if (text) {
      return await handleTextMessage(chatId, text, from);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[Telegram Webhook] Unhandled error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// ─── /start Handler ───────────────────────────────────────────────────────────

async function handleStart(chatId: number, text: string, from?: any) {
  const chatIdStr = String(chatId);
  const parts = text.split(' ');
  const payload = parts[1]?.trim().toLowerCase();

  // If payload (username) provided in the start link (e.g., /start john):
  if (payload) {
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: payload, mode: 'insensitive' } },
          { name: { equals: payload, mode: 'insensitive' } },
        ]
      },
    });

    // Unbind this chatId from any other user to prevent unique constraint violation
    await prisma.user.updateMany({
      where: { telegramChatId: chatIdStr, NOT: user ? { id: user.id } : undefined },
      data: { telegramChatId: null },
    });

    if (!user) {
      // Auto-create account with requested payload
      user = await prisma.user.create({
        data: {
          username: payload,
          name: from?.first_name || payload,
          telegramChatId: chatIdStr,
        },
      });
    } else {
      // Link to existing user record
      user = await prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: chatIdStr },
      });
    }

    await sendMessage(
      chatId,
      `Welcome to Finance AI, ${user.username}! 🎉\n\nYour Telegram account is now connected.\n\nYou can now:\n• Ask any financial questions, budgeting advice, or expense queries.\n• Send your bank statement (PDF) directly here to analyze income, expenses, and savings.\n\nAll your data is secure and linked to your profile.`
    );
    return NextResponse.json({ ok: true });
  }

  // If no payload provided, check if this chatId is already linked
  let existingUser = await prisma.user.findUnique({
    where: { telegramChatId: chatIdStr },
  });

  // If not linked by chatId, try finding by Telegram username
  if (!existingUser && from?.username) {
    const tgUsername = from.username.trim().toLowerCase();
    const matched = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: tgUsername, mode: 'insensitive' } },
          { name: { equals: tgUsername, mode: 'insensitive' } },
        ]
      }
    });

    if (matched) {
      await prisma.user.updateMany({
        where: { telegramChatId: chatIdStr, NOT: { id: matched.id } },
        data: { telegramChatId: null },
      });
      existingUser = await prisma.user.update({
        where: { id: matched.id },
        data: { telegramChatId: chatIdStr },
      });
    }
  }

  // If still not linked, seamlessly create user so they can immediately chat
  if (!existingUser) {
    const fallbackUsername = (from?.username || from?.first_name || `user_${chatId}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 32);

    try {
      await prisma.user.updateMany({
        where: { telegramChatId: chatIdStr },
        data: { telegramChatId: null },
      });

      existingUser = await prisma.user.upsert({
        where: { username: fallbackUsername },
        update: { telegramChatId: chatIdStr },
        create: {
          username: fallbackUsername,
          name: from?.first_name || fallbackUsername,
          telegramChatId: chatIdStr,
        }
      });
    } catch (e) {
      console.warn('Auto-create user notice in handleStart:', e);
    }
  }

  const displayName = existingUser?.username || from?.first_name || 'there';
  await sendMessage(
    chatId,
    `Welcome to Finance AI, ${displayName}! 👋\n\nI am your AI financial advisor. How can I assist you with your finances today?\n\n• Ask budgeting questions (e.g., "How can I budget with ₦100k?")\n• Get investment advice for Nigeria\n• Upload a bank statement PDF for instant income & expense analysis`
  );
  return NextResponse.json({ ok: true });
}

// ─── Text Message Handler ──────────────────────────────────────────────────────

async function handleTextMessage(chatId: number, text: string, from?: any) {
  const chatIdStr = String(chatId);

  // 1. Look up user by linked Telegram chatId
  let user = await prisma.user.findUnique({
    where: { telegramChatId: chatIdStr },
  });

  // 2. If not found, try matching by Telegram username
  if (!user && from?.username) {
    const tgUsername = from.username.trim().toLowerCase();
    const matched = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: tgUsername, mode: 'insensitive' } },
          { name: { equals: tgUsername, mode: 'insensitive' } },
        ]
      }
    });

    if (matched) {
      await prisma.user.updateMany({
        where: { telegramChatId: chatIdStr, NOT: { id: matched.id } },
        data: { telegramChatId: null },
      });
      user = await prisma.user.update({
        where: { id: matched.id },
        data: { telegramChatId: chatIdStr },
      });
    }
  }

  // 3. If still not found, auto-create account seamlessly so the user ALWAYS gets a reply
  if (!user) {
    const fallbackUsername = (from?.username || from?.first_name || `user_${chatId}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 32);

    try {
      await prisma.user.updateMany({
        where: { telegramChatId: chatIdStr },
        data: { telegramChatId: null },
      });

      user = await prisma.user.upsert({
        where: { username: fallbackUsername },
        update: { telegramChatId: chatIdStr },
        create: {
          username: fallbackUsername,
          name: from?.first_name || fallbackUsername,
          telegramChatId: chatIdStr,
        }
      });
    } catch (e) {
      console.warn('Auto-create user notice in handleTextMessage:', e);
    }
  }

  if (!user) {
    await sendMessage(
      chatId,
      'Welcome to Finance AI! 👋\n\nPlease send /start to connect your account.'
    );
    return NextResponse.json({ ok: true });
  }

  // 4. Persist incoming user message
  try {
    await prisma.telegramMessage.create({
      data: {
        userId: user.id,
        role: 'USER',
        text,
      },
    });
  } catch (err) {
    console.warn('[Telegram User Message Save Notice]:', err);
  }

  // 5. Generate AI response with full financial context, RAG & Claude
  let botReply = '';
  try {
    botReply = await generateBotResponse(user.id, text);
  } catch (genErr) {
    console.error('[Telegram generateBotResponse Error]:', genErr);
    botReply = "I am having a brief moment processing that. How can I assist you with your finances today?";
  }

  // 6. Persist bot reply
  try {
    await prisma.telegramMessage.create({
      data: {
        userId: user.id,
        role: 'BOT',
        text: botReply,
      },
    });
  } catch (err) {
    console.warn('[Telegram Bot Message Save Notice]:', err);
  }

  // 7. Send message back to user on Telegram
  await sendMessage(chatId, botReply);
  return NextResponse.json({ ok: true });
}

// ─── Document Handler (PDF Bank Statements) ───────────────────────────────────

async function handleDocument(chatId: number, document: { file_id: string; file_name?: string }, from?: any) {
  const chatIdStr = String(chatId);

  // Verify or auto-link user
  let user = await prisma.user.findUnique({
    where: { telegramChatId: chatIdStr },
  });

  if (!user) {
    const fallbackUsername = (from?.username || from?.first_name || `user_${chatId}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 32);

    user = await prisma.user.upsert({
      where: { username: fallbackUsername },
      update: { telegramChatId: chatIdStr },
      create: {
        username: fallbackUsername,
        name: from?.first_name || fallbackUsername,
        telegramChatId: chatIdStr,
      }
    });
  }

  const fileName = document.file_name ?? 'Bank_Statement.pdf';

  if (!fileName.toLowerCase().endsWith('.pdf')) {
    await sendMessage(chatId, 'Please upload a PDF bank statement file.');
    return NextResponse.json({ ok: true });
  }

  await sendMessage(chatId, `Analyzing statement "${fileName}"... Please give me a moment.`);

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
      .map((line: string) => line.replace(/\0/g, '').trim())
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
    const dateRegex = /\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\b/;
    const amountRegex = /(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/;

    for (const line of lines) {
      const amountMatch = line.match(amountRegex);
      if (amountMatch && amountMatch[0].length >= 2) {
        const amount = parseFloat(amountMatch[0].replace(/,/g, ''));
        if (Number.isFinite(amount) && amount > 0) {
          const lower = line.toLowerCase();
          const isDebit = lower.includes('debit') || lower.includes('dr') || lower.includes('-') || lower.includes('withdrawal');
          const dateMatch = line.match(dateRegex);
          const txDate = dateMatch ? dateMatch[0] : new Date().toISOString().split('T')[0];

          detectedTransactions.push({
            date: txDate,
            description: line.substring(0, 60).trim(),
            amount: amount,
            type: isDebit ? 'debit' : 'credit',
          });
        }
      }
    }

    // 5. Create user session for this statement
    const session = await prisma.chatSession.create({
      data: {
        title: `Telegram: ${fileName}`,
        userId: user.id,
      },
    });

    // 6. Save detected transactions to database
    if (detectedTransactions.length > 0) {
      try {
        await prisma.transaction.createMany({
          data: detectedTransactions.slice(0, 100).map((t) => ({
            sessionId: session.id,
            date: t.date,
            description: t.description,
            amount: t.amount,
            type: t.type === 'debit' ? 'DEBIT' : 'CREDIT',
          })),
        });
      } catch (txErr) {
        console.warn('[Telegram Document Transactions Save Notice]:', txErr);
      }
    }

    // 7. Generate vector embeddings in batch via Voyage AI
    const batchSize = 30;
    const totalLinesToProcess = Math.min(lines.length, 120);
    for (let i = 0; i < totalLinesToProcess; i += batchSize) {
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

    // 8. Calculate financial summary safely
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

    // 9. Send structured summary message back to user on Telegram
    const summaryMessage = `Statement analysis complete for "${fileName}"! 📊

• Total Inflow: ₦${summary.totalInflow.toLocaleString()}
• Total Outflow: ₦${summary.totalOutflow.toLocaleString()}
• Net Savings: ₦${summary.netSavings.toLocaleString()}
• Savings Rate: ${summary.savingsRatePercent}%

Expense Breakdown:
• Transport: ₦${(summary.categories['Transport'] || 0).toLocaleString()}
• Food: ₦${(summary.categories['Food'] || 0).toLocaleString()}
• Utilities: ₦${(summary.categories['Utilities'] || 0).toLocaleString()}
• Shopping: ₦${(summary.categories['Shopping'] || 0).toLocaleString()}
• Other: ₦${(summary.categories['Uncategorized'] || 0).toLocaleString()}

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
  let history: Array<{ role: string; text: string }> = [];
  try {
    history = await prisma.telegramMessage.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
  } catch (histErr) {
    console.warn('[Telegram History Fetch Notice]:', histErr);
  }

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

  // Add current user query
  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    messages[messages.length - 1].content += '\n' + userQuery;
  } else {
    messages.push({ role: 'user', content: userQuery });
  }

  // 5. Build Concise, Professional System Prompt
  const systemPrompt = `You are Finance AI, a professional and concise financial advisor.
Your responses must be short, structured, and direct to the point.

Format style:
- Brief 1-line summary/introductory sentence.
- 3 to 5 clear bullet points using "• Item: Description or Amount".
- 1 short closing follow-up question or call to action.
- Currency: Always use Nigerian Naira (₦) for amounts.
- Do NOT generate lengthy paragraphs, rambling essays, or excessive text.

${exactMatchContext ? `### Exact Matches:\n${exactMatchContext}\n` : ''}
${summaryContext ? `### Statement Summary:\n${summaryContext}\n` : ''}
${ragContext ? `### Statement Context:\n${ragContext}\n` : ''}`;

  // 6. Direct Claude AI Execution using MODELS list
  const MODELS = [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-5',
  ];

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const AnthropicModule = await import('@anthropic-ai/sdk');
      const Anthropic = AnthropicModule.default || AnthropicModule.Anthropic;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });

      for (const model of MODELS) {
        try {
          const response = await client.messages.create({
            model: model,
            max_tokens: 512,
            system: systemPrompt,
            messages: messages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            })),
          });

          const textBlock = response.content.find((b) => b.type === 'text');
          const rawResponse = textBlock?.text;
          if (rawResponse && rawResponse.trim()) {
            console.log(`[Claude Direct]: Generated concise response with: ${model}`);
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

  // Intelligent Financial Advisory Fallback Engine
  return generateFinancialFallback(userQuery, exactMatchContext, summaryContext);
}

/** Built-in concise financial intelligence engine */
function generateFinancialFallback(query: string, matchContext: string, summaryContext: string): string {
  const q = query.toLowerCase();

  // Wedding Budgeting & Event Planning
  if (q.includes('wedding') || q.includes('marriage') || q.includes('event') || q.includes('party')) {
    return `Here is your recommended December Wedding Budget breakdown:

• Food & Drinks (35%): Catering, small chops, and beverages
• Venue & Decor (30%): Event hall and lighting/decoration
• Attire & Rings (15%): Bride/Groom outfits, rings, and beauty
• Media (10%): Photography and videography
• Contingency (10%): Emergency buffer for peak December rates

What total budget amount in ₦ are you targeting for the event?`;
  }

  // Number budget matching (e.g. 50k, 80000, 100,000)
  const numberMatch = query.match(/(\d[\d,]*)/);
  if (numberMatch && (q.includes('budget') || q.includes('invest') || q.includes('save') || q.includes('spend'))) {
    const rawNum = parseFloat(numberMatch[1].replace(/,/g, ''));
    if (!isNaN(rawNum) && rawNum > 0) {
      const needs = Math.round(rawNum * 0.5);
      const wants = Math.round(rawNum * 0.3);
      const savings = Math.round(rawNum * 0.2);

      return `Here is your 50/30/20 budget plan for ₦${rawNum.toLocaleString()}:

• Needs (50%): ₦${needs.toLocaleString()} (Food, transport, utilities)
• Wants (30%): ₦${wants.toLocaleString()} (Personal care, leisure)
• Savings & Investment (20%): ₦${savings.toLocaleString()} (Emergency fund)

Would you like me to allocate this across specific expense categories?`;
    }
  }

  // Investing queries
  if (q.includes('invest') || q.includes('investment') || q.includes('stock') || q.includes('crypto')) {
    return `Here are the top low-risk investment options in Nigeria:

• Money Market Funds (MMF): 15% - 20% annual yield, high liquidity
• Treasury Bills (T-Bills): Government backed, fixed tenure
• High-Yield Savings Accounts: Automated daily/monthly interest
• Agriculture/Commercial Paper: For vetted short-term returns

Would you like recommendations based on a specific investment timeline?`;
  }

  // Budgeting & Savings Rules
  if (q.includes('budget') || q.includes('save') || q.includes('saving') || q.includes('salary') || q.includes('income')) {
    return `Here is your personal savings framework:

• Needs (50%): Rent, groceries, transport, utilities
• Wants (30%): Subscriptions, dining, personal items
• Savings (20%): Emergency fund & wealth building

Would you like to share your monthly income to see exact Naira allocations?`;
  }

  // Bank Statement / Expense Queries
  if (matchContext || summaryContext) {
    return `Here is your statement summary:

${summaryContext ? summaryContext + '\n\n' : ''}${matchContext ? matchContext + '\n\n' : ''}Would you like me to show specific transactions or ways to reduce spending?`;
  }

  // General Financial Advice
  return `Here is how I can assist your finances:

• Bank Statement Analysis: Extract income, outflow, and savings rate
• Budget Planning: 50/30/20 monthly budget creation
• Expense Tracking: Identify top spending categories
• Investment Guidance: Low-risk wealth accumulation strategies

Would you like to upload a bank statement PDF or create a custom budget?`;
}