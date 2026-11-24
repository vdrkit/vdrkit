// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { linkAnswer, serverApi } from '@/api/server';
import { EmailChangeConfirm, EmailChangeInvalid } from '@/components/email-change/EmailChangeConfirm';
import { OutsidePage } from '@/components/outside/OutsidePage';

export const metadata: Metadata = { title: 'Confirm your new sign-in address' };

export default async function EmailChange({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const api = await serverApi();
  const link = await linkAnswer(await api.GET('/v1/public/email-change/{token}', { params: { path: { token } } }));
  return (
    <OutsidePage>
      {link ? <EmailChangeConfirm token={decodeURIComponent(token)} newEmail={link.newEmail} /> : <EmailChangeInvalid />}
    </OutsidePage>
  );
}
