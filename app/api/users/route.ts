export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// POST /api/users - Register or find user by name
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { name } = body;

        if (!name || typeof name !== 'string' || !name.trim()) {
            return NextResponse.json({ error: 'Name is required' }, { status: 400 });
        }

        const trimmedName = name.trim();
        // Derive a username slug from the display name for the required unique field
        const usernameSlug = trimmedName
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .slice(0, 32) || 'user';

        // Search for existing user by name or matching username slug (case-insensitive)
        let user = await prisma.user.findFirst({
            where: {
                OR: [
                    { name: { equals: trimmedName, mode: 'insensitive' } },
                    { username: { equals: usernameSlug, mode: 'insensitive' } },
                ]
            }
        });

        let isNew = false;

        // If user does not exist, register new user in database
        if (!user) {
            user = await prisma.user.create({
                data: {
                    name: trimmedName,
                    username: usernameSlug,
                }
            });
            isNew = true;
        }

        return NextResponse.json({ success: true, user, isNew });
    } catch (error) {
        console.error('Error finding/creating user:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
