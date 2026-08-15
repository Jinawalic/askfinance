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

    const netSavings = totalInflow - totalOutflow;
    const savingsRatePercent = totalInflow > 0 ? Math.round((netSavings / totalInflow) * 100) : 0;

    return {
        totalInflow,
        totalOutflow,
        netSavings,
        savingsRatePercent,
        categories
    };
}