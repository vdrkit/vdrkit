// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { LinkExpired } from '@/components/errors/pages';
import { OutsidePage } from '@/components/outside/OutsidePage';
import { MagicLinkLanding } from '@/components/signin/MagicLinkLanding';
import { safeNext } from '@/lib/auth-client';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInLink({ searchParams }: { searchParams: Promise<{ token?: string; next?: string }> }) {
  const q = await searchParams;
  return (
    <OutsidePage>
      {q.token ? <MagicLinkLanding token={q.token} next={safeNext(q.next)} /> : <LinkExpired />}
    </OutsidePage>
  );
}
