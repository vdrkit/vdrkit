// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { appendEvent } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { deleted } from '../routes/sign-in.js';
import { authReady, requestTrustIdentifier, type VdrAuth } from './better-auth.js';
import { authTx, browserLabel, policyForLogin, randomToken, readSignedCookie, totpUri, verifyTotp } from './sessions.js';


export const NEW_PHONE_MINUTES = 10;
export const NEW_PHONE_ATTEMPTS = 5;
// Better Auth's lockout: 15 min after 10 wrong codes; keep in step
const LOCK_AFTER = 10;

const newPhoneId = (userId: string) => `vdrkit-new-phone-${userId}`;

function loginOf(caller: Caller) {
  if (!caller.login) throw forbidden('This needs a sign-in session in a browser.', 'session_required');
  return caller.login;
}

const personOf = (c: Caller) => (c.principal.kind === 'person' ? c.principal.personId : c.principal.onBehalfOfPersonId);

function agentRefused(caller: Caller) {
  if (caller.principal.kind === 'agent') throw forbidden('Agents cannot change how a person signs in.', 'agent_needs_approval');
}

const TrustedBrowser = z.object({
  id: z.string().uuid(),
  browser: z.string(),
  trustedAt: z.string(),
  trustedUntil: z.string(),
  lastUsedAt: z.string().nullable(),
  thisBrowser: z.boolean(),
});

const wrongCode = (detail: string) => new HttpProblem({ type: 'https://vdrkit.com/problems/wrong-code', title: 'Code not accepted', status: 400, detail });
const notSetUp = () => badRequest('Two-factor sign-in is not set up yet. Set it up first; there is no old phone to move from.');
const tooManyCodes = () => new HttpProblem({ type: 'https://vdrkit.com/problems/rate-limited', title: 'Too many wrong codes', status: 429,
  detail: 'Too many wrong codes. Wait 15 minutes and try again, or ask the room admin to reset your two-factor sign-in.' });

export function sessionRoutes(auth: VdrAuth): FastifyPluginAsync {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const cfg = auth.vdrkit;

    r.get('/v1/public/sign-in/pending', {
      schema: {
        summary: 'Whether this browser may be trusted during the authenticator step. 404 without the two-factor cookie',
        response: { 200: z.object({ allowTrustedBrowser: z.boolean(), trustedBrowserDays: z.number().int() }) },
      },
    }, async (req) => {
      await authReady(auth);
      const identifier = readSignedCookie(req.headers.cookie, cfg.twoFactorCookieName, cfg.secret);
      if (!identifier) throw notFound();
      const now = cfg.now();
      const userId = (await authTx(cfg.db, cfg.dbRole, (tx) => tx.query<{ value: string }>(
        `select value from auth_verification where identifier = $1 and expires_at > $2`, [identifier, now.toISOString()]))).rows[0]?.value;
      if (!userId) throw notFound();
      const policy = await policyForLogin(cfg.db, userId, cfg.dbRole, now);
      return { allowTrustedBrowser: policy.allowTrustedBrowser, trustedBrowserDays: policy.trustedBrowserDays };
    });

    r.get('/v1/me/trusted-browsers', {
      schema: { summary: 'My trusted browsers', response: { 200: z.object({ items: z.array(TrustedBrowser) }) } },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const login = loginOf(caller);
      await authReady(auth);
      const now = cfg.now();
      const mine = requestTrustIdentifier(auth, req);
      const policy = login.policy;
      if (!policy.allowTrustedBrowser) return { items: [] };
      const { rows } = await tx.query<{ id: string; user_agent: string | null; created_at: string; trusted_until: string; last_used_at: string | null; trust_identifier: string }>(
        `select b.id, b.user_agent, b.created_at, b.trusted_until, b.last_used_at, b.trust_identifier
           from auth_trusted_browser b join auth_verification v on v.identifier = b.trust_identifier and v.value = b.user_id
          where b.user_id = $1 order by b.created_at desc`, [login.userId]);
      const maxAge = policy.trustedBrowserDays * 86_400_000;
      const items = [];
      for (const b of rows) {
        const until = Math.min(new Date(b.trusted_until).getTime(), new Date(b.created_at).getTime() + maxAge);
        if (until <= now.getTime()) continue;
        items.push({
          id: b.id,
          browser: browserLabel(b.user_agent),
          trustedAt: new Date(b.created_at).toISOString(),
          trustedUntil: new Date(until).toISOString(),
          lastUsedAt: b.last_used_at ? new Date(b.last_used_at).toISOString() : null,
          thisBrowser: b.trust_identifier === mine,
        });
      }
      return { items };
    }));

    r.delete('/v1/me/trusted-browsers/:id', {
      schema: {
        summary: 'Stop trusting a browser',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    }, async (req, reply) => {
      await app.inTenant(req, async (tx, caller) => {
        const login = loginOf(caller);
        agentRefused(caller);
        const removed = (await tx.query<{ trust_identifier: string; user_agent: string | null }>(
          `delete from auth_trusted_browser where id = $1 and user_id = $2 returning trust_identifier, user_agent`, [req.params.id, login.userId])).rows[0];
        if (!removed) throw notFound();
        await tx.query(`delete from auth_verification where identifier = $1`, [removed.trust_identifier]);
        await appendEvent(tx, { action: 'auth.trusted_browser_removed', actorId: caller.actorId, resourceType: 'person', resourceId: personOf(caller),
          data: { person_id: personOf(caller), browser: browserLabel(removed.user_agent) }, occurredAt: app.now(), requestId: req.id });
      });
      return reply.code(204).send(null);
    });

    r.post('/v1/me/sign-out-everywhere', {
      schema: {
        summary: 'Sign out all other browsers',
        response: { 200: z.object({ sessionsEnded: z.number().int() }) },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const login = loginOf(caller);
      agentRefused(caller);
      const ended = await deleted(tx, `delete from auth_session where user_id = $1 and id <> $2 and rotated_to is distinct from $2 returning 1`,
        [login.userId, login.sessionId]);
      await appendEvent(tx, { action: 'auth.signed_out_everywhere', actorId: caller.actorId, resourceType: 'person', resourceId: personOf(caller),
        data: { person_id: personOf(caller), sessions_ended: ended }, occurredAt: app.now(), requestId: req.id,
        context: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null } });
      return { sessionsEnded: ended };
    }));

    r.post('/v1/me/two-factor/new-phone', {
      schema: {
        summary: 'Move two-factor sign-in to a new phone, step 1: new secret',
        response: { 200: z.object({ totpURI: z.string(), expiresAt: z.string() }) },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const login = loginOf(caller);
      agentRefused(caller);
      await authReady(auth);
      const user = (await tx.query<{ email: string; on: boolean }>(`select email, two_factor_enabled as on from auth_user where id = $1`, [login.userId])).rows[0];
      if (!user?.on) throw notSetUp();
      const secret = randomToken(32);
      const expiresAt = new Date(cfg.now().getTime() + NEW_PHONE_MINUTES * 60_000);
      const value = JSON.stringify({ secret: await symmetricEncrypt({ key: cfg.secretConfig as string, data: secret }), attempts: 0 });
      const identifier = newPhoneId(login.userId);
      await tx.query(`delete from auth_verification where identifier = $1`, [identifier]);
      await tx.query(`insert into auth_verification (id, identifier, value, expires_at) values ($1, $2, $3, $4)`,
        [randomBytes(16).toString('hex'), identifier, value, expiresAt.toISOString()]);
      return { totpURI: totpUri(secret, user.email), expiresAt: expiresAt.toISOString() };
    }));

    r.post('/v1/me/two-factor/new-phone/confirm', {
      schema: {
        summary: 'Move two-factor sign-in to a new phone, step 2: confirm with codes from both phones',
        body: z.object({ oldCode: z.string().regex(/^\d{6}$/), newCode: z.string().regex(/^\d{6}$/) }),
        response: { 200: z.object({ movedAt: z.string() }) },
      },
    }, async (req) => {
      // wrong codes return, not throw: a throw rolls back the attempt count
      type Outcome = { ok: true; movedAt: string } | { ok: false; problem: HttpProblem };
      const out: Outcome = await app.inTenant(req, async (tx, caller): Promise<Outcome> => {
        const login = loginOf(caller);
        agentRefused(caller);
        await authReady(auth);
        const now = cfg.now();
        const key = cfg.secretConfig as string;
        const identifier = newPhoneId(login.userId);
        const pending = (await tx.query<{ value: string; expires_at: string }>(
          `select value, expires_at from auth_verification where identifier = $1 for update`, [identifier])).rows[0];
        if (!pending || new Date(pending.expires_at).getTime() <= now.getTime()) {
          throw new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Start again', status: 409,
            detail: `Moving to a new phone must be finished within ${NEW_PHONE_MINUTES} minutes. Start again and scan the new code.` });
        }
        const tf = (await tx.query<{ id: string; secret: string; locked_until: string | null; failed_verification_count: number | null }>(
          `select id, secret, locked_until, failed_verification_count from auth_two_factor where user_id = $1 for update`, [login.userId])).rows[0];
        if (!tf) throw notSetUp();
        if (tf.locked_until && new Date(tf.locked_until).getTime() > Date.now()) return { ok: false, problem: tooManyCodes() };
        const state = JSON.parse(pending.value) as { secret: string; attempts: number };
        const oldOk = verifyTotp(await symmetricDecrypt({ key, data: tf.secret }), req.body.oldCode);
        const newSecret = await symmetricDecrypt({ key, data: state.secret });
        const newOk = verifyTotp(newSecret, req.body.newCode);
        if (!oldOk || !newOk) {
          const attempts = state.attempts + 1;
          const exhausted = attempts >= NEW_PHONE_ATTEMPTS;
          if (exhausted) await tx.query(`delete from auth_verification where identifier = $1`, [identifier]);
          else await tx.query(`update auth_verification set value = $2 where identifier = $1`, [identifier, JSON.stringify({ ...state, attempts })]);
          if (!oldOk) {
            const failures = (tf.failed_verification_count ?? 0) + 1;
            const lockedUntil = failures >= LOCK_AFTER ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
            await tx.query(`update auth_two_factor set failed_verification_count = $2, locked_until = $3 where id = $1`,
              [tf.id, failures, lockedUntil]);
          }
          let detail = oldOk ? 'The code from your new phone is not right.' : 'The code from your old phone is not right.';
          if (exhausted) detail += ' Too many wrong codes: start again and scan the new code.';
          return { ok: false, problem: wrongCode(detail) };
        }
        await tx.query(`update auth_two_factor set secret = $2, verified = true, failed_verification_count = 0, locked_until = null, set_up_at = record_clock() where id = $1`,
          [tf.id, await symmetricEncrypt({ key, data: newSecret })]);
        await tx.query(`delete from auth_verification where identifier = $1`, [identifier]);
        await appendEvent(tx, { action: 'auth.two_factor_moved', actorId: caller.actorId, resourceType: 'person', resourceId: personOf(caller),
          data: { person_id: personOf(caller) }, occurredAt: now, requestId: req.id,
          context: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null } });
        return { ok: true, movedAt: now.toISOString() };
      });
      if (!out.ok) throw out.problem;
      return { movedAt: out.movedAt };
    });
  };
}

