export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';

type SessionWithRelations = Prisma.ChatSessionGetPayload<{
    include: {
        messages: true;
        financialSummary: true;
    };
}>;

// GET /api/sessions - Fetch all chat sessions from database (optionally filtered by userId)
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const userId = searchParams.get('userId');

        const sessions = await prisma.chatSession.findMany({
            where: userId ? { OR: [{ userId }, { userId: null }] } : {},
            orderBy: { updatedAt: 'desc' },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' }
                },
                financialSummary: true,
            }
        });

        const formatted = sessions.map((s: SessionWithRelations) => ({
            id: s.id,
            title: s.title,
            createdAt: s.createdAt.getTime(),
            messages: s.messages.map((m) => ({
                id: m.id,
                text: m.text,
                sender: m.sender.toLowerCase() as 'user' | 'ai',
                fileName: m.fileName || undefined,
                createdAt: m.createdAt.toISOString(),
            })),
            financialSummary: s.financialSummary ? {
                totalInflow: s.financialSummary.totalInflow,
                totalOutflow: s.financialSummary.totalOutflow,
                netSavings: s.financialSummary.netSavings,
                savingsRatePercent: s.financialSummary.savingsRatePercent,
                categories: s.financialSummary.categories as Record<string, number>,
            } : undefined
        }));

        return NextResponse.json({ success: true, sessions: formatted });
    } catch (error) {
        console.error('Error fetching sessions:', error);
        return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 });
    }
}

// DELETE /api/sessions?id=... - Delete a session from database
export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
        }

        await prisma.chatSession.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting session:', error);
        return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 });
    }
}
