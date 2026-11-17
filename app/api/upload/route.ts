export const runtime = 'nodejs';
export const maxDuration = 60; // Allow up to 60s on Vercel for large PDF processing

import { NextRequest, NextResponse } from 'next/server';
import { extractText } from 'unpdf';
import { parseBankStatementText, computeStatementSummary } from '@/utils/statementParser';
import { generateBatchEmbeddings } from '@/utils/embeddings';
import { prisma } from '@/lib/db';

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        let sessionId = formData.get('sessionId') as string;
        const userId = formData.get('userId') as string;

        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        if (!file.name.toLowerCase().endsWith('.pdf')) {
            return NextResponse.json({ error: 'Only PDF files are supported.' }, { status: 400 });
        }

        // 1. Verify userId in database if provided to prevent foreign key constraint violations
        let validUserId: string | null = null;
        if (userId && typeof userId === 'string' && userId.trim() && userId !== 'undefined' && userId !== 'null') {
            try {
                const user = await prisma.user.findUnique({
                    where: { id: userId.trim() },
                    select: { id: true }
                });
                if (user) {
                    validUserId = user.id;
                }
            } catch (userErr) {
                console.warn('Warning: Failed to verify userId in database:', userErr);
            }
        }

        // 2. Ensure session exists in Postgres & link to valid userId
        if (!sessionId || sessionId === 'default-session') {
            const newSession = await prisma.chatSession.create({
                data: {
                    title: `Statement: ${file.name}`,
                    userId: validUserId || undefined,
                }
            });
            sessionId = newSession.id;
        } else {
            const existing = await prisma.chatSession.findUnique({ where: { id: sessionId } });
            if (!existing) {
                const newSession = await prisma.chatSession.create({
                    data: {
                        id: sessionId,
                        title: `Statement: ${file.name}`,
                        userId: validUserId || undefined,
                    }
                });
                sessionId = newSession.id;
            } else if (validUserId && !existing.userId) {
                await prisma.chatSession.update({
                    where: { id: sessionId },
                    data: { userId: validUserId }
                });
            }
        }

        // 3. Parse PDF text using unpdf
        const arrayBuffer = await file.arrayBuffer();
        let rawText = '';
        try {
            const parsed = await extractText(new Uint8Array(arrayBuffer), { mergePages: true });
            rawText = parsed?.text ?? '';
        } catch (pdfErr) {
            console.error('Error extracting text from PDF:', pdfErr);
            return NextResponse.json({
                error: 'Could not parse the PDF file. Please ensure it is a valid, unencrypted text-based bank statement.',
                details: pdfErr instanceof Error ? pdfErr.message : String(pdfErr)
            }, { status: 422 });
        }

        // Clean lines & strip null bytes or binary noise
        const lines = (rawText ?? '')
            .split('\n')
            .map((line: string) => line.replace(/\0/g, '').trim())
            .filter((line: string) => line.length > 5);

        if (lines.length === 0) {
            return NextResponse.json({
                error: 'Could not extract any text from the PDF. Please ensure it is a text-based (not scanned/image-only) bank statement.'
            }, { status: 422 });
        }

        // 4. Extract structured financial transactions using high-precision parser
        const detectedTransactions = parseBankStatementText(rawText);

        // 5. Store detected transactions in database with structured columns
        if (detectedTransactions.length > 0) {
            try {
                await prisma.transaction.createMany({
                    data: detectedTransactions.map((tx) => ({
                        sessionId: sessionId,
                        statementId: sessionId,
                        userId: validUserId || undefined,
                        transactionDate: tx.transactionDate,
                        date: tx.dateStr,
                        description: tx.description,
                        amount: tx.amount,
                        debit: tx.debit,
                        credit: tx.credit,
                        balanceAfter: tx.balanceAfter,
                        type: tx.type === 'debit' ? 'DEBIT' : 'CREDIT',
                        accountSection: tx.accountSection,
                        category: tx.category,
                        isInternalSweep: tx.isInternalSweep,
                    }))
                });
            } catch (txDbErr) {
                console.warn('Notice: Could not insert transactions table records:', txDbErr);
            }
        }

        // 6. Generate vector embeddings in batch via Voyage AI (chunks of max 30 lines)
        const batchSize = 30;
        const totalLinesToProcess = Math.min(lines.length, 150); // Cap at 150 top lines for fast RAG ingestion

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
                                ${sessionId}, 
                                ${lineText}, 
                                ${embeddingVectorString}::vector
                            );
                        `;
                    }
                }
            } catch (batchErr) {
                console.warn(`Warning: Batch embedding failed for lines ${i} to ${i + batchSize}:`, batchErr);
            }
        }

        // 7. Calculate financial statistics excluding internal sweeps
        const financialSummary = computeStatementSummary(detectedTransactions);

        // 8. Upsert summary to Postgres safely
        await prisma.financialSummary.upsert({
            where: { sessionId: sessionId },
            update: {
                totalInflow: financialSummary.totalInflow,
                totalOutflow: financialSummary.totalOutflow,
                netSavings: financialSummary.netSavings,
                savingsRatePercent: financialSummary.savingsRatePercent,
                categories: financialSummary.categories,
            },
            create: {
                sessionId: sessionId,
                totalInflow: financialSummary.totalInflow,
                totalOutflow: financialSummary.totalOutflow,
                netSavings: financialSummary.netSavings,
                savingsRatePercent: financialSummary.savingsRatePercent,
                categories: financialSummary.categories,
            }
        });

        // 9. Record document upload message in session history
        await prisma.message.create({
            data: {
                sessionId: sessionId,
                sender: 'USER',
                text: `Uploaded bank statement file: ${file.name}`,
                fileName: file.name
            }
        });

        return NextResponse.json({
            success: true,
            sessionId: sessionId,
            summary: financialSummary,
            chunkCount: lines.length
        });
    } catch (error: unknown) {
        console.error("Upload Route Failure:", error instanceof Error ? error.message : error);
        const detail = error instanceof Error ? error.message : String(error);
        return NextResponse.json({ error: 'Failed to parse statement and store vectors in database', details: detail }, { status: 500 });
    }
}