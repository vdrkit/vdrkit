// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, resetGrant, setGrant, type LevelValue } from '@vdrkit/core';
import { badRequest } from '../problems.js';
import { refuseIfArchived, requireWorkspaceAdmin } from './util.js';

const LevelIn = z.union([z.literal(0), z.literal(10), z.literal(20), z.literal(30), z.literal(40), z.literal(50), z.literal(60)]);

const Change = z.object({
  nodeId: z.string().uuid(),
  groupId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  effect: z.enum(['allow', 'deny']).default('allow'),
  reset: z.boolean().default(false),
  level: LevelIn.default(0),
  canUpload: z.boolean().default(false),
  canManage: z.boolean().default(false),
  canPublish: z.boolean().default(false),
  validFrom: z.string().datetime().nullable().default(null),
  validTo: z.string().datetime().nullable().default(null),
}).refine((c) => (c.groupId ? 1 : 0) + (c.personId ? 1 : 0) === 1, { message: 'Give exactly one of groupId or personId' })
  .refine((c) => c.effect === 'allow' || c.personId, { message: 'A deny always names a person' })
  .refine((c) => !c.validFrom || !c.validTo || Date.parse(c.validFrom) < Date.parse(c.validTo),
    { message: 'An access window must end after it starts. Move the end date later or the start date earlier.' });

export const grantRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const WsParams = z.object({ ws: z.string().uuid() });

  r.get('/v1/workspaces/:ws/grants', {
    schema: {
      summary: 'Grants in force on a date',
      params: WsParams,
      querystring: z.object({ at: z.string().datetime().optional() }),
      response: {
        200: z.object({
          at: z.string(),
          grants: z.array(z.object({
            id: z.string().uuid(), nodeId: z.string().uuid(), groupId: z.string().uuid().nullable(), personId: z.string().uuid().nullable(),
            effect: z.enum(['allow', 'deny']), level: z.number(), canUpload: z.boolean(), canManage: z.boolean(), canPublish: z.boolean(),
            validFrom: z.string().nullable(), validTo: z.string().nullable(),
          })),
          nodes: z.array(z.object({
            id: z.string().uuid(), parentId: z.string().uuid().nullable(), kind: z.enum(['folder', 'document']),
            name: z.string(), indexNumber: z.string().nullable(), state: z.enum(['draft', 'published', 'withdrawn']),
            path: z.string(),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const at = req.query.at ? new Date(req.query.at) : app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, app.now());
    const { rows } = await tx.query<any>(
      `select id, node_id, subject_group_id, subject_person_id, effect, level, can_upload, can_manage, can_publish,
              case when valid_from = '-infinity' then null else valid_from end as valid_from,
              case when valid_to = 'infinity' then null else valid_to end as valid_to
         from access_grant
        where workspace_id = $1 and valid_from <= $2 and $2 < valid_to
          and recorded_at <= coalesce($3::timestamptz, record_clock()) and coalesce($3::timestamptz, record_clock()) < superseded_at`,
      // null: record_clock()
      [req.params.ws, at.toISOString(), req.query.at ? at.toISOString() : null],
    );
    const tree = await tx.query<any>(
      req.query.at
        ? `select node_id as id, parent_id, kind, name, index_number, state, path::text as path
             from node_tree_at($1, $2) order by path`
        : `select id, parent_id, kind, name, index_number, state, path::text as path
             from node where workspace_id = $1 and deleted_at is null order by path`,
      req.query.at ? [req.params.ws, at.toISOString()] : [req.params.ws],
    );
    return {
      at: at.toISOString(),
      nodes: tree.rows.map((n: any) => ({
        id: n.id, parentId: n.parent_id, kind: n.kind, name: n.name, indexNumber: n.index_number, state: n.state, path: n.path,
      })),
      grants: rows.map((g: any) => ({
        id: g.id, nodeId: g.node_id, groupId: g.subject_group_id, personId: g.subject_person_id, effect: g.effect,
        level: Number(g.level), canUpload: g.can_upload, canManage: g.can_manage, canPublish: g.can_publish,
        validFrom: g.valid_from ? new Date(g.valid_from).toISOString() : null,
        validTo: g.valid_to ? new Date(g.valid_to).toISOString() : null,
      })),
    };
  }));

  r.get('/v1/workspaces/:ws/permissions', {
    schema: {
      summary: 'Permission matrix, now or at a past date. Room admins only',
      params: WsParams,
      querystring: z.object({ at: z.string().datetime().optional() }),
      response: {
        200: z.object({
          at: z.string(),
          past: z.boolean(),
          room: z.object({ state: z.string(), fourEyesPublish: z.boolean(), summaryTimes: z.array(z.string()) }),
          parties: z.array(z.object({ id: z.string().uuid(), name: z.string(), kind: z.string() })),
          groups: z.array(z.object({
            id: z.string().uuid(), name: z.string(), partyId: z.string().uuid(), parentGroupId: z.string().uuid().nullable(),
            roleTemplate: z.string(), people: z.number(),
            soleMember: z.string().nullable(),
          })),
          nodes: z.array(z.object({
            id: z.string().uuid(), parentId: z.string().uuid().nullable(), kind: z.enum(['folder', 'document']), name: z.string(),
            indexNumber: z.string().nullable(), state: z.string(), published: z.number(), drafts: z.number(),
          })),
          grants: z.array(z.object({
            nodeId: z.string().uuid(), groupId: z.string().uuid(), level: z.number(), canUpload: z.boolean(), canManage: z.boolean(),
            canPublish: z.boolean(), validFrom: z.string().nullable(), validTo: z.string().nullable(), inForce: z.boolean(),
          })),
          effective: z.array(z.object({
            groupId: z.string().uuid(), nodeId: z.string().uuid(), level: z.number(), canUpload: z.boolean(), canManage: z.boolean(),
            canPublish: z.boolean(), sourceNodeId: z.string().uuid().nullable(), capped: z.boolean(),
          })),
          personGrants: z.array(z.object({
            personId: z.string().uuid(), name: z.string(), nodeId: z.string().uuid(), effect: z.enum(['allow', 'deny']), level: z.number(),
            canUpload: z.boolean(), canPublish: z.boolean(), groupIds: z.array(z.string().uuid()),
          })),
          history: z.array(z.object({ at: z.string(), opened: z.boolean() })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    const past = !!req.query.at;
    const at = past ? new Date(req.query.at!) : now;
    if (past && at.getTime() > now.getTime()) throw badRequest('Choose a moment in the past. The room can only be shown as it stood.');
    const atIso = at.toISOString();
    const known = past ? atIso : null;
    const k = 'coalesce($3::timestamptz, record_clock())';

    const room = (await tx.query<{ state: string; four_eyes_publish: boolean; summary_times: string[] | null }>(
      `select workspace_state_at(w.id, $2, ${k}) as state, w.four_eyes_publish, s.summary_times
         from workspace w left join notification_room_setting s on s.workspace_id = w.id where w.id = $1`, [ws, atIso, known])).rows[0]!;
    const parties = (await tx.query<any>(`select id, name, kind from party where workspace_id = $1 order by name`, [ws])).rows;
    const groups = (await tx.query<any>(
      `select g.id, g.name, g.party_id, g.parent_group_id, g.role_template,
              count(distinct m.person_id)::int as people,
              case when count(distinct m.person_id) = 1 then min(p.name) end as sole
         from groups g
         left join membership m on m.group_id = g.id and m.status = 'active' and m.valid_from <= $2 and $2 < m.valid_to
              and m.recorded_at <= ${k} and ${k} < m.superseded_at
         left join person p on p.id = m.person_id
        where g.workspace_id = $1 and g.valid_from <= $2 and $2 < g.valid_to
        group by g.id order by g.name`, [ws, atIso, known])).rows;
    const tree = (await tx.query<any>(
      past
        ? `select node_id as id, parent_id, kind, name, index_number, state, path::text as path from node_tree_at($1, $2::timestamptz, $2::timestamptz)`
        : `select id, parent_id, kind, name, index_number, state, path::text as path from node where workspace_id = $1 and deleted_at is null`,
      past ? [ws, atIso] : [ws])).rows;
    const grants = (await tx.query<any>(
      `select node_id, subject_group_id, level, can_upload, can_manage, can_publish, valid_from <= $2 as in_force,
              case when valid_from = '-infinity' then null else valid_from end as valid_from,
              case when valid_to = 'infinity' then null else valid_to end as valid_to
         from access_grant
        where workspace_id = $1 and subject_group_id is not null and effect = 'allow'
          and $2 < valid_to and (valid_from <= $2 or $3::timestamptz is null)
          and recorded_at <= ${k} and ${k} < superseded_at`, [ws, atIso, known])).rows;
    const effective = (await tx.query<any>(`select * from group_access_matrix($1, $2, ${k})`, [ws, atIso, known])).rows;
    const personGrants = (await tx.query<any>(
      `select ag.subject_person_id, p.name, ag.node_id, ag.effect, ag.level, ag.can_upload, ag.can_publish,
              coalesce((select array_agg(distinct m.group_id) from membership m join groups g on g.id = m.group_id
                         where m.person_id = ag.subject_person_id and g.workspace_id = $1 and m.status = 'active'
                           and m.valid_from <= $2 and $2 < m.valid_to and m.recorded_at <= ${k} and ${k} < m.superseded_at
                           and g.valid_from <= $2 and $2 < g.valid_to), '{}') as group_ids
         from access_grant ag join person p on p.id = ag.subject_person_id
        where ag.workspace_id = $1 and ag.subject_person_id is not null
          and ag.valid_from <= $2 and $2 < ag.valid_to and ag.recorded_at <= ${k} and ${k} < ag.superseded_at
        order by p.name`, [ws, atIso, known])).rows;
    const history = (await tx.query<{ at: Date; opened: boolean }>(
      `with tz as (select coalesce(time_zone, 'UTC') as z from workspace where id = $1),
       moments as (
         select distinct t from (
           select recorded_at as t from access_grant where workspace_id = $1
           union all select superseded_at from access_grant where workspace_id = $1 and superseded_at < 'infinity'
           union all select recorded_at from node_history where workspace_id = $1
         ) x where t <= $2
       ), today as (select ($2::timestamptz at time zone tz.z)::date as d from tz),
       earlier as (
         select at from (
           select max(t) as at from moments, tz, today where (t at time zone tz.z)::date < today.d group by (t at time zone tz.z)::date
         ) e where e.at < (select max(t) from moments)
       ), todays as (
         select t as at from moments, tz, today where (t at time zone tz.z)::date = today.d and t < (select max(t) from moments)
       ), opened as (
         select min(valid_from) as at from workspace_state_history where workspace_id = $1 and state = 'open' and valid_from > '-infinity'
       )
       select x.at, bool_or(x.opened) as opened from (
         select at, false as opened from earlier
         union all select at, false from todays
         union all select o.at, true from opened o where o.at is not null and o.at < $2
       ) x group by x.at order by x.at desc limit 20`, [ws, now.toISOString()])).rows;

    const byId = new Map<string, any>(tree.map((n: any) => [n.id, n]));
    const counts = new Map<string, { published: number; drafts: number }>();
    for (const n of tree) {
      if (n.kind !== 'document' || !n.parent_id) continue;
      const c = counts.get(n.parent_id) ?? { published: 0, drafts: 0 };
      if (n.state === 'published') c.published++;
      else if (n.state === 'draft') c.drafts++;
      counts.set(n.parent_id, c);
    }
    const rowIds = new Set<string>(effective.map((e: any) => e.node_id));
    for (const n of tree) if (n.kind === 'folder') rowIds.add(n.id);
    for (const g of personGrants) rowIds.add(g.node_id);
    const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
    const rowNodes = [...rowIds].map((id) => byId.get(id)).filter(Boolean);
    rowNodes.sort((a: any, b: any) => String(a.path).localeCompare(String(b.path)));
    return {
      at: atIso,
      past,
      room: { state: room.state, fourEyesPublish: room.four_eyes_publish, summaryTimes: room.summary_times ?? ['08:00'] },
      parties: parties.map((p: any) => ({ id: p.id, name: p.name, kind: p.kind })),
      groups: groups.map((g: any) => ({
        id: g.id, name: g.name, partyId: g.party_id, parentGroupId: g.parent_group_id, roleTemplate: g.role_template,
        people: Number(g.people), soleMember: g.sole,
      })),
      nodes: rowNodes.map((n: any) => ({
        id: n.id, parentId: n.parent_id, kind: n.kind, name: n.name, indexNumber: n.index_number, state: n.state,
        published: counts.get(n.id)?.published ?? 0, drafts: counts.get(n.id)?.drafts ?? 0,
      })),
      grants: grants.map((g: any) => ({
        nodeId: g.node_id, groupId: g.subject_group_id, level: Number(g.level), canUpload: g.can_upload, canManage: g.can_manage,
        canPublish: g.can_publish, validFrom: iso(g.valid_from), validTo: iso(g.valid_to), inForce: g.in_force,
      })),
      effective: effective.map((e: any) => ({
        groupId: e.group_id, nodeId: e.node_id, level: Number(e.level), canUpload: e.can_upload, canManage: e.can_manage,
        canPublish: e.can_publish, sourceNodeId: e.source_node_id, capped: e.capped,
      })),
      personGrants: personGrants.map((g: any) => ({
        personId: g.subject_person_id, name: g.name, nodeId: g.node_id, effect: g.effect, level: Number(g.level),
        canUpload: g.can_upload, canPublish: g.can_publish, groupIds: [...(g.group_ids ?? [])],
      })),
      history: history.map((h) => ({ at: new Date(h.at).toISOString(), opened: h.opened })),
    };
  }));

  r.put('/v1/workspaces/:ws/grants', {
    schema: {
      summary: 'Save permission matrix changes (all or nothing)',
      params: WsParams,
      body: z.object({ changes: z.array(Change).min(1).max(1000) }),
      response: { 200: z.object({ changed: z.number(), eventId: z.string().uuid() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    await refuseIfArchived(tx, ws);

    const changes = req.body.changes;
    const cellKeys = changes.map((c) => `${c.nodeId}:${c.groupId ?? c.personId}:${c.effect}`);
    const repeated = cellKeys.filter((k, i) => cellKeys.indexOf(k) !== i);
    if (repeated.length) throw badRequest('The same cell appears more than once in one save.', [...new Set(repeated)]);
    const ids = (k: 'nodeId' | 'groupId' | 'personId') => [...new Set(changes.map((c) => c[k]).filter(Boolean))] as string[];
    const nodes = await tx.query<{ id: string }>(`select id from node where workspace_id = $1 and id = any($2::uuid[])`, [ws, ids('nodeId')]);
    const groups = await tx.query<{ id: string }>(`select id from groups where workspace_id = $1 and id = any($2::uuid[])`, [ws, ids('groupId')]);
    const people = await tx.query<{ id: string }>(
      `select distinct m.person_id as id from membership m join groups g on g.id = m.group_id
        where g.workspace_id = $1 and m.person_id = any($2::uuid[])`, [ws, ids('personId')]);
    const known = new Set([...nodes.rows, ...groups.rows, ...people.rows].map((x) => x.id));
    const unknown = [...ids('nodeId'), ...ids('groupId'), ...ids('personId')].filter((id) => !known.has(id));
    if (unknown.length) throw badRequest('Some ids are not part of this room.', unknown);

    // these rights show drafts: never to the buy side, open invitations and later starts included
    const contributing = changes.filter((c) => !c.reset && c.effect === 'allow' && (c.canUpload || c.canManage || c.canPublish));
    if (contributing.length) {
      const buySide = (await tx.query<{ id: string }>(
        `select g.id from groups g join party pa on pa.id = g.party_id
          where g.workspace_id = $1 and g.id = any($2::uuid[]) and pa.kind in ('bidder', 'financier')
         union
         select m.person_id from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
          where g.workspace_id = $1 and m.person_id = any($3::uuid[]) and pa.kind in ('bidder', 'financier')
            and m.status in ('approved', 'active') and m.superseded_at = 'infinity' and $4 < m.valid_to
            and not coalesce((m.metadata ->> 'revoked')::boolean, false)`,
        [ws, contributing.map((c) => c.groupId).filter(Boolean), contributing.map((c) => c.personId).filter(Boolean), now.toISOString()])).rows.map((r) => r.id);
      if (buySide.length) throw badRequest('Only the seller side may add files, publish or manage. Bidders and financiers get a level only.', buySide);
    }

    const groupLevel = async (groupId: string, nodeId: string) =>
      (await tx.query<{ level: number | null }>(`select group_level($1, $2, record_clock()) as level`, [groupId, nodeId])).rows[0]?.level ?? 0;
    const cells = [];
    for (const c of changes) {
      const subject = c.groupId ? { groupId: c.groupId } : { personId: c.personId! };
      const common = { workspaceId: ws, nodeId: c.nodeId, subject, effect: c.effect, actorId: caller.actorId, requestId: req.id, now, audit: false };
      const before = c.groupId ? await groupLevel(c.groupId, c.nodeId) : null;
      if (c.reset) {
        await resetGrant(tx, common);
      } else {
        await setGrant(tx, {
          ...common, level: c.level as LevelValue, canUpload: c.canUpload, canManage: c.canManage, canPublish: c.canPublish,
          validFrom: c.validFrom ? new Date(c.validFrom) : null, validTo: c.validTo ? new Date(c.validTo) : null,
        });
      }
      const after = c.groupId ? await groupLevel(c.groupId, c.nodeId) : null;
      cells.push({ node_id: c.nodeId, group_id: c.groupId ?? null, person_id: c.personId ?? null, effect: c.effect,
        reset: c.reset, level: c.reset ? null : c.level, can_upload: c.canUpload, can_manage: c.canManage, can_publish: c.canPublish,
        valid_from: c.validFrom, valid_to: c.validTo, ...(before !== null ? { before_level: Number(before), after_level: Number(after) } : {}) });
    }
    const ev = await appendEvent(tx, {
      action: 'grants.bulk_changed', workspaceId: ws, actorId: caller.actorId, resourceType: 'workspace', resourceId: ws,
      data: { cells }, requestId: req.id, occurredAt: now,
    });
    return { changed: changes.length, eventId: ev.id };
  }));
};
