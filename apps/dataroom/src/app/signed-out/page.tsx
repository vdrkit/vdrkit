// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { SignedOut } from '@/components/errors/pages';
import { OutsidePage } from '@/components/outside/OutsidePage';
import { safeNext, SIGNED_OUT_COOKIE } from '@/lib/auth-client';

export const metadata: Metadata = { title: 'Signed out' };

// cookie only, never the query: a crafted link mustn't put text here
export default async function SignedOutPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const q = await searchParams;
  let room: string | null = null;
  let minutes: number | null = null;
  try {
    const raw = (await cookies()).get(SIGNED_OUT_COOKIE)?.value;
    if (raw) {
      const f = JSON.parse(decodeURIComponent(raw)) as { room?: unknown; minutes?: unknown };
      room = typeof f.room === 'string' ? f.room.slice(0, 200) : null;
      minutes = typeof f.minutes === 'number' && Number.isInteger(f.minutes) && f.minutes > 0 ? f.minutes : null;
    }
  } catch { room = null; minutes = null; }
  return (
    <OutsidePage>
      <SignedOut room={room} minutes={minutes} next={safeNext(q.next)} />
    </OutsidePage>
  );
}
