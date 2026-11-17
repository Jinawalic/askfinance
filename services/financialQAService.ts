/**
 * services/financialQAService.ts
 * Deterministic Exact-Answer Engine using Anthropic Claude Tool Calling & PostgreSQL / Voyage AI.
 *
 * Implements:
 * 1. query_transactions: exact SQL/Prisma filtering, SUM and COUNT
 * 2. semantic_search_transactions: voyage-finance-2 vector search on pgvector
 * 3. Anthropic tool use loop with claude-haiku-4-5-20251001 / claude-sonnet-4-5-20250929
 */

import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { generateEmbedding } from '@/utils/embeddings';
import type Anthropic from '@anthropic-ai/sdk';

export interface QAServiceOptions {
  userId: string;
  statementId?: string;
  userQuery: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export async function askFinancialQuestion(options: QAServiceOptions): Promise<string> {
  const { userId, statementId, userQuery, history = [] } = options;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured in environment variables');
  }

  const AnthropicModule = await import('@anthropic-ai/sdk');
  const AnthropicClient = AnthropicModule.default || AnthropicModule.Anthropic;
  const client = new AnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });

  // Fetch statement date boundaries to provide context to Claude
  let statementContextInfo = '';
  let statementYear = new Date().getFullYear();
  try {
    const boundaryAgg = await prisma.transaction.aggregate({
      where: statementId ? { statementId } : { userId },
      _min: { transactionDate: true },
      _max: { transactionDate: true },
      _count: { id: true },
    });
    if (boundaryAgg._count.id > 0 && boundaryAgg._min.transactionDate && boundaryAgg._max.transactionDate) {
      statementYear = boundaryAgg._max.transactionDate.getUTCFullYear();
      statementContextInfo = `Statement Transactions: ${boundaryAgg._count.id} rows spanning from ${boundaryAgg._min.transactionDate.toISOString().split('T')[0]} to ${boundaryAgg._max.transactionDate.toISOString().split('T')[0]} (Year: ${statementYear}).`;
    }
  } catch (bErr) {
    console.warn('[Statement boundary notice]:', bErr);
  }

  // Define Claude Tool Specifications
  const tools: Anthropic.Tool[] = [
    {
      name: 'query_transactions',
      description:
        'Executes exact SQL/database search and arithmetic calculations (SUM, COUNT) over user transactions. Always use this tool for specific spending questions (e.g. Airtime, Mobile Data, MTN, Airtel, Stamp Duty, transfers to specific people/accounts, date-range spending, or category totals).',
      input_schema: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description:
              'Case-insensitive substring search in description (e.g. "Airtime", "Mobile Data", "MTN", "Airtel", "Samson", "Stamp Duty", "POS")',
          },
          category: {
            type: 'string',
            description:
              'Category filter (e.g. "Airtime", "Mobile Data", "Food", "Transport", "Bank Charges", "Transfer Out", "Transfer In", "Merchant/POS")',
          },
          type: {
            type: 'string',
            enum: ['debit', 'credit', 'all'],
            description: 'Filter by transaction type. Default is debit for spending questions.',
          },
          startDate: {
            type: 'string',
            description: 'Start date filter in YYYY-MM-DD format (inclusive)',
          },
          endDate: {
            type: 'string',
            description: 'End date filter in YYYY-MM-DD format (inclusive)',
          },
          accountSection: {
            type: 'string',
            enum: ['WALLET', 'SAVINGS', 'ALL'],
            description: 'Filter by account section (WALLET or SAVINGS). Default is ALL or WALLET.',
          },
          includeInternalSweeps: {
            type: 'boolean',
            description:
              'Whether to include internal movement sweeps (Auto-save to OWealth, OWealth Withdrawal, Spend & Save). Default is FALSE to ensure accurate real spending/income totals without double counting.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum itemized rows to return (default 25)',
          },
        },
      },
    },
    {
      name: 'semantic_search_transactions',
      description:
        'Performs vector similarity search via voyage-finance-2 embeddings on pgvector. Use for fuzzy or conceptual queries (e.g. "eating out", "school fees", "entertainment", "groceries") where exact merchant keywords might vary.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The conceptual query text',
          },
          type: {
            type: 'string',
            enum: ['debit', 'credit', 'all'],
            description: 'Transaction type filter',
          },
          includeInternalSweeps: {
            type: 'boolean',
            description: 'Whether to include internal sweeps (default false)',
          },
          limit: {
            type: 'integer',
            description: 'Number of top semantic matches to return (default 10)',
          },
        },
        required: ['query'],
      },
    },
  ];

  // Tool Executor
  async function executeTool(name: string, input: any): Promise<any> {
    if (name === 'query_transactions') {
      const {
        keyword,
        category,
        type = 'debit',
        startDate,
        endDate,
        accountSection,
        includeInternalSweeps = false,
        limit = 25,
      } = input;

      console.log('[executeTool input]:', JSON.stringify(input));

      const where: Prisma.TransactionWhereInput = {};
      if (statementId) {
        where.statementId = statementId;
      } else if (userId) {
        where.userId = userId;
      }

      if (!includeInternalSweeps) {
        where.isInternalSweep = false;
      }

      if (type === 'debit') {
        where.debit = { gt: 0 };
      } else if (type === 'credit') {
        where.credit = { gt: 0 };
      }

      if (keyword && typeof keyword === 'string' && keyword.trim()) {
        where.description = { contains: keyword.trim(), mode: 'insensitive' };
      }

      if (category && typeof category === 'string' && category.trim()) {
        where.category = { contains: category.trim(), mode: 'insensitive' };
      }

      if (accountSection && accountSection !== 'ALL') {
        where.accountSection = accountSection;
      }

      if (startDate || endDate) {
        where.transactionDate = {};
        if (startDate) {
          where.transactionDate.gte = new Date(startDate);
        }
        if (endDate) {
          const eDate = new Date(endDate);
          eDate.setHours(23, 59, 59, 999);
          where.transactionDate.lte = eDate;
        }
      }

      let [matchingRows, aggregate] = await Promise.all([
        prisma.transaction.findMany({
          where,
          orderBy: { transactionDate: 'desc' },
          take: limit,
          select: {
            id: true,
            date: true,
            description: true,
            debit: true,
            credit: true,
            amount: true,
            type: true,
            accountSection: true,
            category: true,
            isInternalSweep: true,
          },
        }),
        prisma.transaction.aggregate({
          where,
          _sum: {
            debit: true,
            credit: true,
            amount: true,
          },
          _count: {
            id: true,
          },
        }),
      ]);

      // If date filter returned 0 results, check if the statement contains matches across its actual statement dates
      if (aggregate._count.id === 0 && (startDate || endDate)) {
        const relaxedWhere = { ...where };
        delete relaxedWhere.transactionDate;
        const [relaxedRows, relaxedAgg] = await Promise.all([
          prisma.transaction.findMany({
            where: relaxedWhere,
            orderBy: { transactionDate: 'desc' },
            take: limit,
            select: {
              id: true,
              date: true,
              description: true,
              debit: true,
              credit: true,
              amount: true,
              type: true,
              accountSection: true,
              category: true,
              isInternalSweep: true,
            },
          }),
          prisma.transaction.aggregate({
            where: relaxedWhere,
            _sum: {
              debit: true,
              credit: true,
              amount: true,
            },
            _count: {
              id: true,
            },
          }),
        ]);

        if (relaxedAgg._count.id > 0) {
          matchingRows = relaxedRows;
          aggregate = relaxedAgg;
        }
      }

      const sumDebit = aggregate._sum.debit || 0;
      const sumCredit = aggregate._sum.credit || 0;
      const totalAmount = type === 'credit' ? sumCredit : sumDebit;

      console.log('[executeTool query_transactions result]:', {
        count: aggregate._count.id,
        totalAmount,
        returned: matchingRows.length,
      });

      return {
        success: true,
        transactionCount: aggregate._count.id,
        totalAmount,
        totalDebit: sumDebit,
        totalCredit: sumCredit,
        formattedTotal: `₦${totalAmount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        returnedRowsCount: matchingRows.length,
        transactions: matchingRows.map((r) => ({
          date: r.date,
          description: r.description,
          amount: `₦${r.amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          debit: r.debit,
          credit: r.credit,
          type: r.type,
          accountSection: r.accountSection,
          category: r.category,
        })),
      };
    }

    if (name === 'semantic_search_transactions') {
      const { query, type = 'all', includeInternalSweeps = false, limit = 10 } = input;
      try {
        const queryEmbedding = await generateEmbedding(query, 'query');
        const embeddingVectorString = `[${queryEmbedding.join(',')}]`;

        const typeFilter =
          type === 'debit'
            ? Prisma.sql`AND debit > 0`
            : type === 'credit'
            ? Prisma.sql`AND credit > 0`
            : Prisma.sql``;

        const sweepFilter = includeInternalSweeps
          ? Prisma.sql``
          : Prisma.sql`AND "isInternalSweep" = false`;

        const scopeFilter = statementId
          ? Prisma.sql`"statementId" = ${statementId}`
          : Prisma.sql`"userId" = ${userId}`;

        const rows: any[] = await prisma.$queryRaw`
          SELECT id, "date", description, debit, credit, amount, type, "accountSection", category, "isInternalSweep"
          FROM "Transaction"
          WHERE ${scopeFilter}
            AND embedding IS NOT NULL
            ${sweepFilter}
            ${typeFilter}
          ORDER BY embedding <=> ${embeddingVectorString}::vector
          LIMIT ${limit};
        `;

        const totalSum = rows.reduce(
          (acc, r) => acc + (type === 'credit' ? Number(r.credit) : Number(r.debit || r.amount)),
          0
        );

        return {
          success: true,
          transactionCount: rows.length,
          totalAmount: totalSum,
          formattedTotal: `₦${totalSum.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          transactions: rows.map((r) => ({
            date: r.date,
            description: r.description,
            amount: `₦${Number(r.amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            debit: Number(r.debit),
            credit: Number(r.credit),
            type: r.type,
            category: r.category,
          })),
        };
      } catch (vectorErr) {
        console.warn('[Semantic Search Notice]:', vectorErr);
        return { success: false, error: 'Vector search unavailable, use query_transactions instead.' };
      }
    }

    return { error: `Unknown tool: ${name}` };
  }

  // System Prompt for Claude
  const systemPrompt = `You are Finance AI, an expert and precise personal financial advisor for Nigerian bank statements (e.g., OPay, Access, GTBank, Zenith).
${statementContextInfo ? `\nCURRENT DATASET CONTEXT:\n${statementContextInfo}\n` : ''}
CRITICAL CALCULATION & ACCURACY RULES:
1. NEVER guess, estimate, or manually add up numbers from memory.
2. ALWAYS call the "query_transactions" tool to get exact SQL SUMs and COUNTs from the database.
   - For spending on Airtime: call query_transactions with keyword="Airtime", type="debit".
   - For spending on Mobile Data: call query_transactions with keyword="Mobile Data", type="debit".
   - For Stamp Duty or Bank Charges: call query_transactions with keyword="Stamp Duty" or category="Bank Charges", type="debit".
   - For transfers to a person: call query_transactions with keyword=<person name>, type="debit".
   - For total spending or outflow: call query_transactions with type="debit", includeInternalSweeps=false.
   - For total income or inflow: call query_transactions with type="credit", includeInternalSweeps=false.
   - For date filtering: if the user mentions a month (e.g., "in October"), match the year of the uploaded statement (${statementYear}). If unsure of the year, omit startDate/endDate and let keyword/category query across the statement.
3. NEVER count internal movement sweeps (like "Auto-save to OWealth", "OWealth Withdrawal", "Spend & Save") as real spending or real income. Keep "includeInternalSweeps=false" unless the user specifically asks about their OWealth savings sweeps.
4. If exact keywords might vary (e.g. food, dining, catering), you may call "semantic_search_transactions" or "query_transactions" with category="Food".
5. RESPONSE FORMATTING (concise and clean for Telegram):
   - State the exact total in Nigerian Naira (₦X,XXX.XX) and the transaction count.
   - Provide a clean bulleted itemized breakdown of matching transactions: "• DD Mon YYYY: Description — ₦Amount".
   - Conclude with a helpful, 1-line financial insight or follow-up question.
   - Keep answers direct, professional, and well-structured.`;

  // Build message history
  const messages: Anthropic.MessageParam[] = [];
  for (const h of history) {
    if (h.content && h.content.trim()) {
      messages.push({ role: h.role, content: h.content.trim() });
    }
  }

  // Ensure alternating roles starting with 'user'
  while (messages.length > 0 && messages[0].role !== 'user') {
    messages.shift();
  }

  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    messages[messages.length - 1].content = userQuery;
  } else {
    messages.push({ role: 'user', content: userQuery });
  }

  const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-sonnet-5'];

  for (const model of MODELS) {
    try {
      let currentMessages = [...messages];
      let maxTurns = 4;

      while (maxTurns > 0) {
        maxTurns--;

        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          tools,
          messages: currentMessages,
        });

        // If Claude wants to call a tool
        if (response.stop_reason === 'tool_use') {
          const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
          
          currentMessages.push({
            role: 'assistant',
            content: response.content,
          });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of toolUseBlocks) {
            const result = await executeTool(block.name, block.input);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }

          currentMessages.push({
            role: 'user',
            content: toolResults,
          });

          continue; // Loop back so Claude generates final text from tool results
        }

        // Final text response
        const textBlock = response.content.find((b) => b.type === 'text') as Anthropic.TextBlock | undefined;
        if (textBlock && textBlock.text && textBlock.text.trim()) {
          return formatTelegramResponse(textBlock.text.trim());
        }
      }
    } catch (err: unknown) {
      console.warn(`[Claude Q&A Error with ${model}]:`, err instanceof Error ? err.message : err);
    }
  }

  // Fallback if AI call fails
  return fallbackDeterministicAnswer(userId, statementId, userQuery);
}

/**
 * Format markdown for clean Telegram delivery
 */
function formatTelegramResponse(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fallback deterministic calculation engine when API is temporarily unreachable.
 */
async function fallbackDeterministicAnswer(
  userId: string,
  statementId: string | undefined,
  userQuery: string
): Promise<string> {
  const q = userQuery.toLowerCase();
  const where: Prisma.TransactionWhereInput = {};
  if (statementId) where.statementId = statementId;
  else if (userId) where.userId = userId;

  where.isInternalSweep = false;

  let title = 'Transactions';
  if (q.includes('airtime')) {
    where.description = { contains: 'airtime', mode: 'insensitive' };
    where.debit = { gt: 0 };
    title = 'Airtime Spending';
  } else if (q.includes('data')) {
    where.description = { contains: 'data', mode: 'insensitive' };
    where.debit = { gt: 0 };
    title = 'Mobile Data Spending';
  } else if (q.includes('stamp duty')) {
    where.description = { contains: 'stamp duty', mode: 'insensitive' };
    where.debit = { gt: 0 };
    title = 'Stamp Duty Fees';
  } else {
    where.debit = { gt: 0 };
    title = 'Total Expenses';
  }

  const [rows, agg] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { transactionDate: 'desc' },
      take: 15,
    }),
    prisma.transaction.aggregate({
      where,
      _sum: { debit: true },
      _count: { id: true },
    }),
  ]);

  const total = agg._sum.debit || 0;
  const count = agg._count.id;

  let reply = `Here is your exact ${title} breakdown:\n\n`;
  reply += `• Total: ₦${total.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
  reply += `• Count: ${count} transaction${count === 1 ? '' : 's'}\n\n`;

  if (rows.length > 0) {
    reply += `Itemized Transactions:\n`;
    for (const r of rows) {
      reply += `• ${r.date}: ${r.description} — ₦${r.debit.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    }
  }

  reply += `\nWould you like more details on any of these transactions?`;
  return reply;
}
