export interface Transaction {
    date: string;
    description: string;
    amount: number;
    type: 'credit' | 'debit';
}

export function analyzeTransactions(transactions: Transaction[]) {
    let totalInflow = 0;
    let totalOutflow = 0;

    const categories: Record<string, number> = {
        Transport: 0,
        Food: 0,
        Utilities: 0,
        Shopping: 0,
        Uncategorized: 0
    };

    transactions.forEach(({ description, amount, type }) => {
        const desc = description.toLowerCase();

        if (type === 'credit') {
            totalInflow += amount;
        } else {
            totalOutflow += amount;

            // Nigerian context keyword matching rules
            if (
                desc.includes('uber') ||
                desc.includes('bolt') ||
                desc.includes('transport') ||
                desc.includes('brt')
            ) {
                categories.Transport += amount;
            } else if (
                desc.includes('restaurant') ||
                desc.includes('eats') ||
                desc.includes('food') ||
                desc.includes('canteen') ||
                desc.includes('chowdeck')
            ) {
                categories.Food += amount;
            } else if (
                desc.includes('utility') ||
                desc.includes('electricity') ||
                desc.includes('dstv') ||
                desc.includes('data') ||
                desc.includes('airtime')
            ) {
                categories.Utilities += amount;
            } else if (
                desc.includes('jumia') ||
                desc.includes('store') ||
                desc.includes('mall') ||
                desc.includes('pos') ||
                desc.includes('konga')
            ) {
                categories.Shopping += amount;
            } else {
                categories.Uncategorized += amount;
            }
        }
    });

    const safeInflow = Number.isFinite(totalInflow) ? Math.round(totalInflow * 100) / 100 : 0;
    const safeOutflow = Number.isFinite(totalOutflow) ? Math.round(totalOutflow * 100) / 100 : 0;
    const netSavings = Math.round((safeInflow - safeOutflow) * 100) / 100;
    
    let savingsRatePercent = 0;
    if (safeInflow > 0 && Number.isFinite(netSavings)) {
        const rawRate = Math.round((netSavings / safeInflow) * 100);
        // Clamp to safe PostgreSQL integer limits (-100% to 100%)
        savingsRatePercent = Math.max(-100, Math.min(100, rawRate));
    }

    return {
        totalInflow: safeInflow,
        totalOutflow: safeOutflow,
        netSavings,
        savingsRatePercent,
        categories
    };
}