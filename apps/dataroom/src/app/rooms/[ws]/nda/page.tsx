// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { OutsidePage } from '@/components/outside/OutsidePage';
import { NdaForm } from '@/components/signin/NdaForm';
import { safeNext } from '@/lib/auth-client';

export const metadata: Metadata = { title: 'Confidentiality agreement' };

export default async function Nda({ params, searchParams }: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ next?: string; from?: string; tfa?: string }>;
}) {
  const { ws } = await params;
  const q = await searchParams;
  const next = safeNext(q.next);
  const api = await serverApi();
  const [nda, shell] = await Promise.all([
    must(await api.GET('/v1/workspaces/{ws}/nda', { params: { path: { ws } } }), ws),
    getRoomShell(ws),
  ]);
  if (!nda.mustAccept || !nda.versionId || nda.versionNo === null || nda.body === null) redirect(next === '/' ? `/rooms/${ws}/dashboard` : next);
  return (
    <OutsidePage wide>
      <NdaForm
        ws={ws}
        next={next}
        timeZone={shell.me.timeZone}
        nda={{ ...nda, versionId: nda.versionId, versionNo: nda.versionNo, body: nda.body }}
        steps={q.from === 'invite' ? { twoFactor: q.tfa !== '0' } : undefined}
      />
    </OutsidePage>
  );
}
