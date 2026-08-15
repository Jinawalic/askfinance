export interface FinancialSummaryData {
    totalInflow: number;
    totalOutflow: number;
    netSavings: number;
    savingsRatePercent: number;
    categories: Record<string, number>;
}

export interface Message {
    id: string;
    text: string;
    sender: 'user' | 'ai';
    fileName?: string;
    createdAt?: string;
}

export interface ChatSession {
    id: string;
    title: string;
    messages: Message[];
    createdAt: number;
    financialSummary?: FinancialSummaryData;
}
