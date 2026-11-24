// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, type SqlClient } from '@vdrkit/core';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { personOf, refuseIfArchived, requireWorkspaceAdmin } from './util.js';
import { conflict, currentMembership, endless, endMembership, greetingName, hasEnded, HOLDING_STATES, inRoomsNotRunBy, sendInvites, type NewInvite } from './people.js';
import { Company, FamilyName, GivenName, JobTitle, readDetails, recordDetailsChange, roomsOf, type PersonDetails } from './profile.js';
import { mailBranding } from '../mail/branding.js';
import { ndaReminderEmail, toMessage } from '../mail/templates.js';
import { mailEvent } from '../mail/proof.js';

const WsParams = z.object({ ws: z.string().uuid() });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const INVITE_LINK_DAYS = 14;

export const peopleAdminRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.patch('/v1/workspaces/:ws/groups/:id', {
    schema: {
      summary: 'Edit a group: name, organisation and access end date. Logged',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({
        name: z.string().trim().min(1).max(120).optional(),
        organisation: z.string().trim().max(200).nullable().optional(),
        accessEndsAt: z.string().datetime().nullable().optional(),
      }).strict(),
      response: { 200: z.object({ id: z.string().uuid(), membershipsChanged: z.number().int() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, id } = req.params;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    await refuseIfArchived(tx, ws);
    // ended groups are history, don't touch
    const g = (await tx.query<any>(
      `select g.id, g.name, g.organisation, g.valid_to, g.parent_group_id, g.role_template, p.valid_to as parent_ends_at
         from groups g left join groups p on p.id = g.parent_group_id
        where g.id = $1 and g.workspace_id = $2 and g.valid_from <= $3 and $3 < g.valid_to`, [id, ws, now.toISOString()])).rows[0];
    if (!g) throw notFound();
    const b = req.body;
    const iso = (v: unknown) => (endless(v) ? null : new Date(v as string).toISOString());
    const before = { name: g.name as string, organisation: (g.organisation ?? null) as string | null, accessEndsAt: iso(g.valid_to) };
    let accessEndsAt = before.accessEndsAt;
    if (b.accessEndsAt !== undefined) accessEndsAt = b.accessEndsAt ? new Date(b.accessEndsAt).toISOString() : null;
    const after = {
      name: b.name ?? before.name,
      organisation: b.organisation === undefined ? before.organisation : (b.organisation || null),
      accessEndsAt,
    };
    let changed = 0;
    if (after.accessEndsAt !== before.accessEndsAt) {
      if (g.role_template === 'admin') throw badRequest('The room admin group has no end date. Room admins keep access until the room closes.');
      const until = after.accessEndsAt ? new Date(after.accessEndsAt) : null;
      if (until && until <= now) throw badRequest('To end access now, revoke the group instead.');
      const parentEnd = iso(g.parent_ends_at);
      if (g.parent_group_id && parentEnd && (!until || until > new Date(parentEnd))) {
        throw badRequest('A subgroup cannot have access longer than its parent group. Change the parent group first.');
      }
      const subs = (await tx.query<{ id: string; valid_to: unknown }>(
        `select id, valid_to from groups where parent_group_id = $1 and valid_from <= $2 and $2 < valid_to`, [id, now.toISOString()])).rows;
      const plan: { gid: string; from: string | null; to: Date | null }[] = [{ gid: id, from: before.accessEndsAt, to: until }];
      // never extend a subgroup's own earlier end date
      for (const s of subs) {
        const own = iso(s.valid_to);
        let to: Date | null;
        if (own === null || own === before.accessEndsAt) to = until;
        else to = until && until < new Date(own) ? until : new Date(own);
        if (iso(to?.toISOString() ?? 'infinity') !== own) plan.push({ gid: s.id, from: own, to });
      }
      for (const { gid, to } of plan) {
        await tx.query(`update groups set valid_to = coalesce($2::timestamptz, 'infinity') where id = $1`, [gid, to?.toISOString() ?? null]);
      }
      // lock order: group, then person (deadlocks otherwise)
      for (const { gid, from, to } of [...plan].sort((x, y) => (x.gid < y.gid ? -1 : 1))) {
        if (from === null) continue;
        const ms = (await tx.query<{ id: string }>(
          `select distinct on (person_id) id from membership where group_id = $1 and superseded_at = 'infinity' order by person_id, valid_from desc`,
          [gid])).rows;
        for (const m of ms) {
          const cur = await currentMembership(tx, m.id, ws);
          if (!cur || hasEnded(cur, now) || iso(cur.valid_to) !== from) continue;
          await endMembership(tx, m.id, ws, now, to ?? new Date(8.64e15), false, null);
          changed++;
        }
      }
    }
    await tx.query(`update groups set name = $2, organisation = $3 where id = $1`, [id, after.name, after.organisation]);
    const fields = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k]);
    if (fields.length) {
      await appendEvent(tx, { action: 'group.details_changed', workspaceId: ws, actorId: caller.actorId, resourceType: 'group', resourceId: id,
        data: { fields, before, after, memberships_changed: changed }, occurredAt: now, requestId: req.id });
    }
    return { id, membershipsChanged: changed };
  }));

  r.post('/v1/workspaces/:ws/memberships/:id/remind', {
    schema: {
      summary: 'Send a reminder. Room admins only, once per person and group per hour; 409 for bidder groups while the room is preparing or closed',
      params: WsParams.extend({ id: z.string().uuid() }),
      response: {
        200: z.object({
          reason: z.enum(['invitation', 'nda']),
          sentTo: z.string(),
          expiresAt: z.string().nullable(),
          delivery: z.string(),
        }),
      },
    },
  }, async (req) => {
    const { ws, id } = req.params;
    const now = app.now();
    const plan = await app.inTenant(req, async (tx, caller) => {
      await requireWorkspaceAdmin(tx, caller, ws, now);
      await refuseIfArchived(tx, ws);
      const m = await currentMembership(tx, id, ws);
      if (!m) throw notFound();
      const g = (await tx.query<{ valid: boolean; kind: string; requires_nda: boolean; room: string; state: string }>(
        `select g.valid_from <= $2 and $2 < g.valid_to as valid, pa.kind, w.requires_nda, w.name as room, w.state
           from groups g join party pa on pa.id = g.party_id join workspace w on w.id = g.workspace_id where g.id = $1`,
        [m.group_id, now.toISOString()])).rows[0]!;
      if (!g.valid || hasEnded(m, now)) throw conflict('Access has ended', 'This person no longer has access. Invite them again instead.');
      const p = (await tx.query<{ email: string; given_name: string; name: string; erased: boolean; disabled: boolean }>(
        `select email, given_name, name, erased_at is not null as erased, disabled_at is not null as disabled from person where id = $1`, [m.person_id])).rows[0]!;
      if (p.erased) throw notFound();
      // disabled accounts get no room email
      if (p.disabled) {
        throw new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Account disabled', status: 409, reason: 'account_disabled',
          detail: `A site admin disabled the account of ${p.name}, so no reminder can be sent. Ask a site admin.` });
      }
      const ndaOpen = m.status === 'active' && g.kind !== 'seller' && g.requires_nda
        && !(await tx.query<{ ok: boolean }>(`select nda_accepted($1, $2, record_clock()) as ok`, [m.person_id, ws])).rows[0]?.ok;
      if (m.status !== 'approved' && !ndaOpen) throw conflict('Nothing to remind', 'This person has signed in and accepted the NDA.');
      if (g.kind !== 'seller' && HOLDING_STATES.includes(g.state)) {
        const waiting = m.status === 'approved' && (await tx.query<{ w: boolean }>(
          `select waits_for_room as w from invitation where membership_id = $1 order by created_at desc limit 1`, [m.id])).rows[0]?.w;
        if (waiting) throw conflict('Invitation not sent yet', `The invitation to ${p.name} goes out when you open the room. There is nothing to send again before then.`);
        const state = g.state === 'closed' ? 'closed' : 'being prepared';
        throw conflict('The room is not open', `${p.name} cannot enter while the room is ${state}. Send the reminder after you open the room.`);
      }
      const recent = (await tx.query(
        `select 1 from event e where e.workspace_id = $1 and e.action = 'invitation.reminded' and e.data ->> 'person_id' = $2
            and e.data ->> 'group_id' = $3 and e.occurred_at > $4::timestamptz - interval '1 hour' limit 1`,
        [ws, m.person_id, m.group_id, now.toISOString()])).rows.length;
      if (recent) {
        throw new HttpProblem({ type: 'https://vdrkit.com/problems/rate-limited', title: 'Reminder already sent', status: 429,
          detail: `A reminder went to ${p.name} less than an hour ago. Try again later.` });
      }
      if (m.status === 'approved') {
        const inv = (await tx.query<any>(
          `select id, status, message, access_expires_at, waits_for_room from invitation where membership_id = $1 order by created_at desc limit 1`, [m.id])).rows[0];
        if (!inv || inv.status !== 'pending') throw conflict('No open invitation', 'There is no open invitation to send again. Invite the person again instead.');
        // new token: the earlier email's link stops working
        const tenant = (await tx.query<{ t: string }>(`select current_tenant_id()::text as t`)).rows[0]!.t;
        const token = `${tenant}.${randomBytes(32).toString('base64url')}`;
        const expiresAt = new Date(now.getTime() + INVITE_LINK_DAYS * 86_400_000);
        await tx.query(`update invitation set token_sha256 = $2, expires_at = $3, waits_for_room = false, sent_at = coalesce(sent_at, $4) where id = $1`,
          [inv.id, sha(token), expiresAt.toISOString(), now.toISOString()]);
        await appendEvent(tx, { action: 'invitation.reminded', workspaceId: ws, actorId: caller.actorId, resourceType: 'invitation', resourceId: inv.id,
          data: { person_id: m.person_id, group_id: m.group_id, reason: 'invitation' }, occurredAt: now, requestId: req.id });
        const invite: NewInvite = {
          invitationId: inv.id, personId: m.person_id, email: p.email, givenName: greetingName(p.given_name, p.email), token,
          groupName: m.group_name, expiresAt, role: m.role, accessExpiresAt: inv.access_expires_at ? new Date(inv.access_expires_at) : null,
          message: inv.message ?? null,
        };
        return { reason: 'invitation' as const, invite };
      }
      await appendEvent(tx, { action: 'invitation.reminded', workspaceId: ws, actorId: caller.actorId, resourceType: 'membership', resourceId: m.id,
        data: { person_id: m.person_id, group_id: m.group_id, reason: 'nda' }, occurredAt: now, requestId: req.id });
      return { reason: 'nda' as const, personId: m.person_id as string, email: p.email, givenName: p.given_name, room: g.room, membershipId: m.id as string };
    });
    if (plan.reason === 'invitation') {
      await sendInvites(app, req, ws, [plan.invite], 'invitation_reminder');
      const status = await app.inTenant(req, async (tx) => {
        const { rows } = await tx.query<{ action: string }>(
          `select action from event where resource_id = $1 and action in ('invitation.sent', 'invitation.not_sent') order by seq desc limit 1`,
          [plan.invite.invitationId]);
        return rows[0]?.action;
      });
      return { reason: plan.reason, sentTo: plan.invite.email, expiresAt: plan.invite.expiresAt.toISOString(),
        delivery: status === 'invitation.sent' ? 'accepted' : 'not_sent' };
    }
    const brand = await app.inTenant(req, (tx) => mailBranding(tx, app.deps.storage, app.deps.publicUrl));
    const mail = ndaReminderEmail({ brand, room: plan.room, givenName: greetingName(plan.givenName, plan.email),
      url: `${app.deps.publicUrl.replace(/\/$/, '')}/rooms/${ws}` });
    const result: { status: string; providerMessageId?: string; error?: string } = app.deps.mailer
      ? await app.deps.mailer.send(toMessage(mail, plan.personId, plan.email))
      : { status: 'no_mailer', error: 'No mail server is configured' };
    await app.inTenant(req, async (tx) => {
      const m = mailEvent({ type: 'nda_reminder', personId: plan.personId, to: plan.email, subject: mail.subject, result, extra: { kind: 'nda_reminder' } });
      await appendEvent(tx, { action: result.status === 'accepted' ? 'notification.sent' : 'notification.failed', workspaceId: ws,
        actorId: req.caller?.actorId ?? null, resourceType: 'membership', resourceId: plan.membershipId,
        data: m.data, context: m.context, occurredAt: app.now(), requestId: req.id });
    });
    return { reason: plan.reason, sentTo: plan.email, expiresAt: null, delivery: result.status };
  });

  r.patch('/v1/workspaces/:ws/people/:personId', {
    schema: {
      summary: 'Correct a person’s name, company and role. Room admins only. Logged',
      params: z.object({ ws: z.string().uuid(), personId: z.string().uuid() }),
      body: z.object({
        givenName: GivenName.optional(),
        familyName: FamilyName.optional(),
        company: Company.nullable().optional(),
        jobTitle: JobTitle.nullable().optional(),
      }).strict(),
      response: { 200: z.object({ personId: z.string().uuid(), name: z.string(), givenName: z.string(), familyName: z.string(),
        company: z.string().nullable(), jobTitle: z.string().nullable() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, personId } = req.params;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    await refuseIfArchived(tx, ws);
    if (!(await inRoom(tx, personId, ws, now))) throw notFound();
    const roles = (await tx.query<{ target: boolean; caller: boolean }>(
      `select coalesce((select is_site_admin from person where id = $1), false) as target,
              coalesce((select is_site_admin and disabled_at is null and erased_at is null from person where id = $2), false) as caller`,
      [personId, personOf(caller)])).rows[0]!;
    if (roles.target && !roles.caller) throw forbidden('Only a site admin can change the details of a site admin.', 'target_is_site_admin');
    if (!roles.caller && await inRoomNotRunBy(tx, personId, personOf(caller), now)) {
      throw forbidden('This person is also in a room you do not run, so only a site admin can change their name, company and role.', 'target_in_other_room');
    }
    const before = await readDetails(tx, personId);
    if (!before) throw notFound();
    const b = req.body;
    const after: PersonDetails = {
      givenName: b.givenName ?? before.givenName,
      familyName: b.familyName ?? before.familyName,
      company: b.company === undefined ? before.company : (b.company || null),
      jobTitle: b.jobTitle === undefined ? before.jobTitle : (b.jobTitle || null),
    };
    if (!after.givenName || !after.familyName) throw badRequest('Give both a first name and a last name.');
    await tx.query(`update person set given_name = $2, family_name = $3, company = $4, job_title = $5, updated_at = $6 where id = $1`,
      [personId, after.givenName, after.familyName, after.company, after.jobTitle, now.toISOString()]);
    // roomsOf() skips open invitations
    const rooms = [...new Set([ws, ...(await roomsOf(tx, personId, now)), ...(await invitedRooms(tx, personId, now))])];
    await recordDetailsChange(tx, { personId, before, after, now, actorId: caller.actorId, requestId: req.id, rooms,
      ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    const p = (await tx.query<any>(`select name, given_name, family_name, company, job_title from person where id = $1`, [personId])).rows[0];
    return { personId, name: p.name, givenName: p.given_name, familyName: p.family_name, company: p.company ?? null, jobTitle: p.job_title ?? null };
  }));
};

export async function invitedRooms(tx: SqlClient, personId: string, now: Date): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `select distinct g.workspace_id as id from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
      where m.person_id = $1 and m.superseded_at = 'infinity' and m.status = 'approved' and $2 < m.valid_to
        and not coalesce((m.metadata ->> 'revoked')::boolean, false) and g.valid_from <= $2 and $2 < g.valid_to and w.state <> 'deleted'`,
    [personId, now.toISOString()]);
  return rows.map((r) => r.id);
}

export async function inRoomNotRunBy(tx: SqlClient, personId: string, admin: string, now: Date): Promise<boolean> {
  return (await inRoomsNotRunBy(tx, [personId], admin, now)).has(personId);
}

export async function inRoom(tx: SqlClient, personId: string, ws: string, now: Date): Promise<boolean> {
  const { rows } = await tx.query(
    `select 1 from membership m join groups g on g.id = m.group_id
      where m.person_id = $1 and g.workspace_id = $2 and m.superseded_at = 'infinity' and m.status in ('approved', 'active')
        and $3 < m.valid_to and not coalesce((m.metadata ->> 'revoked')::boolean, false)
        and g.valid_from <= $3 and $3 < g.valid_to limit 1`, [personId, ws, now.toISOString()]);
  return rows.length > 0;
}
