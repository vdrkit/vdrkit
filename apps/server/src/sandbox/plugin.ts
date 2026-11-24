// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '@vdrkit/core';
import { DEMO_PEOPLE } from '../demo/seed-demo.js';
import { authReady, type VdrAuth } from '../auth/better-auth.js';
import { linkPersonToLogin } from '../auth/person-link.js';
import { authTx, randomToken, readSignedCookie, serializeCookie, signCookieValue, SESSION_LIFETIME_S } from '../auth/sessions.js';
import { HttpProblem, notFound } from '../problems.js';
import { normalisedPath } from '../rate-limit.js';
import {
  nextReset, RESET_TIME_TEXT, SANDBOX_MAX_FILE_BYTES, SANDBOX_TENANT_ID, SANDBOX_UPLOADS_PER_DAY, SANDBOX_UPLOADS_PER_VISITOR_PER_DAY,
} from './config.js';
import { SANDBOX_GROUPS, SANDBOX_PEOPLE, SANDBOX_WORKSPACE_ID, sandboxPersonId, type SandboxPersonSpec } from './people.js';

export interface SandboxOptions {
  auth: VdrAuth;
}

const PROBLEM = 'https://vdrkit.com/problems/sandbox-refused';

export const sandboxRefused = (detail: string) => new HttpProblem({
  type: PROBLEM, title: 'Not in the sandbox', status: 403, reason: 'sandbox_refused', detail,
});

const SITE = 'Site settings stay as they are in the sandbox, so it works the same for every visitor.';
const SIGN_IN = 'The sandbox has no sign-in settings to change: visitors enter as a demo person, without a code.';
const PEOPLE = 'The demo people keep their access in the sandbox, so the next visitor can enter as them.';

const REFUSED: Record<string, string> = {
  'PATCH /v1/site/settings': SITE,
  'DELETE /v1/site/settings/mail': SITE,
  'POST /v1/site/mail/test': 'The sandbox sends no email.',
  'PUT /v1/site/branding/logos/:variant': SITE,
  'DELETE /v1/site/branding/logos/:variant': SITE,
  'POST /v1/site/room-creators': SITE,
  'DELETE /v1/site/room-creators/:personId': SITE,
  'POST /v1/site/admins': SITE,
  'POST /v1/site/accounts/:personId/disable': PEOPLE,
  'POST /v1/site/accounts/:personId/enable': PEOPLE,
  'POST /v1/site/accounts/:personId/reset-two-factor': SIGN_IN,
  'POST /v1/site/accounts/:personId/email-change': 'Email addresses stay as they are in the sandbox.',
  'POST /v1/workspaces/:ws/people/:personId/email-change': 'Email addresses stay as they are in the sandbox.',
  'POST /v1/workspaces/:ws/people/:personId/reset-two-factor': SIGN_IN,
  'POST /v1/workspaces': 'The sandbox has its rooms already: try Project Heron. To create rooms of your own, run VDRkit yourself.',
  'PUT /v1/workspaces/:ws/logo/:variant': 'Room logos stay as they are in the sandbox.',
  'DELETE /v1/workspaces/:ws/logo/:variant': 'Room logos stay as they are in the sandbox.',
  'POST /v1/me/sign-out-everywhere': 'In the sandbox, other visitors may be signed in as the same person; only this browser can sign out.',
  'POST /v1/me/two-factor/new-phone': SIGN_IN,
  'POST /v1/me/two-factor/new-phone/confirm': SIGN_IN,
};

const SETTINGS_REFUSED: Record<string, string> = {
  requireTwoFactor: SIGN_IN, allowTrustedBrowser: SIGN_IN, trustedBrowserDays: SIGN_IN, idleSignOutMinutes: SIGN_IN,
  state: 'Project Heron stays open in the sandbox, so every visitor finds it as described.',
};

const AUTH_ALLOWED = new Set(['GET /v1/auth/get-session', 'POST /v1/auth/sign-out']);

const MEMBERSHIP_CHANGES = new Set([
  'POST /v1/workspaces/:ws/memberships/:id/revoke',
  'PATCH /v1/workspaces/:ws/memberships/:id',
  'POST /v1/workspaces/:ws/memberships/:id/make-member',
  'POST /v1/workspaces/:ws/memberships/:id/make-lead',
]);

const PERSONA_IDS = new Set(SANDBOX_PEOPLE.map((p) => sandboxPersonId(p.key)));

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export async function installSandbox(app: FastifyInstance, db: Database, dbRole: 'vdrkit_app' | undefined, opts: SandboxOptions): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  app.addHook('onRequest', async (req) => {
    const path = normalisedPath(req.url);
    if (path !== null && path.startsWith('/v1/auth/') && !AUTH_ALLOWED.has(`${req.method} ${path}`)) throw notFound();
  });

  // before validation: refuse whatever the body
  app.addHook('preValidation', async (req) => {
    const route = req.routeOptions.url ?? '';
    const key = `${req.method} ${route}`;
    const refused = REFUSED[key];
    if (refused) throw sandboxRefused(refused);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (key === 'PATCH /v1/workspaces/:ws/settings') {
      for (const [field, why] of Object.entries(SETTINGS_REFUSED)) if (body[field] !== undefined) throw sandboxRefused(why);
    }
    const caller = req.caller;
    const id = (req.params as { id?: string } | undefined)?.id;
    if (key === 'POST /v1/workspaces/:ws/upload-sessions' && caller) return checkUpload(req);
    if (!caller || !id) return;
    const touchesPersona = async (sql: string) => {
      const { rows } = await app.inTenantId(caller.tenantId, (tx) => tx.query<{ hit: boolean }>(sql, [id, [...PERSONA_IDS]]));
      return rows[0]?.hit;
    };
    if (MEMBERSHIP_CHANGES.has(key)) {
      if (await touchesPersona(`select exists (select 1 from membership where id = $1 and person_id = any($2::uuid[])) as hit`)) throw sandboxRefused(PEOPLE);
    }
    if (key === 'POST /v1/workspaces/:ws/groups/:id/revoke' || (key === 'PATCH /v1/workspaces/:ws/groups/:id' && body.accessEndsAt !== undefined)) {
      if (await touchesPersona(`select exists (select 1 from membership m join groups g on g.id = m.group_id
          where (g.id = $1 or g.parent_group_id = $1) and m.person_id = any($2::uuid[])) as hit`)) throw sandboxRefused(PEOPLE);
    }
  });

  const perVisitor = new Map<string, number>();
  const visitorKey = (req: FastifyRequest) => `${utcDay(app.now())}:${req.ip}`;
  const uploadLimit = (detail: string) => new HttpProblem({
    type: 'https://vdrkit.com/problems/sandbox-limit', title: 'Upload limit reached', status: 429, reason: 'sandbox_upload_limit', detail,
  });
  async function checkUpload(req: FastifyRequest): Promise<void> {
    const size = Number((req.body as { size?: unknown } | undefined)?.size ?? 0);
    if (size > SANDBOX_MAX_FILE_BYTES) {
      throw new HttpProblem({ type: 'https://vdrkit.com/problems/sandbox-limit', title: 'File too large for the sandbox', status: 413, reason: 'sandbox_file_too_large',
        detail: `The sandbox takes files up to ${SANDBOX_MAX_FILE_BYTES / 1024 / 1024} MB. Try a smaller one, and never a confidential or personal file.` });
    }
    if ((perVisitor.get(visitorKey(req)) ?? 0) >= SANDBOX_UPLOADS_PER_VISITOR_PER_DAY) {
      throw uploadLimit(`In the sandbox each visitor may upload ${SANDBOX_UPLOADS_PER_VISITOR_PER_DAY} files a day. Try again after the reset at ${RESET_TIME_TEXT}.`);
    }
    const all = await app.inTenantId(req.caller!.tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(`select count(*)::int as n from upload_session`);
      return Number(rows[0]?.n ?? 0);
    });
    if (all >= SANDBOX_UPLOADS_PER_DAY) {
      throw uploadLimit(`The sandbox has taken all the uploads it takes in a day. Try again after the reset at ${RESET_TIME_TEXT}.`);
    }
  }
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.routeOptions.url !== '/v1/workspaces/:ws/upload-sessions' || reply.statusCode !== 201) return;
    const today = utcDay(app.now());
    for (const k of perVisitor.keys()) if (!k.startsWith(`${today}:`)) perVisitor.delete(k);
    const visitor = visitorKey(req);
    perVisitor.set(visitor, (perVisitor.get(visitor) ?? 0) + 1);
  });

  const people = SANDBOX_PEOPLE.map((p) => {
    const d = DEMO_PEOPLE[p.key];
    return { key: p.key, name: d.name, company: d.company, jobTitle: d.jobTitle, group: p.group, groupLabel: SANDBOX_GROUPS[p.group], can: p.can };
  });
  r.get('/v1/sandbox', { schema: { hide: true } }, async () => ({
    sandbox: true as const,
    resetTime: RESET_TIME_TEXT,
    nextResetAt: nextReset(app.now()).toISOString(),
    roomName: 'Project Heron',
    limits: { maxFileBytes: SANDBOX_MAX_FILE_BYTES, uploadsPerVisitorPerDay: SANDBOX_UPLOADS_PER_VISITOR_PER_DAY },
    people,
  }));

  const keys = SANDBOX_PEOPLE.map((p) => p.key) as [SandboxPersonSpec['key'], ...SandboxPersonSpec['key'][]];
  r.post('/v1/sandbox/sign-in', {
    schema: { hide: true, body: z.object({ person: z.enum(keys) }).strict() },
  }, async (req, reply) => {
    await authReady(opts.auth);
    const cfg = opts.auth.vdrkit;
    const key = req.body.person;
    const personId = sandboxPersonId(key);
    const now = app.now();
    const found = await app.inTenantId(SANDBOX_TENANT_ID, async (tx) => {
      const p = (await tx.query<{ name: string; email: string }>(
        `select name, email from person where id = $1 and erased_at is null and disabled_at is null`, [personId])).rows[0];
      if (!p) return null;
      const inHeron = (await tx.query(
        `select 1 from membership m join groups g on g.id = m.group_id
          where m.person_id = $1 and g.workspace_id = $2 and m.status = 'active' and m.superseded_at = 'infinity'
            and m.valid_from <= $3 and $3 < m.valid_to and g.valid_from <= $3 and $3 < g.valid_to`, [personId, SANDBOX_WORKSPACE_ID, now.toISOString()])).rows.length > 0;
      return { ...p, inHeron };
    });
    if (!found) throw notFound();

    const userId = `sandbox-${key}`;
    const token = randomToken();
    const previous = readSignedCookie(req.headers.cookie, cfg.sessionCookie.name, cfg.secret);
    await authTx(db, dbRole, async (tx) => {
      await tx.query(`delete from auth_user where lower(email) = lower($2) and id <> $1`, [userId, found.email]);
      await tx.query(
        `insert into auth_user (id, name, email, email_verified, two_factor_enabled, created_at, updated_at) values ($1, $2, $3, true, false, $4, $4)
         on conflict (id) do update set name = excluded.name, email = excluded.email, email_verified = true, two_factor_enabled = false, updated_at = excluded.updated_at`,
        [userId, found.name, found.email, now.toISOString()]);
      await tx.query(`delete from auth_two_factor where user_id = $1`, [userId]);
      if (previous) await tx.query(`delete from auth_session where token = $1`, [previous]);
      // no IP or user agent: keep nothing about visitors
      await tx.query(
        `insert into auth_session (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at, last_active_at, token_issued_at)
         values ($1, $2, $3, $4, null, null, $5, $5, $5, $5)`,
        [randomToken(), userId, token, new Date(now.getTime() + SESSION_LIFETIME_S * 1000).toISOString(), now.toISOString()]);
    });
    await app.inTenantId(SANDBOX_TENANT_ID, async (tx) => {
      await linkPersonToLogin(tx, personId);
      await tx.query(`update auth_person set user_id = $2 where person_id = $1 and user_id is distinct from $2`, [personId, userId]);
    });
    reply.header('set-cookie', serializeCookie(cfg.sessionCookie.name, signCookieValue(token, cfg.secret),
      { ...cfg.sessionCookie.attributes, maxAge: SESSION_LIFETIME_S }));
    return { person: key, name: found.name, next: found.inHeron ? `/rooms/${SANDBOX_WORKSPACE_ID}/dashboard` : '/' };
  });
}
