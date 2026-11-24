// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from 'node:net';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { APIError, betterAuth, type BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { expireCookie } from 'better-auth/cookies';
import { emailOTP, magicLink, twoFactor } from 'better-auth/plugins';
import { appendEvent, withTenant, type Channel, type Database } from '@vdrkit/core';
import type { Authenticator, Caller } from '../auth.js';
import { mailBranding } from '../mail/branding.js';
import type { MailBranding } from '../mail/layout.js';
import { signInEmail, toMessage } from '../mail/templates.js';
import type { Storage } from '../pipeline/pipeline.js';
import { DEFAULT_LIMITS, memoryCountStore, normalisedPath, SIGN_IN_ADDRESS_LIMIT, signInAddressKey, type CountStore } from '../rate-limit.js';
import { channelProbe, MailHealth } from './mail-health.js';
import { callerForLogin, linksForEmail } from './person-link.js';
import { siteTenantId } from '../site/mail.js';
import type { AuthPool } from './pool.js';
import {
  authTx, browserLabel, linksForUser, policyForLogin, readSignedCookie, serializeCookie, sessionExpired, signCookieValue, signedOutInactive, touchSession,
  trustIdentifierOf, twoFactorSetupRequired, SESSION_LIFETIME_S, SESSION_MAX_DAYS, TRUST_DEVICE_MAX_AGE_S, type CookieAttributes, type DbRole, type SignOutReason,
} from './sessions.js';

export interface BetterAuthConfig {
  db: Database;
  pool: AuthPool;
  secret: string;
  publicUrl: string;
  mailer?: Channel;
  mailHealth?: MailHealth;
  storage?: Storage;
  dbRole?: 'vdrkit_app';
  trustedOrigins?: string[];
  now?: () => Date;
  /** false: no Better Auth limits and no per-address limit */
  builtInRateLimit?: boolean;
  rateLimitStorage?: CountStore;
}

export const AUTH_BASE_PATH = '/v1/auth';

interface SignInContext { headers?: Headers | undefined; request?: Request | undefined }
interface SignInRequest { hint: string | null; userAgent: string | null; ip: string | null; at: Date }

function tenantHintOf(ctx?: SignInContext): string | null {
  const value = ctx?.headers?.get('x-vdrkit-tenant') ?? ctx?.request?.headers.get('x-vdrkit-tenant') ?? null;
  if (!value) return null;
  const hint = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hint) ? hint.toLowerCase() : null;
}

// set from request.ip; a client copy would spoof audit and rate-limit IPs
export const CLIENT_IP_HEADER = 'x-vdrkit-client-ip';

function ipFrom(headers: Headers | undefined | null): string | null {
  const ip = headers?.get(CLIENT_IP_HEADER)?.trim();
  return ip && isIP(ip) ? ip : null;
}

const userAgentFrom = (headers: Headers | undefined) => headers?.get('user-agent')?.slice(0, 500) ?? null;
const clientIpOf = (ctx?: SignInContext) => ipFrom(ctx?.headers) ?? ipFrom(ctx?.request?.headers);
const userAgentOf = (ctx?: SignInContext) => ctx?.headers?.get('user-agent') ?? ctx?.request?.headers.get('user-agent') ?? null;

// the 2FA plugin only hooks password sign-in
const PASSWORDLESS_SIGN_IN = new Set(['/sign-in/email-otp', '/magic-link/verify']);
const isPasswordless = (ctx: { path?: string }) => PASSWORDLESS_SIGN_IN.has(ctx.path ?? '');

const SENDS_SIGN_IN_EMAIL = new Set(['/sign-in/magic-link', '/email-otp/send-verification-otp']);
export const EMAIL_NOT_SENT = 'EMAIL_NOT_SENT';
export const EMAIL_NOT_SENT_MESSAGE = 'We could not send the email right now. Try again in a few minutes.';

export const SIGN_IN_EMAIL_MINUTES = 15;
export const SIGN_IN_ADDRESS_LIMITED = 'SIGN_IN_ADDRESS_LIMITED';

// disable, get-totp-uri: would skip the current-device check
export const DISABLED_AUTH_PATHS = [
  '/two-factor/disable', '/two-factor/get-totp-uri',
  '/two-factor/verify-backup-code', '/two-factor/generate-backup-codes', '/two-factor/view-backup-codes',
  '/two-factor/send-otp', '/two-factor/verify-otp',
  // no passwords: these would mail codes past the per-address limit, or set a password
  '/email-otp/request-password-reset', '/forget-password/email-otp', '/email-otp/reset-password',
  // address changes go through our own flow
  '/email-otp/request-email-change', '/email-otp/change-email',
];

// anything not listed answers 404, including routes a library upgrade adds
export const ALLOWED_AUTH_PATHS = new Set([
  '/sign-in/magic-link', '/magic-link/verify', '/email-otp/send-verification-otp', '/sign-in/email-otp',
  '/two-factor/enable', '/two-factor/verify-totp', '/get-session', '/sign-out', '/ok', '/error',
].map((p) => `${AUTH_BASE_PATH}${p}`));

const NO_IDLE_CHECK = new Set(['/sign-out', '/ok', '/error']);

// Better Auth's per-IP limits are too tight for an office signing in at once
const SIGN_IN_RULE = { window: DEFAULT_LIMITS.signIn.windowMs / 1000, max: DEFAULT_LIMITS.signIn.max };
const SIGN_IN_RULES = Object.fromEntries(['/sign-in/*', '/magic-link/*', '/email-otp/*', '/two-factor/*'].map((p) => [p, SIGN_IN_RULE]));

const snake = <K extends string>(...keys: K[]) =>
  Object.fromEntries(keys.map((k) => [k, k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)])) as Record<K, string>;

export interface AuthSettings {
  secret: string;
  sessionCookie: { name: string; attributes: CookieAttributes };
  trustCookieName: string;
  twoFactorCookieName: string;
  secretConfig: unknown;
  db: Database;
  dbRole: DbRole;
  now: () => Date;
  mailHealth: MailHealth;
  /** sign-in emails still being sent; with a timeout, waits at most that long */
  signInMailSettled(timeoutMs?: number): Promise<void>;
}

export interface VdrAuth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(ctx: { headers: Headers }): Promise<{
      user: { id: string; email: string; emailVerified: boolean };
      session: { id: string; token: string };
    } | null>;
  };
  /** await authReady() before reading */
  vdrkit: AuthSettings;
}

// same-site paths only (open redirect)
export function signInLinkFor(publicUrl: string, verifyUrl: string, token: string): string {
  const link = new URL('/sign-in/link', publicUrl);
  link.searchParams.set('token', token);
  let next: string | null = null;
  try { next = new URL(verifyUrl).searchParams.get('callbackURL'); } catch { next = null; }
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && next !== '/') link.searchParams.set('next', next);
  return link.toString();
}

export function createBetterAuth(cfg: BetterAuthConfig): VdrAuth {
  const now = () => (cfg.now ? cfg.now() : new Date());
  const dbRole = cfg.dbRole;
  const mailHealth = cfg.mailHealth ?? new MailHealth(channelProbe(cfg.mailer));

  // silent for unknown addresses; log to one tenant at most
  async function sendSignInEmail(kind: 'magic_link' | 'email_code', email: string, parts: { code: string | null; link: string | null }, req: SignInRequest) {
    const links = await linksForEmail(cfg.db, email, cfg.dbRole);
    if (links.length === 0) return;
    const { hint } = req;
    const hinted = hint ? links.find((l) => l.tenant_id === hint) : undefined;
    const own = hinted ?? links[0]!;
    const { brand, timeZone } = await withTenant(cfg.db, own.tenant_id, async (tx) => {
      const tz = (await tx.query<{ tz: string }>(`select time_zone as tz from person where id = $1`, [own.person_id])).rows[0]?.tz ?? 'UTC';
      let brand: MailBranding;
      try {
        brand = await mailBranding(tx, cfg.storage, cfg.publicUrl);
      } catch {
        brand = { orgName: null, logo: null, privacyUrl: null };
      }
      return { timeZone: tz, brand };
    }, cfg.dbRole ? { role: cfg.dbRole } : {});
    const label = req.userAgent ? browserLabel(req.userAgent) : null;
    const mail = signInEmail({ brand, ...parts, minutes: SIGN_IN_EMAIL_MINUTES, requestedAt: req.at, timeZone,
      browser: label && label !== 'Unknown browser' ? label : null, ip: req.ip });
    let result: { status: string; providerMessageId?: string; error?: string };
    if (!cfg.mailer) result = { status: 'no_mailer', error: 'No mail server is configured' };
    else {
      try {
        result = await cfg.mailer.send(toMessage(mail, own.person_id, email));
      } catch (err) {
        result = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    }
    let logIn: typeof links = [];
    if (hint) logIn = links.filter((l) => l.tenant_id === hint).slice(0, 1);
    else if (new Set(links.map((l) => l.tenant_id)).size === 1) logIn = links.slice(0, 1);
    for (const l of logIn) {
      await withTenant(cfg.db, l.tenant_id, (tx) => appendEvent(tx, {
        action: result.status === 'accepted' ? `auth.${kind}.sent` : `auth.${kind}.not_sent`,
        resourceType: 'person', resourceId: l.person_id,
        data: { recipient_person_id: l.person_id, channel: 'email', delivery_status: result.status, provider_message_id: result.providerMessageId ?? null,
          ...(result.status === 'accepted' ? {} : { error: result.error ?? null }) },
        occurredAt: now(),
      }), cfg.dbRole ? { role: cfg.dbRole } : {});
    }
  }

  // after the response, for every address: awaiting would leak known addresses by timing
  const sending = new Set<Promise<void>>();
  function queueSignInEmail(kind: 'magic_link' | 'email_code', email: string, parts: { code: string | null; link: string | null }, ctx?: SignInContext) {
    const req: SignInRequest = { hint: tenantHintOf(ctx), userAgent: userAgentOf(ctx), ip: clientIpOf(ctx), at: now() };
    const job: Promise<void> = sendSignInEmail(kind, email, parts, req)
      .catch((err: unknown) => { console.error('Sign-in email: could not send or record it.', err); })
      .finally(() => { sending.delete(job); });
    sending.add(job);
  }
  async function signInMailSettled(timeoutMs?: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = (async () => { while (sending.size) await Promise.all([...sending]); })();
    if (timeoutMs === undefined) return waited;
    await Promise.race([waited, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  // email-otp codes caught for the magic-link email, by address
  const codeFor = new Map<string, string | null>();

  const twoFactorPlugin = twoFactor({
    issuer: 'VDRkit',
    allowPasswordless: true,
    trustDeviceMaxAge: TRUST_DEVICE_MAX_AGE_S,
    schema: {
      user: { fields: snake('twoFactorEnabled') },
      twoFactor: { modelName: 'auth_two_factor', fields: snake('userId', 'backupCodes', 'failedVerificationCount', 'lockedUntil') },
    },
  });
  twoFactorPlugin.hooks.after = twoFactorPlugin.hooks.after.map((h) => ({
    ...h,
    matcher: (ctx: Parameters<typeof h.matcher>[0]) => h.matcher(ctx) || isPasswordless(ctx),
  }));

  const auth = betterAuth({
    appName: 'VDRkit',
    baseURL: cfg.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: cfg.secret,
    database: cfg.pool as never,
    trustedOrigins: [cfg.publicUrl, ...(cfg.trustedOrigins ?? [])],
    emailAndPassword: { enabled: false },
    disabledPaths: DISABLED_AUTH_PATHS,
    rateLimit: { enabled: cfg.builtInRateLimit ?? true, customRules: SIGN_IN_RULES, ...(cfg.rateLimitStorage ? { customStorage: cfg.rateLimitStorage } : {}) },
    telemetry: { enabled: false },
    advanced: { cookiePrefix: 'vdrkit', ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    user: { modelName: 'auth_user', fields: snake('emailVerified', 'createdAt', 'updatedAt') },
    session: {
      modelName: 'auth_session', fields: snake('userId', 'expiresAt', 'ipAddress', 'userAgent', 'createdAt', 'updatedAt'),
      // rotation, idle sign-out and max age are ours
      expiresIn: SESSION_LIFETIME_S, disableSessionRefresh: true,
    },
    account: {
      modelName: 'auth_account',
      fields: snake('userId', 'accountId', 'providerId', 'accessToken', 'refreshToken', 'idToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'createdAt', 'updatedAt'),
    },
    verification: { modelName: 'auth_verification', fields: snake('expiresAt', 'createdAt', 'updatedAt') },
    databaseHooks: {
      session: {
        create: {
          after: async (session: { id: string }) => {
            await authTx(cfg.db, dbRole, (tx) => tx.query(
              `update auth_session set last_active_at = $2, token_issued_at = $2 where id = $1`, [session.id, now().toISOString()]));
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: SIGN_IN_EMAIL_MINUTES * 60,
        sendMagicLink: async ({ email, url, token }, ctx) => {
          const key = email.trim().toLowerCase();
          let code: string | null = null;
          codeFor.set(key, null);
          try {
            await (auth.api as unknown as { sendVerificationOTP(a: { body: { email: string; type: 'sign-in' } }): Promise<unknown> })
              .sendVerificationOTP({ body: { email, type: 'sign-in' } });
            code = codeFor.get(key) ?? null;
          } catch {
            code = null;
          } finally {
            codeFor.delete(key);
          }
          await authTx(cfg.db, dbRole, (tx) => tx.query(
            `delete from auth_verification where identifier like 'magic-link:%' and identifier <> $2
                and (case when identifier like 'magic-link:%' then (value::jsonb ->> 'email') end) = $1`,
            [email, `magic-link:${token}`]));
          const link = signInLinkFor(cfg.publicUrl, url, token);
          queueSignInEmail('magic_link', email, { code, link }, ctx);
        },
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: SIGN_IN_EMAIL_MINUTES * 60,
        allowedAttempts: 3,
        sendVerificationOTP: async ({ email, otp }, ctx) => {
          const key = email.trim().toLowerCase();
          if (codeFor.has(key)) { codeFor.set(key, otp); return; }
          queueSignInEmail('email_code', email, { code: otp, link: null }, ctx);
        },
      }),
      twoFactorPlugin,
      // must stay after twoFactorPlugin: reads the trust cookie it sets
      vdrkitSignIn({ db: cfg.db, dbRole, now, mailHealth,
        addressLimit: cfg.builtInRateLimit === false ? null : cfg.rateLimitStorage ?? memoryCountStore() }),
    ],
  });

  const out = auth as unknown as VdrAuth & { vdrkitReady: Promise<void> };
  out.vdrkit = { secret: cfg.secret, sessionCookie: { name: '', attributes: {} }, trustCookieName: '', twoFactorCookieName: '', secretConfig: cfg.secret, db: cfg.db, dbRole, now, mailHealth, signInMailSettled };
  out.vdrkitReady = auth.$context.then((c) => {
    Object.assign(out.vdrkit, {
      sessionCookie: { name: c.authCookies.sessionToken.name, attributes: c.authCookies.sessionToken.attributes as CookieAttributes },
      trustCookieName: c.createAuthCookie('trust_device').name,
      twoFactorCookieName: c.createAuthCookie('two_factor').name,
      secretConfig: c.secretConfig,
    });
  });
  return out;
}

export async function authReady(auth: VdrAuth): Promise<void> {
  await (auth as VdrAuth & { vdrkitReady?: Promise<void> }).vdrkitReady;
}

function setTrustIdentifier(headers: Headers | undefined | null, cookieName: string): string | null {
  for (const c of headers?.getSetCookie?.() ?? []) {
    if (!c.startsWith(`${cookieName}=`)) continue;
    const raw = c.slice(cookieName.length + 1).split(';')[0]!;
    if (!raw) return null;
    let v: string;
    try { v = decodeURIComponent(raw); } catch { return null; }
    return trustIdentifierOf(v.slice(0, v.lastIndexOf('.')));
  }
  return null;
}

function signOutEvent(reason: SignOutReason, personId: string, idleMinutes: number) {
  return reason === 'expired'
    ? { action: 'auth.signed_out_expired', data: { person_id: personId, max_days: SESSION_MAX_DAYS } }
    : { action: 'auth.signed_out_inactive', data: { person_id: personId, idle_minutes: idleMinutes } };
}

// several tenants and no hint: log nowhere
async function idleLogTenant(db: Database, dbRole: DbRole, userId: string, headers?: Headers): Promise<{ tenant_id: string; person_id: string } | null> {
  const links = await linksForUser(db, dbRole, userId);
  if (!links) return null;
  const hint = tenantHintOf({ headers });
  if (hint) return links.find((l) => l.tenant_id === hint) ?? null;
  return new Set(links.map((l) => l.tenant_id)).size === 1 ? links[0]! : null;
}

type SignInMethod = 'email_link' | 'email_code' | 'authenticator';

export type SignInFailure = 'wrong_code' | 'expired_code' | 'too_many_attempts' | 'link_used_or_expired' | 'wrong_authenticator_code' | 'authenticator_locked';

async function logSignedIn(db: Database, dbRole: DbRole, userId: string, method: SignInMethod, headers: Headers | undefined, now: Date): Promise<void> {
  for (const at of await signInLogTenants(db, dbRole, userId, headers)) {
    await logSignedInAt(db, dbRole, at, method, headers, now).catch(() => undefined);
  }
}

async function signInLogTenants(db: Database, dbRole: DbRole, userId: string, headers?: Headers): Promise<{ tenant_id: string; person_id: string }[]> {
  const links = await linksForUser(db, dbRole, userId);
  if (!links) return [];
  const hint = tenantHintOf({ headers });
  const seen = new Set<string>();
  const out = [];
  for (const link of links) {
    if (hint && link.tenant_id !== hint) continue;
    if (seen.has(link.tenant_id)) continue;
    seen.add(link.tenant_id);
    out.push(link);
  }
  return out;
}

async function logSignedInAt(db: Database, dbRole: DbRole, at: { tenant_id: string; person_id: string }, method: SignInMethod, headers: Headers | undefined, now: Date): Promise<void> {
  // ip and browser in context, outside the hash chain: erasable
  const context = { ip: ipFrom(headers), userAgent: userAgentFrom(headers), subjectPersonId: at.person_id };
  await withTenant(db, at.tenant_id, async (tx) => {
    const rooms = (await tx.query<{ workspace_id: string }>(
      `select distinct g.workspace_id from membership m join groups g on g.id = m.group_id
        where m.person_id = $1 and m.status = 'active' and m.valid_from <= $2 and $2 < m.valid_to and m.superseded_at = 'infinity'
          and g.valid_from <= $2 and $2 < g.valid_to`, [at.person_id, now.toISOString()])).rows;
    const data = { person_id: at.person_id, method };
    await appendEvent(tx, { action: 'auth.signed_in', resourceType: 'person', resourceId: at.person_id, data, occurredAt: now, context });
    for (const r of rooms) {
      await appendEvent(tx, { action: 'auth.signed_in', workspaceId: r.workspace_id, resourceType: 'person', resourceId: at.person_id, data, occurredAt: now, context });
    }
  }, dbRole ? { role: dbRole } : {});
}

async function logSignInFailed(db: Database, dbRole: DbRole, f: { reason: SignInFailure; method: SignInMethod; email: string | null; headers: Headers | undefined; now: Date }): Promise<void> {
  try {
    const email = f.email?.trim().toLowerCase().slice(0, 254) || null;
    // don't look up the address here (enumeration)
    const tenant = tenantHintOf({ headers: f.headers }) ?? await siteTenantId(db, dbRole ?? undefined);
    if (!tenant) return;
    await withTenant(db, tenant, (tx) => appendEvent(tx, {
      action: 'auth.sign_in_failed', resourceType: 'sign_in', data: { reason: f.reason, method: f.method }, occurredAt: f.now,
      context: { ip: ipFrom(f.headers), userAgent: userAgentFrom(f.headers), personal: email ? { email } : null },
    }), dbRole ? { role: dbRole } : {});
  } catch {
    // best effort
  }
}

function failureOf(returned: unknown): { statusCode: number; code: string | null; location: string | null } | null {
  if (!returned || typeof returned !== 'object' || !(returned instanceof Error)) return null;
  const r = returned as Error & { statusCode?: number; body?: { code?: string }; headers?: Headers | Record<string, string> };
  const headers = r.headers;
  const location = headers instanceof Headers ? headers.get('location') : (headers?.location ?? headers?.Location ?? null);
  return { statusCode: Number(r.statusCode ?? 500), code: r.body?.code ?? null, location: location ?? null };
}

function vdrkitSignIn(opts: { db: Database; dbRole: DbRole; now: () => Date; mailHealth: MailHealth; addressLimit: CountStore | null }): BetterAuthPlugin {
  const tx = <T>(fn: (t: import('@vdrkit/core').SqlClient) => Promise<T>) => authTx(opts.db, opts.dbRole, fn);
  type Ctx = {
    path?: string;
    headers?: Headers;
    request?: Request;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    getSignedCookie(name: string, secret: string): Promise<string | null | false>;
    context: {
      secret: string;
      responseHeaders?: Headers;
      authCookies: { sessionToken: { name: string } };
      createAuthCookie(name: string): { name: string; attributes: Record<string, unknown> };
    };
  };
  const mw = (fn: (ctx: Ctx) => Promise<void>) => createAuthMiddleware(fn as never);
  const trustName = (ctx: Ctx) => ctx.context.createAuthCookie('trust_device').name;
  const requestTrust = async (ctx: Ctx) => trustIdentifierOf((await ctx.getSignedCookie(trustName(ctx), ctx.context.secret)) || null);
  const expireTrust = (ctx: Ctx) => expireCookie(ctx as never, ctx.context.createAuthCookie('trust_device') as never);

  // link and code are single-use together
  const presented = new Map<string, string>();
  const otpIdentifier = (email: string) => `sign-in-otp-${email.toLowerCase()}`;
  const presentedKey = (ctx: Ctx): { key: string; identifier: string } | null => {
    if (ctx.path === '/magic-link/verify' && typeof ctx.query?.token === 'string') {
      return { key: `link:${ctx.query.token}`, identifier: `magic-link:${ctx.query.token}` };
    }
    if (ctx.path === '/sign-in/email-otp' && typeof ctx.body?.email === 'string') {
      return { key: `code:${ctx.body.email.toLowerCase()}`, identifier: otpIdentifier(ctx.body.email) };
    }
    return null;
  };

  return {
    id: 'vdrkit-sign-in',
    hooks: {
      before: [
        {
          // before any address lookup: same answer for every address
          matcher: (ctx: { path?: string }) => SENDS_SIGN_IN_EMAIL.has(ctx.path ?? ''),
          handler: mw(async (ctx) => {
            if (!opts.mailHealth.ok()) throw new APIError('SERVICE_UNAVAILABLE', { code: EMAIL_NOT_SENT, message: EMAIL_NOT_SENT_MESSAGE });
            const email = ctx.body?.email;
            // HTTP only: the magic-link sender asks for its code through the API as well
            if (!opts.addressLimit || ctx.request === undefined || typeof email !== 'string') return;
            const { allowed, retryAfter } = await opts.addressLimit.consume(signInAddressKey(email),
              { window: SIGN_IN_ADDRESS_LIMIT.windowMs / 1000, max: SIGN_IN_ADDRESS_LIMIT.max });
            if (!allowed) {
              const seconds = retryAfter ?? 60;
              const minutes = Math.ceil(seconds / 60);
              throw new APIError('TOO_MANY_REQUESTS', { code: SIGN_IN_ADDRESS_LIMITED,
                message: `Too many sign-in emails were asked for this address. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
              { 'retry-after': String(seconds) });
            }
          }),
        },
        {
          matcher: isPasswordless,
          handler: mw(async (ctx) => {
            const entry = presentedKey(ctx);
            if (!entry) return;
            const row = (await tx((t) => t.query<{ value: string }>(`select value from auth_verification where identifier = $1`, [entry.identifier]))).rows[0];
            if (!row) return;
            let email: string | null = null;
            if (entry.key.startsWith('code:')) {
              email = entry.key.slice('code:'.length);
            } else {
              try {
                const value = JSON.parse(row.value) as { email?: unknown };
                email = String(value.email ?? '') || null;
              } catch {
                email = null;
              }
            }
            if (email) presented.set(entry.key, email.toLowerCase());
          }),
        },
        {
          // HTTP only; BetterAuthAuthenticator checks idle itself
          matcher: (ctx: { path?: string; request?: unknown }) =>
            ctx.request !== undefined && !NO_IDLE_CHECK.has(ctx.path ?? '') && !isPasswordless(ctx),
          handler: mw(async (ctx) => {
            const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
            if (!token) return;
            const session = (await tx((t) => t.query<{ id: string; user_id: string }>(`select id, user_id from auth_session where token = $1`, [token]))).rows[0];
            if (!session) return;
            const now = opts.now();
            const policy = await policyForLogin(opts.db, session.user_id, opts.dbRole, now);
            const at = await idleLogTenant(opts.db, opts.dbRole, session.user_id, ctx.headers);
            const touch: Parameters<typeof touchSession>[5] = { rotate: false };
            if (at) {
              touch.idleLog = { tenantId: at.tenant_id, write: (t, reason) => appendEvent(t, {
                ...signOutEvent(reason, at.person_id, policy.idleSignOutMinutes), resourceType: 'person', resourceId: at.person_id, actorId: null, occurredAt: now,
              }) };
            }
            await touchSession(opts.db, opts.dbRole, session.id, policy.idleSignOutMinutes, now, touch);
          }),
        },
        {
          matcher: isPasswordless,
          handler: mw(async (ctx) => {
            const identifier = await requestTrust(ctx);
            if (!identifier) return;
            const now = opts.now();
            const row = (await tx((t) => t.query<{ user_id: string; created_at: string; trusted_until: string }>(
              `select b.user_id, b.created_at, b.trusted_until from auth_trusted_browser b
                 join auth_verification v on v.identifier = b.trust_identifier and v.value = b.user_id
                where b.trust_identifier = $1`, [identifier]))).rows[0];
            let keep = false;
            if (row) {
              const policy = await policyForLogin(opts.db, row.user_id, opts.dbRole, now);
              const maxEnd = new Date(row.created_at).getTime() + policy.trustedBrowserDays * 86_400_000;
              const end = Math.min(new Date(row.trusted_until).getTime(), maxEnd);
              keep = policy.allowTrustedBrowser && now.getTime() < end;
            }
            if (!keep) {
              await tx(async (t) => {
                await t.query(`delete from auth_verification where identifier = $1`, [identifier]);
                await t.query(`delete from auth_trusted_browser where trust_identifier = $1`, [identifier]);
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx: { path?: string }) => isPasswordless(ctx) || ctx.path === '/two-factor/verify-totp',
          handler: mw(async (ctx) => {
            const now = opts.now();
            const c = ctx.context as Ctx['context'] & { newSession?: { user?: { id?: string } } | null; returned?: unknown };
            let method: SignInMethod = 'authenticator';
            if (ctx.path === '/magic-link/verify') method = 'email_link';
            else if (ctx.path === '/sign-in/email-otp') method = 'email_code';
            let userId: string | null = null;
            if (method === 'authenticator') {
              // also hit during set-up; skip that
              const challenge = await ctx.getSignedCookie(ctx.context.createAuthCookie('two_factor').name, ctx.context.secret);
              if (!challenge) return;
              userId = (await tx((t) => t.query<{ value: string }>(`select value from auth_verification where identifier = $1`, [challenge]))).rows[0]?.value
                ?? c.newSession?.user?.id ?? null;
            }
            if (c.newSession?.user?.id) {
              await logSignedIn(opts.db, opts.dbRole, c.newSession.user.id, method, ctx.headers, now).catch(() => undefined);
              return;
            }
            const failed = failureOf(c.returned);
            if (!failed) return;
            let reason: SignInFailure | null = null;
            let email: string | null = null;
            if (method === 'email_link') {
              if (!failed.location || !/[?&]error=/.test(failed.location)) return;
              reason = 'link_used_or_expired';
              const entry = presentedKey(ctx);
              email = entry ? presented.get(entry.key) ?? null : null;
            } else if (method === 'email_code') {
              if (failed.statusCode < 400) return;
              if (failed.code === 'OTP_EXPIRED') reason = 'expired_code';
              else if (failed.code === 'TOO_MANY_ATTEMPTS') reason = 'too_many_attempts';
              else reason = 'wrong_code';
              email = typeof ctx.body?.email === 'string' ? ctx.body.email : null;
            } else {
              if (failed.statusCode < 400) return;
              if (failed.statusCode === 429 || failed.code === 'ACCOUNT_TEMPORARILY_LOCKED') reason = 'authenticator_locked';
              else if (failed.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') reason = 'too_many_attempts';
              else reason = 'wrong_authenticator_code';
              if (userId) email = (await tx((t) => t.query<{ email: string }>(`select email from auth_user where id = $1`, [userId]))).rows[0]?.email ?? null;
            }
            await logSignInFailed(opts.db, opts.dbRole, { reason, method, email, headers: ctx.headers, now });
          }),
        },
        {
          matcher: isPasswordless,
          handler: mw(async (ctx) => {
            const entry = presentedKey(ctx);
            if (!entry) return;
            const email = presented.get(entry.key);
            if (!email) return;
            presented.delete(entry.key);
            await tx(async (t) => {
              const still = (await t.query(`select 1 from auth_verification where identifier = $1`, [entry.identifier])).rows.length > 0;
              if (still) return;
              if (entry.key.startsWith('link:')) {
                await t.query(`delete from auth_verification where identifier = $1`, [otpIdentifier(email)]);
              } else {
                await t.query(
                  `delete from auth_verification where identifier like 'magic-link:%'
                      and lower(case when identifier like 'magic-link:%' then (value::jsonb ->> 'email') end) = $1`, [email]);
              }
            });
          }),
        },
        {
          // drop backup codes
          matcher: (ctx: { path?: string }) => ctx.path === '/two-factor/enable',
          handler: createAuthMiddleware((async (ctx: Ctx & { json(v: unknown): unknown }) => {
            const r = (ctx.context as { returned?: unknown }).returned;
            if (r && typeof r === 'object' && 'totpURI' in r) {
              const { method, totpURI } = r as { method?: string; totpURI: string };
              return ctx.json({ method, totpURI });
            }
            return undefined;
          }) as never),
        },
        {
          // trust record is reissued per use; keep the original end
          matcher: isPasswordless,
          handler: mw(async (ctx) => {
            const old = await requestTrust(ctx);
            const fresh = setTrustIdentifier(ctx.context.responseHeaders, trustName(ctx));
            if (!old || !fresh || old === fresh) return;
            const now = opts.now();
            const moved = await tx(async (t) => {
              const r = await t.query<{ trusted_until: string }>(
                `update auth_trusted_browser set trust_identifier = $2, last_used_at = $3 where trust_identifier = $1 returning trusted_until`,
                [old, fresh, now.toISOString()]);
              const until = r.rows[0]?.trusted_until;
              if (until) await t.query(`update auth_verification set expires_at = $2 where identifier = $1`, [fresh, new Date(until).toISOString()]);
              else await t.query(`delete from auth_verification where identifier = $1`, [fresh]);
              return !!until;
            });
            if (!moved) expireTrust(ctx);
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === '/two-factor/verify-totp',
          handler: mw(async (ctx) => {
            const identifier = setTrustIdentifier(ctx.context.responseHeaders, trustName(ctx));
            if (!identifier) return;
            const now = opts.now();
            const userId = (await tx((t) => t.query<{ value: string }>(`select value from auth_verification where identifier = $1`, [identifier]))).rows[0]?.value;
            const policy = userId ? await policyForLogin(opts.db, userId, opts.dbRole, now) : null;
            if (!userId || !policy?.allowTrustedBrowser) {
              await tx((t) => t.query(`delete from auth_verification where identifier = $1`, [identifier]));
              expireTrust(ctx);
              return;
            }
            const until = new Date(now.getTime() + policy.trustedBrowserDays * 86_400_000);
            await tx(async (t) => {
              await t.query(`update auth_verification set expires_at = $2 where identifier = $1`, [identifier, until.toISOString()]);
              await t.query(
                `insert into auth_trusted_browser (user_id, trust_identifier, user_agent, created_at, trusted_until, last_used_at)
                 values ($1, $2, $3, $4, $5, $4)`,
                [userId, identifier, userAgentFrom(ctx.headers), now.toISOString(), until.toISOString()]);
            });
          }),
        },
      ],
    },
  } as unknown as BetterAuthPlugin;
}

function toHeaders(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.toLowerCase() === CLIENT_IP_HEADER) continue;
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else h.set(k, String(v));
  }
  return h;
}

const BEFORE_TWO_FACTOR_SETUP = new Set(['GET /v1/me/sign-in-policy']);

const personIdOf = (c: Caller) => (c.principal.kind === 'person' ? c.principal.personId : c.principal.onBehalfOfPersonId);

export class BetterAuthAuthenticator implements Authenticator {
  constructor(private readonly auth: VdrAuth, private readonly db: Database, private readonly dbRole?: 'vdrkit_app') {}

  async authenticate(req: FastifyRequest, reply?: FastifyReply): Promise<Caller | null> {
    await authReady(this.auth);
    const found = await this.auth.api.getSession({ headers: toHeaders(req) });
    if (!found) return null;
    const { user, session } = found;
    const hint = req.headers['x-vdrkit-tenant'];
    const caller = await callerForLogin(this.db, { userId: user.id, email: user.email, emailVerified: user.emailVerified },
      { tenantId: typeof hint === 'string' ? hint : undefined, dbRole: this.dbRole });
    if (!caller) return null;
    const cfg = this.auth.vdrkit;
    const now = cfg.now();
    const policy = await policyForLogin(this.db, user.id, this.dbRole, now);
    const touched = await touchSession(this.db, this.dbRole, session.id, policy.idleSignOutMinutes, now, {
      // SSR can't set cookies
      rotate: req.headers['x-vdrkit-render'] !== 'server',
      idleLog: { tenantId: caller.tenantId, write: (tx, reason) => appendEvent(tx, {
        ...signOutEvent(reason, personIdOf(caller), policy.idleSignOutMinutes), resourceType: 'person', resourceId: personIdOf(caller), actorId: caller.actorId,
        occurredAt: now, requestId: req.id,
      }) },
    });
    if (touched.status === 'gone') return null;
    if (touched.status === 'idle' || touched.status === 'expired') {
      reply?.header('set-cookie', serializeCookie(cfg.sessionCookie.name, '', { ...cfg.sessionCookie.attributes, maxAge: 0 }));
      throw touched.status === 'idle' ? signedOutInactive(policy.idleSignOutMinutes) : sessionExpired(SESSION_MAX_DAYS);
    }
    if (touched.newToken && reply) {
      reply.header('set-cookie', serializeCookie(cfg.sessionCookie.name, signCookieValue(touched.newToken, cfg.secret),
        { ...cfg.sessionCookie.attributes, maxAge: SESSION_LIFETIME_S }));
    }
    if (policy.requireTwoFactor) {
      const enabled = (await authTx(this.db, this.dbRole, (tx) => tx.query<{ on: boolean }>(
        `select two_factor_enabled as on from auth_user where id = $1`, [user.id]))).rows[0]?.on;
      if (!enabled && !BEFORE_TWO_FACTOR_SETUP.has(`${req.method} ${normalisedPath(req.url) ?? ''}`)) throw twoFactorSetupRequired();
    }
    return { ...caller, login: { userId: user.id, sessionId: touched.sessionId, policy } };
  }
}

export function requestTrustIdentifier(auth: VdrAuth, req: FastifyRequest): string | null {
  return trustIdentifierOf(readSignedCookie(req.headers.cookie, auth.vdrkit.trustCookieName, auth.vdrkit.secret));
}

// docker stop allows 10 s before it kills the process
const SHUTDOWN_MAIL_WAIT_MS = 5_000;

export function betterAuthRoutes(auth: VdrAuth, publicUrl: string): FastifyPluginAsync {
  const origin = new URL(publicUrl).origin;
  return async (app) => {
    app.addHook('onClose', async () => { await auth.vdrkit.signInMailSettled(SHUTDOWN_MAIL_WAIT_MS); });
    app.route({
      method: ['GET', 'POST'],
      url: `${AUTH_BASE_PATH}/*`,
      schema: { hide: true },
      handler: async (req, reply) => {
        const headers = toHeaders(req);
        if (req.ip) headers.set(CLIENT_IP_HEADER, req.ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, ''));
        let body: string | undefined;
        if (req.method !== 'GET' && req.body !== undefined && req.body !== null) {
          body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
        const url = new URL(req.url, origin);
        if (!ALLOWED_AUTH_PATHS.has(url.pathname)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Not found' });
        const res = await auth.handler(new Request(url, { method: req.method, headers, body }));
        reply.code(res.status);
        res.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value); });
        const cookies = res.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.send(Buffer.from(await res.arrayBuffer()));
      },
    });
  };
}
