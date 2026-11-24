// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, signInPolicy, type SqlClient } from '@vdrkit/core';
import { forbidden, HttpProblem, notFound } from '../problems.js';
import { inRoomNotRunBy } from './people-admin.js';
import { personOf, refuseIfArchived, requireWorkspaceAdmin } from './util.js';

export const resetElsewhere = () => new HttpProblem({
  type: 'https://vdrkit.com/problems/two-factor-reset-elsewhere', title: 'Cannot reset here', status: 409,
  reason: 'login_used_by_another_organisation',
  detail: 'This person also signs in to rooms of another organisation with the same login. Resetting their two-factor sign-in '
    + 'here would affect those rooms too, so it is not done. The person can use Move to a new phone if they still have the old one.',
});

export const SignInPolicyOut = z.object({
  requireTwoFactor: z.boolean(),
  allowTrustedBrowser: z.boolean(),
  trustedBrowserDays: z.number().int(),
  idleSignOutMinutes: z.number().int(),
  rooms: z.number().int(),
  twoFactorEnabled: z.boolean().nullable(),
  twoFactorSetUpAt: z.string().nullable(),
  twoFactorSetupRequired: z.boolean(),
});

export async function deleted(tx: SqlClient, sql: string, params: unknown[]): Promise<number> {
  return Number((await tx.query<{ n: number }>(`with d as (${sql}) select count(*)::int as n from d`, params)).rows[0]?.n ?? 0);
}

export async function resetTwoFactorOf(
  tx: SqlClient, personId: string,
): Promise<{ userId: string | null; hadTwoFactor: boolean; sessionsEnded: number; trustedBrowsersRemoved: number }> {
  const userId = (await tx.query<{ user_id: string | null }>(
    `select coalesce(ap.user_id, (select u.id from auth_user u where lower(u.email) = lower(ap.email) and u.email_verified)) as user_id
       from auth_person ap where ap.person_id = $1 and ap.tenant_id = current_tenant_id()`, [personId])).rows[0]?.user_id ?? null;
  // logins are global: don't strip another tenant's second factor
  if (userId) {
    const elsewhere = await tx.query(
      `select 1 from auth_person ap where ap.tenant_id <> current_tenant_id()
          and (ap.user_id = $1 or (ap.user_id is null and exists (
                select 1 from auth_user u where u.id = $1 and u.email_verified and lower(u.email) = lower(ap.email))))
        limit 1`, [userId]);
    if (elsewhere.rows.length > 0) throw resetElsewhere();
  }
  let hadTwoFactor = false;
  let sessionsEnded = 0;
  let trustedBrowsersRemoved = 0;
  if (userId) {
    hadTwoFactor = !!(await tx.query<{ on: boolean }>(`select two_factor_enabled as on from auth_user where id = $1`, [userId])).rows[0]?.on;
    await tx.query(`delete from auth_two_factor where user_id = $1`, [userId]);
    await tx.query(`update auth_user set two_factor_enabled = false, updated_at = now() where id = $1`, [userId]);
    trustedBrowsersRemoved = await deleted(tx, `delete from auth_trusted_browser where user_id = $1 returning 1`, [userId]);
    await tx.query(
      `delete from auth_verification where (value = $1 and (identifier like 'trust-device-%' or identifier like '2fa-%'))
          or identifier = 'vdrkit-new-phone-' || $1`, [userId]);
    sessionsEnded = await deleted(tx, `delete from auth_session where user_id = $1 returning 1`, [userId]);
  }
  return { userId, hadTwoFactor, sessionsEnded, trustedBrowsersRemoved };
}

export const signInRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/me/sign-in-policy', {
    schema: {
      summary: 'Sign-in rules that apply to me (strictest across my rooms)',
      response: { 200: SignInPolicyOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const policy = caller.login?.policy ?? await signInPolicy(tx, personOf(caller), app.now());
    let enabled: boolean | null = null;
    let setUpAt: string | null = null;
    if (caller.login) {
      const u = (await tx.query<{ on: boolean; set_up_at: string | null }>(
        `select u.two_factor_enabled as on, (select max(t.set_up_at) from auth_two_factor t where t.user_id = u.id) as set_up_at
           from auth_user u where u.id = $1`, [caller.login.userId])).rows[0];
      enabled = !!u?.on;
      setUpAt = enabled && u?.set_up_at ? new Date(u.set_up_at).toISOString() : null;
    }
    return { ...policy, twoFactorEnabled: enabled, twoFactorSetUpAt: setUpAt, twoFactorSetupRequired: policy.requireTwoFactor && enabled === false };
  }));

  r.post('/v1/workspaces/:ws/people/:personId/reset-two-factor', {
    schema: {
      summary: 'Reset someone’s two-factor sign-in. Room admins only',
      params: z.object({ ws: z.string().uuid(), personId: z.string().uuid() }),
      response: { 200: z.object({ personId: z.string().uuid(), hadTwoFactor: z.boolean(), sessionsEnded: z.number().int(), trustedBrowsersRemoved: z.number().int() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, personId } = req.params;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    // whoever holds an admin's session must not drop the second factor without the old code
    if (personId === personOf(caller)) {
      throw new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Not possible', status: 409,
        detail: 'You cannot reset your own two-factor sign-in. Use Move to a new phone in your profile, or ask a site admin.' });
    }
    await refuseIfArchived(tx, ws);
    const rooms = (await tx.query<{ id: string }>(
      `select distinct g.workspace_id as id from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
        where m.person_id = $1 and m.status = 'active' and m.superseded_at = 'infinity'
          and m.valid_from <= $2 and $2 < m.valid_to and g.valid_from <= $2 and $2 < g.valid_to and w.state <> 'deleted'`,
      [personId, now.toISOString()])).rows.map((x) => x.id);
    if (!rooms.includes(ws)) throw notFound();
    // site admins: only another site admin
    const roles = (await tx.query<{ target: boolean; caller: boolean }>(
      `select coalesce((select is_site_admin from person where id = $1), false) as target,
              coalesce((select is_site_admin and disabled_at is null and erased_at is null from person where id = $2), false) as caller`,
      [personId, caller.principal.kind === 'person' ? caller.principal.personId : null])).rows[0]!;
    if (roles.target && !roles.caller) {
      throw forbidden('Only a site admin can reset the two-factor sign-in of a site admin.', 'target_is_site_admin');
    }
    if (!roles.caller && await inRoomNotRunBy(tx, personId, personOf(caller), now)) {
      throw forbidden('This person is also in a room you do not run, so only a site admin can reset their two-factor sign-in.', 'target_in_other_room');
    }
    const { userId, hadTwoFactor, sessionsEnded, trustedBrowsersRemoved } = await resetTwoFactorOf(tx, personId);
    // copies in other rooms must not leak this room's id
    for (const room of [ws, ...rooms.filter((x) => x !== ws)]) {
      await appendEvent(tx, {
        action: 'auth.two_factor_reset', workspaceId: room, actorId: caller.actorId, resourceType: 'person', resourceId: personId,
        data: { person_id: personId, reset_here: room === ws, ...(room === ws ? { reset_in_workspace_id: ws } : {}),
          had_login: userId !== null, had_two_factor: hadTwoFactor,
          sessions_ended: sessionsEnded, trusted_browsers_removed: trustedBrowsersRemoved },
        occurredAt: now, requestId: req.id, context: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
      });
    }
    return { personId, hadTwoFactor, sessionsEnded, trustedBrowsersRemoved };
  }));
};
