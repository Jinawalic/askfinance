import { VoyageAIClient } from 'voyageai';

// Initialize the client using the environment variable
const voyage = new VoyageAIClient({
    apiKey: process.env.VOYAGE_API_KEY
});

/**
 * Converts a single text string into a 1024-dimensional vector embedding.
 */
export async function generateEmbedding(text: string, inputType: 'document' | 'query' = 'document'): Promise<number[]> {
    try {
        const response = await voyage.embed({
            model: 'voyage-finance-2',
            input: text,
            inputType: inputType,
        });

        if (!response.data || response.data.length === 0) {
            throw new Error("No data returned from Voyage AI");
        }

        const embedding = response.data[0].embedding;
        if (!embedding) {
            throw new Error("Embedding vector array is undefined");
        }

        return embedding;
    } catch (error) {
        console.error('Error executing Voyage AI embedding:', error);
        throw new Error('Failed to generate vector embedding.');
    }
}

/**
 * Converts a batch of text strings into 1024-dimensional vector embeddings in a single API call.
 */
export async function generateBatchEmbeddings(
    texts: string[],
    inputType: 'document' | 'query' = 'document'
): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
        const response = await voyage.embed({
            model: 'voyage-finance-2',
            input: texts,
            inputType: inputType,
        });

        if (!response.data || response.data.length === 0) {
            throw new Error("No data returned from Voyage AI");
        }

        return response.data.map((item) => (item.embedding as number[]) || []);
    } catch (error) {
        console.error('Error executing Voyage AI batch embedding:', error);
        return [];
    }
}