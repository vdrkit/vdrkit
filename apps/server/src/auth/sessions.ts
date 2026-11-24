// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { roomSignInSettings, strictestSignInPolicy, withTenant, type Database, type SignInPolicy, type SqlClient } from '@vdrkit/core';
import { HttpProblem } from '../problems.js';
import { linksForLogin, type LinkRow } from './person-link.js';

// auth_* tables: no RLS

export const ROTATE_AFTER_MS = 15 * 60_000;
export const ROTATION_GRACE_MS = 60_000;
// renewed on rotation; idle timeout or SESSION_MAX_DAYS ends a session
export const SESSION_LIFETIME_S = 7 * 24 * 3600;
// from sign-in, however active the session; rotation keeps created_at
export const SESSION_MAX_DAYS = 30;
export const TRUST_DEVICE_MAX_AGE_S = 90 * 24 * 3600;

export type DbRole = 'vdrkit_app' | undefined;

export async function authTx<T>(db: Database, dbRole: DbRole, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (dbRole) await tx.query(`set local role ${dbRole}`);
    return fn(tx);
  });
}

export async function linksForUser(db: Database, dbRole: DbRole, userId: string): Promise<LinkRow[] | null> {
  const user = (await authTx(db, dbRole, (tx) => tx.query<{ email: string; email_verified: boolean }>(
    `select email, email_verified from auth_user where id = $1`, [userId]))).rows[0];
  if (!user) return null;
  return linksForLogin(db, { userId, email: user.email, emailVerified: user.email_verified }, dbRole);
}

// strictest across all tenants
export async function policyForLogin(db: Database, userId: string, dbRole: DbRole, at: Date): Promise<SignInPolicy> {
  const links = await linksForUser(db, dbRole, userId);
  if (!links) return strictestSignInPolicy([]);
  const byTenant = new Map<string, string[]>();
  for (const link of links) {
    const people = byTenant.get(link.tenant_id);
    if (people) people.push(link.person_id);
    else byTenant.set(link.tenant_id, [link.person_id]);
  }
  const rooms = [];
  for (const [tenant, people] of byTenant) {
    rooms.push(...await withTenant(db, tenant, (tx) => roomSignInSettings(tx, people, at), dbRole ? { role: dbRole } : {}));
  }
  return strictestSignInPolicy(rooms);
}

export const signedOutInactive = (minutes: number) => new HttpProblem({
  type: 'https://vdrkit.com/problems/signed-out-inactive', title: 'Signed out after inactivity', status: 401,
  detail: `You were signed out after ${describeMinutes(minutes)} without activity. Sign in again to continue.`,
});

export const sessionExpired = (days: number) => new HttpProblem({
  type: 'https://vdrkit.com/problems/session-expired', title: 'Signed out after the session limit', status: 401,
  detail: `You were signed out because you signed in ${days} days ago. Sign in again to continue.`,
});

export const twoFactorSetupRequired = () => new HttpProblem({
  type: 'https://vdrkit.com/problems/two-factor-setup-required', title: 'Set up two-factor sign-in', status: 403,
  reason: 'two_factor_setup_required',
  detail: 'Your data room asks for a code from an authenticator app when you sign in. Set it up to continue.',
});

export function describeMinutes(m: number): string {
  if (m < 60) return `${m} minutes`;
  const h = m / 60;
  return h === 1 ? '1 hour' : `${h} hours`;
}

interface SessionState {
  id: string;
  user_id: string;
  created_at: Date | string | null;
  last_active_at: Date | string | null;
  token_issued_at: Date | string | null;
  rotated_at: Date | string | null;
  rotated_to: string | null;
}

const ms = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());

export type TouchResult =
  | { status: 'ok'; sessionId: string; newToken?: string }
  | { status: 'idle' }
  | { status: 'expired' }
  | { status: 'gone' };

export type SignOutReason = 'idle' | 'expired';

// may return a different sessionId (grace-period token)
export async function touchSession(
  db: Database, dbRole: DbRole, sessionId: string, idleMinutes: number, now: Date,
  opts: { rotate: boolean; idleLog?: { tenantId: string; write: (tx: SqlClient, reason: SignOutReason) => Promise<unknown> } },
): Promise<TouchResult> {
  // delete and audit event in one transaction
  const run = <T>(fn: (tx: SqlClient) => Promise<T>) => opts.idleLog
    ? withTenant(db, opts.idleLog.tenantId, fn, dbRole ? { role: dbRole } : {})
    : authTx(db, dbRole, fn);
  return run(async (tx): Promise<TouchResult> => {
    const lock = async (id: string) => (await tx.query<SessionState>(
      `select id, user_id, created_at, last_active_at, token_issued_at, rotated_at, rotated_to from auth_session where id = $1 for update`, [id])).rows[0];
    let presented = await lock(sessionId);
    if (!presented) return { status: 'gone' };
    let current = presented;
    if (presented.rotated_at !== null) {
      if (now.getTime() - ms(presented.rotated_at)! > ROTATION_GRACE_MS || !presented.rotated_to) {
        await tx.query(`delete from auth_session where id = $1`, [presented.id]);
        return { status: 'gone' };
      }
      const next = await lock(presented.rotated_to);
      if (!next) return { status: 'gone' };
      current = next;
      presented = next;
    }
    const created = ms(current.created_at) ?? now.getTime();
    if (now.getTime() - created > SESSION_MAX_DAYS * 86_400_000) {
      await tx.query(`delete from auth_session where id = $1 or rotated_to = $1`, [current.id]);
      if (opts.idleLog) await opts.idleLog.write(tx, 'expired');
      return { status: 'expired' };
    }
    const last = ms(current.last_active_at) ?? ms(current.token_issued_at) ?? now.getTime();
    if (now.getTime() - last > idleMinutes * 60_000) {
      await tx.query(`delete from auth_session where id = $1 or rotated_to = $1`, [current.id]);
      if (opts.idleLog) await opts.idleLog.write(tx, 'idle');
      return { status: 'idle' };
    }
    const issued = ms(current.token_issued_at) ?? now.getTime();
    if (opts.rotate && now.getTime() - issued >= ROTATE_AFTER_MS) {
      const token = randomToken();
      const id = randomToken();
      await tx.query(
        `insert into auth_session (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at, last_active_at, token_issued_at)
         select $2, user_id, $3, $4, ip_address, user_agent, created_at, $5, $5, $5 from auth_session where id = $1`,
        [current.id, id, token, new Date(now.getTime() + SESSION_LIFETIME_S * 1000).toISOString(), now.toISOString()]);
      await tx.query(
        `update auth_session set rotated_at = $2, rotated_to = $3, expires_at = $4, updated_at = $2 where id = $1`,
        [current.id, now.toISOString(), id, new Date(now.getTime() + ROTATION_GRACE_MS).toISOString()]);
      await tx.query(`update auth_session set rotated_to = $2 where rotated_to = $1`, [current.id, id]);
      return { status: 'ok', sessionId: id, newToken: token };
    }
    await tx.query(`update auth_session set last_active_at = $2, token_issued_at = coalesce(token_issued_at, $2) where id = $1`,
      [current.id, now.toISOString()]);
    return { status: 'ok', sessionId: current.id };
  });
}

export function randomToken(length = 32): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function signCookieValue(value: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(value).digest('base64');
  return encodeURIComponent(`${value}.${sig}`);
}

export function readSignedCookie(cookieHeader: string | undefined, name: string, secret: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    let raw: string;
    try { raw = decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    const dot = raw.lastIndexOf('.');
    if (dot < 1) return null;
    const value = raw.slice(0, dot);
    const given = Buffer.from(raw.slice(dot + 1));
    const expected = Buffer.from(createHmac('sha256', secret).update(value).digest('base64'));
    return given.length === expected.length && timingSafeEqual(given, expected) ? value : null;
  }
  return null;
}

export interface CookieAttributes { maxAge?: number; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; domain?: string }

export function serializeCookie(name: string, value: string, a: CookieAttributes): string {
  let c = `${name}=${value}`;
  if (typeof a.maxAge === 'number') c += `; Max-Age=${Math.floor(a.maxAge)}`;
  if (a.domain) c += `; Domain=${a.domain}`;
  c += `; Path=${a.path ?? '/'}`;
  if (a.httpOnly) c += '; HttpOnly';
  if (a.secure) c += '; Secure';
  if (a.sameSite) c += `; SameSite=${a.sameSite.charAt(0).toUpperCase()}${a.sameSite.slice(1)}`;
  return c;
}

export function trustIdentifierOf(cookieValue: string | null): string | null {
  const id = cookieValue?.split('!')[1];
  return id && /^trust-device-[A-Za-z0-9_-]+$/.test(id) ? id : null;
}


const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(data: Buffer): string {
  let bits = '';
  for (const b of data) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

// raw UTF-8 key, not base32
export function totpCode(secret: string, at: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret: string, code: string, at: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let ok = false;
  for (const step of [-1, 0, 1]) {
    const expected = Buffer.from(totpCode(secret, at + step * 30_000));
    if (timingSafeEqual(expected, Buffer.from(code))) ok = true;
  }
  return ok;
}

export function totpUri(secret: string, account: string, issuer = 'VDRkit'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32(Buffer.from(secret, 'utf8'))}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

const BROWSERS: [RegExp, string][] = [[/Edg\//, 'Edge'], [/Firefox\//, 'Firefox'], [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari']];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'Mac'], [/Linux/, 'Linux'],
];

const firstMatch = (ua: string, list: [RegExp, string][]) => list.find(([re]) => re.test(ua))?.[1] ?? null;

export function browserLabel(userAgent: string | null): string {
  const ua = userAgent ?? '';
  const browser = firstMatch(ua, BROWSERS);
  const os = firstMatch(ua, SYSTEMS);
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `A browser on ${os}` : 'Unknown browser');
}
