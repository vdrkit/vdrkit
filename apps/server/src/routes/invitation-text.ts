// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from '@vdrkit/core';
import { sellerNameSql } from './seller.js';

// workspace.metadata.invitation; missing keys fall back to the default
export interface InvitationText {
  subject: string;
  message: string;
  leadParagraph: string;
  senderName: string;
  replyTo: string;
}

export const SIGNATURE = '{signature}';

export function signatureText(senderName: string | null, runBy: string | null): string {
  return [senderName?.trim(), runBy?.trim()].filter(Boolean).join('\n');
}

export function defaultSenderName(senderName: string | null, runBy: string | null): string {
  return [senderName?.trim(), runBy?.trim()].filter(Boolean).join(', ');
}

export const DEFAULT_LEAD_PARAGRAPH =
  'You are invited as a lead for {group}. As a lead you can request to add colleagues and advisers to {group}. ' +
  'Use My team in the data room to send a request, and the room admin approves it.';

export function defaultInvitationText(roomName: string, requiresNda: boolean, runBy?: string | null, seller?: string | null): InvitationText {
  const who = runBy?.trim() ? `${runBy.trim()} has invited you` : 'You are invited';
  const behalf = seller?.trim() ? ` on behalf of ${seller.trim()}` : '';
  return {
    subject: `Invitation to the ${roomName} data room`,
    message: [
      'Dear colleague,',
      '',
      `${who} to the ${roomName} data room${behalf}. Use the button in this email to sign in.` +
        (requiresNda ? ' You will be asked to accept the confidentiality agreement before you see any documents.' : ''),
      '',
      'Your access runs until {until}.',
      '',
      'Kind regards,',
      SIGNATURE,
    ].join('\n'),
    leadParagraph: DEFAULT_LEAD_PARAGRAPH,
    senderName: '',
    replyTo: '',
  };
}

interface Stored { subject?: string; message?: string; lead_paragraph?: string; sender_name?: string; reply_to?: string }

export async function readInvitationText(tx: SqlClient, workspaceId: string): Promise<InvitationText> {
  const w = (await tx.query<{ name: string; requires_nda: boolean; inv: Stored | null; run_by: string | null; seller: string | null }>(
    `select w.name, w.requires_nda, w.metadata -> 'invitation' as inv, t.name as run_by, ${sellerNameSql('w.id')} as seller
       from workspace w join tenant t on t.id = w.tenant_id where w.id = $1`, [workspaceId])).rows[0]!;
  const d = defaultInvitationText(w.name, w.requires_nda, w.run_by, w.seller);
  const s = w.inv ?? {};
  return {
    subject: s.subject ?? d.subject,
    message: s.message ?? d.message,
    leadParagraph: s.lead_paragraph ?? d.leadParagraph,
    senderName: s.sender_name ?? d.senderName,
    replyTo: s.reply_to ?? d.replyTo,
  };
}

// null resets to default
export function mergeInvitationText(
  stored: Stored | null | undefined,
  change: { subject?: string | null; message?: string | null; leadParagraph?: string | null; senderName?: string | null; replyTo?: string | null },
): Stored {
  const out: Stored = { ...stored };
  const set = (key: keyof Stored, v: string | null | undefined) => {
    if (v === undefined) return;
    if (v === null) delete out[key];
    else out[key] = v;
  };
  set('subject', change.subject);
  set('message', change.message);
  set('lead_paragraph', change.leadParagraph);
  set('sender_name', change.senderName === '' ? null : change.senderName);
  set('reply_to', change.replyTo === '' ? null : change.replyTo);
  return out;
}

export function formatUntil(until: Date | null, timeZone: string): string {
  if (!until) return 'the room closes';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(until).replace(/,/g, '');
}

export function invitationBody(a: {
  message: string; leadParagraph: string; role: string; groupName: string; givenName: string; until: Date | null; timeZone: string;
  signature?: string;
}): { message: string; lead: string | null } {
  let message = a.message.split('{until}').join(formatUntil(a.until, a.timeZone)).split(SIGNATURE).join(a.signature ?? '');
  if (a.givenName) message = message.replace(/^Dear colleague\b/, `Dear ${a.givenName}`);
  const lead = a.leadParagraph.trim();
  if (a.role !== 'lead' || !lead) return { message, lead: null };
  return { message, lead: lead.split('{group}').join(a.groupName) };
}
