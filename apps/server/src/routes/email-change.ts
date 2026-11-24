// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, type OutgoingMessage, type SqlClient } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { mailBranding } from '../mail/branding.js';
import { emailChangeApprovalEmail, emailChangeCodeEmail, emailChangedNoticeEmail, toMessage } from '../mail/templates.js';
import { mailEvent } from '../mail/proof.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { requireSiteAdmin } from '../site/common.js';
import { inRoom, inRoomNotRunBy, invitedRooms } from './people-admin.js';
import { roomsOf } from './profile.js';
import { isWorkspaceAdmin, personOf, refuseIfArchived, requireWorkspaceAdmin } from './util.js';

export const EMAIL_CHANGE_HOURS = 72;
export const EMAIL_CHANGE_MAX_WRONG = 5;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const codeHash = (id: string, code: string) => sha(`${id}:${code}`);
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{30,}$/;

const conflict = (detail: string, reason: string) =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Not possible', status: 409, detail, reason });
const linkGone = () => new HttpProblem({ type: 'https://vdrkit.com/problems/invalid-email-change', title: 'This link does not work', status: 410,
  detail: 'This link no longer works. Ask your room admin to change your address again.' });

const userAgent = (req: FastifyRequest) => (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null);

const NewEmail = z.object({ email: z.string().trim().toLowerCase().email().max(320) });

const Pending = z.object({ newEmail: z.string(), requestedAt: z.string(), expiresAt: z.string(), awaitingApproval: z.boolean() }).nullable();
const Info = z.object({
  personId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  // count only
  otherRooms: z.number().int(),
  pending: Pending,
  needsApproval: z.boolean(),
});
// emailStatus: the approval mail when needsApproval, else the code mail
const Requested = z.object({ personId: z.string().uuid(), newEmail: z.string(), expiresAt: z.string(), needsApproval: z.boolean(), emailStatus: z.string() });

// not auth_person alone: disabling an account drops the link until the next sign-in
async function needsApproval(tx: SqlClient, personId: string, callerIsSiteAdmin: boolean): Promise<boolean> {
  if (callerIsSiteAdmin) return false;
  return (await tx.query<{ used: boolean }>(
    `select exists (select 1 from auth_person where person_id = $1 and user_id is not null)
         or exists (select 1 from event where resource_id = $1 and resource_type = 'person' and action = 'auth.signed_in')
         or exists (select 1 from auth_user u join person p on lower(u.email) = lower(p.email) where p.id = $1 and u.email_verified) as used`,
    [personId])).rows[0]!.used;
}

// Re-checked before it takes effect. A request lives for days and the person or requester may have changed.
async function stillStands(tx: SqlClient, c: { person_id: string; requested_by: string; workspace_id: string | null; approved: boolean }, now: Date): Promise<boolean> {
  if (await isSiteAdmin(tx, c.requested_by)) return true;
  // asked on the site route, by someone who is a site admin no longer
  if (!c.workspace_id) return false;
  if (!(await isWorkspaceAdmin(tx, c.requested_by, c.workspace_id, now)) || !(await inRoom(tx, c.person_id, c.workspace_id, now))) return false;
  if ((await tx.query<{ yes: boolean }>(`select coalesce((select is_site_admin from person where id = $1), false) as yes`, [c.person_id])).rows[0]!.yes) return false;
  if (await inRoomNotRunBy(tx, c.person_id, c.requested_by, now)) return false;
  return c.approved || !(await needsApproval(tx, c.person_id, false));
}

// linked login, else the unlinked one with their verified address
async function loginOf(tx: SqlClient, personId: string, email: string): Promise<string | null> {
  return (await tx.query<{ id: string }>(
    `select coalesce(
       (select user_id from auth_person where person_id = $1),
       (select u.id from auth_user u where lower(u.email) = lower($2) and u.email_verified
           and not exists (select 1 from auth_person ap where ap.user_id = u.id))) as id`, [personId, email])).rows[0]?.id ?? null;
}

async function isSiteAdmin(tx: SqlClient, personId: string): Promise<boolean> {
  return (await tx.query<{ ok: boolean }>(
    `select coalesce((select is_site_admin and disabled_at is null and erased_at is null from person where id = $1), false) as ok`, [personId])).rows[0]!.ok;
}

async function addressTaken(tx: SqlClient, email: string, personId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `select 1 from person where lower(email) = lower($1) and id <> $2
     union all
     select 1 from auth_person where lower(email) = lower($1) and person_id <> $2
     union all
     select 1 from auth_user u where lower(u.email) = lower($1)
        and not exists (select 1 from auth_person ap where ap.person_id = $2 and ap.user_id = u.id)
     union all
     select 1 from email_change where new_email = lower($1) and person_id <> $2 and status = 'pending'
     limit 1`, [email, personId]);
  return rows.length > 0;
}

async function allRooms(tx: SqlClient, personId: string, now: Date): Promise<string[]> {
  const member = await roomsOf(tx, personId, now);
  const invited = await invitedRooms(tx, personId, now);
  return [...new Set([...member, ...invited])];
}

async function info(tx: SqlClient, personId: string, here: string | null, now: Date, approval: boolean): Promise<z.infer<typeof Info>> {
  const p = (await tx.query<{ name: string; email: string }>(`select name, email from person where id = $1 and erased_at is null`, [personId])).rows[0];
  if (!p) throw notFound();
  const rooms = await allRooms(tx, personId, now);
  const pending = (await tx.query<{ new_email: string; requested_at: string; expires_at: string; awaiting: boolean }>(
    `select new_email, requested_at, expires_at, approval_token_sha256 is not null and approved_at is null as awaiting
       from email_change where person_id = $1 and status = 'pending' and expires_at > $2`,
    [personId, now.toISOString()])).rows[0];
  return {
    personId, name: p.name, email: p.email, otherRooms: rooms.filter((r) => r !== here).length,
    pending: pending ? { newEmail: pending.new_email, requestedAt: new Date(pending.requested_at).toISOString(), expiresAt: new Date(pending.expires_at).toISOString(),
      awaitingApproval: pending.awaiting } : null,
    needsApproval: approval,
  };
}

interface Started {
  token: string;
  code: string;
  personId: string;
  oldEmail: string;
  newEmail: string;
  requestedBy: string;
  expiresAt: Date;
  approvalToken: string | null;
}

const newToken = (tenantId: string) => `${tenantId}.${randomBytes(32).toString('base64url')}`;
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

async function start(tx: SqlClient, req: FastifyRequest, caller: Caller,
  a: { personId: string; email: string; ws: string | null; now: Date; approval: boolean }): Promise<Started> {
  const p = (await tx.query<{ name: string; email: string; disabled_at: string | null }>(
    `select name, email, disabled_at from person where id = $1 and erased_at is null`, [a.personId])).rows[0];
  if (!p) throw notFound();
  if (p.disabled_at) throw conflict('This account is disabled.', 'account_disabled');
  if (p.email.toLowerCase() === a.email) throw badRequest('That is already their sign-in address.');
  if (await addressTaken(tx, a.email, a.personId)) {
    throw conflict('This address is already used by another account on this site. Each address can belong to one account only.', 'email_taken');
  }
  const by = personOf(caller);
  const requestedBy = (await tx.query<{ name: string }>(`select name from person where id = $1`, [by])).rows[0]?.name ?? 'Your room admin';
  await tx.query(`update email_change set status = 'replaced', closed_at = $2 where person_id = $1 and status = 'pending'`, [a.personId, a.now.toISOString()]);
  const id = (await tx.query<{ id: string }>(`select gen_random_uuid() as id`)).rows[0]!.id;
  // awaiting approval, token and code are throwaway values nobody receives; approve makes the real ones
  const token = newToken(caller.tenantId);
  const code = newCode();
  const approvalToken = a.approval ? newToken(caller.tenantId) : null;
  const expiresAt = new Date(a.now.getTime() + EMAIL_CHANGE_HOURS * 3_600_000);
  await tx.query(
    `insert into email_change (id, tenant_id, person_id, old_email, new_email, token_sha256, code_sha256, approval_token_sha256,
                               workspace_id, requested_by, requested_at, expires_at)
     values ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, a.personId, p.email, a.email, sha(token), codeHash(id, code), approvalToken && sha(approvalToken),
      a.ws, by, a.now.toISOString(), expiresAt.toISOString()]);
  const context = { ip: req.ip, userAgent: userAgent(req),
    personal: { before: { email: p.email }, after: { email: a.email } }, subjectPersonId: a.personId };
  if (a.ws) {
    await appendEvent(tx, { action: 'person.email_change_requested', workspaceId: a.ws, actorId: caller.actorId, resourceType: 'person', resourceId: a.personId,
      data: { person_id: a.personId, ...(a.approval ? { needs_approval: true } : {}) }, occurredAt: a.now, requestId: req.id, context });
  } else {
    await appendEvent(tx, { action: 'site.person.email_change_requested', actorId: caller.actorId, resourceType: 'site', resourceId: caller.tenantId,
      data: { actor_person_id: by, person_id: a.personId }, occurredAt: a.now, requestId: req.id, context });
  }
  return { token, code, personId: a.personId, oldEmail: p.email, newEmail: a.email, requestedBy, expiresAt, approvalToken };
}

async function liveRoom(tx: SqlClient, ws: string | null): Promise<string | null> {
  if (!ws) return null;
  return (await tx.query<{ id: string }>(`select id from workspace where id = $1 and state <> 'deleted'`, [ws])).rows[0]?.id ?? null;
}

export const emailChangeRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function deliver(msg: OutgoingMessage): Promise<{ status: string; providerMessageId?: string; error?: string }> {
    if (!app.deps.mailer) return { status: 'no_mailer', error: 'No mail server is configured' };
    return app.deps.mailer.send(msg).catch((e: unknown) => ({ status: 'failed', error: e instanceof Error ? e.message.slice(0, 200) : 'failed' }));
  }

  // tenantId: sent from a public link, so there is no caller
  function inTenantOf<T>(req: FastifyRequest, tenantId: string | null, fn: (tx: SqlClient, caller: Caller | null) => Promise<T>): Promise<T> {
    return tenantId ? app.inTenantId(tenantId, (tx) => fn(tx, null)) : app.inTenant(req, fn);
  }

  async function sendCode(req: FastifyRequest, s: Started, ws: string | null, tenantId: string | null = null): Promise<string> {
    const brand = await inTenantOf(req, tenantId, (tx) => mailBranding(tx, app.deps.storage, app.deps.publicUrl));
    const url = `${app.deps.publicUrl.replace(/\/$/, '')}/email-change/${encodeURIComponent(s.token)}`;
    const mail = emailChangeCodeEmail({ brand, requestedBy: s.requestedBy, newEmail: s.newEmail, code: s.code, url, hours: EMAIL_CHANGE_HOURS });
    const res = await deliver(toMessage(mail, s.personId, s.newEmail));
    const action = res.status === 'accepted' ? 'email_change_code_sent' : 'email_change_code_not_sent';
    const m = mailEvent({ type: 'email_change_code', personId: s.personId, to: s.newEmail, subject: mail.subject, result: res });
    await inTenantOf(req, tenantId, (tx, caller) => appendEvent(tx, {
      action: ws ? `person.${action}` : `site.person.${action}`, ...(ws ? { workspaceId: ws } : {}), ...(caller ? { actorId: caller.actorId } : {}),
      resourceType: ws ? 'person' : 'site', resourceId: ws ? s.personId : (caller?.tenantId ?? tenantId!), requestId: req.id,
      data: { ...(ws ? {} : { actor_person_id: caller ? personOf(caller) : s.personId }), person_id: s.personId, ...m.data },
      ...(ws ? { context: m.context } : {}),
    }));
    return res.status;
  }

  async function sendApproval(req: FastifyRequest, s: Started, ws: string): Promise<string> {
    const brand = await app.inTenant(req, (tx) => mailBranding(tx, app.deps.storage, app.deps.publicUrl));
    const url = `${app.deps.publicUrl.replace(/\/$/, '')}/email-change/approve/${encodeURIComponent(s.approvalToken!)}`;
    const mail = emailChangeApprovalEmail({ brand, requestedBy: s.requestedBy, oldEmail: s.oldEmail, newEmail: s.newEmail, url, hours: EMAIL_CHANGE_HOURS });
    const res = await deliver(toMessage(mail, s.personId, s.oldEmail));
    const m = mailEvent({ type: 'email_change_approval', personId: s.personId, to: s.oldEmail, subject: mail.subject, result: res });
    await app.inTenant(req, (tx, caller) => appendEvent(tx, {
      action: res.status === 'accepted' ? 'person.email_change_approval_sent' : 'person.email_change_approval_not_sent',
      workspaceId: ws, actorId: caller.actorId, resourceType: 'person', resourceId: s.personId, requestId: req.id,
      data: { person_id: s.personId, ...m.data }, context: m.context,
    }));
    return res.status;
  }

  // under for update; null for anything that does not work
  async function approvalRow(tx: SqlClient, token: string, now: Date) {
    const c = (await tx.query<{ id: string; person_id: string; old_email: string; new_email: string; expires_at: string; status: string;
      approved_at: string | null; requested_by: string; workspace_id: string | null }>(
      `select id, person_id, old_email, new_email, expires_at, status, approved_at, requested_by, workspace_id
         from email_change where approval_token_sha256 = $1 for update`, [sha(token)])).rows[0];
    if (!c || c.status !== 'pending' || c.approved_at) return null;
    if (new Date(c.expires_at) <= now) {
      await tx.query(`update email_change set status = 'expired', closed_at = $2 where id = $1`, [c.id, now.toISOString()]);
      return null;
    }
    const p = (await tx.query(`select 1 from person where id = $1 and erased_at is null and disabled_at is null`, [c.person_id])).rows[0];
    if (!p) return null;
    // agreeing is the person's own act, so only the requester's standing is in question here
    if (!(await stillStands(tx, { ...c, approved: true }, now))) {
      await tx.query(`update email_change set status = 'expired', closed_at = $2 where id = $1`, [c.id, now.toISOString()]);
      return null;
    }
    return c;
  }


  r.get('/v1/workspaces/:ws/people/:personId/email-change', {
    schema: {
      summary: 'Preview a sign-in email change (room admin)',
      params: z.object({ ws: z.string().uuid(), personId: z.string().uuid() }),
      response: { 200: Info },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, personId } = req.params;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    if (!(await inRoom(tx, personId, ws, now))) throw notFound();
    return info(tx, personId, ws, now, await needsApproval(tx, personId, await isSiteAdmin(tx, personOf(caller))));
  }));

  r.post('/v1/workspaces/:ws/people/:personId/email-change', {
    schema: {
      summary: 'Change someone’s sign-in email (room admin). Logged',
      params: z.object({ ws: z.string().uuid(), personId: z.string().uuid() }),
      body: NewEmail,
      response: { 200: Requested },
    },
  }, async (req) => {
    const { ws, personId } = req.params;
    const now = app.now();
    const s = await app.inTenant(req, async (tx, caller) => {
      await requireWorkspaceAdmin(tx, caller, ws, now);
      await refuseIfArchived(tx, ws);
      if (!(await inRoom(tx, personId, ws, now))) throw notFound();
      // room admins can't touch site admins
      const roles = (await tx.query<{ target: boolean; caller: boolean }>(
        `select coalesce((select is_site_admin from person where id = $1), false) as target,
                coalesce((select is_site_admin and disabled_at is null and erased_at is null from person where id = $2), false) as caller`,
        [personId, personOf(caller)])).rows[0]!;
      if (roles.target && !roles.caller) throw forbidden('Only a site admin can change the sign-in email of a site admin.', 'target_is_site_admin');
      if (!roles.caller && await inRoomNotRunBy(tx, personId, personOf(caller), now)) {
        throw forbidden('This person is also in a room you do not run, so only a site admin can change their sign-in email.', 'target_in_other_room');
      }
      return start(tx, req, caller, { personId, email: req.body.email, ws, now, approval: await needsApproval(tx, personId, roles.caller) });
    });
    const emailStatus = s.approvalToken ? await sendApproval(req, s, ws) : await sendCode(req, s, ws);
    return { personId, newEmail: s.newEmail, expiresAt: s.expiresAt.toISOString(), needsApproval: s.approvalToken !== null, emailStatus };
  });


  r.get('/v1/site/accounts/:personId/email-change', {
    schema: {
      summary: 'Preview a sign-in email change (site admin)', tags: ['site'],
      params: z.object({ personId: z.string().uuid() }),
      response: { 200: Info },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    await requireSiteAdmin(tx, caller);
    return info(tx, req.params.personId, null, app.now(), false);
  }));

  r.post('/v1/site/accounts/:personId/email-change', {
    schema: {
      summary: 'Change someone’s sign-in email (site admin). Logged', tags: ['site'],
      params: z.object({ personId: z.string().uuid() }),
      body: NewEmail,
      response: { 200: Requested },
    },
  }, async (req) => {
    const now = app.now();
    const s = await app.inTenant(req, async (tx, caller) => {
      await requireSiteAdmin(tx, caller);
      return start(tx, req, caller, { personId: req.params.personId, email: req.body.email, ws: null, now, approval: false });
    });
    const emailStatus = await sendCode(req, s, null);
    return { personId: s.personId, newEmail: s.newEmail, expiresAt: s.expiresAt.toISOString(), needsApproval: false, emailStatus };
  });


  r.get('/v1/public/email-change/approval/:token', {
    schema: {
      summary: 'Look up a request to change your sign-in address. 410 for any link that does not work',
      params: z.object({ token: z.string().max(200) }),
      response: { 200: z.object({ oldEmail: z.string(), newEmail: z.string(), requestedBy: z.string(), expiresAt: z.string() }) },
    },
  }, async (req) => {
    const token = req.params.token;
    if (!TOKEN.test(token)) throw linkGone();
    const now = app.now();
    return app.inTenantId(token.split('.')[0]!, async (tx) => {
      const row = (await tx.query<{ old_email: string; new_email: string; expires_at: string; status: string; approved_at: string | null; requested_by: string | null }>(
        `select c.old_email, c.new_email, c.expires_at, c.status, c.approved_at, r.name as requested_by
           from email_change c join person p on p.id = c.person_id left join person r on r.id = c.requested_by
          where c.approval_token_sha256 = $1 and p.erased_at is null and p.disabled_at is null`, [sha(token)])).rows[0];
      if (!row || row.status !== 'pending' || row.approved_at || new Date(row.expires_at) <= now) throw linkGone();
      return {
        oldEmail: row.old_email, newEmail: row.new_email, requestedBy: row.requested_by ?? 'Your room admin',
        expiresAt: new Date(row.expires_at).toISOString(),
      };
    });
  });

  r.post('/v1/public/email-change/approve', {
    schema: {
      summary: 'Agree, from the current address, to a sign-in address change. Sends the code to the new address. Logged',
      body: z.object({ token: z.string().regex(TOKEN) }),
      response: { 200: z.object({ newEmail: z.string(), expiresAt: z.string(), emailStatus: z.string() }) },
    },
  }, async (req) => {
    const tenantId = req.body.token.split('.')[0]!;
    const now = app.now();
    // don't throw: an expired row must commit as expired
    const out = await app.inTenantId(tenantId, async (tx) => {
      const c = await approvalRow(tx, req.body.token, now);
      if (!c) return null;
      const token = newToken(tenantId);
      const code = newCode();
      const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_HOURS * 3_600_000);
      await tx.query(`update email_change set token_sha256 = $2, code_sha256 = $3, approved_at = $4, expires_at = $5 where id = $1`,
        [c.id, sha(token), codeHash(c.id, code), now.toISOString(), expiresAt.toISOString()]);
      const ws = await liveRoom(tx, c.workspace_id);
      if (ws) {
        await appendEvent(tx, { action: 'person.email_change_approved', workspaceId: ws, resourceType: 'person', resourceId: c.person_id,
          data: { person_id: c.person_id, requested_by: c.requested_by }, occurredAt: now, requestId: req.id,
          context: { ip: req.ip, userAgent: userAgent(req),
            personal: { before: { email: c.old_email }, after: { email: c.new_email } }, subjectPersonId: c.person_id } });
      }
      const requestedBy = (await tx.query<{ name: string }>(`select name from person where id = $1`, [c.requested_by])).rows[0]?.name ?? 'Your room admin';
      const s: Started = { token, code, personId: c.person_id, oldEmail: c.old_email, newEmail: c.new_email, requestedBy, expiresAt, approvalToken: null };
      return { s, ws };
    });
    if (!out) throw linkGone();
    const emailStatus = await sendCode(req, out.s, out.ws, tenantId);
    return { newEmail: out.s.newEmail, expiresAt: out.s.expiresAt.toISOString(), emailStatus };
  });

  r.post('/v1/public/email-change/decline', {
    schema: {
      summary: 'Refuse, from the current address, a sign-in address change. Nothing changes. Logged',
      body: z.object({ token: z.string().regex(TOKEN) }),
      response: { 204: z.null() },
    },
  }, async (req, reply) => {
    const tenantId = req.body.token.split('.')[0]!;
    const now = app.now();
    const ok = await app.inTenantId(tenantId, async (tx) => {
      const c = await approvalRow(tx, req.body.token, now);
      if (!c) return false;
      await tx.query(`update email_change set status = 'declined', closed_at = $2 where id = $1`, [c.id, now.toISOString()]);
      const ws = await liveRoom(tx, c.workspace_id);
      if (ws) {
        await appendEvent(tx, { action: 'person.email_change_declined', workspaceId: ws, resourceType: 'person', resourceId: c.person_id,
          data: { person_id: c.person_id, requested_by: c.requested_by }, occurredAt: now, requestId: req.id,
          context: { ip: req.ip, userAgent: userAgent(req),
            personal: { before: { email: c.old_email }, after: { email: c.new_email } }, subjectPersonId: c.person_id } });
      }
      return true;
    });
    if (!ok) throw linkGone();
    return reply.code(204).send(null);
  });

  r.get('/v1/public/email-change/:token', {
    schema: {
      summary: 'Look up an email-change link. 410 for any link that does not work',
      params: z.object({ token: z.string().max(200) }),
      response: { 200: z.object({ newEmail: z.string(), expiresAt: z.string() }) },
    },
  }, async (req) => {
    const token = req.params.token;
    if (!TOKEN.test(token)) throw linkGone();
    const now = app.now();
    return app.inTenantId(token.split('.')[0]!, async (tx) => {
      const row = (await tx.query<{ new_email: string; expires_at: string; status: string }>(
        `select c.new_email, c.expires_at, c.status from email_change c join person p on p.id = c.person_id
          where c.token_sha256 = $1 and p.erased_at is null and p.disabled_at is null
            and (c.approval_token_sha256 is null or c.approved_at is not null)`, [sha(token)])).rows[0];
      if (!row || row.status !== 'pending' || new Date(row.expires_at) <= now) throw linkGone();
      return { newEmail: row.new_email, expiresAt: new Date(row.expires_at).toISOString() };
    });
  });

  r.post('/v1/public/email-change/confirm', {
    schema: {
      summary: 'Confirm a new sign-in address with the emailed code. '
        + `The link stops working after ${EMAIL_CHANGE_MAX_WRONG} wrong codes`,
      body: z.object({ token: z.string().regex(TOKEN), code: z.string().regex(/^\d{6}$/) }),
      response: { 200: z.object({ email: z.string(), sessionsEnded: z.number().int() }) },
    },
  }, async (req) => {
    const { token, code } = req.body;
    const tenantId = token.split('.')[0]!;
    const now = app.now();
    type Outcome =
      | { kind: 'gone' }
      | { kind: 'wrong'; left: number }
      | { kind: 'taken' }
      | { kind: 'done'; personId: string; oldEmail: string; newEmail: string; sessionsEnded: number; timeZone: string;
          brand: Awaited<ReturnType<typeof mailBranding>> };
    // don't throw: must commit to count wrong codes
    const out = await app.inTenantId(tenantId, async (tx): Promise<Outcome> => {
      const c = (await tx.query<{ id: string; person_id: string; old_email: string; new_email: string; code_sha256: string; expires_at: string;
        status: string; wrong_codes: number; requested_by: string; workspace_id: string | null; awaiting: boolean; approved: boolean }>(
        `select id, person_id, old_email, new_email, code_sha256, expires_at, status, wrong_codes, requested_by, workspace_id,
                approval_token_sha256 is not null and approved_at is null as awaiting, approved_at is not null as approved
           from email_change where token_sha256 = $1 for update`, [sha(token)])).rows[0];
      if (!c || c.status !== 'pending' || c.awaiting) return { kind: 'gone' };
      if (new Date(c.expires_at) <= now) {
        await tx.query(`update email_change set status = 'expired', closed_at = $2 where id = $1`, [c.id, now.toISOString()]);
        return { kind: 'gone' };
      }
      const p = (await tx.query<{ email: string; time_zone: string | null }>(
        `select email, time_zone from person where id = $1 and erased_at is null and disabled_at is null`, [c.person_id])).rows[0];
      if (!p) return { kind: 'gone' };
      // before the code is even looked at: a request that no longer stands is closed, whatever the code
      if (!(await stillStands(tx, c, now))) {
        await tx.query(`update email_change set status = 'expired', closed_at = $2 where id = $1`, [c.id, now.toISOString()]);
        return { kind: 'gone' };
      }
      const right = Buffer.from(codeHash(c.id, code));
      if (!timingSafeEqual(right, Buffer.from(c.code_sha256))) {
        const wrong = c.wrong_codes + 1;
        const locked = wrong >= EMAIL_CHANGE_MAX_WRONG;
        await tx.query(`update email_change set wrong_codes = $2, status = $3, closed_at = $4 where id = $1`,
          [c.id, wrong, locked ? 'locked' : 'pending', locked ? now.toISOString() : null]);
        return locked ? { kind: 'gone' } : { kind: 'wrong', left: EMAIL_CHANGE_MAX_WRONG - wrong };
      }
      if (await addressTaken(tx, c.new_email, c.person_id)) return { kind: 'taken' };

      const userId = await loginOf(tx, c.person_id, p.email);
      await tx.query(`update person set email = $2, updated_at = $3 where id = $1`, [c.person_id, c.new_email, now.toISOString()]);
      // person trigger unbinds auth_person; rebind
      let sessionsEnded = 0;
      if (userId) {
        await tx.query(`update auth_person set user_id = $2 where person_id = $1`, [c.person_id, userId]);
        await tx.query(`update auth_user set email = $2, email_verified = true, updated_at = $3 where id = $1`, [userId, c.new_email, now.toISOString()]);
        sessionsEnded = (await tx.query(`delete from auth_session where user_id = $1 returning 1`, [userId])).rows.length;
        await tx.query(`delete from auth_verification where value = $1 and identifier like '2fa-%'`, [userId]);
      }
      await tx.query(
        `delete from auth_verification where identifier = 'sign-in-otp-' || $1
            or (identifier like 'magic-link:%' and (case when identifier like 'magic-link:%' then (value::jsonb ->> 'email') end) = $1)`,
        [c.old_email]);
      await tx.query(`update email_change set status = 'confirmed', closed_at = $2 where id = $1`, [c.id, now.toISOString()]);

      const context = { ip: req.ip, userAgent: userAgent(req),
        personal: { before: { email: c.old_email }, after: { email: c.new_email } }, subjectPersonId: c.person_id };
      const rooms = [...new Set([...(c.workspace_id ? [c.workspace_id] : []), ...(await allRooms(tx, c.person_id, now))])];
      let live: string[] = [];
      if (rooms.length) {
        const { rows } = await tx.query<{ id: string }>(`select id from workspace where id = any($1::uuid[]) and state <> 'deleted'`, [rooms]);
        live = rows.map((x) => x.id);
      }
      for (const ws of rooms.filter((x) => live.includes(x))) {
        await appendEvent(tx, { action: 'person.email_changed', workspaceId: ws, resourceType: 'person', resourceId: c.person_id,
          data: { person_id: c.person_id, requested_by: c.requested_by, sessions_ended: sessionsEnded }, occurredAt: now, requestId: req.id, context });
      }
      await appendEvent(tx, { action: 'site.person.email_changed', resourceType: 'site', resourceId: tenantId,
        data: { actor_person_id: c.person_id, person_id: c.person_id, requested_by: c.requested_by, sessions_ended: sessionsEnded },
        occurredAt: now, requestId: req.id, context });
      return { kind: 'done', personId: c.person_id, oldEmail: c.old_email, newEmail: c.new_email, sessionsEnded, timeZone: p.time_zone ?? 'UTC',
        brand: await mailBranding(tx, app.deps.storage, app.deps.publicUrl) };
    });

    if (out.kind === 'gone') throw linkGone();
    if (out.kind === 'wrong') {
      throw badRequest(out.left === 1 ? 'That code is not right. You have 1 more try.' : `That code is not right. You have ${out.left} more tries.`);
    }
    if (out.kind === 'taken') {
      throw conflict('This address is now used by another account, so it cannot be yours. Ask your room admin to choose another.', 'email_taken');
    }
    const mail = emailChangedNoticeEmail({ brand: out.brand, oldEmail: out.oldEmail, newEmail: out.newEmail, changedAt: now, timeZone: out.timeZone });
    const res = await deliver(toMessage(mail, out.personId, out.oldEmail));
    await app.inTenantId(tenantId, (tx) => appendEvent(tx, {
      action: res.status === 'accepted' ? 'site.person.email_changed_notice_sent' : 'site.person.email_changed_notice_not_sent',
      resourceType: 'site', resourceId: tenantId, requestId: req.id,
      data: { actor_person_id: out.personId, person_id: out.personId, recipient_person_id: out.personId, channel: 'email', delivery_status: res.status,
        ...(res.error ? { error: res.error } : {}) },
    }));
    return { email: out.newEmail, sessionsEnded: out.sessionsEnded };
  });
};
