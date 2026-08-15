export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// POST /api/users/register
// Accepts { username } and upserts the user record by that unique key.
// Called by the frontend login form before redirecting to Telegram.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username } = body;

    if (!username || typeof username !== 'string') {
      return NextResponse.json(
        { error: 'Username is required' },
        { status: 400 }
      );
    }

    // Sanitise: lowercase, strip everything except a-z 0-9 and underscore,
    // then enforce Telegram's 32-char max length.
    const sanitized = username
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 32);

    if (sanitized.length < 3) {
      return NextResponse.json(
        { error: 'Username must be at least 3 characters (letters, numbers, underscores only)' },
        { status: 400 }
      );
    }

    // Upsert: create if new, update updatedAt if already exists.
    const user = await prisma.user.upsert({
      where: { username: sanitized },
      update: {
        // Keep the record "touched" so updatedAt reflects last login time.
        updatedAt: new Date(),
      },
      create: {
        username: sanitized,
        // name mirrors username for backward-compat with web session display
        name: sanitized,
      },
    });

    return NextResponse.json({ success: true, user }, { status: 200 });
  } catch (error) {
    console.error('[/api/users/register] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
