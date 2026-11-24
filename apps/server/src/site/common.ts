// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { SqlClient } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import type { KeyProvider } from '../crypto/envelope.js';
import type { MailBranding } from '../mail/layout.js';
import type { SmtpSettings } from '../mail/smtp.js';
import { testEmail, toMessage } from '../mail/templates.js';
import { forbidden } from '../problems.js';
import { visibleText } from '../routes/util.js';
import type { TxtResolver } from './domain-check.js';
import type { HealthProbes } from './health.js';
import { addressOf, type MailTransportFactory } from './mail.js';

export interface SiteContext {
  keyProvider?: KeyProvider;
  probes: HealthProbes;
  transport: MailTransportFactory;
  resolver: TxtResolver;
  env: Record<string, string | undefined>;
}

export const PersonName = visibleText(z.string().trim().min(1).max(100));

export const FAILED_SIGN_IN_DAYS = 30;

export const MailFormBody = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, 'A host name such as smtp.example.com'),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['starttls', 'tls']),
  user: z.string().trim().max(320).nullable().optional(),
  /** write-only; empty keeps the current one */
  password: z.string().max(1024).optional(),
  removePassword: z.boolean().optional(),
  fromAddress: z.string().trim().toLowerCase().email().max(320),
});
export type MailFormBody = z.infer<typeof MailFormBody>;

export async function requireSiteAdmin(tx: SqlClient, caller: Caller): Promise<string> {
  if (caller.principal.kind !== 'person') throw forbidden('Only site admins can do this.', 'not_site_admin');
  const ok = (await tx.query<{ ok: boolean }>(
    `select is_site_admin and disabled_at is null and erased_at is null as ok from person where id = $1`, [caller.principal.personId])).rows[0]?.ok;
  if (!ok) throw forbidden('Only site admins can do this.', 'not_site_admin');
  return caller.principal.personId;
}

// codes only: the raw text would make this a network probe
export function plainMailError(raw: string | undefined): string {
  const e = raw ?? '';
  const code = /\b(E[A-Z]{3,12})\b/.exec(e)?.[1];
  const reply = /\b([2-5]\d\d)\b/.exec(e)?.[1];
  const tag = [code, reply].filter(Boolean).join(' ');
  const why = mailErrorReason(e, code, reply);
  return tag ? `${why} Error code: ${tag}.` : why;
}

function mailErrorReason(e: string, code: string | undefined, reply: string | undefined): string {
  if (/no mail server is configured/i.test(e)) return 'No mail server is configured.';
  if (code === 'EAUTH' || reply === '535' || reply === '534' || /authentication|credentials/i.test(e)) {
    return 'The mail server refused the user name or password.';
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(e)) return 'The mail server refused the connection. Check the server name and port.';
  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(e)) return 'The server name was not found. Check the spelling.';
  if (code === 'ETIMEDOUT' || /timeout|timed out|ETIMEDOUT/i.test(e)) {
    return 'The mail server did not answer in time. Check the server name, the port and any firewall.';
  }
  if (code === 'ETLS' || /TLS|SSL|certificate/i.test(e)) {
    return 'A secure connection could not be made. Check the encryption setting and the port: TLS usually uses 465, STARTTLS 587.';
  }
  if (/refused the recipient/i.test(e) || code === 'EENVELOPE') return 'The mail server refused the sender or the recipient address.';
  if (reply?.startsWith('5')) return 'The mail server refused the message.';
  return 'The mail server could not be reached or refused the message.';
}

interface TestEmailResult { status: 'accepted' | 'failed'; sentTo: string; server: string; sentAt: string; error?: string }

export async function sendTestEmail(c: Pick<SiteContext, 'transport'>, s: SmtpSettings, to: { personId: string; email: string },
  brand: MailBranding, at: Date, timeZone = 'UTC') {
  const server = `${s.host}:${s.port} (${s.security === 'tls' ? 'TLS' : 'STARTTLS'})`;
  const channel = c.transport(s);
  const mail = testEmail({ brand, host: s.host, port: s.port, security: s.security, sender: addressOf(s.from), sentAt: at, timeZone });
  const r = await channel.send(toMessage(mail, to.personId, to.email))
    .catch((err: unknown) => ({ status: 'failed' as const, error: err instanceof Error ? err.message.slice(0, 200) : 'The mail server could not be reached' }));
  const result: TestEmailResult = { status: r.status, sentTo: to.email, server, sentAt: at.toISOString() };
  if (r.status !== 'accepted') result.error = plainMailError(r.error);
  return result;
}
