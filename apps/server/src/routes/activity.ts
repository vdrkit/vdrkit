// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SqlClient } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { forbidden, notFound } from '../problems.js';
import { EVENT_PERSON } from './activity-log.js';
import { currentMembers, lastSevenDays, roomZone } from './activity-basis.js';
import type { ReaderRole } from './events.js';
import { personOf, requireActivityReader } from './util.js';

const WsParams = z.object({ ws: z.string().uuid() });

// null = no limit (admins)
async function readableBy(tx: SqlClient, caller: Caller, ws: string, role: ReaderRole, now: Date): Promise<Set<string> | null> {
  if (role === 'admin') return null;
  const { rows } = await tx.query<{ node_id: string }>(
    `select node_id from readable_nodes($1, $2, $3, record_clock(), false) where level > 0`, [personOf(caller), ws, now.toISOString()]);
  return new Set(rows.map((r) => r.node_id));
}

async function bidderGroups(tx: SqlClient, ws: string, now: Date) {
  const rows = (await tx.query<{ id: string; name: string; parent_group_id: string | null; party_kind: string }>(
    `select g.id, g.name, g.parent_group_id, pa.kind as party_kind
       from groups g join party pa on pa.id = g.party_id
      where g.workspace_id = $1 and pa.kind in ('bidder', 'financier') and g.valid_from <= $2 and $2 < g.valid_to`, [ws, now.toISOString()])).rows;
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const tops = rows.filter((g) => !g.parent_group_id || !rows.some((x) => x.id === g.parent_group_id)).sort(byName);
  const ordered: typeof rows = [];
  for (const t of tops) ordered.push(t, ...rows.filter((g) => g.parent_group_id === t.id).sort(byName));
  return ordered;
}

async function membersOf(tx: SqlClient, groupIds: string[], now: Date) {
  return (await tx.query<{
    membership_id: string; group_id: string; person_id: string; name: string; company: string | null; role: string; status: string;
  }>(
    `select distinct on (m.group_id, m.person_id) m.id as membership_id, m.group_id, m.person_id,
            case when p.erased_at is not null then 'Erased user' else p.name end as name, p.company, m.role, m.status
       from membership m join person p on p.id = m.person_id
      where m.group_id = any($1::uuid[]) and m.superseded_at = 'infinity' and m.status in ('active', 'approved')
        and m.valid_from <= $2 and $2 < m.valid_to and not coalesce((m.metadata ->> 'revoked')::boolean, false)
      order by m.group_id, m.person_id, m.valid_from desc`, [groupIds, now.toISOString()])).rows;
}

export const activityRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/activity/summary', {
    schema: {
      summary: 'Bidder activity per group, last 7 days',
      params: WsParams,
      response: {
        200: z.object({
          days: z.array(z.string()),
          timeZone: z.string(),
          groups: z.array(z.object({
            id: z.string().uuid(), name: z.string(), parentGroupId: z.string().uuid().nullable(), partyKind: z.string(),
            parentName: z.string().nullable(),
            members: z.number(),
            active: z.number(),
            docsOpened: z.number(), docsVisible: z.number(),
            downloads: z.number(),
            pagesPerDay: z.array(z.number()),
            readsMost: z.array(z.object({ indexNumber: z.string().nullable(), name: z.string(), share: z.number() })),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    const role = await requireActivityReader(tx, caller, ws, now);
    const tz = await roomZone(tx, ws);
    const days = lastSevenDays(now, tz);
    const since = days[0]!;
    const vis = await readableBy(tx, caller, ws, role, now);
    const groups = await bidderGroups(tx, ws, now);
    const ids = groups.map((g) => g.id);
    const members = await currentMembers(tx, ids, now);

    const sessions = (await tx.query<{ person_id: string; node_id: string; opened_at: string | Date; pages: number; tix: string | null; tname: string; tid: string }>(
      `select v.person_id, v.node_id, v.opened_at, cardinality(v.pages_seen) as pages, t.id as tid, t.index_number as tix, t.name as tname
         from view_session v join node d on d.id = v.node_id join node t on t.workspace_id = d.workspace_id and t.path = subltree(d.path, 0, 1)
        where v.workspace_id = $1 and v.opened_at >= $2 and v.opened_at <= $3`, [ws, since.toISOString(), now.toISOString()])).rows
      .filter((s) => !vis || vis.has(s.node_id));
    const downloads = (await tx.query<{ person_id: string; node_id: string }>(
      `select pe.id as person_id, e.resource_id as node_id from event e
         left join principal pr on pr.id = e.actor_id
         left join person pe on pe.id = coalesce(pr.person_id, pr.on_behalf_of_person_id, ${EVENT_PERSON})
        where e.workspace_id = $1 and e.action = 'document.downloaded' and e.occurred_at >= $2 and e.occurred_at <= $3`,
      [ws, since.toISOString(), now.toISOString()])).rows.filter((d) => !vis || vis.has(d.node_id));

    // mirrors group_level(): keep in step
    const visibleCounts = new Map<string, number>();
    if (groups.length) {
      const docIds = vis ? [...vis] : null;
      const rows = (await tx.query<{ gid: string; n: number }>(
        `with docs as materialized (
           select d.id, d.path from node d
            where d.workspace_id = $1 and d.kind = 'document' and d.state = 'published' and d.deleted_at is null
              and ($5::uuid[] is null or d.id = any($5::uuid[]))),
         gr as materialized (
           select ag.subject_group_id as gid, a.path, ag.level from access_grant ag join node a on a.id = ag.node_id
            where ag.workspace_id = $1 and ag.effect = 'allow' and ag.subject_group_id is not null
              and ag.valid_from <= $2 and $2 < ag.valid_to and ag.superseded_at = 'infinity')
         select x.gid, count(*)::int as n
           from unnest($3::uuid[], $4::uuid[]) as x(gid, parent) cross join docs d
          where coalesce((select gr.level from gr where gr.gid = x.gid and gr.path @> d.path order by nlevel(gr.path) desc limit 1), 0) >= 20
            and (x.parent is null or coalesce((select gr.level from gr where gr.gid = x.parent and gr.path @> d.path order by nlevel(gr.path) desc limit 1), 0) >= 20)
          group by x.gid`,
        [ws, now.toISOString(), ids, groups.map((g) => g.parent_group_id), docIds])).rows;
      for (const r0 of rows) visibleCounts.set(r0.gid, Number(r0.n));
    }

    const out = groups.map((g) => {
      const people = members.get(g.id)!;
      const mine = sessions.filter((s) => people.has(s.person_id));
      const downs = downloads.filter((d) => people.has(d.person_id));
      const perDay = days.map((start, i) => {
        const stop = days[i + 1] ?? new Date(now.getTime() + 1);
        let pages = 0;
        for (const s of mine) {
          const t = new Date(s.opened_at).getTime();
          if (t >= start.getTime() && t < stop.getTime()) pages += Number(s.pages);
        }
        return pages;
      });
      const byFolder = new Map<string, { indexNumber: string | null; name: string; pages: number }>();
      for (const s of mine) {
        const f = byFolder.get(s.tid) ?? { indexNumber: s.tix, name: s.tname, pages: 0 };
        f.pages += Number(s.pages);
        byFolder.set(s.tid, f);
      }
      const folders = [...byFolder.values()];
      const totalPages = folders.reduce((sum, f) => sum + f.pages, 0);
      const top = folders.filter((f) => f.pages > 0).sort((a, b) => b.pages - a.pages).slice(0, 2);
      const readsMost = top.map((f) => ({ indexNumber: f.indexNumber, name: f.name, share: Math.round((f.pages / totalPages) * 100) }));
      return {
        id: g.id, name: g.name, parentGroupId: g.parent_group_id, partyKind: g.party_kind,
        parentName: g.parent_group_id ? groups.find((x) => x.id === g.parent_group_id)?.name ?? null : null,
        members: people.size,
        active: new Set([...mine.map((s) => s.person_id), ...downs.map((d) => d.person_id)]).size,
        docsOpened: new Set(mine.map((s) => s.node_id)).size,
        docsVisible: visibleCounts.get(g.id) ?? 0,
        downloads: downs.length,
        pagesPerDay: perDay,
        readsMost,
      };
    });
    return { days: days.map((d) => d.toISOString()), timeZone: tz, groups: out };
  }));

  r.get('/v1/workspaces/:ws/activity/groups/:group/people', {
    schema: {
      summary: 'Reading activity of one group’s members',
      params: WsParams.extend({ group: z.string().uuid() }),
      response: {
        200: z.object({
          group: z.object({ id: z.string().uuid(), name: z.string(), parentGroupId: z.string().uuid().nullable() }),
          docsVisible: z.number(),
          people: z.array(z.object({
            personId: z.string().uuid(),
            membershipId: z.string().uuid().nullable(),
            name: z.string(), company: z.string().nullable(), lead: z.boolean(),
            status: z.enum(['active', 'invited', 'nda']),
            invitedAt: z.string().nullable(),
            lastSeenAt: z.string().nullable(),
            joinedAt: z.string().nullable(),
            docsRead: z.number(), pagesRead: z.number(), downloads: z.number(),
            minutes: z.number(),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, group } = req.params;
    const now = app.now();
    const role = await requireActivityReader(tx, caller, ws, now);
    if (role !== 'admin') throw forbidden('Only room admins see the people in a bidder group.', 'not_room_admin');
    const groups = await bidderGroups(tx, ws, now);
    const g = groups.find((x) => x.id === group);
    if (!g) throw notFound();
    const vis = await readableBy(tx, caller, ws, role, now);
    const members = await membersOf(tx, [group], now);
    const ids = members.map((m) => m.person_id);

    const reading = (await tx.query<{ person_id: string; node_id: string; pages: number; minutes: number; last_seen_at: string | Date }>(
      `select v.person_id, v.node_id, cardinality(v.pages_seen) as pages,
              greatest(0, extract(epoch from (v.last_seen_at - v.opened_at)) / 60) as minutes, v.last_seen_at
         from view_session v where v.workspace_id = $1 and v.person_id = any($2::uuid[])`, [ws, ids])).rows
      .filter((s) => !vis || vis.has(s.node_id));
    const downloads = (await tx.query<{ person_id: string; node_id: string }>(
      `select pe.id as person_id, e.resource_id as node_id from event e
         left join principal pr on pr.id = e.actor_id
         left join person pe on pe.id = coalesce(pr.person_id, pr.on_behalf_of_person_id, ${EVENT_PERSON})
        where e.workspace_id = $1 and e.action = 'document.downloaded' and pe.id = any($2::uuid[])`, [ws, ids])).rows
      .filter((d) => !vis || vis.has(d.node_id));
    type Facts = { person_id: string; visit: string | Date | null; invited_at: string | Date | null; accepted_at: string | Date | null; nda: boolean };
    const facts = new Map((await tx.query<Facts>(
      `select p.id as person_id,
              (select v.last_visit_at from workspace_visit v where v.workspace_id = $1 and v.person_id = p.id) as visit,
              (select max(i.sent_at) from invitation i where i.workspace_id = $1 and i.person_id = p.id and i.group_id = $3) as invited_at,
              (select max(i.accepted_at) from invitation i where i.workspace_id = $1 and i.person_id = p.id) as accepted_at,
              (not w.requires_nda or nda_accepted(p.id, $1, record_clock())) as nda
         from person p cross join workspace w where w.id = $1 and p.id = any($2::uuid[])`, [ws, ids, group])).rows.map((f) => [f.person_id, f]));
    const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);

    const docsVisible = (await tx.query<{ n: number }>(
      `with docs as materialized (
         select d.id, d.path from node d
          where d.workspace_id = $1 and d.kind = 'document' and d.state = 'published' and d.deleted_at is null
            and ($5::uuid[] is null or d.id = any($5::uuid[]))),
       gr as materialized (
         select ag.subject_group_id as gid, a.path, ag.level from access_grant ag join node a on a.id = ag.node_id
          where ag.workspace_id = $1 and ag.effect = 'allow' and ag.subject_group_id in ($3, $4)
            and ag.valid_from <= $2 and $2 < ag.valid_to and ag.superseded_at = 'infinity')
       select count(*)::int as n from docs d
        where coalesce((select gr.level from gr where gr.gid = $3 and gr.path @> d.path order by nlevel(gr.path) desc limit 1), 0) >= 20
          and ($4::uuid is null or coalesce((select gr.level from gr where gr.gid = $4 and gr.path @> d.path order by nlevel(gr.path) desc limit 1), 0) >= 20)`,
      [ws, now.toISOString(), group, g.parent_group_id, vis ? [...vis] : null])).rows[0]?.n ?? 0;

    const people = members.map((m) => {
      const f = facts.get(m.person_id);
      const mine = reading.filter((s) => s.person_id === m.person_id);
      const seen = [f?.visit, ...mine.map((s) => s.last_seen_at)].filter(Boolean);
      const last = seen.map((x) => new Date(x as string).getTime());
      let status: 'active' | 'invited' | 'nda' = 'active';
      if (m.status === 'approved') status = 'invited';
      else if (f && !f.nda) status = 'nda';
      return {
        personId: m.person_id, membershipId: m.membership_id,
        name: m.name, company: m.company,
        lead: m.role === 'lead' && !g.parent_group_id, status,
        invitedAt: iso(f?.invited_at), lastSeenAt: last.length ? new Date(Math.max(...last)).toISOString() : null, joinedAt: iso(f?.accepted_at),
        docsRead: new Set(mine.map((s) => s.node_id)).size,
        pagesRead: mine.reduce((sum, s) => sum + Number(s.pages), 0),
        downloads: downloads.filter((d) => d.person_id === m.person_id).length,
        minutes: Math.round(mine.reduce((sum, s) => sum + Number(s.minutes), 0)),
      };
    });
    people.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active')
      || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') || Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name));
    return { group: { id: g.id, name: g.name, parentGroupId: g.parent_group_id }, docsVisible: Number(docsVisible), people };
  }));

};
