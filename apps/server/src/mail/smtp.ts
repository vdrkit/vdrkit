// SPDX-License-Identifier: AGPL-3.0-only
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { Channel, OutgoingMessage } from '@vdrkit/core';

// Don't log subjects or bodies: they hold sign-in codes

export type SmtpSecurity = 'starttls' | 'tls';

export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  user?: string;
  password?: string;
  from: string;
}

type Env = Record<string, string | undefined>;

export function smtpSettingsFromEnv(env: Env = process.env): SmtpSettings | null {
  const host = env.SMTP_HOST?.trim();
  const url = env.SMTP_URL?.trim();
  if (!host && !url) return null;
  const from = env.MAIL_FROM?.trim();
  if (!from) throw new Error('MAIL_FROM is not set. It is required when SMTP_HOST or SMTP_URL is set.');

  if (host) {
    const security = parseSecurity(env.SMTP_SECURE);
    const port = env.SMTP_PORT?.trim() ? parsePort(env.SMTP_PORT) : 587;
    return { host, port, security, from, ...credentials(env.SMTP_USER, env.SMTP_PASSWORD) };
  }

  let u: URL;
  try { u = new URL(url!); } catch { throw new Error('SMTP_URL is not a valid URL.'); }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('SMTP_URL must start with smtp:// or smtps://.');
  if (!u.hostname) throw new Error('SMTP_URL has no host.');
  const security: SmtpSecurity = u.protocol === 'smtps:' ? 'tls' : 'starttls';
  const port = u.port ? parsePort(u.port) : security === 'tls' ? 465 : 587;
  const user = u.username ? decodeURIComponent(u.username) : undefined;
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  return { host: u.hostname, port, security, from, ...credentials(user, password) };
}

function parseSecurity(v: string | undefined): SmtpSecurity {
  const s = (v ?? '').trim().toLowerCase();
  if (s === '' || s === 'starttls') return 'starttls';
  if (s === 'tls') return 'tls';
  throw new Error('SMTP_SECURE must be "starttls" or "tls".');
}

function parsePort(v: string): number {
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('SMTP_PORT must be a port number.');
  return n;
}

function credentials(user: string | undefined, password: string | undefined): { user?: string; password?: string } {
  if (!user) return {};
  return password ? { user, password } : { user };
}

export function smtpTransportOptions(s: SmtpSettings): SMTPTransport.Options {
  const options: SMTPTransport.Options = {
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    tls: { minVersion: 'TLSv1.2', servername: s.host },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    dnsTimeout: 10_000,
    logger: false,
    debug: false,
    // attachments must not read files or fetch URLs
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (s.user) options.auth = { user: s.user, pass: s.password ?? '' };
  return options;
}

export type MailLog = (msg: string, extra: Record<string, unknown>) => void;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function bodies(msg: Pick<OutgoingMessage, 'text' | 'html' | 'lines'>): { text: string; html: string } {
  const lines = msg.lines ?? [];
  return {
    text: msg.text ?? lines.join('\n\n'),
    html: msg.html ?? lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n'),
  };
}

// goes into the audit trail: strip the password and message text
function failureReason(err: unknown, secrets: string[]): string {
  const e = err as { code?: unknown; responseCode?: unknown; message?: unknown };
  const codes: string[] = [];
  if (typeof e?.code === 'string' && e.code) codes.push(e.code);
  if (typeof e?.responseCode === 'number') codes.push(String(e.responseCode));
  const parts = codes.join(' ');
  let text = typeof e?.message === 'string' ? e.message : String(err);
  for (const s of secrets) if (s && s.length >= 4) text = text.split(s).join('[removed]');
  text = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return parts ? `${parts}: ${text}` : text;
}

function secretsOf(subject: string, text: string): string[] {
  const out = [subject];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) out.push(trimmed);
  }
  for (const [match] of `${subject}\n${text}`.matchAll(/https?:\/\/\S+|\b\d{3} ?\d{3}\b/g)) {
    const spaced = /^\d{6}$/.test(match) ? `${match.slice(0, 3)} ${match.slice(3)}` : match;
    out.push(match, match.replace(' ', ''), spaced);
  }
  return out;
}

export function hasName(from: string): boolean {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  return !!m && m[1]!.trim().length > 0;
}

export function withName(from: string, name: string): string {
  const m = /<([^>]+)>\s*$/.exec(from);
  const address = (m ? m[1]! : from).trim();
  const n = name.replace(/["\\\r\n<>]/g, '').trim();
  return n ? `"${n}" <${address}>` : from;
}

export class SmtpChannel implements Channel {
  readonly name = 'email';

  constructor(
    private readonly transport: Pick<Transporter, 'sendMail'>,
    private readonly from: string,
    private readonly log: MailLog = (msg, extra) => console.error(JSON.stringify({ msg, ...extra })),
    private readonly password?: string,
  ) {}

  async send(msg: OutgoingMessage): Promise<{ status: 'accepted' | 'failed'; providerMessageId?: string; error?: string }> {
    const body = bodies(msg);
    const secrets = [this.password ?? '', ...secretsOf(msg.subject, body.text)];
    try {
      let from = this.from;
      if (msg.fromName) from = withName(this.from, msg.fromName);
      else if (msg.fallbackFromName && !hasName(this.from)) from = withName(this.from, msg.fallbackFromName);
      const mail: Parameters<Transporter['sendMail']>[0] = { from, to: msg.to, subject: msg.subject };
      if (msg.replyTo) mail.replyTo = msg.replyTo;
      Object.assign(mail, body);
      if (msg.inline?.length) {
        mail.attachments = msg.inline.map((a) => ({
          cid: a.cid, filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content), contentDisposition: 'inline' as const,
        }));
      }
      const info = await this.transport.sendMail(mail);
      const result: { status: 'accepted' | 'failed'; providerMessageId?: string; error?: string } = { status: 'accepted' };
      if (info.rejected?.length) {
        result.status = 'failed';
        result.error = 'The mail server refused the recipient';
        this.log('mail.failed', { person_id: msg.personId, reason: result.error });
      }
      if (info.messageId) result.providerMessageId = info.messageId;
      return result;
    } catch (err) {
      const error = failureReason(err, secrets);
      this.log('mail.failed', { person_id: msg.personId, reason: error });
      return { status: 'failed', error };
    }
  }
}

export function smtpChannelFromEnv(env: Env = process.env, log?: MailLog): SmtpChannel | undefined {
  const s = smtpSettingsFromEnv(env);
  if (!s) return undefined;
  return new SmtpChannel(nodemailer.createTransport(smtpTransportOptions(s)), s.from, log, s.password);
}

export function describeSmtp(env: Env = process.env): string | null {
  const s = smtpSettingsFromEnv(env);
  return s ? `${s.host}:${s.port} (${s.security === 'tls' ? 'TLS' : 'STARTTLS required'})` : null;
}
