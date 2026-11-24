// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { BeingUpdated } from '@/components/errors/live';
import { OutsideFrame } from '@/components/outside/OutsideFrame';
import { getBranding } from '@/components/outside/OutsidePage';
import { safeNext } from '@/lib/auth-client';

export const metadata: Metadata = { title: 'Being updated' };

export default async function Updating({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const q = await searchParams;
  const branding = await getBranding();
  return (
    <OutsideFrame branding={branding}>
      <BeingUpdated org={branding.name} next={safeNext(q.next)} />
    </OutsideFrame>
  );
}
