/**
 * utils/statementParser.ts
 * High-precision parser for OPay and Nigerian bank statements.
 * Handles multi-line table rows, internal sweeps (OWealth / Spend & Save),
 * account section tracking ("WALLET" vs "SAVINGS"), and accurate categorization.
 */

export interface ParsedTransactionRecord {
  transactionDate: Date;
  dateStr: string;
  description: string;
  debit: number;
  credit: number;
  amount: number;
  type: 'debit' | 'credit';
  balanceAfter: number | null;
  accountSection: 'WALLET' | 'SAVINGS' | 'MAIN';
  category: string;
  isInternalSweep: boolean;
}

export interface StatementSummaryMetrics {
  totalInflow: number;
  totalOutflow: number;
  netSavings: number;
  savingsRatePercent: number;
  categories: Record<string, number>;
  totalTransactionsCount: number;
  realTransactionsCount: number;
  internalSweepsCount: number;
}

/**
 * Checks if a transaction is an internal transfer / auto-sweep between
 * Wallet, OWealth, and Spend & Save.
 */
export function isInternalSweepRow(description: string): boolean {
  if (!description) return false;
  const d = description.toLowerCase().replace(/\s+/g, ' ');
  return (
    d.includes('auto-save to owealth') ||
    d.includes('owealth withdrawal') ||
    d.includes('owealth deposit') ||
    d.includes('spend & save deposit') ||
    d.includes('spend & save withdrawal') ||
    d.includes('spend and save deposit') ||
    d.includes('spend and save withdrawal') ||
    d.includes('autosave to owealth')
  );
}

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

export function parseTransactionDate(dateStr: string): Date {
  if (!dateStr) return new Date();

  // Pattern 1: "01 Oct 2026 08:44:14" or "01 Oct 2026"
  const m1 = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (m1) {
    const day = parseInt(m1[1], 10);
    const month = MONTH_MAP[m1[2].toLowerCase().slice(0, 3)] ?? 0;
    const year = parseInt(m1[3], 10);
    const hours = m1[4] ? parseInt(m1[4], 10) : 0;
    const mins = m1[5] ? parseInt(m1[5], 10) : 0;
    const secs = m1[6] ? parseInt(m1[6], 10) : 0;
    return new Date(Date.UTC(year, month, day, hours, mins, secs));
  }

  // Pattern 2: DD/MM/YYYY or DD-MM-YYYY or YYYY-MM-DD
  const m2 = dateStr.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m2) {
    const d = parseInt(m2[1], 10);
    const m = parseInt(m2[2], 10) - 1;
    let y = parseInt(m2[3], 10);
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, m, d));
  }

  const m3 = dateStr.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m3) {
    const y = parseInt(m3[1], 10);
    const m = parseInt(m3[2], 10) - 1;
    const d = parseInt(m3[3], 10);
    return new Date(Date.UTC(y, m, d));
  }

  return new Date();
}

/**
 * Assigns a domain-specific financial category based on Nigerian banking descriptions.
 */
export function categorizeTransaction(description: string, isInternalSweep: boolean): string {
  if (isInternalSweep) return 'Internal Sweep';
  const d = description.toLowerCase();

  if (d.includes('airtime')) return 'Airtime';
  if (d.includes('mobile data') || d.includes('data plan') || d.includes('data |') || d.includes('internet')) {
    return 'Mobile Data';
  }
  if (d.includes('stamp duty') || d.includes('sms fee') || d.includes('maintenance fee') || d.includes('charge')) {
    return 'Bank Charges';
  }
  if (d.includes('interest earned') || d.includes('interest paid') || d.includes('dividend')) {
    return 'Interest Income';
  }
  if (
    d.includes('food') || d.includes('restaurant') || d.includes('canteen') ||
    d.includes('catering') || d.includes('chowdeck') || d.includes('eats') ||
    d.includes('kitchen') || d.includes('buka') || d.includes('bakery')
  ) {
    return 'Food';
  }
  if (
    d.includes('transport') || d.includes('uber') || d.includes('bolt') ||
    d.includes('fuel') || d.includes('filling station') || d.includes('brt') || d.includes('ride')
  ) {
    return 'Transport';
  }
  if (
    d.includes('electricity') || d.includes('nepa') || d.includes('phcn') ||
    d.includes('dstv') || d.includes('gotv') || d.includes('startimes') || d.includes('water bill')
  ) {
    return 'Utilities';
  }
  if (
    d.includes('jumia') || d.includes('konga') || d.includes('supermarket') ||
    d.includes('shopping') || d.includes('store') || d.includes('mall')
  ) {
    return 'Shopping';
  }
  if (d.includes('transfer to') || d.includes('trf to') || d.includes('outward transfer')) {
    return 'Transfer Out';
  }
  if (d.includes('transfer from') || d.includes('trf from') || d.includes('inward transfer')) {
    return 'Transfer In';
  }
  if (d.includes('pos transfer') || d.includes('merchant consumption') || d.includes('pos')) {
    return 'Merchant/POS';
  }

  return 'General';
}

/**
 * Parses raw text extracted from bank statements (OPay & other Nigerian banks).
 * Gracefully merges wrapped multi-line table rows and extracts structured records.
 */
export function parseBankStatementText(rawText: string): ParsedTransactionRecord[] {
  if (!rawText) return [];

  const rawLines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const transactions: ParsedTransactionRecord[] = [];
  let currentSection: 'WALLET' | 'SAVINGS' | 'MAIN' = 'WALLET';

  // Date pattern starting an OPay statement transaction row:
  // e.g. "01 Oct 2026 08:44:14 01 Oct 2026 ..." or "01 Oct 2026 ..."
  const opayRowStart = /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}(?:\s+\d{2}:\d{2}:\d{2})?)/i;
  // Generic bank row start: "01/10/2026" or "2026-10-01"
  const genericRowStart = /^(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\b/;

  // Collect raw line blocks per transaction
  interface RowBlock {
    section: 'WALLET' | 'SAVINGS' | 'MAIN';
    lines: string[];
  }

  const blocks: RowBlock[] = [];
  let currentBlock: RowBlock | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // Detect Section Headers (OPay divides statement into Wallet Account and Savings Account)
    if (line.includes('Savings Account') && line.includes('Period:')) {
      currentSection = 'SAVINGS';
      continue;
    } else if (line.includes('Wallet Account') && line.includes('Period:')) {
      currentSection = 'WALLET';
      continue;
    }

    // Filter out page headers, column titles, and metadata banners
    if (
      line.startsWith('Trans. Time') ||
      line.startsWith('Account Statement') ||
      line.startsWith('Generated on') ||
      line.startsWith('Channel Transaction') ||
      line.startsWith('Balance After') ||
      line.startsWith('Debit Count') ||
      line.startsWith('Credit Count') ||
      line.startsWith('Total Debit') ||
      line.startsWith('Total Credit') ||
      line.startsWith('Opening Balance') ||
      line.startsWith('Closing Balance') ||
      line.startsWith('Account Number') ||
      line.startsWith('Account Name')
    ) {
      continue;
    }

    const isOPay = opayRowStart.test(line);
    const isGeneric = !isOPay && genericRowStart.test(line);

    if (isOPay || isGeneric) {
      if (currentBlock && currentBlock.lines.length > 0) {
        blocks.push(currentBlock);
      }
      currentBlock = {
        section: currentSection,
        lines: [line],
      };
    } else if (currentBlock) {
      // Continuation line of multi-line transaction description or reference
      currentBlock.lines.push(line);
    }
  }

  if (currentBlock && currentBlock.lines.length > 0) {
    blocks.push(currentBlock);
  }

  // Parse each row block into a structured transaction
  for (const block of blocks) {
    const rawJoined = block.lines.join(' ').replace(/\s+/g, ' ');

    // 1. Try OPay-style statement pattern:
    // Starts with [Trans. Time] [Value Date?] [Description] [Debit] [Credit] [Balance After] [Channel?] [Ref?]
    const opayMatch = rawJoined.match(
      /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}(?:\s+\d{2}:\d{2}:\d{2})?)\s+(?:\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s+)?(.*)$/i
    );

    if (opayMatch) {
      const transTimeStr = opayMatch[1].trim();
      const remainder = opayMatch[2].trim();

      // Look for the trailing 3 amounts: Debit, Credit, Balance After
      // Debit: "--" or "1,000.00"
      // Credit: "--" or "1,000.00"
      // Balance: "0.00" or "1,000.00"
      const amountsMatch = remainder.match(/(--|\d[\d,]*\.\d{2})\s+(--|\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})(.*)$/);

      if (amountsMatch) {
        let desc = remainder.slice(0, amountsMatch.index).trim();
        const debitStr = amountsMatch[1];
        const creditStr = amountsMatch[2];
        const balStr = amountsMatch[3];

        const debit = debitStr === '--' ? 0 : parseFloat(debitStr.replace(/,/g, ''));
        const credit = creditStr === '--' ? 0 : parseFloat(creditStr.replace(/,/g, ''));
        const balanceAfter = balStr === '--' ? null : parseFloat(balStr.replace(/,/g, ''));
        const amount = Math.max(debit, credit);
        const type = debit > 0 ? 'debit' : 'credit';

        if (!desc || desc.length < 2) {
          desc = 'Transaction';
        }

        const isInternal = isInternalSweepRow(desc);
        const category = categorizeTransaction(desc, isInternal);
        const txDate = parseTransactionDate(transTimeStr);
        const dateParts = transTimeStr.split(' ');
        const dateStr = dateParts.slice(0, 3).join(' ');

        transactions.push({
          transactionDate: txDate,
          dateStr,
          description: desc,
          debit,
          credit,
          amount,
          type,
          balanceAfter,
          accountSection: block.section,
          category,
          isInternalSweep: isInternal,
        });
        continue;
      }
    }

    // 2. Fallback to generic Nigerian bank statement line parser:
    const genericMatch = rawJoined.match(
      /^(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(.*)$/
    );

    if (genericMatch) {
      const dateStr = genericMatch[1].trim();
      const rest = genericMatch[2].trim();

      // Find all currency amounts in the line
      const amountMatches = Array.from(rest.matchAll(/(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g));
      if (amountMatches.length > 0) {
        const lastAmount = parseFloat(amountMatches[amountMatches.length - 1][0].replace(/,/g, ''));
        if (Number.isFinite(lastAmount) && lastAmount > 0) {
          const lower = rest.toLowerCase();
          const isDebit = lower.includes('debit') || lower.includes('dr') || lower.includes('-') || lower.includes('withdrawal');
          const debit = isDebit ? lastAmount : 0;
          const credit = isDebit ? 0 : lastAmount;
          const desc = rest.replace(/\b(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/g, '').replace(/\s+/g, ' ').trim() || 'Transaction';
          const isInternal = isInternalSweepRow(desc);
          const category = categorizeTransaction(desc, isInternal);
          const txDate = parseTransactionDate(dateStr);

          transactions.push({
            transactionDate: txDate,
            dateStr,
            description: desc,
            debit,
            credit,
            amount: lastAmount,
            type: isDebit ? 'debit' : 'credit',
            balanceAfter: null,
            accountSection: block.section,
            category,
            isInternalSweep: isInternal,
          });
        }
      }
    }
  }

  return transactions;
}

/**
 * Computes financial summary totals excluding internal sweeps so that
 * money moving between Wallet and OWealth/Spend&Save does not inflate
 * real spending or income.
 */
export function computeStatementSummary(transactions: ParsedTransactionRecord[]): StatementSummaryMetrics {
  let totalInflow = 0;
  let totalOutflow = 0;

  const categories: Record<string, number> = {
    Airtime: 0,
    'Mobile Data': 0,
    Food: 0,
    Transport: 0,
    Utilities: 0,
    Shopping: 0,
    'Bank Charges': 0,
    'Transfer Out': 0,
    'Merchant/POS': 0,
    Other: 0,
  };

  let realTxCount = 0;
  let sweepCount = 0;

  for (const tx of transactions) {
    if (tx.isInternalSweep) {
      sweepCount++;
      continue;
    }

    realTxCount++;

    if (tx.type === 'credit') {
      totalInflow += tx.credit;
    } else {
      totalOutflow += tx.debit;

      if (categories[tx.category] !== undefined) {
        categories[tx.category] += tx.debit;
      } else {
        categories.Other += tx.debit;
      }
    }
  }

  const safeInflow = Math.round(totalInflow * 100) / 100;
  const safeOutflow = Math.round(totalOutflow * 100) / 100;
  const netSavings = Math.round((safeInflow - safeOutflow) * 100) / 100;

  let savingsRatePercent = 0;
  if (safeInflow > 0) {
    savingsRatePercent = Math.max(-100, Math.min(100, Math.round((netSavings / safeInflow) * 100)));
  }

  return {
    totalInflow: safeInflow,
    totalOutflow: safeOutflow,
    netSavings,
    savingsRatePercent,
    categories,
    totalTransactionsCount: transactions.length,
    realTransactionsCount: realTxCount,
    internalSweepsCount: sweepCount,
  };
}

