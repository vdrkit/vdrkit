// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  appendEvent, enqueueForEvent, FREQUENCIES, IDLE_SIGN_OUT_MINUTES, MODES, NOTIFICATION_EVENTS, notificationEvent, roomTiming, STANDARD_MA_INDEX,
  TRUSTED_BROWSER_DAYS, type Frequency, type SqlClient,
} from '@vdrkit/core';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { personOf, refuseIfArchived, refuseIfFrozen, requireMember, requireWorkspaceAdmin } from './util.js';
import { defaultInvitationText, mergeInvitationText, readInvitationText } from './invitation-text.js';
import { mailFormFromEnv, readMailRow } from '../site/mail.js';
import { countWaitingInvitations, endless, invite, OPEN_STATES, releaseWaitingInvitations, sendInvites, type Invitee, type NewInvite } from './people.js';
import { ndaPdf } from './nda-pdf.js';
import { DEFAULT_FIELDS } from '../pipeline/watermark.js';
import { SELLER_ID_SQL, sellerNameSql } from './seller.js';
import { checkLogo, copyRoom, createStandardIndex, legacyLogoPng, LOGO_TYPES, storeLogo, type CopyResult } from './room-setup.js';
import { isTimeZone } from './profile.js';

const WsParams = z.object({ ws: z.string().uuid() });
const TimeZone = z.string().refine(isTimeZone, 'Unknown time zone');
const WatermarkFields = z.object({ name: z.boolean(), email: z.boolean(), group: z.boolean(), dateTime: z.boolean(), ip: z.boolean() });
const Mode = z.enum(MODES as unknown as [string, ...string[]]);
const Frequency = z.enum(FREQUENCIES as unknown as [Frequency, ...Frequency[]]);
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const IdleMinutes = z.number().int().refine((m) => (IDLE_SIGN_OUT_MINUTES as readonly number[]).includes(m),
  { message: `Choose one of ${IDLE_SIGN_OUT_MINUTES.join(', ')} minutes.` });
const TrustDays = z.number().int().min(TRUSTED_BROWSER_DAYS.min).max(TRUSTED_BROWSER_DAYS.max);

const NdaOut = z.object({ required: z.boolean(), versionId: z.string().uuid().nullable(), versionNo: z.number().nullable(), body: z.string().nullable(), acceptedAt: z.string().nullable(),
  mode: z.enum(['everyone', 'correction']).nullable(),
  mustAccept: z.boolean(),
  name: z.string().nullable(),
  publishedAt: z.string().nullable(),
  pages: z.number().int().nullable(),
  roomName: z.string(),
  runBy: z.string(),
  sellerName: z.string().nullable(),
  contactName: z.string().nullable(),
  accessEndsAt: z.string().nullable(),
});

function ndaPdfInput(roomName: string, v: { version_no: number | string; body: string; published_at: string | Date; name: string }, timeZone = 'UTC') {
  const day = new Date(v.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone });
  return { title: v.name, subtitle: `${roomName} · version ${Number(v.version_no)} · published ${day}`, body: v.body };
}

async function ndaFacts(tx: SqlClient, ws: string, personId: string, now: Date) {
  const r = (await tx.query<any>(
    `select w.name as room_name, t.name as run_by,
            ${sellerNameSql('w.id')} as seller,
            (select case when p.erased_at is null then p.name end from membership m join groups g on g.id = m.group_id join person p on p.id = m.person_id
              where g.workspace_id = w.id and g.role_template = 'admin' and m.status = 'active' and m.superseded_at = 'infinity'
                and m.valid_from <= $3 and $3 < m.valid_to and p.erased_at is null
              order by m.valid_from, p.name limit 1) as contact,
            (select max(m.valid_to) from membership m join groups g on g.id = m.group_id
              where g.workspace_id = w.id and m.person_id = $2 and m.status = 'active' and m.superseded_at = 'infinity'
                and m.valid_from <= $3 and $3 < m.valid_to) as until
       from workspace w join tenant t on t.id = w.tenant_id where w.id = $1`, [ws, personId, now.toISOString()])).rows[0];
  const until = r?.until;
  return { roomName: r.room_name as string, runBy: r.run_by as string, sellerName: (r.seller ?? null) as string | null,
    contactName: (r.contact ?? null) as string | null, accessEndsAt: endless(until) ? null : new Date(until).toISOString() };
}

const NdaOverview = z.object({
  required: z.boolean(),
  name: z.string().nullable(),
  current: z.object({
    versionId: z.string().uuid(), versionNo: z.number().int(), name: z.string(), publishedAt: z.string(),
    publishedBy: z.string().nullable(),
    mode: z.enum(['everyone', 'correction']), pages: z.number().int(),
    body: z.string(),
  }).nullable(),
  people: z.object({ accepted: z.number().int(), total: z.number().int() }),
  groups: z.array(z.object({ id: z.string().uuid(), name: z.string(), partyKind: z.string(), parentGroupId: z.string().uuid().nullable(),
    accepted: z.number().int(), total: z.number().int() })),
  history: z.array(z.object({ versionNo: z.number().int(), name: z.string(), publishedAt: z.string(), replacedAt: z.string(), accepted: z.number().int() })),
});

const Logo = z.object({
  contentType: z.enum(LOGO_TYPES),
  data: z.string().max(400_000),
});

const NAME_KEY = `lower(regexp_replace(btrim(w.name), '[[:space:]]+', ' ', 'g'))`;
const nameKey = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();

async function mayCreateRooms(tx: SqlClient, personId: string): Promise<void> {
  const me = await tx.query<{ can: boolean }>(`select person_can_create_rooms($1) as can`, [personId]);
  if (!me.rows[0]?.can) throw notFound();
}

// own rooms only: leaks code names otherwise
async function nameTaken(tx: SqlClient, personId: string, name: string, at: Date, except: string | null = null): Promise<boolean> {
  const r = await tx.query(
    `select 1 from workspace w
      where w.state <> 'deleted' and ${NAME_KEY} = $1 and ($4::uuid is null or w.id <> $4)
        and exists (select 1 from membership m join groups g on g.id = m.group_id
                     where g.workspace_id = w.id and m.person_id = $2 and m.status = 'active'
                       and m.valid_from <= $3 and $3 < m.valid_to and m.superseded_at = 'infinity'
                       and g.valid_from <= $3 and $3 < g.valid_to)
      limit 1`, [nameKey(name), personId, at.toISOString(), except]);
  return r.rows.length > 0;
}

// one create or rename per tenant at a time: two rooms must not take the same name
const lockNames = (tx: SqlClient) => tx.query(`select pg_advisory_xact_lock(hashtextextended('workspace.name:' || current_tenant_id()::text, 0))`);

const nameConflict = (name: string) => new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Name already used', status: 409,
  detail: `You already have a room called ${name}. Choose another name.` });

export const ROOM_STATES = ['preparing', 'open', 'frozen', 'closed', 'archived', 'deleted'] as const;
const RoomState = z.enum(ROOM_STATES);
const TRANSITIONS: Record<string, string[]> = {
  preparing: ['open', 'frozen', 'closed', 'deleted'],
  open: ['preparing', 'frozen', 'closed'],
  frozen: ['preparing', 'open', 'closed'],
  closed: ['preparing', 'open', 'frozen', 'archived'],
  archived: ['deleted'],
  deleted: [],
};
const InvitationText = z.object({ subject: z.string(), message: z.string(), leadParagraph: z.string(),
  senderName: z.string(),
  replyTo: z.string() });

export async function grantAdminsOnTopFolder(tx: SqlClient, workspaceId: string, nodeId: string, now: Date) {
  await tx.query(
    `insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, can_upload, can_manage, can_publish, recorded_at)
     select current_tenant_id(), $1, $2, g.id, 60, true, true, true, $3
       from groups g join party pa on pa.id = g.party_id
      where g.workspace_id = $1 and g.role_template = 'admin' and pa.kind = 'seller'`,
    [workspaceId, nodeId, now.toISOString()],
  );
}

export const roomRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/me/workspaces', {
    schema: {
      summary: 'List my rooms, roles and next milestones',
      response: {
        200: z.object({
          items: z.array(z.object({
            id: z.string().uuid(), name: z.string(), state: z.string(), groups: z.array(z.string()), isAdmin: z.boolean(),
            nextMilestone: z.object({ title: z.string(), dueAt: z.string() }).nullable(),
            openAtSignIn: z.boolean(),
            logos: z.object({ light: z.boolean(), dark: z.boolean() }),
            stateSince: z.string().nullable(),
            onBehalfOf: z.string().nullable(),
            contactName: z.string().nullable(),
          })),
          openAtSignInWorkspaceId: z.string().uuid().nullable(),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    const { rows } = await tx.query<any>(
      `select w.id, w.name, w.state, array_agg(distinct g.name order by g.name) as groups,
              array_agg(distinct g.id) || array_agg(distinct g.parent_group_id) filter (where g.parent_group_id is not null) as group_ids,
              is_workspace_admin($1, w.id, $2) as is_admin, bool_or(pa.kind = 'seller') as is_seller,
              exists (select 1 from workspace_logo l where l.workspace_id = w.id and l.variant = 'light') as logo_light,
              exists (select 1 from workspace_logo l where l.workspace_id = w.id and l.variant = 'dark') as logo_dark,
              (select h.valid_from from workspace_state_history h where h.workspace_id = w.id and h.valid_from <= $2
                order by h.valid_from desc, h.id desc limit 1) as state_since,
              ${sellerNameSql('w.id')} as seller,
              (select p.name from membership am join groups ag on ag.id = am.group_id join person p on p.id = am.person_id
                where ag.workspace_id = w.id and ag.role_template = 'admin' and am.status = 'active' and am.superseded_at = 'infinity'
                  and am.valid_from <= $2 and $2 < am.valid_to and p.erased_at is null
                order by am.valid_from, p.name limit 1) as contact
         from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id join workspace w on w.id = g.workspace_id
        where m.person_id = $1 and m.status = 'active' and m.valid_from <= $2 and $2 < m.valid_to
          and m.superseded_at = 'infinity' and g.valid_from <= $2 and $2 < g.valid_to and w.state <> 'deleted'
        group by w.id, w.name, w.state order by w.name`,
      [personOf(caller), now.toISOString()],
    );
    const pick = (await tx.query<{ ws: string | null }>(`select open_at_sign_in_workspace_id as ws from person where id = $1`, [personOf(caller)])).rows[0]?.ws ?? null;
    const items = [];
    for (const w of rows) {
      const since = w.state_since ? new Date(w.state_since) : null;
      const facts = {
        stateSince: since && Number.isFinite(since.getTime()) ? since.toISOString() : null,
        onBehalfOf: w.seller ?? null,
        contactName: w.contact ?? null,
      };
      const ended = w.state === 'closed' || w.state === 'archived';
      // must match requireMember(): no timetable for anyone who may not enter
      let mayEnter = true;
      if (w.state === 'preparing') mayEnter = w.is_seller;
      else if (ended) mayEnter = w.is_admin;
      const home = w.id === pick && mayEnter && !ended;
      if (!mayEnter) {
        items.push({ id: w.id, name: w.name, state: w.state, groups: w.groups, isAdmin: w.is_admin, nextMilestone: null,
          openAtSignIn: false, logos: { light: w.logo_light, dark: w.logo_dark }, ...facts });
        continue;
      }
      const ms = await tx.query<{ title: string; due_at: string }>(
        `select title, due_at from milestone
          where workspace_id = $1 and deleted_at is null and due_at > $2
            and ($3 or cardinality(visible_to_group_ids) = 0 or visible_to_group_ids && $4::uuid[])
          order by due_at limit 1`, [w.id, now.toISOString(), w.is_admin || w.is_seller, w.group_ids]);
      const m = ms.rows[0];
      items.push({ id: w.id, name: w.name, state: w.state, groups: w.groups, isAdmin: w.is_admin,
        nextMilestone: m ? { title: m.title, dueAt: new Date(m.due_at).toISOString() } : null,
        openAtSignIn: home, logos: { light: w.logo_light, dark: w.logo_dark }, ...facts });
    }
    return { items, openAtSignInWorkspaceId: items.some((i) => i.openAtSignIn) ? pick : null };
  }));

  r.put('/v1/me/open-at-sign-in', {
    schema: {
      summary: 'Set the room to open after sign-in (null for My rooms)',
      body: z.object({ workspaceId: z.string().uuid().nullable() }),
      response: { 200: z.object({ workspaceId: z.string().uuid().nullable() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    if (caller.principal.kind !== 'person') throw forbidden('Only the person themselves can choose this.', 'agent_needs_approval');
    const ws = req.body.workspaceId;
    if (ws) await requireMember(tx, caller, ws, app.now(), { beforeNda: true });
    await tx.query(`update person set open_at_sign_in_workspace_id = $2 where id = $1`, [caller.principal.personId, ws]);
    return { workspaceId: ws };
  }));

  r.get('/v1/workspaces/name-check', {
    schema: {
      summary: 'Check whether a room name is free',
      querystring: z.object({ name: z.string().trim().min(1).max(120) }),
      response: { 200: z.object({ available: z.boolean() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    if (caller.principal.kind !== 'person') throw forbidden('Only people can create rooms.');
    await mayCreateRooms(tx, caller.principal.personId);
    return { available: !(await nameTaken(tx, caller.principal.personId, req.query.name, app.now())) };
  }));

  r.get('/v1/room-templates/standard', {
    schema: {
      summary: 'Preview the Standard M&A index',
      response: {
        200: z.object({
          folders: z.number().int(),
          subfolders: z.number().int(),
          items: z.array(z.object({ indexNumber: z.string(), name: z.string(), children: z.array(z.object({ indexNumber: z.string(), name: z.string() })) })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    if (caller.principal.kind !== 'person') throw forbidden('Only people can create rooms.');
    await mayCreateRooms(tx, caller.principal.personId);
    const items = STANDARD_MA_INDEX.map((f, i) => ({
      indexNumber: String(i + 1), name: f.name,
      children: (f.children ?? []).map((c, j) => ({ indexNumber: `${i + 1}.${j + 1}`, name: c.name })),
    }));
    return { folders: items.length, subfolders: items.reduce((n, f) => n + f.children.length, 0), items };
  }));

  r.post('/v1/workspaces/:ws/standard-index', {
    schema: {
      summary: 'Create the Standard M&A index in an empty room. Room admins only; 409 room_not_empty or room_frozen',
      params: WsParams,
      response: { 201: z.object({ folders: z.number().int(), subfolders: z.number().int() }) },
    },
  }, async (req, reply) => reply.code(201).send(await app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    // double click: the second waits here, then finds folders
    await tx.query(`select 1 from workspace where id = $1 for update`, [ws]);
    await refuseIfFrozen(tx, ws);
    const held = await tx.query(`select bool_or(deleted_at is null) as live from node where workspace_id = $1`, [ws]);
    if (held.rows[0]?.live != null) {
      const detail = held.rows[0].live
        ? 'This room already has folders, so the standard index cannot be added. Create folders in Documents instead.'
        : 'This room still holds removed folders or documents, which keep their numbers, so the standard index cannot be added. Create folders in Documents instead.';
      throw new HttpProblem({ type: 'https://vdrkit.com/problems/room-not-empty', title: 'Room not empty', status: 409, detail, reason: 'room_not_empty' });
    }
    const total = await createStandardIndex(tx, ws, now, grantAdminsOnTopFolder);
    const folders = STANDARD_MA_INDEX.length;
    await appendEvent(tx, { action: 'workspace.standard_index_created', workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace', resourceId: ws,
      data: { person_id: personOf(caller), folders, subfolders: total - folders }, occurredAt: now, requestId: req.id });
    return { folders, subfolders: total - folders };
  })));

  const CreateRoom = z.object({
    name: z.string().trim().min(2).max(120),
    seller: z.string().trim().min(1).max(200).optional(),
    timeZone: TimeZone.default('UTC'),
    start: z.enum(['standard', 'copy', 'empty']).default('empty'),
    copyFrom: z.object({
      workspaceId: z.string().uuid(),
      folders: z.boolean().default(true),
      settings: z.boolean().default(true),
      nda: z.boolean().default(true),
      invitationEmail: z.boolean().default(true),
      sellerGroups: z.boolean().default(false),
    }).optional(),
    topFolders: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    logos: z.object({ light: Logo.optional(), dark: Logo.optional() }).optional(),
    admins: z.array(z.object({ email: z.string().trim().toLowerCase().email().max(320), name: z.string().trim().min(1).max(200).optional() })).max(20).default([]),
  }).refine((b) => (b.start === 'copy') === !!b.copyFrom, { message: 'Give copyFrom with start "copy", and only then', path: ['copyFrom'] })
    .refine((b) => b.start === 'empty' || b.topFolders.length === 0, { message: 'topFolders only goes with start "empty"', path: ['topFolders'] });

  r.post('/v1/workspaces', {
    bodyLimit: 2 * 1024 * 1024,
    schema: {
      summary: 'Create a room',
      body: CreateRoom,
      response: {
        201: z.object({
          id: z.string().uuid(),
          folders: z.number(),
          copied: z.object({ folders: z.number(), sellerGroups: z.number(), grants: z.number(), settings: z.boolean(), nda: z.boolean(), invitationEmail: z.boolean() }).nullable(),
          invitedAdmins: z.array(z.object({ email: z.string(), personId: z.string().uuid() })),
        }),
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const out = await app.inTenant(req, async (tx, caller) => {
      if (caller.principal.kind !== 'person') throw forbidden('Only people can create rooms.');
      const me = caller.principal.personId;
      await mayCreateRooms(tx, me);
      const now = app.now();
      const logos: { variant: 'light' | 'dark'; png: Buffer }[] = [];
      for (const v of ['light', 'dark'] as const) {
        const l = b.logos?.[v];
        if (l) logos.push({ variant: v, png: (await checkLogo(v, l.contentType, l.data)).png });
      }
      if (b.copyFrom) {
        const run = (await tx.query<{ ok: boolean }>(
          `select is_workspace_admin($1, $2, $3) and exists (select 1 from workspace where id = $2 and state <> 'deleted') as ok`,
          [me, b.copyFrom.workspaceId, now.toISOString()])).rows[0]?.ok;
        if (!run) throw notFound();
      }
      await lockNames(tx);
      if (await nameTaken(tx, me, b.name, now)) throw nameConflict(b.name);
      const ws = (await tx.query<{ id: string }>(
        `insert into workspace (tenant_id, name, time_zone, state) values (current_tenant_id(), $1, $2, 'preparing') returning id`,
        [b.name, b.timeZone])).rows[0]!.id;
      const party = (await tx.query<{ id: string }>(
        `insert into party (tenant_id, workspace_id, name, kind) values (current_tenant_id(), $1, $2, 'seller') returning id`, [ws, b.seller ?? 'Seller'])).rows[0]!.id;
      const group = (await tx.query<{ id: string }>(
        `insert into groups (tenant_id, workspace_id, party_id, name, role_template) values (current_tenant_id(), $1, $2, 'Room admins', 'admin') returning id`,
        [ws, party])).rows[0]!.id;
      await tx.query(`insert into membership (tenant_id, person_id, group_id, role, recorded_at) values (current_tenant_id(), $1, $2, 'admin', $3)`,
        [me, group, now.toISOString()]);

      let folders = 0;
      let copied: CopyResult | null = null;
      if (b.start === 'standard') {
        folders = await createStandardIndex(tx, ws, now, grantAdminsOnTopFolder);
      } else if (b.copyFrom) {
        const { workspaceId: from, ...parts } = b.copyFrom;
        copied = await copyRoom(tx, { from, to: ws, toSellerParty: party, parts, now, actorId: caller.actorId, personId: personOf(caller), requestId: req.id }, grantAdminsOnTopFolder);
        folders = copied.folders;
      } else {
        let i = 0;
        for (const name of b.topFolders) {
          i++;
          const node = (await tx.query<{ id: string }>(
            `insert into node (tenant_id, workspace_id, kind, name, index_number, sort_key) values (current_tenant_id(), $1, 'folder', $2, $3, $4) returning id`,
            [ws, name, String(i), i])).rows[0]!.id;
          await grantAdminsOnTopFolder(tx, ws, node, now);
        }
        folders = i;
      }
      for (const l of logos) await storeLogo(tx, ws, l.variant, l.png);

      const mine = (await tx.query<{ email: string }>(`select lower(email) as email from person where id = $1`, [me])).rows[0];
      const seen = new Set<string>([mine?.email ?? '']);
      const people: Invitee[] = [];
      for (const a of b.admins) {
        if (seen.has(a.email)) continue;
        seen.add(a.email);
        people.push(a.name ? { email: a.email, name: a.name } : { email: a.email });
      }

      await appendEvent(tx, { action: 'workspace.created', workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace', resourceId: ws,
        data: { person_id: me, time_zone: b.timeZone, start: b.start, folders, top_folders: b.topFolders.length,
          ...(b.copyFrom ? { copied_from_workspace_id: b.copyFrom.workspaceId, copied } : {}),
          logos: logos.map((l) => l.variant), admins_invited: people.length },
        occurredAt: now, requestId: req.id });
      if (b.copyFrom && copied) {
        await appendEvent(tx, { action: 'workspace.copied', workspaceId: b.copyFrom.workspaceId, actorId: caller.actorId,
          resourceType: 'workspace', resourceId: b.copyFrom.workspaceId, data: { to_workspace_id: ws, person_id: me, copied }, occurredAt: now, requestId: req.id });
      }
      const invites: NewInvite[] = people.length ? await invite(tx, {
        workspaceId: ws, groupId: group, people, role: 'admin', accessExpiresAt: null, message: null,
        invitedBy: me, actorId: caller.actorId, now, requestId: req.id }) : [];
      return { id: ws, folders, copied, invites };
    });
    await sendInvites(app, req, out.id, out.invites);
    return reply.code(201).send({ id: out.id, folders: out.folders, copied: out.copied,
      invitedAdmins: out.invites.map((i) => ({ email: i.email, personId: i.personId })) });
  });

  r.get('/v1/workspaces/:ws/logo/:variant', {
    schema: {
      summary: 'Room logo, light or dark. Members only',
      params: WsParams.extend({ variant: z.enum(['light', 'dark']) }),
    },
  }, async (req, reply) => {
    const logo = await app.inTenant(req, async (tx, caller) => {
      await requireMember(tx, caller, req.params.ws, app.now(), { beforeNda: true });
      return (await tx.query<{ content_type: string; bytes: Buffer | Uint8Array; sha256: string }>(
        `select content_type, bytes, sha256 from workspace_logo where workspace_id = $1 and variant = $2`, [req.params.ws, req.params.variant])).rows[0];
    });
    if (!logo) throw notFound();
    // never serve the SVG
    const body = logo.content_type === 'image/png' ? Buffer.from(logo.bytes) : (await legacyLogoPng(Buffer.from(logo.bytes), logo.content_type));
    if (!body) throw notFound();
    return reply.header('content-type', 'image/png')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=300')
      .header('etag', `"${logo.sha256}"`)
      .send(body);
  });

  r.put('/v1/workspaces/:ws/logo/:variant', {
    bodyLimit: 1024 * 1024,
    schema: {
      summary: 'Replace the room logo (PNG, JPEG, WebP or SVG; served as PNG). Room admins',
      params: WsParams.extend({ variant: z.enum(['light', 'dark']) }),
      body: Logo,
      response: { 200: z.object({ variant: z.enum(['light', 'dark']), contentType: z.string(), sha256: z.string() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, variant } = req.params;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    await refuseIfArchived(tx, ws);
    const { png } = await checkLogo(variant, req.body.contentType, req.body.data);
    const sha256 = await storeLogo(tx, ws, variant, png);
    await appendEvent(tx, { action: 'workspace.logo_changed', workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace', resourceId: ws,
      data: { variant, content_type: 'image/png', uploaded_as: req.body.contentType, sha256, bytes: png.length }, occurredAt: now, requestId: req.id });
    return { variant, contentType: 'image/png', sha256 };
  }));

  r.delete('/v1/workspaces/:ws/logo/:variant', {
    schema: {
      summary: 'Remove the room logo. Room admins',
      params: WsParams.extend({ variant: z.enum(['light', 'dark']) }),
      response: { 204: z.null() },
    },
  }, async (req, reply) => {
    await app.inTenant(req, async (tx, caller) => {
      const { ws, variant } = req.params;
      const now = app.now();
      await requireWorkspaceAdmin(tx, caller, ws, now);
      await refuseIfArchived(tx, ws);
      const gone = (await tx.query<{ sha256: string }>(`delete from workspace_logo where workspace_id = $1 and variant = $2 returning sha256`, [ws, variant])).rows[0];
      if (!gone) throw notFound();
      await appendEvent(tx, { action: 'workspace.logo_removed', workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace', resourceId: ws,
        data: { variant, sha256: gone.sha256 }, occurredAt: now, requestId: req.id });
    });
    return reply.code(204).send(null);
  });

  const Settings = z.object({
    name: z.string(),
    state: RoomState,
    timeZone: z.string(),
    requiresNda: z.boolean(),
    fourEyesPublish: z.boolean(),
    watermark: WatermarkFields,
    invitation: InvitationText,
    requireTwoFactor: z.boolean(),
    allowTrustedBrowser: z.boolean(),
    trustedBrowserDays: z.number().int(),
    idleSignOutMinutes: z.number().int(),
    notifications: z.record(z.string(), z.object({
      label: z.string(), enabled: z.boolean(), mode: Frequency, mandatory: z.boolean(),
      allowedModes: z.array(Mode).nullable(), digestTimes: z.array(z.string()).nullable(),
    })),
    notificationTiming: z.object({ bundleQuietMinutes: z.number(), bundleMaxMinutes: z.number(), summaryTimes: z.array(z.string()) }),
    sellerName: z.string().nullable(),
    invitationDefault: z.object({ subject: z.string(), message: z.string(), leadParagraph: z.string() }),
    sendingAddress: z.object({ address: z.string() }).nullable(),
    publishers: z.array(z.object({ name: z.string(), folders: z.array(z.string()) })),
    waitingInvitations: z.number().int(),
  });

  async function sendingAddress(tx: SqlClient): Promise<{ address: string } | null> {
    const row = await readMailRow(tx);
    if (row?.mail_from_address) return { address: row.mail_from_address };
    const env = mailFormFromEnv(process.env);
    return env ? { address: env.fromAddress } : null;
  }

  const strip = (x: z.infer<typeof Settings>) => ({ ...x, name: undefined, state: undefined, invitation: undefined,
    invitationDefault: undefined, sendingAddress: undefined, publishers: undefined, waitingInvitations: undefined });

  async function readSettings(tx: SqlClient, ws: string): Promise<z.infer<typeof Settings>> {
    const w = (await tx.query<any>(`select name, state, time_zone, requires_nda, four_eyes_publish, metadata, require_two_factor, allow_trusted_browser,
              trusted_browser_days, idle_sign_out_minutes,
              ${sellerNameSql('workspace.id')} as seller,
              (select t.name from tenant t where t.id = workspace.tenant_id) as run_by
         from workspace where id = $1`, [ws])).rows[0];
    // effective_level, not the raw grant
    const pubs = await tx.query<{ who: string; folder: string }>(
      `select coalesce(g.name, p.name) as who, coalesce(n.index_number || ' ', '') || n.name as folder
         from access_grant ag join node n on n.id = ag.node_id and n.deleted_at is null
         left join groups g on g.id = ag.subject_group_id
         left join person p on p.id = ag.subject_person_id and p.erased_at is null
        where ag.workspace_id = $1 and ag.can_publish and ag.effect = 'allow'
          and ag.valid_from <= record_clock() and record_clock() < ag.valid_to
          and ag.recorded_at <= record_clock() and record_clock() < ag.superseded_at
          and coalesce(g.role_template, '') <> 'admin' and coalesce(g.name, p.name) is not null
          and (g.id is null or (g.valid_from <= record_clock() and record_clock() < g.valid_to))
          and exists (
            select 1 from (
              select ag.subject_person_id as pid where ag.subject_person_id is not null
              union all
              select m.person_id from membership m
               where m.group_id = ag.subject_group_id and m.status = 'active'
                 and m.valid_from <= record_clock() and record_clock() < m.valid_to and m.superseded_at = 'infinity'
            ) c join person cp on cp.id = c.pid and cp.erased_at is null and cp.disabled_at is null
            cross join lateral effective_level(c.pid, ag.node_id, record_clock()) e
            where e.can_publish)
        order by 1, n.path`, [ws]);
    const publishers = new Map<string, string[]>();
    for (const r of pubs.rows) {
      const folders = publishers.get(r.who) ?? [];
      folders.push(r.folder);
      publishers.set(r.who, folders);
    }
    const d = defaultInvitationText(w.name, w.requires_nda, w.run_by, w.seller);
    const pol = await tx.query<any>(`select category, enabled, mode, mandatory, allowed_modes, digest_times from notification_policy where workspace_id = $1 and scope = 'workspace'`, [ws]);
    const rows = new Map<string, any>(pol.rows.map((p: any) => [p.category, p]));
    const keys = [...new Set([...NOTIFICATION_EVENTS.map((e) => e.key), ...rows.keys()])];
    return {
      name: w.name, state: w.state, timeZone: w.time_zone, requiresNda: w.requires_nda, fourEyesPublish: w.four_eyes_publish,
      watermark: { ...DEFAULT_FIELDS, ...(w.metadata?.watermark ?? {}) },
      invitation: await readInvitationText(tx, ws),
      requireTwoFactor: w.require_two_factor, allowTrustedBrowser: w.allow_trusted_browser,
      trustedBrowserDays: Number(w.trusted_browser_days), idleSignOutMinutes: Number(w.idle_sign_out_minutes),
      notifications: Object.fromEntries(keys.map((key) => {
        const p = rows.get(key);
        const e = notificationEvent(key);
        const mode = (p?.mode ?? e?.defaultFrequency ?? 'bundled') as Frequency;
        return [key, {
          label: e?.label ?? key,
          enabled: p ? p.enabled !== false : true,
          mode,
          mandatory: p?.mandatory ?? false,
          allowedModes: p?.allowed_modes ?? null,
          digestTimes: p?.digest_times ?? null,
        }];
      })),
      notificationTiming: await roomTiming(tx, ws),
      sellerName: w.seller ?? null,
      invitationDefault: { subject: d.subject, message: d.message, leadParagraph: d.leadParagraph },
      sendingAddress: await sendingAddress(tx),
      publishers: [...publishers].map(([name, folders]) => ({ name, folders })),
      waitingInvitations: await countWaitingInvitations(tx, ws, app.now()),
    };
  }

  r.get('/v1/workspaces/:ws/settings', {
    schema: { summary: 'Room settings', params: WsParams, response: { 200: Settings } },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    await requireWorkspaceAdmin(tx, caller, req.params.ws, app.now());
    return readSettings(tx, req.params.ws);
  }));

  r.patch('/v1/workspaces/:ws/settings', {
    schema: {
      summary: 'Change room settings, including its state',
      params: WsParams,
      body: z.object({
        name: z.string().trim().min(2).max(120).optional(),
        state: RoomState.optional(),
        timeZone: TimeZone.optional(),
        requiresNda: z.boolean().optional(),
        fourEyesPublish: z.boolean().optional(),
        watermark: WatermarkFields.partial().optional(),
        invitation: z.object({
          subject: z.string().trim().min(1).max(200).nullable().optional(),
          message: z.string().trim().min(1).max(5000).nullable().optional(),
          leadParagraph: z.string().trim().max(2000).nullable().optional(),
          senderName: z.string().trim().max(120).nullable().optional(),
          replyTo: z.union([z.literal(''), z.string().trim().email().max(254)]).nullable().optional(),
        }).strict().optional(),
        sellerName: z.string().trim().min(2).max(120).optional(),
        requireTwoFactor: z.boolean().optional(),
        allowTrustedBrowser: z.boolean().optional(),
        trustedBrowserDays: TrustDays.optional(),
        idleSignOutMinutes: IdleMinutes.optional(),
        notifications: z.record(z.string().regex(/^[a-z_]{2,40}$/), z.object({
          enabled: z.boolean().default(true),
          mode: Frequency, mandatory: z.boolean().default(false),
          allowedModes: z.array(Mode).nullable().default(null), digestTimes: z.array(Clock).max(6).nullable().default(null),
        })).optional(),
        notificationTiming: z.object({
          bundleQuietMinutes: z.number().int().min(1).max(60).optional(),
          bundleMaxMinutes: z.number().int().min(10).max(240).optional(),
          summaryTimes: z.array(Clock).min(1).max(2).optional(),
        }).optional(),
      }),
      response: { 200: Settings },
    },
  }, async (req) => {
    const ws = req.params.ws;
    const out = await app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      await requireWorkspaceAdmin(tx, caller, ws, now);
      const b = req.body;
      // an archived room can only be deleted
      if (!(b.state === 'deleted' && Object.entries(b).every(([k, v]) => k === 'state' || v === undefined))) await refuseIfArchived(tx, ws, 'update');
      const before = await readSettings(tx, ws);
      let release: { tenantId: string; actorId: string | null } | null = null;
      if (b.state && b.state !== before.state && !TRANSITIONS[before.state]!.includes(b.state)) {
        throw new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Not possible', status: 409,
          detail: `A room in state "${before.state}" cannot move to "${b.state}".` });
      }
      if (b.name && nameKey(b.name) !== nameKey(before.name)) {
        await lockNames(tx);
        if (await nameTaken(tx, personOf(caller), b.name, now, ws)) throw nameConflict(b.name);
      }
      if (b.requiresNda) {
        const nda = await tx.query(`select 1 from agreement a join agreement_version v on v.agreement_id = a.id where a.workspace_id = $1 and a.kind = 'nda'`, [ws]);
        if (nda.rows.length === 0) throw badRequest('Publish the NDA text before requiring it.');
      }
      const meta: Record<string, unknown> = {};
      if (b.watermark) {
        const watermark = { ...before.watermark, ...b.watermark };
        if (!watermark.name && !watermark.email) throw badRequest('A watermark must carry at least the name or the email address.');
        meta.watermark = watermark;
      }
      if (b.sellerName !== undefined && b.sellerName !== before.sellerName) {
        const seller = (await tx.query<{ id: string }>(
          SELLER_ID_SQL, [ws])).rows[0];
        if (seller) await tx.query(`update party set name = $2 where id = $1`, [seller.id, b.sellerName]);
        else await tx.query(`insert into party (tenant_id, workspace_id, name, kind) values (current_tenant_id(), $1, $2, 'seller')`, [ws, b.sellerName]);
      }
      if (b.invitation) {
        const stored = (await tx.query<{ inv: any }>(`select metadata -> 'invitation' as inv from workspace where id = $1`, [ws])).rows[0]?.inv;
        meta.invitation = mergeInvitationText(stored, b.invitation);
      }
      if (b.state && b.state !== before.state) {
        await tx.query(`select set_config('vdrkit.state_valid_from', $1, true)`, [now.toISOString()]);
      }
      await tx.query(
        `update workspace set name = coalesce($2, name), state = coalesce($3, state), time_zone = coalesce($4, time_zone),
                requires_nda = coalesce($5, requires_nda), metadata = metadata || $6::jsonb, updated_at = $7,
                four_eyes_publish = coalesce($8, four_eyes_publish),
                require_two_factor = coalesce($9, require_two_factor), allow_trusted_browser = coalesce($10, allow_trusted_browser),
                trusted_browser_days = coalesce($11, trusted_browser_days), idle_sign_out_minutes = coalesce($12, idle_sign_out_minutes)
          where id = $1`,
        [ws, b.name ?? null, b.state ?? null, b.timeZone ?? null, b.requiresNda ?? null, JSON.stringify(meta), now.toISOString(),
          b.fourEyesPublish ?? null, b.requireTwoFactor ?? null, b.allowTrustedBrowser ?? null, b.trustedBrowserDays ?? null,
          b.idleSignOutMinutes ?? null]);
      for (const [category, p] of Object.entries(b.notifications ?? {})) {
        const e = notificationEvent(category);
        if (!e) throw badRequest(`There is no event called "${category}". Choose one of: ${NOTIFICATION_EVENTS.map((x) => x.key).join(', ')}.`);
        if (p.mandatory && !p.enabled) throw badRequest(`${e.label} cannot be mandatory and off by default. A mandatory event is always on.`);
        if (p.allowedModes?.length && !p.allowedModes.includes(p.mode)) {
          throw badRequest(`${e.label}: the default "${p.mode}" must be one of the allowed choices.`);
        }
        await tx.query(
          `insert into notification_policy (tenant_id, workspace_id, scope, category, enabled, mode, mandatory, allowed_modes, digest_times)
           values (current_tenant_id(), $1, 'workspace', $2, $3, $4, $5, $6, $7)
           on conflict (workspace_id, scope, coalesce(group_id, person_id, workspace_id), category)
           do update set enabled = excluded.enabled, mode = excluded.mode, mandatory = excluded.mandatory,
                         allowed_modes = excluded.allowed_modes, digest_times = excluded.digest_times`,
          [ws, category, p.enabled, p.mode, p.mandatory, p.allowedModes, p.digestTimes]);
      }
      if (b.notificationTiming) {
        const t = { ...before.notificationTiming, ...b.notificationTiming };
        if (t.bundleMaxMinutes < t.bundleQuietMinutes) {
          throw badRequest(`A bundle cannot wait longer for quiet (${t.bundleQuietMinutes} minutes) than its longest wait (${t.bundleMaxMinutes} minutes).`);
        }
        if (new Set(t.summaryTimes).size !== t.summaryTimes.length) throw badRequest('Choose two different summary times, or only one.');
        await tx.query(
          `insert into notification_room_setting (tenant_id, workspace_id, bundle_quiet_minutes, bundle_max_minutes, summary_times, updated_at)
           values (current_tenant_id(), $1, $2, $3, $4, $5)
           on conflict (workspace_id) do update set bundle_quiet_minutes = excluded.bundle_quiet_minutes,
             bundle_max_minutes = excluded.bundle_max_minutes, summary_times = excluded.summary_times, updated_at = excluded.updated_at`,
          [ws, t.bundleQuietMinutes, t.bundleMaxMinutes, [...t.summaryTimes].sort(), now.toISOString()]);
      }
      const after = await readSettings(tx, ws);
      if (b.state && b.state !== before.state) {
        const toSend = OPEN_STATES.includes(b.state) ? before.waitingInvitations : 0;
        if (toSend) release = { tenantId: caller.tenantId, actorId: caller.actorId };
        await appendEvent(tx, { action: 'workspace.state_changed', workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace', resourceId: ws,
          data: { before: before.state, after: b.state, ...(toSend ? { invitations_to_send: toSend } : {}) }, occurredAt: now, requestId: req.id });
        if (b.state === 'closed') {
          const cleared = (await tx.query<{ id: string }>(
            `update person set open_at_sign_in_workspace_id = null where open_at_sign_in_workspace_id = $1 returning id`, [ws])).rows.length;
          if (cleared) {
            await appendEvent(tx, { action: 'workspace.open_at_sign_in_cleared', workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace',
              resourceId: ws, data: { people: cleared }, occurredAt: now, requestId: req.id });
          }
        }
      }
      const { state: _s, ...rest } = b;
      if (Object.values(rest).some((v) => v !== undefined)) {
        await appendEvent(tx, { action: 'workspace.settings_changed',
          workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace', resourceId: ws,
          data: { before: strip(before), after: strip(after), renamed: b.name ? true : undefined,
            invitation_changed: b.invitation ? Object.keys(b.invitation) : undefined },
          occurredAt: now, requestId: req.id });
      }
      return { after, release };
    });
    if (out.release) await sendWaitingInvitations(req, ws, out.release);
    return out.after;
  });

  async function sendWaitingInvitations(req: FastifyRequest, ws: string, a: { tenantId: string; actorId: string | null }) {
    const inline = () => releaseWaitingInvitations({ ...app.deps, now: () => app.now() }, (fn) => app.inTenantId(a.tenantId, fn), ws,
      { actorId: a.actorId, requestId: req.id });
    const queue = app.deps.queue;
    if (!queue) {
      await inline();
      return;
    }
    try {
      await queue.enqueue('send-waiting-invitations', { tenantId: a.tenantId, workspaceId: ws, actorId: a.actorId, publicUrl: app.deps.publicUrl });
    } catch (err) {
      req.log.error({ err }, 'Could not queue the waiting invitations; sending them now');
      await inline();
    }
  }

  r.get('/v1/workspaces/:ws/nda', {
    schema: {
      summary: 'Current NDA and whether I accepted it',
      params: WsParams,
      response: { 200: NdaOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    const me = await requireMember(tx, caller, req.params.ws, now, { beforeNda: true });
    const w = (await tx.query<{ requires_nda: boolean; accepted: boolean }>(
      `select requires_nda, nda_accepted($2, id, record_clock()) as accepted from workspace where id = $1`,
      [req.params.ws, personOf(caller)])).rows[0]!;
    const v = (await tx.query<any>(
      `select v.id, v.version_no, v.body, v.requires_reacceptance, v.published_at, coalesce(v.name, a.name) as name, ac.accepted_at
         from agreement a join agreement_version v on v.agreement_id = a.id
         left join acceptance ac on ac.agreement_version_id = v.id and ac.person_id = $2
        where a.workspace_id = $1 and a.kind = 'nda' and v.published_at <= record_clock()
        order by v.published_at desc, v.version_no desc limit 1`, [req.params.ws, personOf(caller)])).rows[0];
    const seller = me.partyKinds.includes('seller');
    const facts = await ndaFacts(tx, req.params.ws, personOf(caller), now);
    let mode: 'everyone' | 'correction' | null = null;
    if (v) mode = v.requires_reacceptance ? 'everyone' : 'correction';
    return { required: w.requires_nda, versionId: v?.id ?? null, versionNo: v ? Number(v.version_no) : null, body: v?.body ?? null,
      acceptedAt: v?.accepted_at ? new Date(v.accepted_at).toISOString() : null,
      mode,
      mustAccept: !!v && w.requires_nda && !seller && !w.accepted,
      name: v?.name ?? null, publishedAt: v ? new Date(v.published_at).toISOString() : null,
      pages: v ? (await ndaPdf(ndaPdfInput(facts.roomName, v))).pages : null,
      ...facts };
  }));

  r.get('/v1/workspaces/:ws/nda/pdf', {
    schema: {
      summary: 'Current NDA as PDF',
      params: WsParams,
    },
  }, async (req, reply) => {
    const out = await app.inTenant(req, async (tx, caller) => {
      await requireMember(tx, caller, req.params.ws, app.now(), { beforeNda: true });
      const v = (await tx.query<any>(
        `select v.version_no, v.body, v.published_at, coalesce(v.name, a.name) as name, w.name as room_name, w.time_zone
           from agreement a join agreement_version v on v.agreement_id = a.id join workspace w on w.id = a.workspace_id
          where a.workspace_id = $1 and a.kind = 'nda' and v.published_at <= record_clock()
          order by v.published_at desc, v.version_no desc limit 1`, [req.params.ws])).rows[0];
      if (!v) throw notFound();
      return { pdf: await ndaPdf(ndaPdfInput(v.room_name, v, v.time_zone)), versionNo: Number(v.version_no) };
    });
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="nda-version-${out.versionNo}.pdf"`)
      .header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store')
      .send(Buffer.from(out.pdf.bytes));
  });

  r.get('/v1/workspaces/:ws/nda/overview', {
    schema: {
      summary: 'NDA versions and acceptance per group. Room admins only',
      params: WsParams,
      response: { 200: NdaOverview },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    const w = (await tx.query<{ requires_nda: boolean; room_name: string; agreement: string | null }>(
      `select w.requires_nda, w.name as room_name, a.name as agreement from workspace w
         left join agreement a on a.workspace_id = w.id and a.kind = 'nda' where w.id = $1`, [ws])).rows[0]!;
    const versions = (await tx.query<any>(
      `select v.id, v.version_no, v.body, v.published_at, v.requires_reacceptance, coalesce(v.name, a.name) as name,
              case when p.erased_at is null then p.name end as published_by,
              (select count(*) from acceptance ac where ac.agreement_version_id = v.id)::int as accepted
         from agreement a join agreement_version v on v.agreement_id = a.id left join person p on p.id = v.published_by
        where a.workspace_id = $1 and a.kind = 'nda' and v.published_at <= record_clock()
        order by v.published_at desc, v.version_no desc`, [ws])).rows;
    const people = (await tx.query<{ group_id: string; group_name: string; party_kind: string; parent: string | null; person_id: string; ok: boolean }>(
      `select g.id as group_id, g.name as group_name, pa.kind as party_kind, g.parent_group_id as parent, m.person_id,
              nda_accepted(m.person_id, $1, record_clock()) as ok
         from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id join person p on p.id = m.person_id
        where g.workspace_id = $1 and pa.kind <> 'seller' and m.status = 'active' and m.superseded_at = 'infinity'
          and m.valid_from <= $2 and $2 < m.valid_to and g.valid_from <= $2 and $2 < g.valid_to and p.erased_at is null
        order by g.name`, [ws, now.toISOString()])).rows;
    const groups = new Map<string, { id: string; name: string; partyKind: string; parentGroupId: string | null; accepted: number; total: number }>();
    const persons = new Map<string, boolean>();
    for (const r of people) {
      const g = groups.get(r.group_id) ?? { id: r.group_id, name: r.group_name, partyKind: r.party_kind, parentGroupId: r.parent, accepted: 0, total: 0 };
      g.total += 1;
      if (r.ok) g.accepted += 1;
      groups.set(r.group_id, g);
      persons.set(r.person_id, (persons.get(r.person_id) ?? false) || r.ok);
    }
    const cur = versions[0];
    const iso = (d: unknown) => new Date(d as string).toISOString();
    return {
      required: w.requires_nda,
      name: w.agreement,
      current: cur ? {
        versionId: cur.id, versionNo: Number(cur.version_no), name: cur.name, publishedAt: iso(cur.published_at),
        publishedBy: cur.published_by ?? null,
        mode: cur.requires_reacceptance || versions.length === 1 ? 'everyone' as const : 'correction' as const,
        pages: (await ndaPdf(ndaPdfInput(w.room_name, cur))).pages, body: cur.body,
      } : null,
      people: { accepted: [...persons.values()].filter(Boolean).length, total: persons.size },
      groups: [...groups.values()],
      history: versions.slice(1).map((v: any, i: number) => ({
        versionNo: Number(v.version_no), name: v.name, publishedAt: iso(v.published_at),
        replacedAt: iso(versions[i]!.published_at), accepted: v.accepted,
      })),
    };
  }));

  r.put('/v1/workspaces/:ws/nda', {
    schema: {
      summary: 'Publish a new NDA version: "everyone" or "correction"',
      params: WsParams,
      body: z.object({ body: z.string().trim().min(20).max(100_000), mode: z.enum(['everyone', 'correction']).default('everyone'),
        name: z.string().trim().min(1).max(120).optional() }),
      response: { 200: z.object({ versionId: z.string().uuid(), versionNo: z.number(), mode: z.enum(['everyone', 'correction']),
        requiresNda: z.boolean() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    // the first version also switches the NDA on in the room row
    await refuseIfArchived(tx, ws, 'update');
    let agreement = (await tx.query<{ id: string }>(`select id from agreement where workspace_id = $1 and kind = 'nda'`, [ws])).rows[0]?.id;
    if (!agreement) {
      agreement = (await tx.query<{ id: string }>(`insert into agreement (tenant_id, workspace_id, kind, name) values (current_tenant_id(), $1, 'nda', 'Non-disclosure agreement') returning id`, [ws])).rows[0]!.id;
    }
    const next = Number((await tx.query<{ n: number }>(`select coalesce(max(version_no), 0) + 1 as n from agreement_version where agreement_id = $1`, [agreement])).rows[0]!.n);
    const mode = next === 1 ? 'everyone' as const : req.body.mode;
    const name = req.body.name ?? (await tx.query<{ name: string | null }>(
      `select name from agreement_version where agreement_id = $1 order by version_no desc limit 1`, [agreement])).rows[0]?.name ?? null;
    const v = (await tx.query<{ id: string }>(
      `insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at, requires_reacceptance, name, published_by)
       values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
      [agreement, next, req.body.body, now.toISOString(), mode === 'everyone', name, personOf(caller)])).rows[0]!.id;
    const ev = await appendEvent(tx, { action: 'agreement.version_published', workspaceId: ws, actorId: caller.actorId,
      resourceType: 'agreement_version', resourceId: v, data: { version_no: next, mode, ...(name ? { name } : {}) }, occurredAt: now, requestId: req.id });
    if (mode === 'everyone') {
      await enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: ws, resourceId: null, occurredAt: now, actorPersonId: personOf(caller) });
    }
    let requiresNda = (await tx.query<{ requires_nda: boolean }>(`select requires_nda from workspace where id = $1`, [ws])).rows[0]!.requires_nda;
    if (next === 1 && !requiresNda) {
      const before = await readSettings(tx, ws);
      await tx.query(`update workspace set requires_nda = true, updated_at = $2 where id = $1`, [ws, now.toISOString()]);
      const after = await readSettings(tx, ws);
      await appendEvent(tx, { action: 'workspace.settings_changed', workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace', resourceId: ws,
        data: { before: strip(before), after: strip(after), first_nda: true }, occurredAt: now, requestId: req.id });
      requiresNda = true;
    }
    return { versionId: v, versionNo: next, mode, requiresNda };
  }));

  r.post('/v1/workspaces/:ws/nda/accept', {
    schema: {
      summary: 'Accept the current NDA',
      params: WsParams,
      body: z.object({ versionId: z.string().uuid() }),
      response: { 200: z.object({ acceptedAt: z.string() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    if (caller.principal.kind !== 'person') throw forbidden('Only the person themselves can accept an NDA.');
    await requireMember(tx, caller, ws, now, { beforeNda: true });
    await refuseIfArchived(tx, ws);
    const current = (await tx.query<{ id: string; version_no: number; body: string; name: string | null }>(
      `select v.id, v.version_no, v.body, v.name from agreement a join agreement_version v on v.agreement_id = a.id
        where a.workspace_id = $1 and a.kind = 'nda' and v.published_at <= record_clock() order by v.published_at desc, v.version_no desc limit 1`,
      [ws])).rows[0];
    if (!current || current.id !== req.body.versionId) {
      throw new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Not the current version', status: 409,
        detail: 'A newer NDA version has been published. Read it and accept that one.' });
    }
    const fresh = (await tx.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values (current_tenant_id(), $1, $2, $3)
      on conflict (agreement_version_id, person_id) do nothing returning id`, [current.id, caller.principal.personId, now.toISOString()])).rows[0];
    // accepted before: the first time stands, and the log gets no second entry with another time
    if (!fresh) {
      const had = (await tx.query<{ accepted_at: string }>(`select accepted_at from acceptance where agreement_version_id = $1 and person_id = $2`,
        [current.id, caller.principal.personId])).rows[0]!;
      return { acceptedAt: new Date(had.accepted_at).toISOString() };
    }
    // IP/UA in erasable context only
    await appendEvent(tx, { action: 'agreement.accepted', workspaceId: ws, actorId: caller.actorId, resourceType: 'agreement_version',
      resourceId: current.id, occurredAt: now, requestId: req.id,
      data: { person_id: caller.principal.personId, version_no: Number(current.version_no), ...(current.name ? { version_name: current.name } : {}),
        text_sha256: createHash('sha256').update(current.body, 'utf8').digest('hex'), accepted_at: now.toISOString() },
      context: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, subjectPersonId: caller.principal.personId } });
    return { acceptedAt: now.toISOString() };
  }));

  r.post('/v1/workspaces/:ws/visit', {
    schema: {
      summary: 'Record a room visit; returns my previous visit',
      params: WsParams,
      response: { 200: z.object({ previousVisitAt: z.string().nullable() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireMember(tx, caller, req.params.ws, now, { beforeNda: true });
    const { rows } = await tx.query<{ previous_visit_at: string | null }>(
      `insert into workspace_visit (tenant_id, workspace_id, person_id, last_visit_at) values (current_tenant_id(), $1, $2, $3)
       on conflict (workspace_id, person_id) do update set
         previous_visit_at = case when workspace_visit.last_visit_at < $3::timestamptz - interval '30 minutes'
                                  then workspace_visit.last_visit_at else workspace_visit.previous_visit_at end,
         last_visit_at = $3
       returning previous_visit_at`, [req.params.ws, personOf(caller), now.toISOString()]);
    const p = rows[0]?.previous_visit_at;
    return { previousVisitAt: p ? new Date(p).toISOString() : null };
  }));
};
