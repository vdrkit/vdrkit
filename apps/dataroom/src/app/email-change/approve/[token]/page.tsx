// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { linkAnswer, serverApi } from '@/api/server';
import { EmailChangeApproval, EmailChangeApprovalInvalid } from '@/components/email-change/EmailChangeApproval';
import { OutsidePage } from '@/components/outside/OutsidePage';

export const metadata: Metadata = { title: 'Change your sign-in address?' };

export default async function EmailChangeApprove({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const api = await serverApi();
  const link = await linkAnswer(await api.GET('/v1/public/email-change/approval/{token}', { params: { path: { token } } }));
  return (
    <OutsidePage>
      {link
        ? <EmailChangeApproval token={decodeURIComponent(token)} oldEmail={link.oldEmail} newEmail={link.newEmail} requestedBy={link.requestedBy} />
        : <EmailChangeApprovalInvalid />}
    </OutsidePage>
  );
}
