// SPDX-License-Identifier: AGPL-3.0-only
import type { paths } from '@/api/client';
import { formatDay, partsIn } from '@/lib/time';
import type { SiteTab } from './routes';

export type Settings = paths['/v1/site/settings']['get']['responses'][200]['content']['application/json'];
export type SiteRooms = paths['/v1/site/rooms']['get']['responses'][200]['content']['application/json'];
export type SiteRoom = SiteRooms['items'][number];
export type Accounts = paths['/v1/site/accounts']['get']['responses'][200]['content']['application/json'];
export type Account = Accounts['items'][number];
export type Health = paths['/v1/site/health']['get']['responses'][200]['content']['application/json'];
export type DomainCheck = paths['/v1/site/mail/domain-check']['get']['responses'][200]['content']['application/json'];
export type TestResult = paths['/v1/site/mail/test']['post']['responses'][200]['content']['application/json'];
export type SettingsPatch = NonNullable<paths['/v1/site/settings']['patch']['requestBody']>['content']['application/json'];
export type MailBody = SettingsPatch['mail'];

export type Security = 'starttls' | 'tls';
export type PrivacyKind = Settings['organisation']['privacyNotice']['kind'];

export interface Form {
  org: string;
  privacyKind: PrivacyKind;
  privacyUrl: string;
  privacyText: string;
  host: string;
  port: string;
  security: Security;
  user: string;
  /** write-only; empty keeps the saved one */
  pw: string;
  from: string;
  dkim: string;
  alertAdmins: boolean;
  alertTo: string;
  alertMin: '5' | '15' | '60';
}

export const OWN: Record<keyof Form, SiteTab> = {
  org: 'branding', privacyKind: 'branding', privacyUrl: 'branding', privacyText: 'branding', host: 'email', port: 'email', security: 'email', user: 'email', pw: 'email', from: 'email',
  dkim: 'email', alertAdmins: 'health', alertTo: 'health', alertMin: 'health',
};

export const MAIL_KEYS: (keyof Form)[] = ['host', 'port', 'security', 'user', 'pw', 'from'];
export const PRIVACY_KEYS: (keyof Form)[] = ['privacyKind', 'privacyUrl', 'privacyText'];

export function privacyBody(w: Form): { url: string } | { text: string } | null {
  if (w.privacyKind === 'url') return { url: w.privacyUrl.trim() };
  if (w.privacyKind === 'text') return { text: w.privacyText.replace(/\r\n?/g, '\n').trim() };
  return null;
}

export const samePrivacy = (a: Form, b: Form) => JSON.stringify(privacyBody(a)) === JSON.stringify(privacyBody(b));
export const PRIVACY_TEXT_MAX = 50_000;

export function formFrom(s: Settings): Form {
  return {
    org: s.organisation.name ?? '',
    privacyKind: s.organisation.privacyNotice.kind,
    privacyUrl: s.organisation.privacyNotice.kind === 'url' ? s.organisation.privacyNotice.url : '',
    privacyText: s.organisation.privacyNotice.kind === 'text' ? s.organisation.privacyNotice.text : '',
    host: s.mail.host ?? '',
    port: s.mail.port ? String(s.mail.port) : '587',
    security: s.mail.security ?? 'starttls',
    user: s.mail.user ?? '',
    pw: '',
    from: s.mail.fromAddress ?? '',
    dkim: s.mail.dkimSelector,
    alertAdmins: s.alerts.notifySiteAdmins,
    alertTo: s.alerts.extraEmail ?? '',
    alertMin: String(s.alerts.afterMinutes) as Form['alertMin'],
  };
}

export type LogoStage = { kind: 'keep' } | { kind: 'new'; file: File; url: string } | { kind: 'remove' };
export type LogoVariant = 'light' | 'dark';

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[A-Za-z0-9.-]+$/;

export function mailBody(w: Form): NonNullable<MailBody> {
  return {
    host: w.host.trim(),
    port: Number(w.port),
    security: w.security,
    user: w.user.trim() || null,
    password: w.pw || undefined,
    fromAddress: w.from.trim(),
  };
}

export function problems(w: Form, keys: Set<keyof Form>): Partial<Record<keyof Form, string>> {
  const out: Partial<Record<keyof Form, string>> = {};
  if (keys.has('org') && w.org.trim().length < 2) out.org = 'Give the organisation’s name.';
  if (keys.has('privacyKind') && w.privacyKind === 'url' && !/^https?:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(w.privacyUrl.trim())) {
    out.privacyUrl = 'Give the full web address, starting with https://';
  }
  if (keys.has('privacyKind') && w.privacyKind === 'text') {
    const t = w.privacyText.trim();
    if (!t) out.privacyText = 'Paste the text of the privacy notice, or choose another option.';
    else if (t.length > PRIVACY_TEXT_MAX) out.privacyText = `At most ${PRIVACY_TEXT_MAX.toLocaleString('en-GB')} characters. This text has ${t.length.toLocaleString('en-GB')}.`;
  }
  if (MAIL_KEYS.some((k) => keys.has(k))) {
    if (!w.host.trim()) out.host = 'Give the mail server, such as smtp.example.com.';
    else if (!HOST.test(w.host.trim())) out.host = 'A server name has only letters, digits, dots and hyphens.';
    const port = Number(w.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) out.port = 'A port is a number from 1 to 65535.';
    if (!EMAIL.test(w.from.trim())) out.from = 'Give a complete email address.';
  }
  if (keys.has('dkim') && !/^[A-Za-z0-9._-]{1,63}$/.test(w.dkim.trim())) out.dkim = 'Letters, digits, dots, hyphens and underscores only.';
  if (keys.has('alertTo') && w.alertTo.trim() && !EMAIL.test(w.alertTo.trim())) out.alertTo = 'Give a complete email address, or leave it empty.';
  return out;
}

const n = (x: number) => x.toLocaleString('en-GB');
export const count = n;

export function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return b ? `${b} B` : '0 GB';
}

export function formatCreated(at: string, timeZone: string): string {
  return formatDay(at, timeZone, new Date(0));
}

type Parts = ReturnType<typeof partsIn>;
const sameDay = (a: Parts, b: Parts) => a.year === b.year && a.month === b.month && a.day === b.day;

export function formatSignIn(at: string | null, timeZone: string, now = new Date()): string {
  if (!at) return 'Never';
  const d = new Date(at);
  const p = partsIn(d, timeZone);
  const t = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const today = partsIn(now, timeZone);
  const yesterday = partsIn(new Date(now.getTime() - 86_400_000), timeZone);
  if (sameDay(p, today)) return `Today ${t}`;
  if (sameDay(p, yesterday)) return `Yesterday ${t}`;
  return formatDay(d, timeZone, now);
}

export function atWords(at: string, timeZone: string, time: string, now = new Date()): string {
  const today = sameDay(partsIn(new Date(at), timeZone), partsIn(now, timeZone));
  return `${today ? 'today' : formatDay(at, timeZone, now)} at ${time}`;
}

export const STATE: Record<string, { label: string; tone: 'ok' | 'warn' | 'off' }> = {
  preparing: { label: 'Preparing', tone: 'off' }, open: { label: 'Open', tone: 'ok' }, frozen: { label: 'Frozen', tone: 'warn' },
  closed: { label: 'Closed', tone: 'off' }, archived: { label: 'Archived', tone: 'off' },
};

export function names(xs: string[]): string {
  if (xs.length < 2) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export function detailOf(error: unknown, fallback: string): string {
  const e = error as { detail?: string; title?: string } | undefined;
  return e?.detail ?? e?.title ?? fallback;
}
