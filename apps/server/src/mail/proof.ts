// SPDX-License-Identifier: AGPL-3.0-only
import { mailContext, mailReason } from '@vdrkit/core';

export type MailType =
  | 'invitation' | 'invitation_reminder' | 'nda_reminder' | 'colleague_request' | 'request_decision' | 'copy_request'
  | 'site_admin_joined' | 'access_restored' | 'email_change_code' | 'email_change_approval';

export interface MailOutcome { status: string; providerMessageId?: string | undefined; error?: string | undefined }

export function mailEvent(o: { type: MailType; personId: string; to: string; subject: string; result: MailOutcome; extra?: Record<string, unknown> }): {
  data: Record<string, unknown>; context: { personal: Record<string, unknown>; subjectPersonId: string };
} {
  const data: Record<string, unknown> = {
    recipient_person_id: o.personId,
    channel: 'email',
    mail_type: o.type,
    delivery_status: o.result.status,
    provider_message_id: o.result.providerMessageId ?? null,
  };
  if (o.result.status !== 'accepted') data.error = mailReason(o.result.error, o.to);
  Object.assign(data, o.extra);
  return { data, context: mailContext(o.personId, { to: o.to, subject: o.subject })! };
}
