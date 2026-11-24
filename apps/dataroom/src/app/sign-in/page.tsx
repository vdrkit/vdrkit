// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { serverApi } from '@/api/server';
import { OutsidePage } from '@/components/outside/OutsidePage';
import { SignInFlow } from '@/components/signin/SignInFlow';
import { safeNext } from '@/lib/auth-client';
import { sandboxInfo } from '@/lib/sandbox';

export const metadata: Metadata = { title: 'Sign in' };

async function setupOpen(): Promise<boolean> {
  const r = await (await serverApi()).GET('/v1/setup').catch(() => null);
  return !!r?.data?.open;
}

// ?setup=1: signed in, but two-factor was reset
export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; setup?: string; email?: string }> }) {
  const q = await searchParams;
  if (await sandboxInfo()) redirect('/try');
  if (await setupOpen()) redirect('/setup');
  return (
    <OutsidePage>
      <SignInFlow next={safeNext(q.next)} initialStep={q.setup === '1' ? 'setup' : 'email'} initialEmail={q.email ?? ''} />
    </OutsidePage>
  );
}
