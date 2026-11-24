// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { verifyChain, type SqlClient } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { personOf, requireActivityReader, requireMember } from './util.js';
import {
  anyFilter, describe as describeEntry, filterJoins, filterSql, HOUSEKEEPING, KIND_NAMES, kindOf, loadNames, LOG_JOINS, observerView, Params, parseBound, verbOf,
  type LogFilters, type Names,
} from './activity-log.js';
import { proofLookups, proofOf, type ProofLookups } from './activity-proof.js';

export const WsParams = z.object({ ws: z.string().uuid() });

export const LogQuery = z.object({
  action: z.string().max(100).optional(),
  kind: z.enum(KIND_NAMES as [string, ...string[]]).optional(),
  person: z.string().uuid().optional(),
  group: z.string().uuid().optional(),
  node: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

const EntryOut = z.object({
  id: z.string().uuid(), seq: z.number(), occurredAt: z.string(), action: z.string(),
  actorName: z.string().nullable(), resourceType: z.string().nullable(), resourceId: z.string().uuid().nullable(),
  node: z.object({ name: z.string(), indexNumber: z.string().nullable() }).nullable(),
  data: z.record(z.string(), z.unknown()),
  // null once erased
  personal: z.record(z.string(), z.unknown()).nullable(),
  kind: z.string(),
  verb: z.object({ label: z.string(), icon: z.string(), tone: z.string() }),
  person: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  group: z.object({
    id: z.string().uuid(), name: z.string(), parentGroupId: z.string().uuid().nullable(), partyKind: z.string(), isAdmin: z.boolean(),
  }).nullable(),
  item: z.string().nullable(),
  detail: z.string(),
  coverage: z.object({ pagesSeen: z.number(), pageCount: z.number(), minutes: z.number() }).nullable(),
  proof: z.array(z.object({ label: z.string(), value: z.string(), mono: z.boolean().optional() })).nullable(),
});

export type ReaderRole = 'admin' | 'observer';

export async function readerZone(tx: SqlClient, person: string, ws: string): Promise<string> {
  return (await tx.query<{ tz: string }>(
    `select coalesce((select time_zone from person where id = $1), (select time_zone from workspace where id = $2), 'UTC') as tz`, [person, ws])).rows[0]!.tz;
}

export async function readerView(tx: SqlClient, caller: Caller, ws: string, role: ReaderRole, now: Date, p: Params): Promise<string> {
  if (role === 'admin') return '';
  await requireMember(tx, caller, ws, now);
  return `and ${observerView(p, ws, personOf(caller), now.toISOString())}`;
}

export type Entry = z.infer<typeof EntryOut>;

// seen: the nodes the reader may know of. A renumbering lists every item it moved
function readerData(data: Record<string, unknown> | null, seen: Set<string>): Record<string, unknown> {
  if (!data) return data as unknown as Record<string, unknown>;
  const { visible_to_group_ids: _hidden, ...rest } = data;
  if (Array.isArray(rest.changes)) rest.changes = rest.changes.filter((c: { id?: unknown }) => typeof c?.id === 'string' && seen.has(c.id));
  return rest;
}

export async function readEntries(tx: SqlClient, caller: Caller, ws: string, role: ReaderRole, now: Date, f: LogFilters,
  o: { limit?: number | undefined; beforeSeq?: number | undefined; timeZone?: string | undefined } = {}): Promise<Entry[]> {
  const p = new Params();
  const where = filterSql(p, ws, f);
  const own = await readerView(tx, caller, ws, role, now, p);
  const seq = o.beforeSeq ? `and e.seq < ${p.add(o.beforeSeq)}` : '';
  const limit = o.limit ? `limit ${p.add(o.limit)}` : '';
  const { rows } = await tx.query<any>(
    `with page as materialized (
       select e.*,
              -- plain uuid here so RLS can use the index (->> and casts block it)
              case when e.action = 'document.opened' and e.data ->> 'session_id' ~* '^[0-9a-f-]{36}$'
                   then (e.data ->> 'session_id')::uuid end as view_session_id
         from event e ${filterJoins(f)}
        where ${where} ${own} ${seq}
        order by e.seq desc ${limit}
     )
     select e.id, e.seq, e.occurred_at, e.action, e.resource_type, e.resource_id, e.data,
            case when pe.erased_at is not null then 'Erased user' else coalesce(pe.name, pr.name) end as actor_name,
            pe.id as person_id, pe.erased_at is not null as erased,
            coalesce(nh.name, n.name) as node_name, case when nh.node_id is null then n.index_number else nh.index_number end as node_index_number,
            ec.personal, host(ec.ip) as ip, ec.user_agent,
            gr.id as group_id, gr.name as group_name, gr.parent_group_id, gr.party_kind, gr.is_admin,
            vs.pages_seen, vs.pages_list, vs.page_count, vs.minutes,
            av.version_no as agreement_version_no,
            (select g2.name from groups g2 where g2.workspace_id = e.workspace_id and g2.id = case
               when e.resource_type = 'group' then e.resource_id
               when e.data ->> 'group_id' ~* '^[0-9a-f-]{36}$' then (e.data ->> 'group_id')::uuid end) as about_group,
            (select case when sp.erased_at is not null then 'Erased user' else sp.name end from person sp
              where e.data ->> 'person_id' ~* '^[0-9a-f-]{36}$' and sp.id = (e.data ->> 'person_id')::uuid) as subject_name
       from page e ${LOG_JOINS}
       left join lateral (
         select g.id, g.name, g.parent_group_id, pa.kind as party_kind, g.role_template = 'admin' as is_admin
           from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
          where m.person_id = pe.id and g.workspace_id = e.workspace_id and m.status = 'active'
            and m.valid_from <= e.occurred_at and e.occurred_at < m.valid_to
            and m.recorded_at <= e.occurred_at and e.occurred_at < m.superseded_at
          order by g.role_template = 'admin' desc, g.parent_group_id is not null desc, g.name limit 1) gr on true
       left join lateral (
         select cardinality(v.pages_seen) as pages_seen, v.pages_seen as pages_list, v.page_count,
                greatest(0, round(extract(epoch from (v.last_seen_at - v.opened_at)) / 60))::int as minutes
           from view_session v
          where v.id = e.view_session_id) vs on true
       left join agreement_version av on e.resource_type = 'agreement_version' and av.id = e.resource_id
      order by e.seq desc`,
    p.values,
  );

  // older entries lack before levels
  const previous = new Map<string, (number | null)[]>();
  if (role === 'admin') {
    for (const e of rows) {
      if (e.action !== 'grants.bulk_changed' || !Array.isArray(e.data?.cells)) continue;
      const levels: (number | null)[] = [];
      for (const c of e.data.cells as any[]) {
        if (!c.group_id || !c.node_id) { levels.push(null); continue; }
        const before = (await tx.query<{ level: number | null }>(
          `select group_level($2, $1, coalesce(x.at, $3::timestamptz) - interval '1 microsecond') as level
             from (select max(g.recorded_at) as at from access_grant g
                    where g.node_id = $1 and g.subject_group_id = $2 and g.recorded_at <= $3) x`,
          [c.node_id, c.group_id, new Date(e.occurred_at).toISOString()])).rows[0];
        levels.push(before?.level != null ? Number(before.level) : 0);
      }
      previous.set(e.id, levels);
    }
  }
  let seen = new Set<string>();
  if (role !== 'admin' && rows.some((e: any) => Array.isArray(e.data?.changes))) {
    seen = new Set((await tx.query<{ node_id: string }>(
      `select node_id from accessible_nodes($1, $2, $3, record_clock())`, [personOf(caller), ws, now.toISOString()])).rows.map((r) => r.node_id));
  }
  let names: Names = { groups: new Map(), nodes: new Map() };
  let lookups: ProofLookups | null = null;
  if (role === 'admin') {
    names = await loadNames(tx, ws, rows);
    lookups = await proofLookups(tx, ws, o.timeZone ?? await readerZone(tx, personOf(caller), ws), rows, names.groups);
  }

  return rows.map((e: any) => {
    const previousLevels = previous.get(e.id) ?? null;
    let proof = null;
    if (lookups) {
      proof = proofOf({
        ...e,
        previous_levels: previousLevels,
        pages_list: e.pages_list ? (e.pages_list as unknown[]).map(Number) : null,
        page_count: e.page_count == null ? null : Number(e.page_count),
        minutes: e.minutes == null ? null : Number(e.minutes),
      }, lookups);
    }
    const d = describeEntry({
      action: e.action, data: e.data ?? {}, resource_type: e.resource_type, previous_levels: previousLevels,
      agreement_version_no: e.agreement_version_no == null ? null : Number(e.agreement_version_no),
      group_name: e.about_group, subject_name: e.subject_name, personal: role === 'admin' ? e.personal : null,
    }, names);
    return {
      id: e.id, seq: Number(e.seq), occurredAt: new Date(e.occurred_at).toISOString(), action: e.action,
      actorName: e.actor_name, resourceType: e.resource_type, resourceId: e.resource_id,
      node: e.node_name == null ? null : { name: e.node_name, indexNumber: e.node_index_number },
      data: role === 'admin' ? e.data : readerData(e.data, seen),
      personal: role === 'admin' ? e.personal : null,
      kind: kindOf(e.action),
      verb: verbOf(e.action),
      person: e.person_id ? { id: e.person_id, name: e.erased ? 'Erased user' : e.actor_name } : null,
      group: e.group_id ? { id: e.group_id, name: e.group_name, parentGroupId: e.parent_group_id, partyKind: e.party_kind, isAdmin: !!e.is_admin } : null,
      item: d.item,
      detail: d.detail || emailLine(e.data, proof, lookups),
      coverage: e.page_count == null ? null : { pagesSeen: Number(e.pages_seen ?? 0), pageCount: Number(e.page_count), minutes: Number(e.minutes ?? 0) },
      proof,
    };
  });
}

function emailLine(data: Record<string, unknown> | null, proof: { label: string; value: string }[] | null, l: { people: Map<string, string> } | null): string {
  const kind = proof?.find((x) => x.label === 'Email')?.value;
  if (!kind || !l) return '';
  const to = typeof data?.recipient_person_id === 'string' ? l.people.get(data.recipient_person_id) : undefined;
  return to ? `${kind} to ${to}` : kind;
}

export const eventRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/events', {
    schema: {
      summary: 'Activity log, newest first, with filters',
      params: WsParams,
      querystring: LogQuery.extend({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        beforeSeq: z.coerce.number().int().positive().optional(),
      }),
      response: {
        200: z.object({
          items: z.array(EntryOut),
          nextBeforeSeq: z.number().nullable(),
          total: z.number(),
          matching: z.number(),
          reader: z.enum(['admin', 'observer']),
          timeZone: z.string(),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    // not for bidders
    const now = app.now();
    const ws = req.params.ws;
    const role = await requireActivityReader(tx, caller, ws, now);
    const tz = await readerZone(tx, personOf(caller), ws);
    const q = req.query;
    const f: LogFilters = {
      action: q.action, kind: q.kind as LogFilters['kind'], person: q.person, group: q.group, node: q.node, q: q.q,
      from: parseBound(q.from, tz, false), to: parseBound(q.to, tz, true),
    };

    const p = new Params();
    const where = filterSql(p, ws, f);
    const own = await readerView(tx, caller, ws, role, now, p);
    const matching = Number((await tx.query<{ n: string }>(`select count(*) as n from event e ${filterJoins(f)} where ${where} ${own}`, p.values)).rows[0]?.n ?? 0);
    const pt = new Params();
    const total = !anyFilter(f) ? matching : Number((await tx.query<{ n: string }>(
      `select count(*) as n from event e where e.workspace_id = ${pt.add(ws)} and e.action <> all(${pt.add(HOUSEKEEPING)}::text[])
         ${await readerView(tx, caller, ws, role, now, pt)}`, pt.values)).rows[0]?.n ?? 0);
    const items = await readEntries(tx, caller, ws, role, now, f, { limit: q.limit, beforeSeq: q.beforeSeq, timeZone: tz });
    return { items, nextBeforeSeq: items.length === q.limit ? items[items.length - 1]!.seq : null, total, matching, reader: role, timeZone: tz };
  }));

  r.get('/v1/workspaces/:ws/events/verify', {
    schema: {
      summary: 'Verify the room’s hash chain and report the first broken link',
      params: WsParams,
      response: {
        200: z.object({
          checked: z.number().nullable(),
          intact: z.boolean(),
          firstBroken: z.number().nullable(),
          checkedAt: z.string(),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    const role = await requireActivityReader(tx, caller, req.params.ws, now);
    const c = await verifyChain(tx, req.params.ws);
    const admin = role === 'admin';
    return { checked: admin ? c.checked : null, intact: c.firstBroken === null, firstBroken: admin ? c.firstBroken : null, checkedAt: now.toISOString() };
  }));
};
