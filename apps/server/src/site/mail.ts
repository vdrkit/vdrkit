// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { withTenant, type Channel, type Database, type OutgoingMessage, type SqlClient } from '@vdrkit/core';
import type { KeyProvider, WrappedKey } from '../crypto/envelope.js';
import { SmtpChannel, smtpSettingsFromEnv, smtpTransportOptions, type SmtpSecurity, type SmtpSettings } from '../mail/smtp.js';

type Env = Record<string, string | undefined>;

export type MailTransportFactory = (s: SmtpSettings) => Channel & { verify?(): Promise<void> };

export const nodemailerTransport: MailTransportFactory = (s) => {
  const transport = nodemailer.createTransport(smtpTransportOptions(s));
  const channel = new SmtpChannel(transport, s.from, undefined, s.password) as SmtpChannel & { verify?(): Promise<void> };
  channel.verify = async () => { await transport.verify(); };
  return channel;
};

export function fromHeader(address: string, name?: string | null): string {
  const n = (name ?? '').replace(/["\\\r\n]/g, '').trim();
  return n ? `"${n}" <${address}>` : address;
}

export function addressOf(from: string): string {
  const m = /<([^>]+)>\s*$/.exec(from);
  return (m ? m[1]! : from).trim();
}

export interface MailForm {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  fromAddress: string;
}

export function envSettings(env: Env): SmtpSettings | null {
  try {
    return smtpSettingsFromEnv(env);
  } catch {
    return null;
  }
}

export function mailFormFromEnv(env: Env): (MailForm & { passwordSet: boolean }) | null {
  const s = envSettings(env);
  if (!s) return null;
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s.from);
  return {
    host: s.host, port: s.port, security: s.security, user: s.user ?? null,
    fromAddress: m ? m[2]!.trim() : s.from.trim(),
    passwordSet: !!s.password,
  };
}

// stops an admin redirecting the saved password to their own server
export function samePasswordTarget(a: { host: string; user?: string | null }, b: { host: string; user?: string | null }): boolean {
  const host = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');
  return host(a.host) === host(b.host) && (a.user ?? '') === (b.user ?? '');
}

export const PASSWORD_AGAIN = 'You changed the mail server or the user name. Type the password again: a saved password is only sent to the server and user it was saved for.';

export function mailFingerprint(s: SmtpSettings, to: string): string {
  return createHash('sha256').update(JSON.stringify([s.host, s.port, s.security, s.user ?? '', s.password ?? '', s.from, to.toLowerCase()])).digest('hex');
}

const passwordContext = (tenantId: string) => `site-mail-password:${tenantId}`;

export async function wrapPassword(kp: KeyProvider, tenantId: string, password: string): Promise<WrappedKey> {
  return kp.wrap(Buffer.from(password, 'utf8'), passwordContext(tenantId));
}

export async function unwrapPassword(kp: KeyProvider, tenantId: string, w: WrappedKey): Promise<string> {
  return (await kp.unwrap(w, passwordContext(tenantId))).toString('utf8');
}

export interface StoredMailRow {
  mail_host: string | null; mail_port: number | null; mail_security: SmtpSecurity | null; mail_user: string | null;
  mail_password_wrapped: WrappedKey | null; mail_from_address: string | null;
}

export async function readMailRow(tx: SqlClient): Promise<StoredMailRow | null> {
  const r = (await tx.query<StoredMailRow>(
    `select mail_host, mail_port, mail_security, mail_user, mail_password_wrapped, mail_from_address
       from site_settings where tenant_id = current_tenant_id()`)).rows[0];
  return r && r.mail_host ? r : null;
}

export async function savedMailSettings(tx: SqlClient, tenantId: string, kp: KeyProvider | undefined): Promise<SmtpSettings | null> {
  const r = await readMailRow(tx);
  if (!r) return null;
  let password: string | undefined;
  if (r.mail_password_wrapped) {
    if (!kp) throw new Error('A mail password is saved, but VDRKIT_MASTER_KEY is not set, so it cannot be read.');
    password = await unwrapPassword(kp, tenantId, r.mail_password_wrapped);
  }
  const settings: SmtpSettings = { host: r.mail_host!, port: r.mail_port!, security: r.mail_security!, from: fromHeader(r.mail_from_address!) };
  if (r.mail_user) settings.user = r.mail_user;
  if (password) settings.password = password;
  return settings;
}

export async function effectiveMailSettings(tx: SqlClient, tenantId: string, kp: KeyProvider | undefined, env: Env):
  Promise<{ settings: SmtpSettings; source: 'database' | 'env' } | null> {
  const saved = await savedMailSettings(tx, tenantId, kp);
  if (saved) return { settings: saved, source: 'database' };
  const fromEnv = envSettings(env);
  return fromEnv ? { settings: fromEnv, source: 'env' } : null;
}

export async function siteTenantId(db: Database, dbRole?: 'vdrkit_app'): Promise<string | null> {
  return db.transaction(async (tx) => {
    if (dbRole) await tx.query(`set local role ${dbRole}`);
    return (await tx.query<{ tenant_id: string }>(`select tenant_id::text from site_instance`)).rows[0]?.tenant_id ?? null;
  });
}

export interface SiteMailOptions {
  db: Database;
  dbRole?: 'vdrkit_app';
  env?: Env;
  keyProvider?: KeyProvider;
  transport?: MailTransportFactory;
  cacheMs?: number;
}

export class SiteMailChannel implements Channel {
  readonly name = 'email';
  private cached: { until: number; value: { channel: ReturnType<MailTransportFactory>; settings: SmtpSettings; source: 'database' | 'env' } | null } | null = null;

  constructor(private readonly o: SiteMailOptions) {}

  invalidate(): void { this.cached = null; }

  async current() {
    if (this.cached && this.cached.until > Date.now()) return this.cached.value;
    const env = this.o.env ?? process.env;
    const tenant = await siteTenantId(this.o.db, this.o.dbRole);
    let eff: { settings: SmtpSettings; source: 'database' | 'env' } | null = null;
    if (tenant) {
      eff = await withTenant(this.o.db, tenant, (tx) => effectiveMailSettings(tx, tenant, this.o.keyProvider, env),
        this.o.dbRole ? { role: this.o.dbRole } : {});
    } else {
      const s = envSettings(env);
      if (s) eff = { settings: s, source: 'env' };
    }
    const value = eff ? { ...eff, channel: (this.o.transport ?? nodemailerTransport)(eff.settings) } : null;
    this.cached = { until: Date.now() + (this.o.cacheMs ?? 30_000), value };
    return value;
  }

  async verify(): Promise<void> {
    const c = await this.current();
    if (!c) throw new Error('No mail server is configured');
    await c.channel.verify?.();
  }

  async send(msg: OutgoingMessage) {
    let c;
    try {
      c = await this.current();
    } catch (err) {
      return { status: 'failed' as const, error: err instanceof Error ? err.message.slice(0, 200) : 'Mail settings could not be read' };
    }
    if (!c) return { status: 'failed' as const, error: 'No mail server is configured' };
    return c.channel.send(msg);
  }
}

export function invalidateMail(ch: Channel | undefined): void {
  (ch as { invalidate?: () => void } | undefined)?.invalidate?.();
}
