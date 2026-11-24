// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { linkAnswer, serverApi } from '@/api/server';
import { InvitationInvalid } from '@/components/errors/pages';
import { OutsidePage } from '@/components/outside/OutsidePage';
import { InvitationFlow } from '@/components/signin/InvitationFlow';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const api = await serverApi();
  const facts = await linkAnswer(await api.GET('/v1/public/invitations/{token}', { params: { path: { token } } }));
  return (
    <OutsidePage>
      {facts ? <InvitationFlow token={token} facts={facts} /> : <InvitationInvalid />}
    </OutsidePage>
  );
}
