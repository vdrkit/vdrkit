// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, enqueueTeamNews, loadPolicies, memberStanding, resolveForPerson, roomTiming, setGrant, type Channel, type LevelValue, type SqlClient } from '@vdrkit/core';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { personOf, refuseIfArchived, requireMember, requireWorkspaceAdmin, visibleText } from './util.js';
import { linkPersonToLogin } from '../auth/person-link.js';
import { Company, FamilyName, GivenName, IanaTimeZone, JobTitle, readDetails, recordDetailsChange, roomsOf } from './profile.js';
import { defaultSenderName, invitationBody, readInvitationText, signatureText } from './invitation-text.js';
import { brandingFrom, brandingRow, mailBranding } from '../mail/branding.js';
import type { MailBranding } from '../mail/layout.js';
import type { Storage } from '../pipeline/pipeline.js';
import { accessRestoredEmail, colleagueRequestEmail, invitationEmail, notificationsUrl, requestDecisionEmail, toMessage } from '../mail/templates.js';
import { mailEvent } from '../mail/proof.js';
import { sellerNameSql } from './seller.js';

const WsParams = z.object({ ws: z.string().uuid() });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const NAME = `case when p.erased_at is not null then 'Erased user' else p.name end`;
const EMAIL = `case when p.erased_at is not null then '' else p.email end`;
// driver gives 'infinity' as string, number or invalid Date
export const endless = (v: unknown) => v === 'infinity' || v === Infinity || v == null || (v instanceof Date && Number.isNaN(v.getTime()));
const INVITE_LINK_DAYS = 14;
export const conflict = (title: string, detail: string) => new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title, status: 409, detail });
const UNIQUE_VIOLATION = '23505';
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{20,}$/;

const invalidInvitation = () => new HttpProblem({ type: 'https://vdrkit.com/problems/invalid-invitation', title: 'This link does not work', status: 410,
  detail: 'The invitation link is no longer valid. Ask the room administrator to invite you again.' });

export function greetingName(given: string | null, email: string): string {
  return given && given !== email ? given : '';
}

const sendFailed = (e: unknown) => ({ status: 'failed' as const, error: e instanceof Error ? e.message.slice(0, 200) : 'failed' });

export interface Invitee { email: string; givenName?: string; familyName?: string; name?: string; company?: string; jobTitle?: string;
  role?: string }
export interface NewInvite {
  invitationId: string; personId: string; email: string; givenName: string; token: string; groupName: string; expiresAt: Date;
  role: string; accessExpiresAt: Date | null; message: string | null;
  waits?: boolean;
  invitedBy?: string | null;
}

export const HOLDING_STATES = ['preparing', 'closed'];
export const OPEN_STATES = ['open', 'frozen'];

// nobody on both sides of one room, open invitations and later starts included
export async function refuseBothSides(tx: SqlClient, a: { personId: string; workspaceId: string; buy: boolean; who: string; now: Date }): Promise<void> {
  const { rows } = await tx.query<{ across: boolean; contributes: boolean }>(
    `select exists (select 1 from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
                     where m.person_id = $1 and g.workspace_id = $2 and m.superseded_at = 'infinity' and m.status in ('approved', 'active')
                       and $3 < m.valid_to and not coalesce((m.metadata ->> 'revoked')::boolean, false) and $3 < g.valid_to
                       and (pa.kind in ('bidder', 'financier')) <> $4) as across,
            exists (select 1 from access_grant ag
                     where ag.workspace_id = $2 and ag.subject_person_id = $1 and ag.effect = 'allow' and ag.superseded_at = 'infinity'
                       and $3 < ag.valid_to and (ag.can_upload or ag.can_manage or ag.can_publish)) as contributes`,
    [a.personId, a.workspaceId, a.now.toISOString(), a.buy]);
  const r = rows[0]!;
  if (r.across) {
    throw badRequest(a.buy
      ? `${a.who} is on the seller side of this room, so they cannot join a bidder group. Nobody can be on both sides of a room. Revoke their seller access first.`
      : `${a.who} is in a bidder group of this room, so they cannot join the seller side. Nobody can be on both sides of a room. Revoke their bidder access first.`);
  }
  if (a.buy && r.contributes) {
    throw badRequest(`${a.who} may still add files or publish in this room, set for them by name in Permissions. Take that away before they join a bidder group.`);
  }
}

export async function invite(tx: SqlClient, a: {
  workspaceId: string; groupId: string; people: Invitee[]; role: string;
  accessExpiresAt: Date | null; message: string | null; invitedBy: string | null; actorId: string | null; now: Date; requestId: string;
}): Promise<NewInvite[]> {
  const g = (await tx.query<{ name: string; valid: boolean; valid_to: unknown; parent_group_id: string | null; seller: boolean; buy: boolean; state: string }>(
    `select g.name, g.valid_from <= $2 and $2 < g.valid_to as valid, g.valid_to, g.parent_group_id, pa.kind = 'seller' as seller,
            pa.kind in ('bidder', 'financier') as buy, w.state
       from groups g join party pa on pa.id = g.party_id join workspace w on w.id = g.workspace_id where g.id = $1 and g.workspace_id = $3`,
    [a.groupId, a.now.toISOString(), a.workspaceId])).rows[0];
  if (!g) throw badRequest('That group is not part of this room.');
  const waits = !g.seller && HOLDING_STATES.includes(g.state);
  if (!g.valid) throw badRequest('That group has been revoked.');
  if (g.parent_group_id && a.people.some((p) => (p.role ?? a.role) === 'lead')) throw badRequest(NO_SUBGROUP_LEADS);
  const accessExpiresAt = a.accessExpiresAt ?? (endless(g.valid_to) ? null : new Date(g.valid_to as string));
  const out: NewInvite[] = [];
  for (const p of a.people) {
    const email = p.email.trim().toLowerCase();
    const role = p.role ?? a.role;
    const person = (await tx.query<{ id: string; given_name: string; disabled: boolean }>(
      `insert into person (tenant_id, name, given_name, family_name, email, company, job_title)
       values (current_tenant_id(), $1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, email) do update set email = excluded.email returning id, given_name, disabled_at is not null as disabled`,
      [p.name ?? email, p.givenName ?? '', p.familyName ?? '', email, p.company || null, p.jobTitle || null])).rows[0]!;
    if (person.disabled) throw badRequest(`${email} belongs to a disabled account, so it cannot be invited. A site admin disabled it.`);
    const already = await tx.query(
      `select 1 from membership where person_id = $1 and group_id = $2 and superseded_at = 'infinity' and status in ('approved', 'active')
          and $3 < valid_to and not coalesce((metadata ->> 'revoked')::boolean, false)`,
      [person.id, a.groupId, a.now.toISOString()]);
    if (already.rows.length) throw badRequest(`${email} is already a member of this group or has an open invitation.`);
    await refuseBothSides(tx, { personId: person.id, workspaceId: a.workspaceId, buy: g.buy, who: email, now: a.now });
    const membership = (await tx.query<{ id: string }>(
      `insert into membership (tenant_id, person_id, group_id, role, status, valid_to, recorded_at)
       values (current_tenant_id(), $1, $2, $3, 'approved', coalesce($4::timestamptz, 'infinity'), $5) returning id`,
      [person.id, a.groupId, role, accessExpiresAt?.toISOString() ?? null, a.now.toISOString()])).rows[0]!.id;
    const secret = randomBytes(32).toString('base64url');
    const tenant = (await tx.query<{ t: string }>(`select current_tenant_id()::text as t`)).rows[0]!.t;
    const token = `${tenant}.${secret}`;
    const expiresAt = new Date(a.now.getTime() + INVITE_LINK_DAYS * 86_400_000);
    const inv = (await tx.query<{ id: string }>(
      `insert into invitation (tenant_id, workspace_id, group_id, person_id, membership_id, invited_by, message, token_sha256, expires_at, access_expires_at,
                               created_at, waits_for_room, sent_at)
       values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [a.workspaceId, a.groupId, person.id, membership, a.invitedBy, a.message, sha(token), expiresAt.toISOString(),
        accessExpiresAt?.toISOString() ?? null, a.now.toISOString(), waits, waits ? null : a.now.toISOString()])).rows[0]!.id;
    await appendEvent(tx, { action: 'invitation.created', workspaceId: a.workspaceId, actorId: a.actorId, resourceType: 'invitation', resourceId: inv,
      data: { person_id: person.id, group_id: a.groupId, role, access_expires_at: accessExpiresAt?.toISOString() ?? null, ...(waits ? { waits_for_room: true } : {}) },
      occurredAt: a.now, requestId: a.requestId });
    if (waits) {
      await appendEvent(tx, { action: 'invitation.held', workspaceId: a.workspaceId, actorId: a.actorId, resourceType: 'invitation', resourceId: inv,
        data: { person_id: person.id, group_id: a.groupId, room_state: g.state }, occurredAt: a.now, requestId: a.requestId });
    }
    out.push({ invitationId: inv, personId: person.id, email, givenName: person.given_name, token, groupName: g.name, expiresAt,
      role, accessExpiresAt, message: a.message, waits });
  }
  return out;
}

export interface InviteMailDeps { mailer?: Channel | undefined; storage?: Storage | undefined; publicUrl: string; now: () => Date }
export type TenantRun = <T>(fn: (tx: SqlClient) => Promise<T>) => Promise<T>;

export async function sendInvites(app: FastifyInstance, req: FastifyRequest, workspaceId: string, invites: NewInvite[],
  type: 'invitation' | 'invitation_reminder' = 'invitation') {
  await deliverInvites({ ...app.deps, now: () => app.now() }, (fn) => app.inTenant(req, (tx) => fn(tx)), workspaceId,
    invites.filter((i) => !i.waits), { type, actorId: req.caller?.actorId ?? null, requestId: req.id, senderPersonId: req.caller ? personOf(req.caller) : null });
}

export async function deliverInvites(deps: InviteMailDeps, run: TenantRun, workspaceId: string, invites: NewInvite[],
  o: { type: 'invitation' | 'invitation_reminder'; actorId: string | null; requestId?: string | null; senderPersonId: string | null }) {
  if (invites.length === 0) return;
  const signer = (inv: NewInvite) => (inv.invitedBy !== undefined ? inv.invitedBy : o.senderPersonId);
  const { tz, text, senders, runBy, room, brand } = await run(async (tx) => {
    const w = (await tx.query<{ time_zone: string; run_by: string; name: string }>(
      `select w.time_zone, w.name, t.name as run_by from workspace w join tenant t on t.id = w.tenant_id where w.id = $1`, [workspaceId])).rows[0]!;
    const ids = [...new Set(invites.map(signer).filter((x): x is string => !!x))];
    const senders = new Map((await tx.query<{ id: string; name: string }>(
      `select id, name from person where id = any($1::uuid[]) and erased_at is null`, [ids])).rows.map((r) => [r.id, r.name] as const));
    return { tz: w.time_zone, text: await readInvitationText(tx, workspaceId), senders, runBy: w.run_by, room: w.name,
      brand: await mailBranding(tx, deps.storage, deps.publicUrl) };
  });
  type Sent = { inv: NewInvite; subject: string; status: string; providerMessageId?: string; error?: string };
  const results: Sent[] = [];
  const baseUrl = deps.publicUrl.replace(/\/$/, '');
  for (const inv of invites) {
    const id = signer(inv);
    const sender = id ? senders.get(id) ?? null : null;
    const fromName = text.senderName || defaultSenderName(sender, runBy);
    const body = invitationBody({ message: inv.message ?? text.message, leadParagraph: text.leadParagraph, role: inv.role,
      groupName: inv.groupName, givenName: inv.givenName, until: inv.accessExpiresAt, timeZone: tz, signature: signatureText(sender, runBy) });
    const email: Parameters<typeof invitationEmail>[0] = { brand, room, subject: text.subject, message: body.message,
      leadParagraph: body.lead, url: `${baseUrl}/invite/${inv.token}`, to: inv.email, linkDays: INVITE_LINK_DAYS };
    if (fromName) email.fromName = fromName;
    if (text.replyTo) email.replyTo = text.replyTo;
    const mail = invitationEmail(email);
    if (!deps.mailer) {
      results.push({ inv, subject: mail.subject, status: 'no_mailer', error: 'No mail server is configured' });
      continue;
    }
    const r = await deps.mailer.send(toMessage(mail, inv.personId, inv.email));
    const sent: Sent = { inv, subject: mail.subject, status: r.status };
    if (r.providerMessageId) sent.providerMessageId = r.providerMessageId;
    if (r.error) sent.error = r.error;
    results.push(sent);
  }
  await run(async (tx) => {
    for (const r of results) {
      const m = mailEvent({ type: o.type, personId: r.inv.personId, to: r.inv.email, subject: r.subject, result: r });
      await appendEvent(tx, { action: r.status === 'accepted' ? 'invitation.sent' : 'invitation.not_sent', workspaceId, actorId: o.actorId,
        resourceType: 'invitation', resourceId: r.inv.invitationId, data: m.data, context: m.context,
        occurredAt: deps.now(), requestId: o.requestId ?? null });
    }
  });
}

const WAITING_SQL = `
  from invitation i
  join groups g on g.id = i.group_id
  join person p on p.id = i.person_id
  join membership m on m.id = i.membership_id
 where i.workspace_id = $1 and i.waits_for_room and i.status = 'pending'
   and g.valid_from <= $2 and $2 < g.valid_to and p.erased_at is null and p.disabled_at is null
   and m.superseded_at = 'infinity' and m.status = 'approved' and $2 < m.valid_to and not coalesce((m.metadata ->> 'revoked')::boolean, false)`;

export async function countWaitingInvitations(tx: SqlClient, workspaceId: string, now: Date): Promise<number> {
  return Number((await tx.query<{ n: number }>(`select count(*)::int as n ${WAITING_SQL}`, [workspaceId, now.toISOString()])).rows[0]?.n ?? 0);
}

// claim and commit before sending: a retry must never send twice
export async function releaseWaitingInvitations(deps: InviteMailDeps, run: TenantRun, workspaceId: string,
  o: { actorId: string | null; requestId?: string | null }): Promise<{ sent: number; notSent: number }> {
  const invites = await run(async (tx) => {
    const now = deps.now();
    const state = (await tx.query<{ state: string }>(`select state from workspace where id = $1`, [workspaceId])).rows[0]?.state;
    if (!state || !OPEN_STATES.includes(state)) return [];
    const rows = (await tx.query<any>(
      `select i.id, i.person_id, i.message, i.access_expires_at, i.invited_by, m.role, g.name as group_name, p.email, p.given_name
       ${WAITING_SQL} order by i.created_at, i.id for update of i skip locked`, [workspaceId, now.toISOString()])).rows;
    if (!rows.length) return [];
    const tenant = (await tx.query<{ t: string }>(`select current_tenant_id()::text as t`)).rows[0]!.t;
    const expiresAt = new Date(now.getTime() + INVITE_LINK_DAYS * 86_400_000);
    const out: NewInvite[] = [];
    for (const r of rows) {
      const token = `${tenant}.${randomBytes(32).toString('base64url')}`;
      await tx.query(`update invitation set token_sha256 = $2, expires_at = $3, waits_for_room = false, sent_at = $4 where id = $1`,
        [r.id, sha(token), expiresAt.toISOString(), now.toISOString()]);
      out.push({ invitationId: r.id, personId: r.person_id, email: r.email, givenName: greetingName(r.given_name, r.email),
        token, groupName: r.group_name, expiresAt, role: r.role, accessExpiresAt: r.access_expires_at ? new Date(r.access_expires_at) : null,
        message: r.message ?? null, invitedBy: r.invited_by ?? null });
    }
    return out;
  });
  await deliverInvites(deps, run, workspaceId, invites, { type: 'invitation', actorId: o.actorId, requestId: o.requestId ?? null, senderPersonId: null });
  if (!invites.length) return { sent: 0, notSent: 0 };
  const sent = await run(async (tx) => Number((await tx.query<{ n: number }>(
    `select count(*)::int as n from event where action = 'invitation.sent' and resource_id = any($1::uuid[])`,
    [invites.map((i) => i.invitationId)])).rows[0]?.n ?? 0));
  return { sent, notSent: invites.length - sent };
}

// Held to the end of the transaction. A second change to the same membership waits, then reads what the first one left
async function lockMembership(tx: SqlClient, personId: string, groupId: string) {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`membership:${personId}:${groupId}`]);
}

async function supersede(tx: SqlClient, membershipId: string, now: Date) {
  const { rows } = await tx.query(`update membership set superseded_at = $2 where id = $1 and superseded_at = 'infinity' returning id`,
    [membershipId, now.toISOString()]);
  if (rows.length === 0) throw conflict('Changed just now', 'Someone else changed this membership a moment ago. Reload the page and try again.');
}

export async function currentMembership(tx: SqlClient, membershipId: string, workspaceId: string) {
  const of = (await tx.query<{ person_id: string; group_id: string }>(
    `select x.person_id, x.group_id from membership x join groups g on g.id = x.group_id where x.id = $1 and g.workspace_id = $2`,
    [membershipId, workspaceId])).rows[0];
  if (!of) return undefined;
  await lockMembership(tx, of.person_id, of.group_id);
  return (await tx.query<any>(
    `select l.id, l.person_id, l.group_id, l.role, l.valid_from, l.valid_to, l.status, l.metadata, g.role_template, g.name as group_name,
            g.parent_group_id
       from membership x
       join groups g on g.id = x.group_id
       join lateral (select * from membership y where y.person_id = x.person_id and y.group_id = x.group_id and y.superseded_at = 'infinity'
                     order by y.valid_from desc limit 1) l on true
      where x.id = $1 and g.workspace_id = $2`, [membershipId, workspaceId])).rows[0];
}

export const hasEnded = (m: any, now: Date) => !!m.metadata?.revoked || (!endless(m.valid_to) && new Date(m.valid_to) <= now);

export async function endMembership(tx: SqlClient, membershipId: string, workspaceId: string, now: Date, until: Date, revoked: boolean, actor: string | null) {
  const m = await currentMembership(tx, membershipId, workspaceId);
  if (!m) throw notFound();
  if (hasEnded(m, now)) {
    throw badRequest('This membership has already ended. Invite the person again to give them access.');
  }
  await supersede(tx, m.id, now);
  const extra = revoked ? { revoked: true, revoked_by: actor, revoked_at: now.toISOString() } : {};
  const id = (await tx.query<{ id: string }>(
    `insert into membership (tenant_id, person_id, group_id, role, status, valid_from, valid_to, recorded_at, metadata)
     select tenant_id, person_id, group_id, role, status, valid_from, $2, $3, metadata || $4::jsonb from membership where id = $1
     returning id`, [m.id, until.toISOString(), now.toISOString(), JSON.stringify(extra)])).rows[0]!.id;
  await tx.query(`update invitation set membership_id = $2 where membership_id = $1`, [m.id, id]);
  return { previous: m, id };
}

interface Revocation { membershipId: string; workspaceId: string; now: Date; byPerson: string; actorId: string | null; requestId: string }

async function revokeMembership(tx: SqlClient, a: Revocation) {
  const { previous, id } = await endMembership(tx, a.membershipId, a.workspaceId, a.now, a.now, true, a.byPerson);
  await tx.query(`update invitation set status = 'revoked' where membership_id = $1 and status = 'pending'`, [id]);
  await appendEvent(tx, { action: 'membership.revoked', workspaceId: a.workspaceId, actorId: a.actorId, resourceType: 'membership', resourceId: id,
    data: { person_id: previous.person_id, group_id: previous.group_id, role: previous.role }, occurredAt: a.now, requestId: a.requestId });
  return id;
}

const NO_SUBGROUP_LEADS = 'Only main groups have leads. People in a subgroup are members.';

async function changeRole(tx: SqlClient, membershipId: string, workspaceId: string, now: Date, role: 'lead' | 'member') {
  const m = await currentMembership(tx, membershipId, workspaceId);
  if (!m) throw notFound();
  if (m.role_template === 'admin') throw badRequest('Room admins have no leads. Leads belong to bidder and seller team groups.');
  if (role === 'lead' && m.parent_group_id) throw badRequest(NO_SUBGROUP_LEADS);
  if (hasEnded(m, now)) throw badRequest('This membership has ended. Invite the person again first.');
  if (m.role === role) {
    const detail = role === 'lead' ? 'This person is already a lead of the group.' : 'This person is already a member, not a lead.';
    throw conflict('Nothing to change', detail);
  }
  await supersede(tx, m.id, now);
  const startsLater = !endless(m.valid_from) && new Date(m.valid_from) >= now;
  if (!startsLater) {
    await tx.query(
      `insert into membership (tenant_id, person_id, group_id, role, status, valid_from, valid_to, recorded_at, metadata)
       select tenant_id, person_id, group_id, role, status, valid_from, $2, $2, metadata from membership where id = $1`, [m.id, now.toISOString()]);
  }
  const id = (await tx.query<{ id: string }>(
    `insert into membership (tenant_id, person_id, group_id, role, status, valid_from, valid_to, recorded_at, metadata)
     select tenant_id, person_id, group_id, $3, status, case when $4 then valid_from else $2::timestamptz end, valid_to, $2, metadata
       from membership where id = $1 returning id`, [m.id, now.toISOString(), role, startsLater])).rows[0]!.id;
  await tx.query(`update invitation set membership_id = $2 where membership_id = $1`, [m.id, id]);
  return { previous: m, id };
}

async function leadGroupsOf(tx: SqlClient, personId: string, workspaceId: string, now: Date): Promise<string[]> {
  const { rows } = await tx.query<{ group_id: string }>(
    `select distinct m.group_id from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
      where m.person_id = $1 and g.workspace_id = $2 and m.role = 'lead' and m.status = 'active' and m.superseded_at = 'infinity'
        and m.valid_from <= $3 and $3 < m.valid_to and g.valid_from <= $3 and $3 < g.valid_to
        and not coalesce((m.metadata ->> 'revoked')::boolean, false)
        and pa.kind <> 'seller' and g.parent_group_id is null`, [personId, workspaceId, now.toISOString()]);
  return rows.map((r) => r.group_id);
}

const MemberOut = z.object({
  membershipId: z.string().uuid(), personId: z.string().uuid(), name: z.string(), email: z.string(), role: z.string(),
  givenName: z.string(), familyName: z.string(), company: z.string().nullable(), jobTitle: z.string().nullable(),
  status: z.enum(['invited', 'link_expired', 'active', 'expired', 'revoked']), accessEndsAt: z.string().nullable(),
  invitationWaits: z.boolean(),
  // admins and leads only, don't tip off the person
  removalRequested: z.boolean().optional(),
});

const MemberAdminOut = MemberOut.extend({
  lastSignedInAt: z.string().nullable(),
  invitedAt: z.string().nullable(),
  ndaAccepted: z.boolean().nullable(),
  revokedAt: z.string().nullable(),
  // never accepted the invitation; once revoked, only a new invitation brings them back
  neverAccepted: z.boolean(),
  // a site admin disabled the account: it cannot sign in anywhere
  disabled: z.boolean(),
  siteAdmin: z.boolean(),
  // also in a room the caller does not run: only a site admin changes their sign-in or details
  otherRooms: z.boolean(),
});

// sign-in is shared across rooms; a room admin must not reach the others through it
export async function inRoomsNotRunBy(tx: SqlClient, personIds: string[], admin: string, now: Date): Promise<Set<string>> {
  const { rows } = await tx.query<{ person_id: string }>(
    `select distinct m.person_id from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
      where m.person_id = any($1::uuid[]) and m.superseded_at = 'infinity' and m.status in ('approved', 'active')
        and $3 < m.valid_to and not coalesce((m.metadata ->> 'revoked')::boolean, false)
        and $3 < g.valid_to and w.state <> 'deleted'
        and not is_workspace_admin($2, g.workspace_id, $3)`, [personIds, admin, now.toISOString()]);
  return new Set(rows.map((r) => r.person_id));
}

async function members(tx: SqlClient, groupIds: string[], now: Date, ws: string | null = null) {
  const { rows } = await tx.query<any>(
    `select distinct on (m.group_id, m.person_id)
            m.id, m.group_id, m.person_id, ${NAME} as name, ${EMAIL} as email, m.role, m.status, m.valid_from <= $3 as started, m.valid_to, m.metadata,
            p.given_name, p.family_name, p.company, p.job_title, p.is_site_admin, p.disabled_at is not null as disabled,
            (select v.last_visit_at from workspace_visit v where v.workspace_id = $2 and v.person_id = m.person_id) as last_visit,
            case when $2::uuid is null then null
                 when exists (select 1 from groups g join party pa on pa.id = g.party_id where g.id = m.group_id and pa.kind = 'seller') then null
                 when not (select w.requires_nda from workspace w where w.id = $2) then null
                 else nda_accepted(m.person_id, $2, record_clock()) end as nda_ok,
            (select i.status from invitation i where i.membership_id = m.id order by i.created_at desc limit 1) as inv_status,
            (select i.expires_at from invitation i where i.membership_id = m.id order by i.created_at desc limit 1) as inv_expires,
            (select i.sent_at from invitation i where i.membership_id = m.id order by i.created_at desc limit 1) as inv_sent,
            (select i.waits_for_room from invitation i where i.membership_id = m.id order by i.created_at desc limit 1) as inv_waits,
            exists (select 1 from approval ap where ap.kind = 'removal_request' and ap.status = 'pending' and ap.group_id = m.group_id
                       and ap.payload ->> 'person_id' = m.person_id::text) as removal_requested
       from membership m join person p on p.id = m.person_id
      where m.group_id = any($1::uuid[]) and m.superseded_at = 'infinity'
      order by m.group_id, m.person_id, m.valid_from desc`, [groupIds, ws, now.toISOString()]);
  rows.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  return rows.map((m: any) => {
    const ended = !endless(m.valid_to) && new Date(m.valid_to) <= now;
    let status: z.infer<typeof MemberOut>['status'];
    if (m.metadata?.revoked) status = 'revoked';
    else if (m.status === 'approved') status = !m.inv_waits && m.inv_expires && new Date(m.inv_expires) <= now ? 'link_expired' : 'invited';
    else status = ended ? 'expired' : 'active';
    let revokedAt: string | null = m.metadata?.revoked_at ?? null;
    if (revokedAt === null && m.metadata?.revoked) revokedAt = new Date(m.valid_to).toISOString();
    const inTeam = !m.metadata?.revoked && !ended && (m.status === 'approved' || (m.status === 'active' && m.started));
    return { inTeam, groupId: m.group_id as string, membershipId: m.id, personId: m.person_id, name: m.name, email: m.email, role: m.role,
      givenName: m.given_name, familyName: m.family_name, company: m.company, jobTitle: m.job_title, status,
      accessEndsAt: endless(m.valid_to) ? null : new Date(m.valid_to).toISOString(), removalRequested: m.removal_requested,
      invitationWaits: m.status === 'approved' && m.inv_status === 'pending' && !!m.inv_waits && !m.metadata?.revoked,
      invitedAt: m.inv_sent ? new Date(m.inv_sent).toISOString() : null,
      admin: {
        lastSignedInAt: m.last_visit ? new Date(m.last_visit).toISOString() : null,
        ndaAccepted: (m.nda_ok ?? null) as boolean | null,
        revokedAt,
        neverAccepted: m.status === 'approved',
        disabled: !!m.disabled,
        siteAdmin: !!m.is_site_admin,
      } };
  });
}

export async function emailChoice(tx: SqlClient, workspaceId: string, personId: string, category: string, now: Date): Promise<'on' | 'off' | 'summary' | 'not_member'> {
  const standing = await memberStanding(tx, workspaceId, personId, now);
  if (!standing) return 'not_member';
  const p = resolveForPerson(await loadPolicies(tx, workspaceId, category), category, { personId, ...standing }, await roomTiming(tx, workspaceId));
  if (!p.enabled) return 'off';
  return p.mode === 'digest' ? 'summary' : 'on';
}

// approve in the room only, never from the email
async function tellAdminsOfRequest(app: FastifyInstance, req: FastifyRequest, ws: string, made: {
  id: string; to: { id: string; email: string }[]; info: { room: string; lead: string; grp: string };
  payload: { name: string; email: string; company: string; jobTitle: string; reason: string }; brand: MailBranding | null;
}) {
  if (made.to.length === 0 || !made.brand) return;
  const mail = colleagueRequestEmail({ brand: made.brand, room: made.info.room, lead: made.info.lead, group: made.info.grp,
    name: made.payload.name, email: made.payload.email, company: made.payload.company, role: made.payload.jobTitle, reason: made.payload.reason,
    reviewUrl: `${app.deps.publicUrl.replace(/\/$/, '')}/rooms/${ws}/people`, notificationsUrl: notificationsUrl(app.deps.publicUrl, ws) });
  const results: { id: string; email: string; status: string; providerMessageId?: string; error?: string }[] = [];
  for (const a of made.to) {
    const r = app.deps.mailer
      ? await app.deps.mailer.send(toMessage(mail, a.id, a.email)).catch(sendFailed)
      : { status: 'no_mailer', error: 'No mail server is configured' };
    results.push({ id: a.id, email: a.email, ...r });
  }
  await app.inTenant(req, async (tx) => {
    for (const r of results) {
      const m = mailEvent({ type: 'colleague_request', personId: r.id, to: r.email, subject: mail.subject, result: r });
      await appendEvent(tx, { action: 'team_request.admin_told', workspaceId: ws, actorId: req.caller?.actorId ?? null, resourceType: 'approval', resourceId: made.id,
        data: m.data, context: m.context, occurredAt: app.now(), requestId: req.id });
    }
  });
}

async function tellLead(app: FastifyInstance, req: FastifyRequest, ws: string,
  r: { id: string; status: string; name: string; groupName: string; decisionNote: string | null },
  lead: { id: string; email: string; given_name: string; room: string }, decisionEventId: string) {
  const approved = r.status === 'approved';
  const { row, choice } = await app.inTenant(req, async (tx) => {
    const choice = await emailChoice(tx, ws, lead.id, 'requests', app.now());
    if (choice === 'summary') {
      await enqueueTeamNews(tx, { eventId: decisionEventId, action: approved ? 'team_request.approved' : 'team_request.declined',
        workspaceId: ws, leadIds: [lead.id], occurredAt: app.now() });
      await appendEvent(tx, { action: 'team_request.lead_told', workspaceId: ws, actorId: req.caller?.actorId ?? null,
        resourceType: 'approval', resourceId: r.id, data: { decision: r.status, channel: 'email', delivery_status: 'in_summary', provider_message_id: null },
        occurredAt: app.now(), requestId: req.id });
    }
    return { row: choice === 'on' ? await brandingRow(tx) : null, choice };
  });
  if (choice === 'summary') return;
  const brand = await brandingFrom(row, app.deps.storage, app.deps.publicUrl);
  const mail = requestDecisionEmail({ brand, room: lead.room, approved, givenName: lead.given_name, name: r.name, group: r.groupName,
    note: r.decisionNote, teamUrl: `${app.deps.publicUrl.replace(/\/$/, '')}/rooms/${ws}/team`, notificationsUrl: notificationsUrl(app.deps.publicUrl, ws) });
  let result: { status: string; providerMessageId?: string; error?: string };
  if (choice !== 'on') result = { status: choice === 'off' ? 'switched_off' : 'not_member' };
  else if (app.deps.mailer) result = await app.deps.mailer.send(toMessage(mail, lead.id, lead.email));
  else result = { status: 'no_mailer', error: 'No mail server is configured' };
  await app.inTenant(req, async (tx) => {
    const m = mailEvent({ type: 'request_decision', personId: lead.id, to: lead.email, subject: mail.subject, result });
    const { error: _none, ...quiet } = m.data;
    await appendEvent(tx, { action: 'team_request.lead_told', workspaceId: ws, actorId: req.caller?.actorId ?? null, resourceType: 'approval', resourceId: r.id,
      data: { decision: r.status, ...(result.status === 'switched_off' || result.status === 'not_member' ? quiet : m.data) },
      ...(choice === 'on' ? { context: m.context } : {}),
      occurredAt: app.now(), requestId: req.id });
  });
}

export const peopleRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/people', {
    schema: {
      summary: 'Groups and users, with status',
      params: WsParams,
      response: {
        200: z.object({
          parties: z.array(z.object({
            id: z.string().uuid(), name: z.string(), kind: z.string(),
            groups: z.array(z.object({
              id: z.string().uuid(), name: z.string(), parentGroupId: z.string().uuid().nullable(), roleTemplate: z.string(),
              revoked: z.boolean(), members: z.array(MemberAdminOut),
              organisation: z.string().nullable(),
              accessEndsAt: z.string().nullable(),
              revokedAt: z.string().nullable(),
              revokedBy: z.string().nullable(),
              revokedReason: z.string().nullable(),
              uploadFolders: z.array(z.string()),
              publishFolders: z.array(z.string()),
            })),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
    const parties = (await tx.query<any>(`select id, name, kind from party where workspace_id = $1 order by kind <> 'seller', name`, [req.params.ws])).rows;
    const groups = (await tx.query<any>(
      `select g.id, g.party_id, g.name, g.parent_group_id, g.role_template, not (g.valid_from <= $2 and $2 < g.valid_to) as revoked,
              g.organisation, g.valid_to, g.metadata ->> 'revoked_reason' as revoked_reason,
              ${NAME} as revoked_by
         from groups g left join person p on p.id = (g.metadata ->> 'revoked_by')::uuid
        where g.workspace_id = $1 order by coalesce(g.parent_group_id, g.id), g.parent_group_id nulls first, g.name`, [req.params.ws, now.toISOString()])).rows;
    const all = await members(tx, groups.map((g: any) => g.id), now, req.params.ws);
    const me = personOf(caller);
    const site = (await tx.query<{ ok: boolean }>(
      `select coalesce((select is_site_admin and disabled_at is null and erased_at is null from person where id = $1), false) as ok`, [me])).rows[0]!.ok;
    const elsewhere = site ? new Set<string>() : await inRoomsNotRunBy(tx, [...new Set(all.map((m) => m.personId as string))], me, now);
    const rights = (await tx.query<{ group_id: string; label: string; can_upload: boolean; can_publish: boolean }>(
      `select a.subject_group_id as group_id, coalesce(n.index_number || ' ', '') || n.name as label, a.can_upload, a.can_publish
         from access_grant a join node n on n.id = a.node_id
        where a.workspace_id = $1 and n.parent_id is null and n.deleted_at is null and a.subject_group_id is not null and a.effect = 'allow'
          and a.superseded_at = 'infinity' and a.valid_from <= $2 and $2 < a.valid_to and (a.can_upload or a.can_publish)
        order by n.sort_key, n.index_number`, [req.params.ws, now.toISOString()])).rows;
    const folders = (g: string, k: 'can_upload' | 'can_publish') => rights.filter((x) => x.group_id === g && x[k]).map((x) => x.label);
    const iso = (v: unknown) => (v && !endless(v) ? new Date(v as string).toISOString() : null);
    return {
      parties: parties.map((p: any) => ({
        id: p.id, name: p.name, kind: p.kind,
        groups: groups.filter((g: any) => g.party_id === p.id).map((g: any) => {
          // only revoking sets revoked_by
          const byRevoke = !!(g.revoked && g.revoked_by);
          return {
            id: g.id, name: g.name, parentGroupId: g.parent_group_id, roleTemplate: g.role_template, revoked: g.revoked,
            members: all.filter((m) => m.groupId === g.id)
              .map(({ groupId: _g, inTeam: _t, admin, ...m }) => ({ ...m, ...admin, otherRooms: elsewhere.has(m.personId) })),
            organisation: g.organisation ?? null, accessEndsAt: byRevoke ? null : iso(g.valid_to),
            revokedAt: byRevoke ? iso(g.valid_to) : null, revokedBy: g.revoked ? g.revoked_by ?? null : null,
            revokedReason: byRevoke ? g.revoked_reason ?? null : null,
            uploadFolders: folders(g.id, 'can_upload'), publishFolders: folders(g.id, 'can_publish'),
          };
        }),
      })),
    };
  }));

  r.post('/v1/workspaces/:ws/groups', {
    schema: {
      summary: 'Create a group or subgroup',
      params: WsParams,
      body: z.object({
        name: z.string().trim().min(1).max(120),
        partyId: z.string().uuid().optional(),
        newParty: z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['seller', 'bidder', 'financier', 'observer', 'other']) }).optional(),
        parentGroupId: z.string().uuid().optional(),
        roleTemplate: z.enum(['member', 'observer']).default('member'),
        organisation: z.string().trim().min(1).max(200).optional(),
        accessEndsAt: z.string().datetime().nullable().optional(),
        access: z.array(z.object({
          nodeId: z.string().uuid(),
          level: z.union([z.literal(0), z.literal(20), z.literal(40), z.literal(50), z.literal(60)]),
          canUpload: z.boolean().default(false),
          canPublish: z.boolean().default(false),
        })).max(200).default([]),
      }).refine((b) => !!b.partyId !== !!b.newParty || !!b.parentGroupId, { message: 'Give a party, a new party, or a parent group' }),
      response: { 201: z.object({ id: z.string().uuid(), partyId: z.string().uuid() }) },
    },
  }, async (req, reply) => reply.code(201).send(await app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    await refuseIfArchived(tx, ws);
    let partyId = req.body.partyId ?? null;
    if (req.body.parentGroupId) {
      const parent = (await tx.query<{ party_id: string; parent_group_id: string | null }>(
        `select party_id, parent_group_id from groups where id = $1 and workspace_id = $2`, [req.body.parentGroupId, ws])).rows[0];
      if (!parent) throw badRequest('The parent group is not part of this room.');
      if (parent.parent_group_id) throw badRequest('A subgroup cannot have its own subgroups.');
      partyId = parent.party_id;
    } else if (req.body.newParty) {
      partyId = (await tx.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values (current_tenant_id(), $1, $2, $3) returning id`,
        [ws, req.body.newParty.name, req.body.newParty.kind])).rows[0]!.id;
    } else {
      const p = await tx.query(`select 1 from party where id = $1 and workspace_id = $2`, [partyId, ws]);
      if (!p.rows.length) throw badRequest('That party is not part of this room.');
    }
    const kind = (await tx.query<{ kind: string }>(`select kind from party where id = $1`, [partyId])).rows[0]?.kind;
    if (req.body.roleTemplate === 'observer' && kind !== 'seller') {
      throw badRequest('Observer groups belong to the seller side. Choose the seller party.');
    }
    const b = req.body;
    const access = b.access.filter((a) => a.level > 0 || a.canUpload || a.canPublish);
    if (new Set(b.access.map((a) => a.nodeId)).size !== b.access.length) throw badRequest('The same folder appears more than once.');
    if (access.length) {
      const tops = new Set((await tx.query<{ id: string }>(
        `select id from node where workspace_id = $1 and parent_id is null and kind = 'folder' and deleted_at is null and id = any($2::uuid[])`,
        [ws, access.map((a) => a.nodeId)])).rows.map((r) => r.id));
      const unknown = access.filter((a) => !tops.has(a.nodeId)).map((a) => a.nodeId);
      if (unknown.length) throw badRequest('Access is set on the main folders of this room only.', unknown);
      if (kind !== 'seller' && access.some((a) => a.canUpload || a.canPublish)) {
        throw badRequest('Only seller groups may add files or publish. Bidder groups get a level only.');
      }
      if (req.body.parentGroupId) {
        const parentLevels = new Map((await tx.query<{ node_id: string; level: number }>(
          `select node_id, level from access_grant where subject_group_id = $1 and effect = 'allow' and superseded_at = 'infinity'
              and valid_from <= $2 and $2 < valid_to`, [req.body.parentGroupId, now.toISOString()])).rows.map((r) => [r.node_id, Number(r.level)]));
        const over = access.filter((a) => a.level > (parentLevels.get(a.nodeId) ?? 0)).map((a) => a.nodeId);
        if (over.length) throw badRequest('A subgroup cannot see more than its parent group in a folder.', over);
      }
    }
    let until = b.accessEndsAt ? new Date(b.accessEndsAt) : null;
    if (until && until <= now) throw badRequest('The end date has passed. Choose a date in the future.');
    if (b.parentGroupId) {
      const parentEnd = (await tx.query<{ valid_to: unknown }>(`select valid_to from groups where id = $1`, [b.parentGroupId])).rows[0]?.valid_to;
      if (!endless(parentEnd) && (!until || until > new Date(parentEnd as string))) until = new Date(parentEnd as string);
    }
    const id = (await tx.query<{ id: string }>(
      `insert into groups (tenant_id, workspace_id, party_id, name, parent_group_id, role_template, organisation, valid_to)
       values (current_tenant_id(), $1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, 'infinity')) returning id`,
      [ws, partyId, b.name, b.parentGroupId ?? null, b.roleTemplate, b.organisation ?? null, until?.toISOString() ?? null])).rows[0]!.id;
    for (const a of access) {
      await setGrant(tx, { workspaceId: ws, nodeId: a.nodeId, subject: { groupId: id }, level: a.level as LevelValue,
        canUpload: a.canUpload, canManage: false, canPublish: a.canPublish, actorId: caller.actorId, requestId: req.id, now, audit: false });
    }
    await appendEvent(tx, { action: 'group.created', workspaceId: ws, actorId: caller.actorId, resourceType: 'group', resourceId: id,
      data: { party_id: partyId, parent_group_id: b.parentGroupId ?? null, role_template: b.roleTemplate, name: b.name,
        organisation: b.organisation ?? null, access_ends_at: until?.toISOString() ?? null,
        access: access.map((a) => ({ node_id: a.nodeId, level: a.level, can_upload: a.canUpload, can_publish: a.canPublish })) },
      occurredAt: now, requestId: req.id });
    return { id, partyId: partyId! };
  })));

  r.post('/v1/workspaces/:ws/groups/:id/revoke', {
    schema: {
      summary: 'Revoke a group and all its members',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().trim().max(300).optional() }).nullish(),
      response: { 200: z.object({ revokedAt: z.string() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
    const g = (await tx.query<{ role_template: string }>(`select role_template from groups where id = $1 and workspace_id = $2 and $3 < valid_to`,
      [req.params.id, req.params.ws, now.toISOString()])).rows[0];
    if (!g) throw notFound();
    if (g.role_template === 'admin') throw badRequest('The room admin group cannot be revoked.');
    const reason = req.body?.reason || null;
    const revoked = (await tx.query<{ id: string }>(
      `update groups set valid_to = $3, metadata = metadata || jsonb_build_object('revoked_by', $4::text, 'revoked_reason', $5::text)
        where (id = $1 or parent_group_id = $1) and workspace_id = $2 and $3 < valid_to returning id`,
      [req.params.id, req.params.ws, now.toISOString(), personOf(caller), reason])).rows.map((x) => x.id);
    await tx.query(`update invitation set status = 'revoked' where group_id = any($1::uuid[]) and status = 'pending'`, [revoked]);
    await appendEvent(tx, { action: 'group.revoked', workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'group', resourceId: req.params.id,
      data: { groups: revoked, reason }, occurredAt: now, requestId: req.id });
    return { revokedAt: now.toISOString() };
  }));

  r.post('/v1/workspaces/:ws/invitations', {
    schema: {
      summary: 'Invite people into a group',
      params: WsParams,
      body: z.object({
        groupId: z.string().uuid(),
        people: z.array(z.object({
          email: z.string().email(),
          givenName: GivenName.optional(),
          familyName: FamilyName.optional(),
          // deprecated, use givenName/familyName
          name: visibleText(z.string().trim().min(1).max(200)).optional(),
          role: z.enum(['member', 'lead']).optional(),
        }).refine((p) => !!p.givenName === !!p.familyName, { message: 'Give both a first name and a last name, or neither' }))
          .min(1).max(200),
        role: z.enum(['member', 'lead']).default('member'),
        accessExpiresAt: z.string().datetime().nullable().default(null),
        message: z.string().max(5000).nullable().default(null),
      }),
      response: { 201: z.object({ invitations: z.array(z.object({ id: z.string().uuid(), email: z.string(), personId: z.string().uuid(),
        waits: z.boolean() })) }) },
    },
  }, async (req, reply) => {
    const now = app.now();
    const invites = await app.inTenant(req, async (tx, caller) => {
      await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
      await refuseIfArchived(tx, req.params.ws);
      const emails = req.body.people.map((p) => p.email.toLowerCase());
      if (new Set(emails).size !== emails.length) throw badRequest('The same email address appears twice.');
      return invite(tx, {
        workspaceId: req.params.ws, groupId: req.body.groupId, people: req.body.people, role: req.body.role,
        accessExpiresAt: req.body.accessExpiresAt ? new Date(req.body.accessExpiresAt) : null, message: req.body.message,
        invitedBy: personOf(caller), actorId: caller.actorId, now, requestId: req.id,
      });
    });
    await sendInvites(app, req, req.params.ws, invites);
    return reply.code(201).send({ invitations: invites.map((i) => ({ id: i.invitationId, email: i.email, personId: i.personId, waits: !!i.waits })) });
  });

  r.get('/v1/public/invitations/:token', {
    schema: {
      summary: 'Look up an invitation link. 410 for any link that does not work',
      params: z.object({ token: z.string().max(200) }),
      response: { 200: z.object({
        workspaceId: z.string().uuid(),
        roomName: z.string(),
        runBy: z.string(),
        onBehalfOf: z.string().nullable(),
        invitedBy: z.string().nullable(),
        groupName: z.string(),
        accessEndsAt: z.string().nullable(),
        roomTimeZone: z.string(),
        email: z.string(),
        givenName: z.string().nullable(),
        familyName: z.string().nullable(),
        company: z.string().nullable(),
        jobTitle: z.string().nullable(),
        accepted: z.boolean(),
        requireTwoFactor: z.boolean(),
      }) },
    },
  }, async (req) => {
    const token = req.params.token;
    if (!TOKEN.test(token)) throw invalidInvitation();
    const now = app.now();
    return app.inTenantId(token.split('.')[0]!, async (tx) => {
      const row = (await tx.query<any>(
        `select i.workspace_id, i.status, i.expires_at, i.access_expires_at, w.name as room_name, w.time_zone as room_tz, t.name as run_by,
                w.require_two_factor,
                ${sellerNameSql('w.id')} as seller,
                ${NAME.replace(/p\./g, 'ib.')} as invited_by, g.name as group_name,
                p.email, p.given_name, p.family_name, p.company, p.job_title, p.erased_at
           from invitation i join workspace w on w.id = i.workspace_id join tenant t on t.id = i.tenant_id
           join groups g on g.id = i.group_id join person p on p.id = i.person_id
           left join person ib on ib.id = i.invited_by
          where i.token_sha256 = $1 and w.state <> 'deleted' and not i.waits_for_room`, [sha(token)])).rows[0];
      if (!row || row.erased_at) throw invalidInvitation();
      const accepted = row.status === 'accepted';
      if (!accepted && (row.status !== 'pending' || new Date(row.expires_at) <= now)) throw invalidInvitation();
      // accepted links sit in mailboxes for good: sign-in only, nothing about the invitation
      if (accepted) {
        return {
          workspaceId: row.workspace_id, roomName: '', runBy: '', onBehalfOf: null, invitedBy: null, groupName: '', accessEndsAt: null,
          roomTimeZone: 'UTC', email: row.email, givenName: null, familyName: null, company: null, jobTitle: null, accepted,
          requireTwoFactor: true,
        };
      }
      const given = greetingName(row.given_name, row.email) || null;
      return {
        workspaceId: row.workspace_id, roomName: row.room_name, runBy: row.run_by, onBehalfOf: row.seller ?? null,
        invitedBy: row.invited_by ?? null, groupName: row.group_name,
        accessEndsAt: row.access_expires_at ? new Date(row.access_expires_at).toISOString() : null,
        roomTimeZone: row.room_tz, email: row.email, givenName: given, familyName: given ? row.family_name ?? null : null,
        company: row.company ?? null, jobTitle: row.job_title ?? null, accepted, requireTwoFactor: row.require_two_factor !== false,
      };
    });
  });

  r.post('/v1/public/invitations/accept', {
    schema: {
      summary: 'Accept an invitation',
      body: z.object({
        token: z.string().regex(TOKEN),
        givenName: GivenName,
        familyName: FamilyName,
        company: Company,
        jobTitle: JobTitle.optional(),
        timeZone: IanaTimeZone.optional(),
      }),
      response: { 200: z.object({ workspaceId: z.string().uuid(), personId: z.string().uuid() }) },
    },
  }, async (req) => {
    const tenantId = req.body.token.split('.')[0]!;
    const now = app.now();
    return app.inTenantId(tenantId, async (tx) => {
      // membership lock before the invitation row, the order a revoke takes them in
      const of = (await tx.query<{ person_id: string; group_id: string }>(
        `select m.person_id, m.group_id from invitation i join membership m on m.id = i.membership_id where i.token_sha256 = $1`,
        [sha(req.body.token)])).rows[0];
      if (!of) throw invalidInvitation();
      await lockMembership(tx, of.person_id, of.group_id);
      const inv = (await tx.query<any>(`select * from invitation where token_sha256 = $1 for update`, [sha(req.body.token)])).rows[0];
      if (!inv || inv.status !== 'pending' || inv.waits_for_room || new Date(inv.expires_at) <= now) throw invalidInvitation();
      await refuseIfArchived(tx, inv.workspace_id);
      const m = (await tx.query<any>(`select id, status, valid_to > $2 as still_valid from membership where id = $1 and superseded_at = 'infinity'`,
        [inv.membership_id, now.toISOString()])).rows[0];
      if (!m || m.status !== 'approved' || !m.still_valid) throw invalidInvitation();
      const before = await readDetails(tx, inv.person_id);
      if (!before) throw invalidInvitation();
      const rooms = await roomsOf(tx, inv.person_id, now);
      const b = req.body;
      const after = { givenName: b.givenName, familyName: b.familyName, company: b.company, jobTitle: b.jobTitle || null };
      await tx.query(
        `update person set given_name = $2, family_name = $3, company = $4, job_title = $5, time_zone = coalesce($6, time_zone), updated_at = $7
          where id = $1`,
        [inv.person_id, after.givenName, after.familyName, after.company, after.jobTitle, b.timeZone ?? null, now.toISOString()]);
      await recordDetailsChange(tx, { personId: inv.person_id, before, after, now, actorId: null, requestId: req.id, rooms,
        ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
      await supersede(tx, m.id, now);
      await tx.query(`insert into membership (tenant_id, person_id, group_id, role, status, valid_from, valid_to, recorded_at, metadata)
        select tenant_id, person_id, group_id, role, 'approved', valid_from, $2, $2, metadata from membership where id = $1`, [m.id, now.toISOString()]);
      const active = (await tx.query<{ id: string }>(`insert into membership (tenant_id, person_id, group_id, role, status, valid_from, valid_to, recorded_at, metadata)
        select tenant_id, person_id, group_id, role, 'active', $2, valid_to, $2, metadata from membership where id = $1 returning id`,
        [m.id, now.toISOString()])).rows[0]!.id;
      await tx.query(`update invitation set status = 'accepted', accepted_at = $2, membership_id = $3 where id = $1`, [inv.id, now.toISOString(), active]);
      await linkPersonToLogin(tx, inv.person_id);
      const accepted = await appendEvent(tx, { action: 'invitation.accepted', workspaceId: inv.workspace_id, resourceType: 'invitation', resourceId: inv.id,
        data: { person_id: inv.person_id, group_id: inv.group_id }, occurredAt: now, requestId: req.id,
        context: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null } });
      const leads = (await tx.query<{ person_id: string }>(
        `select distinct m.person_id from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
          where m.group_id = $1 and m.role = 'lead' and m.status = 'active' and m.superseded_at = 'infinity' and m.person_id <> $2
            and m.valid_from <= $3 and $3 < m.valid_to and pa.kind <> 'seller' and g.parent_group_id is null
            and not coalesce((m.metadata ->> 'revoked')::boolean, false)`,
        [inv.group_id, inv.person_id, now.toISOString()])).rows.map((x) => x.person_id);
      await enqueueTeamNews(tx, { eventId: accepted.id, action: 'invitation.accepted', workspaceId: inv.workspace_id, leadIds: leads, occurredAt: now, rightAway: true });
      return { workspaceId: inv.workspace_id, personId: inv.person_id };
    });
  });

  r.post('/v1/workspaces/:ws/memberships/:id/revoke', {
    schema: {
      summary: 'Revoke a membership',
      params: WsParams.extend({ id: z.string().uuid() }),
      response: { 200: z.object({ membershipId: z.string().uuid() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
    const id = await revokeMembership(tx, { membershipId: req.params.id, workspaceId: req.params.ws, now, byPerson: personOf(caller),
      actorId: caller.actorId, requestId: req.id });
    return { membershipId: id };
  }));

  r.post('/v1/workspaces/:ws/memberships/:id/restore', {
    schema: {
      summary: 'Restore access after a revoke. Room admins only',
      params: WsParams.extend({ id: z.string().uuid() }),
      response: {
        200: z.object({
          membershipIds: z.array(z.string().uuid()),
          groups: z.array(z.string()),
          accessEndsAt: z.string().nullable(),
          twoFactorReady: z.boolean(),
          twoFactorAgain: z.boolean(),
          email: z.string(),
        }),
      },
    },
  }, async (req) => {
    const ws = req.params.ws;
    const refuse = (reason: string, title: string, detail: string) =>
      new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title, status: 409, detail, reason });
    const done = await app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      await requireWorkspaceAdmin(tx, caller, ws, now);
      await refuseIfArchived(tx, ws);
      // a restore can bring back several groups, so one at a time per person and room
      const who = (await tx.query<{ person_id: string }>(
        `select x.person_id from membership x join groups g on g.id = x.group_id where x.id = $1 and g.workspace_id = $2`, [req.params.id, ws])).rows[0];
      if (!who) throw notFound();
      await lockMembership(tx, who.person_id, ws);
      const m = await currentMembership(tx, req.params.id, ws);
      if (!m) throw notFound();
      const p = (await tx.query<{ name: string; given_name: string | null; email: string; time_zone: string | null; disabled_at: string | null; erased_at: string | null }>(
        `select name, given_name, email, time_zone, disabled_at, erased_at from person where id = $1`, [m.person_id])).rows[0];
      if (!p) throw notFound();
      if (!m.metadata?.revoked) throw refuse('not_revoked', 'Nothing to restore', `${p.name} still has access to ${m.group_name}.`);
      if (p.erased_at) throw refuse('erased', 'Cannot restore', 'The personal data of this person was erased. Invite them again as a new person.');
      if (p.disabled_at) {
        throw refuse('account_disabled', 'Account disabled', `A site admin disabled the account of ${p.name}, so access cannot be restored here. Ask a site admin.`);
      }
      const revokedAt: string | null = m.metadata.revoked_at ?? null;
      const lost = (await tx.query<any>(
        `select distinct on (l.group_id) l.id, l.group_id, l.role, l.metadata, g.name as group_name,
                (g.valid_from <= $3 and $3 < g.valid_to) as group_open, pa.kind in ('bidder', 'financier') as buy
           from membership l join groups g on g.id = l.group_id join party pa on pa.id = g.party_id
          where l.person_id = $1 and g.workspace_id = $2 and l.superseded_at = 'infinity'
            and (l.id = $4 or ($5::text is not null and l.metadata ->> 'revoked_at' = $5))
          order by l.group_id, l.valid_from desc`, [m.person_id, ws, now.toISOString(), m.id, revokedAt])).rows
        .filter((x: any) => x.metadata?.revoked);
      const open = lost.filter((x: any) => x.group_open);
      if (open.length === 0) {
        throw refuse('group_closed', 'The group is closed', `${m.group_name} was revoked as a whole. Use “Invite people again” on the group instead.`);
      }
      const restored: { id: string; group: string; until: Date | null }[] = [];
      for (const x of open) {
        if (x.group_id !== m.group_id) await lockMembership(tx, m.person_id, x.group_id);
        const before = (await tx.query<{ status: string; valid_to: string | Date }>(
          `select status, valid_to from membership where person_id = $1 and group_id = $2 and id <> $3 and superseded_at <> 'infinity'
            order by superseded_at desc, recorded_at desc limit 1`, [m.person_id, x.group_id, x.id])).rows[0];
        if (before?.status === 'approved') {
          throw refuse('never_accepted', 'Invitation not accepted', `${p.name} never accepted the invitation. Invite them again instead, so they get a new invitation link.`);
        }
        const until = before && !endless(before.valid_to) ? new Date(before.valid_to) : null;
        if (until && until <= now) {
          throw refuse('ended', 'Access had ended', `The access of ${p.name} to ${x.group_name} had ended anyway. Invite them again with a new end date.`);
        }
        // they may have joined the other side since the revoke
        await refuseBothSides(tx, { personId: m.person_id, workspaceId: ws, buy: x.buy, who: p.name, now });
        const { revoked: _r, revoked_by: _b, revoked_at: _a, ...keep } = x.metadata ?? {};
        const id = (await tx.query<{ id: string }>(
          `insert into membership (tenant_id, person_id, group_id, role, status, valid_from, valid_to, metadata)
           values (current_tenant_id(), $1, $2, $3, 'active', $4, coalesce($5::timestamptz, 'infinity'), $6) returning id`,
          [m.person_id, x.group_id, x.role, now.toISOString(), until?.toISOString() ?? null,
            JSON.stringify({ ...keep, restored_at: now.toISOString(), restored_by: personOf(caller) })])).rows[0]!.id;
        await appendEvent(tx, { action: 'membership.restored', workspaceId: ws, actorId: caller.actorId, resourceType: 'membership', resourceId: id,
          data: { person_id: m.person_id, group_id: x.group_id, role: x.role, revoked_membership_id: x.id, before: 'revoked', after: x.role,
            valid_to: until?.toISOString() ?? null },
          occurredAt: now, requestId: req.id });
        restored.push({ id, group: x.group_name, until });
      }
      const twoFactor = (await tx.query<{ required: boolean; enabled: boolean | null; was_reset: boolean }>(
        `select w.require_two_factor as required,
                (select u.two_factor_enabled from auth_person ap
                   join auth_user u on u.id = coalesce(ap.user_id, (select x.id from auth_user x where lower(x.email) = lower(ap.email) and x.email_verified))
                  where ap.person_id = $2 and ap.tenant_id = current_tenant_id() limit 1) as enabled,
                exists (select 1 from event e
                         where ((e.resource_id = $2 and e.action = 'auth.two_factor_reset')
                             or (e.resource_id = current_tenant_id() and e.action = 'site.account.two_factor_reset' and e.data ->> 'person_id' = $2::text))
                           and coalesce((e.data ->> 'had_two_factor')::boolean, true)) as was_reset
           from workspace w where w.id = $1`, [ws, m.person_id])).rows[0];
      const twoFactorReady = !twoFactor?.required || !!twoFactor.enabled;
      const room = (await tx.query<{ name: string }>(`select name from workspace where id = $1`, [ws])).rows[0]!.name;
      const admin = (await tx.query<{ name: string }>(`select name from person where id = $1 and erased_at is null`, [personOf(caller)])).rows[0]?.name ?? null;
      return {
        personId: m.person_id as string, email: p.email, givenName: greetingName(p.given_name, p.email),
        timeZone: p.time_zone || 'UTC', room, admin, restored, twoFactorReady, twoFactorAgain: !twoFactorReady && !!twoFactor?.was_reset,
        membershipId: restored[0]!.id, brand: await mailBranding(tx, app.deps.storage, app.deps.publicUrl),
      };
    });

    const until = done.restored.map((x) => x.until).find((u) => u) ?? null;
    const mail = accessRestoredEmail({ brand: done.brand, room: done.room, givenName: done.givenName, admin: done.admin,
      groups: done.restored.map((x) => x.group), until, timeZone: done.timeZone, setUpTwoFactor: done.twoFactorAgain,
      signInUrl: `${app.deps.publicUrl.replace(/\/$/, '')}/sign-in?next=${encodeURIComponent(`/rooms/${ws}`)}` });
    const result: { status: string; providerMessageId?: string; error?: string } = app.deps.mailer
      ? await app.deps.mailer.send(toMessage(mail, done.personId, done.email))
        .catch(sendFailed)
      : { status: 'no_mailer', error: 'No mail server is configured' };
    await app.inTenant(req, async (tx) => {
      const m = mailEvent({ type: 'access_restored', personId: done.personId, to: done.email, subject: mail.subject, result });
      await appendEvent(tx, { action: result.status === 'accepted' ? 'notification.sent' : 'notification.failed', workspaceId: ws,
        actorId: req.caller?.actorId ?? null, resourceType: 'membership', resourceId: done.membershipId,
        data: m.data, context: m.context, occurredAt: app.now(), requestId: req.id });
    });
    return { membershipIds: done.restored.map((x) => x.id), groups: done.restored.map((x) => x.group), accessEndsAt: until?.toISOString() ?? null,
      twoFactorReady: done.twoFactorReady, twoFactorAgain: done.twoFactorAgain, email: result.status };
  });

  r.patch('/v1/workspaces/:ws/memberships/:id', {
    schema: {
      summary: 'Change when a person’s access ends',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({ accessEndsAt: z.string().datetime().nullable() }),
      response: { 200: z.object({ membershipId: z.string().uuid() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
    await refuseIfArchived(tx, req.params.ws);
    const until = req.body.accessEndsAt ? new Date(req.body.accessEndsAt) : new Date(8.64e15);
    if (until <= now) throw badRequest('To end access now, revoke the membership instead.');
    const { previous, id } = await endMembership(tx, req.params.id, req.params.ws, now, until, false, null);
    await appendEvent(tx, { action: 'membership.expiry_changed', workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'membership', resourceId: id,
      data: { person_id: previous.person_id, before: endless(previous.valid_to) ? null : new Date(previous.valid_to).toISOString(), after: req.body.accessEndsAt },
      occurredAt: now, requestId: req.id });
    return { membershipId: id };
  }));

  for (const [path, role] of [['make-lead', 'lead'], ['make-member', 'member']] as const) {
    r.post(`/v1/workspaces/:ws/memberships/:id/${path}`, {
      schema: {
        summary: role === 'lead'
          ? 'Make a member a group lead'
          : 'Make a lead an ordinary member again',
        params: WsParams.extend({ id: z.string().uuid() }),
        response: { 200: z.object({ membershipId: z.string().uuid(), role: z.enum(['lead', 'member']) }) },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
      await refuseIfArchived(tx, req.params.ws);
      const { previous, id } = await changeRole(tx, req.params.id, req.params.ws, now, role);
      await appendEvent(tx, { action: 'membership.role_changed', workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'membership', resourceId: id,
        data: { person_id: previous.person_id, group_id: previous.group_id, before: previous.role, after: role }, occurredAt: now, requestId: req.id });
      return { membershipId: id, role };
    }));
  }

  r.post('/v1/workspaces/:ws/team-requests', {
    schema: {
      summary: 'Ask to add a colleague (bidder lead)',
      params: WsParams,
      body: z.object({
        givenName: GivenName, familyName: FamilyName, email: z.string().email(),
        company: Company, jobTitle: JobTitle.default(''), reason: z.string().max(1000).default(''),
      }),
      response: { 201: z.object({ id: z.string().uuid() }) },
    },
  }, async (req, reply) => {
    const made = await app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      const me = await requireMember(tx, caller, req.params.ws, now);
      const [group] = await leadGroupsOf(tx, personOf(caller), req.params.ws, now);
      if (!group || me.isAdmin) throw forbidden('Only a bidder lead can request a colleague.', 'not_group_lead');
      const email = req.body.email.trim().toLowerCase();
      const inGroup = await tx.query(
        `select 1 from membership m join person p on p.id = m.person_id
          where p.email = $1 and m.group_id = $2 and m.superseded_at = 'infinity' and m.status in ('approved', 'active')
            and $3 < m.valid_to and not coalesce((m.metadata ->> 'revoked')::boolean, false)`, [email, group, now.toISOString()]);
      if (inGroup.rows.length) throw conflict('Already in your team', `${email} is already a member of your group or has an open invitation.`);
      const waiting = await tx.query(
        `select 1 from approval where kind = 'colleague_request' and status = 'pending' and group_id = $1 and lower(payload ->> 'email') = $2`, [group, email]);
      if (waiting.rows.length) throw conflict('Already requested', `A request for ${email} is already waiting for the room admin.`);
      const b = req.body;
      const payload = { givenName: b.givenName, familyName: b.familyName, name: `${b.givenName} ${b.familyName}`, email,
        company: b.company, jobTitle: b.jobTitle, reason: b.reason };
      // unique index settles the race
      let id: string;
      try {
        await tx.query('savepoint colleague_request');
        id = (await tx.query<{ id: string }>(
          `insert into approval (tenant_id, workspace_id, kind, requested_by, group_id, payload)
           values (current_tenant_id(), $1, 'colleague_request', $2, $3, $4) returning id`,
          [req.params.ws, personOf(caller), group, JSON.stringify(payload)])).rows[0]!.id;
        await tx.query('release savepoint colleague_request');
      } catch (err) {
        if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
        await tx.query('rollback to savepoint colleague_request');
        throw conflict('Already requested', `A request for ${email} is already waiting for the room admin.`);
      }
      const created = await appendEvent(tx, { action: 'team_request.created', workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'approval', resourceId: id,
        data: { group_id: group }, occurredAt: now, requestId: req.id });
      const admins = (await tx.query<{ id: string; email: string }>(
        `select distinct p.id, p.email from person p join membership m on m.person_id = p.id join groups g on g.id = m.group_id
          where g.workspace_id = $1 and p.disabled_at is null and p.erased_at is null and is_workspace_admin(p.id, $1, $2)`,
        [req.params.ws, now.toISOString()])).rows;
      const to: typeof admins = [];
      const inSummary: string[] = [];
      for (const a of admins) {
        const choice = await emailChoice(tx, req.params.ws, a.id, 'requests', now);
        if (choice === 'on') to.push(a);
        else if (choice === 'summary') inSummary.push(a.id);
      }
      await enqueueTeamNews(tx, { eventId: created.id, action: 'team_request.created', workspaceId: req.params.ws, leadIds: inSummary, occurredAt: now });
      const info = (await tx.query<{ room: string; lead: string; grp: string }>(
        `select w.name as room, p.name as lead, g.name as grp from workspace w, person p, groups g where w.id = $1 and p.id = $2 and g.id = $3`,
        [req.params.ws, personOf(caller), group])).rows[0]!;
      return { id, to, info, payload, brandRow: to.length ? await brandingRow(tx) : null };
    });
    const brand = made.to.length ? await brandingFrom(made.brandRow, app.deps.storage, app.deps.publicUrl) : null;
    await tellAdminsOfRequest(app, req, req.params.ws, { ...made, brand });
    return reply.code(201).send({ id: made.id });
  });

  const RequestOut = z.object({
    id: z.string().uuid(), status: z.enum(['pending', 'approved', 'declined', 'withdrawn']), groupId: z.string().uuid(), groupName: z.string(),
    requestedBy: z.string(), name: z.string(), givenName: z.string(), familyName: z.string(), email: z.string(),
    company: z.string(), jobTitle: z.string(), reason: z.string(), createdAt: z.string(), decidedAt: z.string().nullable(),
    decisionNote: z.string().nullable(),
    decidedBy: z.string().nullable(),
  });
  const toRequest = (a: any) => {
    const p = a.payload;
    const name: string = p.name ?? `${p.givenName ?? ''} ${p.familyName ?? ''}`.trim();
    const space = name.indexOf(' ');
    return { id: a.id, status: a.status, groupId: a.group_id, groupName: a.group_name, requestedBy: a.requester, name,
      givenName: p.givenName ?? (space < 0 ? name : name.slice(0, space)), familyName: p.familyName ?? (space < 0 ? '' : name.slice(space + 1)),
      email: p.email, company: p.company ?? '', jobTitle: p.jobTitle ?? p.role ?? '', reason: p.reason ?? '',
      createdAt: new Date(a.created_at).toISOString(), decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null,
      decisionNote: a.decision_note ?? null, decidedBy: a.decider ?? null };
  };
  const requestRow = async (tx: SqlClient, id: string) => toRequest((await tx.query<any>(
    `select a.*, g.name as group_name, ${NAME} as requester, (select case when d.erased_at is not null then 'Erased user' else d.name end from person d where d.id = a.decided_by) as decider
       from approval a join groups g on g.id = a.group_id join person p on p.id = a.requested_by
      where a.id = $1`, [id])).rows[0]);

  r.get('/v1/workspaces/:ws/team-requests', {
    schema: {
      summary: 'List access requests',
      params: WsParams, querystring: z.object({ status: z.enum(['pending', 'approved', 'declined', 'withdrawn']).optional() }),
      response: { 200: z.object({ items: z.array(RequestOut) }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    const me = await requireMember(tx, caller, req.params.ws, now);
    const leads = me.isAdmin ? [] : await leadGroupsOf(tx, personOf(caller), req.params.ws, now);
    if (!me.isAdmin && leads.length === 0) throw notFound();
    const { rows } = await tx.query<any>(
      `select a.*, g.name as group_name, ${NAME} as requester, (select case when d.erased_at is not null then 'Erased user' else d.name end from person d where d.id = a.decided_by) as decider
         from approval a join groups g on g.id = a.group_id join person p on p.id = a.requested_by
        where a.workspace_id = $1 and a.kind = 'colleague_request' and ($2 or a.group_id = any($3::uuid[]))
          and ($4::text is null or a.status = $4) order by a.created_at`,
      [req.params.ws, me.isAdmin, leads, req.query.status ?? null]);
    return { items: rows.map(toRequest) };
  }));

  r.post('/v1/workspaces/:ws/team-requests/:id/decide', {
    schema: {
      summary: 'Approve or decline a colleague request',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({ decision: z.enum(['approve', 'decline']), note: z.string().max(1000).optional() }),
      response: { 200: RequestOut },
    },
  }, async (req) => {
    const now = app.now();
    const { out, invites, lead, decisionEventId } = await app.inTenant(req, async (tx, caller) => {
      await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
      await refuseIfArchived(tx, req.params.ws);
      const a = (await tx.query<any>(`select * from approval where id = $1 and workspace_id = $2 and kind = 'colleague_request' for update`, [req.params.id, req.params.ws])).rows[0];
      if (!a) throw notFound();
      if (a.status !== 'pending') throw conflict('Already decided', `This request was ${a.status} earlier.`);
      let invites: NewInvite[] = [];
      if (req.body.decision === 'approve') {
        // else the lead's end date
        const ends = (await tx.query<{ group_end: unknown; lead_end: unknown }>(
          `select g.valid_to as group_end,
                  (select l.valid_to from membership l where l.person_id = $2 and l.group_id = g.id and l.superseded_at = 'infinity'
                    order by l.valid_from desc limit 1) as lead_end
             from groups g where g.id = $1`, [a.group_id, a.requested_by])).rows[0]!;
        let until: Date | null = null;
        if (!endless(ends.group_end)) until = new Date(ends.group_end as string);
        else if (!endless(ends.lead_end)) until = new Date(ends.lead_end as string);
        const p = toRequest({ ...a, group_name: '', requester: '' });
        invites = await invite(tx, { workspaceId: req.params.ws, groupId: a.group_id, role: 'member',
          people: [{ email: p.email, givenName: p.givenName, familyName: p.familyName || undefined, name: p.familyName ? undefined : p.name,
            company: p.company || undefined, jobTitle: p.jobTitle || undefined }],
          accessExpiresAt: until, message: null, invitedBy: personOf(caller), actorId: caller.actorId, now, requestId: req.id });
      }
      const status = req.body.decision === 'approve' ? 'approved' : 'declined';
      await tx.query(`update approval set status = $2, decided_by = $3, decision_note = $4 where id = $1`,
        [a.id, status, personOf(caller), req.body.note ?? null]);
      const decided = await appendEvent(tx, { action: `team_request.${status}`, workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'approval', resourceId: a.id,
        data: { group_id: a.group_id }, occurredAt: now, requestId: req.id });
      const lead = (await tx.query<{ id: string; email: string; given_name: string; gone: boolean; room: string }>(
        `select p.id, p.email, p.given_name, (p.erased_at is not null or p.disabled_at is not null) as gone, w.name as room
           from person p, workspace w where p.id = $1 and w.id = $2`,
        [a.requested_by, req.params.ws])).rows[0];
      const stillLead = !!lead && !lead.gone && (await leadGroupsOf(tx, a.requested_by, req.params.ws, now)).includes(a.group_id);
      return { out: await requestRow(tx, a.id), invites, lead: stillLead ? lead : null, decisionEventId: decided.id };
    });
    await sendInvites(app, req, req.params.ws, invites);
    if (lead) await tellLead(app, req, req.params.ws, out, lead, decisionEventId);
    return out;
  });

  r.post('/v1/workspaces/:ws/team-requests/:id/withdraw', {
    schema: {
      summary: 'Withdraw a pending colleague request',
      params: WsParams.extend({ id: z.string().uuid() }),
      response: { 200: RequestOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireMember(tx, caller, req.params.ws, now);
    const a = (await tx.query<any>(`select * from approval where id = $1 and workspace_id = $2 and kind = 'colleague_request' for update`,
      [req.params.id, req.params.ws])).rows[0];
    if (!a) throw notFound();
    const leads = await leadGroupsOf(tx, personOf(caller), req.params.ws, now);
    if (leads.length === 0) throw forbidden('Only a lead of this group can withdraw its requests.', 'not_group_lead');
    if (!leads.includes(a.group_id)) throw notFound();
    if (a.status !== 'pending') throw conflict('Already decided', `This request was ${a.status} earlier.`);
    await tx.query(`update approval set status = 'withdrawn', decided_by = $2 where id = $1`, [a.id, personOf(caller)]);
    await appendEvent(tx, { action: 'team_request.withdrawn', workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'approval', resourceId: a.id,
      data: { group_id: a.group_id }, occurredAt: now, requestId: req.id });
    return requestRow(tx, a.id);
  }));

  const RemovalOut = z.object({
    id: z.string().uuid(), status: z.enum(['pending', 'approved', 'declined', 'withdrawn']), groupId: z.string().uuid(), groupName: z.string(),
    requestedBy: z.string(), membershipId: z.string().uuid(), personId: z.string().uuid(), name: z.string(), reason: z.string(),
    createdAt: z.string(), decidedAt: z.string().nullable(), decisionNote: z.string().nullable(),
  });
  const removalRows = async (tx: SqlClient, where: string, params: unknown[]) => (await tx.query<any>(
    `select a.*, g.name as group_name, ${NAME.replace(/\bp\./g, 'rq.')} as requester, ${NAME} as name
       from approval a join groups g on g.id = a.group_id join person rq on rq.id = a.requested_by
       join person p on p.id = (a.payload ->> 'person_id')::uuid
      where a.kind = 'removal_request' and ${where} order by a.created_at`, params)).rows.map((a: any) => ({
    id: a.id, status: a.status, groupId: a.group_id, groupName: a.group_name, requestedBy: a.requester,
    membershipId: a.payload.membership_id, personId: a.payload.person_id, name: a.name, reason: a.payload.reason ?? '',
    createdAt: new Date(a.created_at).toISOString(), decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null,
    decisionNote: a.decision_note ?? null,
  }));

  r.post('/v1/workspaces/:ws/removal-requests', {
    schema: {
      summary: 'Ask to remove a colleague (lead)',
      params: WsParams,
      body: z.object({ membershipId: z.string().uuid(), reason: z.string().trim().min(1, 'Give a reason').max(1000) }),
      response: { 201: z.object({ id: z.string().uuid() }) },
    },
  }, async (req, reply) => reply.code(201).send(await app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    const me = await requireMember(tx, caller, req.params.ws, now);
    const m = await currentMembership(tx, req.body.membershipId, req.params.ws);
    const leads = await leadGroupsOf(tx, personOf(caller), req.params.ws, now);
    if (!m || !leads.includes(m.group_id)) {
      if (leads.length === 0 || me.isAdmin) throw forbidden('Only a lead can ask to remove a colleague.', 'not_group_lead');
      // same 404 as a missing membership: don't reveal other groups
      throw notFound();
    }
    if (m.person_id === personOf(caller)) throw badRequest('You cannot ask to remove yourself. Ask the room admin directly.');
    if (m.role === 'lead') throw badRequest('Leads cannot be removed at the request of another lead. Ask the room admin directly.');
    if (hasEnded(m, now) || m.status === 'revoked') throw conflict('Already removed', 'This person no longer has access.');
    const payload = { membership_id: m.id, person_id: m.person_id, reason: req.body.reason };
    let id: string;
    try {
      await tx.query('savepoint removal_request');
      id = (await tx.query<{ id: string }>(
        `insert into approval (tenant_id, workspace_id, kind, requested_by, group_id, payload)
         values (current_tenant_id(), $1, 'removal_request', $2, $3, $4) returning id`,
        [req.params.ws, personOf(caller), m.group_id, JSON.stringify(payload)])).rows[0]!.id;
      await tx.query('release savepoint removal_request');
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      await tx.query('rollback to savepoint removal_request');
      throw conflict('Already requested', 'A request to remove this person is already waiting for the room admin.');
    }
    await appendEvent(tx, { action: 'removal_request.created', workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'approval', resourceId: id,
      data: { group_id: m.group_id, member_person_id: m.person_id }, occurredAt: now, requestId: req.id });
    return { id };
  })));

  r.get('/v1/workspaces/:ws/removal-requests', {
    schema: {
      summary: 'List requests to remove a colleague',
      params: WsParams, querystring: z.object({ status: z.enum(['pending', 'approved', 'declined', 'withdrawn']).optional() }),
      response: { 200: z.object({ items: z.array(RemovalOut) }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    const me = await requireMember(tx, caller, req.params.ws, now);
    const leads = me.isAdmin ? [] : await leadGroupsOf(tx, personOf(caller), req.params.ws, now);
    if (!me.isAdmin && leads.length === 0) throw notFound();
    return { items: await removalRows(tx, `a.workspace_id = $1 and ($2 or a.group_id = any($3::uuid[])) and ($4::text is null or a.status = $4)`,
      [req.params.ws, me.isAdmin, leads, req.query.status ?? null]) };
  }));

  r.post('/v1/workspaces/:ws/removal-requests/:id/decide', {
    schema: {
      summary: 'Approve or decline a request to remove a colleague',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({ decision: z.enum(['approve', 'decline']), note: z.string().max(1000).optional() }),
      response: { 200: RemovalOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
    await refuseIfArchived(tx, req.params.ws);
    const a = (await tx.query<any>(`select * from approval where id = $1 and workspace_id = $2 and kind = 'removal_request' for update`,
      [req.params.id, req.params.ws])).rows[0];
    if (!a) throw notFound();
    if (a.status !== 'pending') throw conflict('Already decided', `This request was ${a.status} earlier.`);
    let revokedMembershipId: string | null = null;
    if (req.body.decision === 'approve') {
      const m = await currentMembership(tx, a.payload.membership_id, req.params.ws);
      if (m && !hasEnded(m, now)) {
        revokedMembershipId = await revokeMembership(tx, { membershipId: m.id, workspaceId: req.params.ws, now, byPerson: personOf(caller),
          actorId: caller.actorId, requestId: req.id });
      }
    }
    const status = req.body.decision === 'approve' ? 'approved' : 'declined';
    await tx.query(`update approval set status = $2, decided_by = $3, decision_note = $4 where id = $1`,
      [a.id, status, personOf(caller), req.body.note ?? null]);
    await appendEvent(tx, { action: `removal_request.${status}`, workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'approval', resourceId: a.id,
      data: { group_id: a.group_id, member_person_id: a.payload.person_id, revoked_membership_id: revokedMembershipId }, occurredAt: now, requestId: req.id });
    return (await removalRows(tx, `a.id = $1`, [a.id]))[0]!;
  }));

  const TeamMemberOut = MemberOut.extend({
    invitedAt: z.string().nullable(),
  });

  r.get('/v1/workspaces/:ws/my-team', {
    schema: {
      summary: 'My team: members, status, access end and room admins',
      params: WsParams,
      response: {
        200: z.object({
          groups: z.array(z.object({
            id: z.string().uuid(), name: z.string(), isLead: z.boolean(),
            organisation: z.string().nullable(),
            accessEndsAt: z.string().nullable(),
            members: z.array(TeamMemberOut),
          })),
          roomAdmins: z.array(z.object({ name: z.string(), company: z.string().nullable() })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    const at = now.toISOString();
    const me = await requireMember(tx, caller, req.params.ws, now);
    const groups = (await tx.query<any>(
      `select g.id, g.name, g.valid_to as group_end, g.parent_group_id,
              coalesce(nullif(btrim(g.organisation), ''), nullif(btrim(g.metadata ->> 'organisation'), '')) as organisation,
              bool_or(m.role = 'lead' and m.status = 'active' and m.valid_from <= $3 and $3 < m.valid_to) as is_lead,
              max(m.valid_to) filter (where m.status = 'active' and m.valid_from <= $3 and $3 < m.valid_to) as my_end
         from groups g join membership m on m.group_id = g.id
        where g.id = any($1::uuid[]) and m.person_id = $2 and m.superseded_at = 'infinity'
        group by g.id, g.name, g.valid_to, g.organisation, g.metadata, g.parent_group_id order by g.name`,
      [me.groupIds, personOf(caller), at])).rows;
    const all = await members(tx, groups.map((g: any) => g.id), now);
    const admins = (await tx.query<{ name: string; company: string | null }>(
      `select distinct ${NAME} as name, case when p.erased_at is null then nullif(btrim(p.company), '') end as company
         from membership m join person p on p.id = m.person_id join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
        where g.workspace_id = $1 and g.role_template = 'admin' and pa.kind = 'seller' and m.status = 'active'
          and m.valid_from <= $2 and $2 < m.valid_to and m.superseded_at = 'infinity' and g.valid_from <= $2 and $2 < g.valid_to
        order by 1`, [req.params.ws, at])).rows;
    for (const g of groups) g.is_lead = !!g.is_lead && !g.parent_group_id;
    const iso = (v: unknown) => (endless(v) ? null : new Date(v as string).toISOString());
    const teamOf = (g: any) => {
      const out = [];
      for (const m of all) {
        if (m.groupId !== g.id || !m.inTeam) continue;
        if (caller.seeAs && m.personId === personOf(caller)) continue;
        const { groupId: _g, inTeam: _t, admin: _a, removalRequested, ...member } = m;
        if (g.parent_group_id && member.role === 'lead') member.role = 'member';
        out.push(g.is_lead ? { ...member, removalRequested } : member);
      }
      return out;
    };
    return {
      groups: groups.map((g: any) => ({ id: g.id, name: g.name, isLead: g.is_lead, organisation: g.organisation ?? null,
        accessEndsAt: iso(g.group_end) ?? iso(g.my_end),
        members: teamOf(g) })),
      roomAdmins: admins,
    };
  }));
};
