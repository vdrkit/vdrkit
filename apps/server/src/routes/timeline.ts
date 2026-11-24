// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, enqueueForEvent, partsIn, type SqlClient } from '@vdrkit/core';
import { badRequest, notFound } from '../problems.js';
import { personOf, refuseIfArchived, requireMember, requireWorkspaceAdmin } from './util.js';

const WsParams = z.object({ ws: z.string().uuid() });
export const PhaseOut = z.object({ name: z.string(), startsOn: z.string().nullable() }).nullable();
export const MilestoneOut = z.object({
  id: z.string().uuid(), title: z.string(), dueAt: z.string(),
  phase: PhaseOut,
  visibleToGroupIds: z.array(z.string().uuid()).optional(),
});
type MilestoneOut = z.infer<typeof MilestoneOut>;

const COLUMNS = `id, title, due_at, visible_to_group_ids, phase_name, phase_starts_on::text as phase_starts_on`;

function milestoneOut(m: any, admin: boolean): MilestoneOut {
  let phase: MilestoneOut['phase'] = null;
  if (m.phase_name) phase = { name: m.phase_name, startsOn: m.phase_starts_on ? String(m.phase_starts_on).slice(0, 10) : null };
  const out: MilestoneOut = { id: m.id, title: m.title, dueAt: new Date(m.due_at).toISOString(), phase };
  if (admin) out.visibleToGroupIds = m.visible_to_group_ids;
  return out;
}

async function roomTimeZone(tx: SqlClient, ws: string): Promise<string> {
  const { rows } = await tx.query<{ time_zone: string }>(`select time_zone from workspace where id = $1`, [ws]);
  return rows[0]?.time_zone ?? 'UTC';
}

export async function visibleMilestones(tx: SqlClient, ws: string,
  me: { isAdmin: boolean; groupAndParentIds: string[]; partyKinds: string[] }): Promise<MilestoneOut[]> {
  const { rows } = await tx.query<any>(
    `select ${COLUMNS} from milestone
      where workspace_id = $1 and deleted_at is null
        and ($2 or cardinality(visible_to_group_ids) = 0 or visible_to_group_ids && $3::uuid[])
      order by due_at`, [ws, seesEveryDate(me), me.groupAndParentIds]);
  return rows.map((m: any) => milestoneOut(m, me.isAdmin));
}

export const seesEveryDate = (me: { isAdmin: boolean; partyKinds: string[] }) => me.isAdmin || me.partyKinds.includes('seller');

async function checkGroups(tx: SqlClient, ws: string, ids: string[]) {
  if (ids.length === 0) return;
  const { rows } = await tx.query<{ id: string }>(`select id from groups where workspace_id = $1 and id = any($2::uuid[])`, [ws, ids]);
  if (rows.length !== new Set(ids).size) throw badRequest('Some groups are not part of this room.');
}

export const timelineRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/milestones', {
    schema: {
      summary: 'Process timeline',
      params: WsParams,
      response: { 200: z.object({ items: z.array(MilestoneOut) }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const me = await requireMember(tx, caller, req.params.ws, app.now());
    return { items: await visibleMilestones(tx, req.params.ws, me) };
  }));

  const Body = z.object({
    title: z.string().trim().min(2).max(200),
    dueAt: z.string().datetime(),
    visibleToGroupIds: z.array(z.string().uuid()).max(100).default([]),
    phase: z.object({
      name: z.string().trim().min(1).max(120),
      startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    }).nullable().optional(),
    // false: logged, nobody emailed
    notify: z.boolean().optional(),
  });

  async function checkPhaseStart(tx: SqlClient, ws: string, startsOn: string | null | undefined, dueAt: Date) {
    if (!startsOn) return;
    const p = partsIn(dueAt, await roomTimeZone(tx, ws));
    const due = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    if (startsOn > due) throw badRequest('A phase starts on or before its deadline.');
  }

  function checkPhase(phase: { name: string } | null | undefined, groups: string[] | undefined) {
    if (phase && groups && groups.length > 0) throw badRequest('A phase deadline is shown to every bidder group. Leave the groups empty.');
  }

  async function changed(
    tx: SqlClient, ws: string, id: string, actorId: string | null, personId: string, now: Date, requestId: string,
    data: Record<string, unknown>, groups: string[], tell: { notify: boolean; urgent?: boolean } = { notify: true },
  ) {
    const ev = await appendEvent(tx, { action: 'milestone.changed', workspaceId: ws, actorId, resourceType: 'milestone', resourceId: id,
      data: tell.notify ? data : { ...data, emailed: false }, occurredAt: now, requestId });
    if (!tell.notify) return;
    const notice: Parameters<typeof enqueueForEvent>[1] = { id: ev.id, action: ev.action, workspaceId: ws, resourceId: null, occurredAt: now,
      actorPersonId: personId, audienceGroupIds: groups };
    if (tell.urgent) notice.urgent = true;
    await enqueueForEvent(tx, notice);
  }

  r.post('/v1/workspaces/:ws/milestones', {
    schema: { summary: 'Add a milestone', params: WsParams, body: Body, response: { 201: MilestoneOut } },
  }, async (req, reply) => reply.code(201).send(await app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
    await refuseIfArchived(tx, req.params.ws);
    await checkGroups(tx, req.params.ws, req.body.visibleToGroupIds);
    checkPhase(req.body.phase, req.body.visibleToGroupIds);
    await checkPhaseStart(tx, req.params.ws, req.body.phase?.startsOn, new Date(req.body.dueAt));
    const row = (await tx.query<any>(
      `insert into milestone (tenant_id, workspace_id, title, due_at, visible_to_group_ids, phase_name, phase_starts_on, created_at, updated_at)
       values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $7) returning ${COLUMNS}`,
      [req.params.ws, req.body.title, req.body.dueAt, req.body.visibleToGroupIds, req.body.phase?.name ?? null, req.body.phase?.startsOn ?? null,
        now.toISOString()])).rows[0];
    await changed(tx, req.params.ws, row.id, caller.actorId, personOf(caller), now, req.id,
      { change: 'added', due_at: req.body.dueAt, visible_to_group_ids: req.body.visibleToGroupIds, ...(req.body.phase ? { phase_name: req.body.phase.name } : {}) },
      req.body.visibleToGroupIds, { notify: req.body.notify !== false });
    return milestoneOut(row, true);
  })));

  r.patch('/v1/workspaces/:ws/milestones/:id', {
    schema: { summary: 'Change a milestone', params: WsParams.extend({ id: z.string().uuid() }), body: Body.partial(), response: { 200: MilestoneOut } },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
    await refuseIfArchived(tx, req.params.ws);
    const before = (await tx.query<any>(`select *, phase_starts_on::text as phase_starts_text from milestone where id = $1 and workspace_id = $2 and deleted_at is null`, [req.params.id, req.params.ws])).rows[0];
    if (!before) throw notFound();
    const b = req.body;
    if (b.visibleToGroupIds) await checkGroups(tx, req.params.ws, b.visibleToGroupIds);
    let phaseAfter: { name: string } | null | undefined = b.phase;
    let startAfter: string | null | undefined = b.phase?.startsOn;
    if (b.phase === undefined) {
      phaseAfter = before.phase_name ? { name: before.phase_name as string } : null;
      startAfter = before.phase_starts_text ?? null;
    }
    checkPhase(phaseAfter, b.visibleToGroupIds ?? before.visible_to_group_ids);
    await checkPhaseStart(tx, req.params.ws, startAfter, new Date(b.dueAt ?? before.due_at));

    const sameTitle = b.title === undefined || b.title === before.title;
    const sameDue = b.dueAt === undefined || new Date(b.dueAt).getTime() === new Date(before.due_at).getTime();
    const beforeIds: string[] = before.visible_to_group_ids;
    const sameGroups = b.visibleToGroupIds === undefined
      || (b.visibleToGroupIds.length === beforeIds.length && b.visibleToGroupIds.every((g) => beforeIds.includes(g)));
    let samePhase = true;
    if (b.phase === null) samePhase = before.phase_name === null;
    else if (b.phase) samePhase = b.phase.name === before.phase_name && (b.phase.startsOn ?? null) === (before.phase_starts_text ?? null);
    if (sameTitle && sameDue && sameGroups && samePhase) {
      const row = (await tx.query<any>(`select ${COLUMNS} from milestone where id = $1`, [req.params.id])).rows[0];
      return milestoneOut(row, true);
    }
    const after = (await tx.query<any>(
      `update milestone set title = coalesce($2, title), due_at = coalesce($3, due_at), visible_to_group_ids = coalesce($4, visible_to_group_ids), updated_at = $5,
              phase_name = case when $6 then $7 else phase_name end, phase_starts_on = case when $6 then $8::date else phase_starts_on end
        where id = $1 returning ${COLUMNS}`,
      [req.params.id, req.body.title ?? null, req.body.dueAt ?? null, req.body.visibleToGroupIds ?? null, now.toISOString(),
        req.body.phase !== undefined, req.body.phase?.name ?? null, req.body.phase?.startsOn ?? null])).rows[0];
    // groups that lost sight of it must not learn the new date
    const beforeGroups: string[] = before.visible_to_group_ids;
    const afterGroups: string[] = after.visible_to_group_ids;
    const notify = req.body.notify !== false;
    const earlier = new Date(after.due_at).getTime() < new Date(before.due_at).getTime();
    await changed(tx, req.params.ws, req.params.id, caller.actorId, personOf(caller), now, req.id, {
      change: 'changed', due_at_before: new Date(before.due_at).toISOString(), due_at_after: new Date(after.due_at).toISOString(),
      ...(before.title !== after.title ? { title_before: before.title } : {}),
    }, afterGroups, { notify, urgent: earlier });
    if (notify && afterGroups.length > 0) {
      const all = beforeGroups.length > 0 ? beforeGroups
        : (await tx.query<{ id: string }>(`select id from groups where workspace_id = $1`, [req.params.ws])).rows.map((g) => g.id);
      const lost = all.filter((g) => !afterGroups.includes(g));
      if (lost.length) await changed(tx, req.params.ws, req.params.id, caller.actorId, personOf(caller), now, req.id, { change: 'removed', title: before.title }, lost);
    }
    return milestoneOut(after, true);
  }));

  r.delete('/v1/workspaces/:ws/milestones/:id', {
    schema: {
      summary: 'Remove a milestone (kept in history)', params: WsParams.extend({ id: z.string().uuid() }),
      querystring: z.object({ notify: z.enum(['true', 'false']).optional() }),
      response: { 204: z.null() },
    },
  }, async (req, reply) => {
    await app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
      await refuseIfArchived(tx, req.params.ws);
      const m = (await tx.query<any>(`update milestone set deleted_at = $3 where id = $1 and workspace_id = $2 and deleted_at is null returning visible_to_group_ids, due_at, title`,
        [req.params.id, req.params.ws, now.toISOString()])).rows[0];
      if (!m) throw notFound();
      await changed(tx, req.params.ws, req.params.id, caller.actorId, personOf(caller), now, req.id,
        { change: 'removed', title: m.title, due_at: new Date(m.due_at).toISOString() }, m.visible_to_group_ids, { notify: req.query.notify !== 'false' });
    });
    return reply.code(204).send(null);
  });
  r.get('/v1/workspaces/:ws/timeline/groups', {
    schema: {
      summary: 'Bidder groups a date can be limited to, with their time zones',
      params: WsParams,
      response: {
        200: z.object({
          roomTimeZone: z.string(),
          items: z.array(z.object({
            id: z.string().uuid(), name: z.string(), parentGroupId: z.string().uuid().nullable(),
            partyKind: z.enum(['bidder', 'financier', 'observer', 'other']),
            timeZone: z.string(),
            zoneFrom: z.enum(['lead', 'members', 'room']),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now).catch(() => { throw notFound(); });
    const roomZone = await roomTimeZone(tx, req.params.ws);
    const { rows } = await tx.query<any>(
      `select g.id, g.name, g.parent_group_id, pa.kind,
              (select p.time_zone from membership m join person p on p.id = m.person_id
                where m.group_id = g.id and m.status = 'active' and m.role = 'lead' and m.superseded_at = 'infinity'
                  and m.valid_from <= $2 and $2 < m.valid_to and p.erased_at is null
                order by p.name limit 1) as lead_zone,
              (select p.time_zone from membership m join person p on p.id = m.person_id
                where m.group_id = g.id and m.status = 'active' and m.superseded_at = 'infinity'
                  and m.valid_from <= $2 and $2 < m.valid_to and p.erased_at is null
                group by p.time_zone order by count(*) desc, p.time_zone limit 1) as member_zone
         from groups g join party pa on pa.id = g.party_id
        where g.workspace_id = $1 and pa.kind <> 'seller' and g.valid_from <= $2 and $2 < g.valid_to
        order by coalesce((select x.name from groups x where x.id = g.parent_group_id), g.name), g.parent_group_id nulls first, g.name`,
      [req.params.ws, now.toISOString()]);
    const items = rows.map((g: any) => {
      let zoneFrom: 'lead' | 'members' | 'room' = 'room';
      if (g.lead_zone) zoneFrom = 'lead';
      else if (g.member_zone) zoneFrom = 'members';
      return {
        id: g.id, name: g.name, parentGroupId: g.parent_group_id, partyKind: g.kind,
        timeZone: g.lead_zone ?? g.member_zone ?? roomZone,
        zoneFrom,
      };
    });
    return { roomTimeZone: roomZone, items };
  }));
};
