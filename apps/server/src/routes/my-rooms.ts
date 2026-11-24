// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SqlClient } from '@vdrkit/core';
import { forbidden } from '../problems.js';

const MyGroup = z.object({
  name: z.string(),
  role: z.string(),
  partyKind: z.enum(['seller', 'bidder', 'financier', 'other']),
  subgroup: z.boolean(),
});

const Room = z.object({
  id: z.string().uuid(),
  name: z.string(),
  state: z.enum(['preparing', 'open', 'frozen']),
  isAdmin: z.boolean(),
  side: z.enum(['seller', 'buyer']),
  sellerName: z.string().nullable(),
  groups: z.array(MyGroup),
  logos: z.object({ light: z.boolean(), dark: z.boolean() }),
  lastVisitAt: z.string().nullable(),
  canEnter: z.boolean(),
  openAtSignIn: z.boolean(),
  attention: z.object({
    newDocuments: z.object({ count: z.number().int(), since: z.string().nullable() }).nullable(),
    // bidder leads: own requests only
    colleagueRequests: z.number().int().nullable(),
    draftsWaiting: z.number().int().nullable(),
    ndaToAccept: z.boolean(),
  }),
  nextMilestone: z.object({ title: z.string(), dueAt: z.string() }).nullable(),
});

const PastRoom = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(['closed', 'access_ended']),
  isAdmin: z.boolean(),
  sellerName: z.string().nullable(),
  groups: z.array(MyGroup),
  logos: z.object({ light: z.boolean(), dark: z.boolean() }),
  endedAt: z.string().nullable(),
  lastVisitAt: z.string().nullable(),
  canOpen: z.boolean(),
});

const MyRooms = z.object({
  runBy: z.string(),
  canCreateRooms: z.boolean(),
  isSiteAdmin: z.boolean(),
  openAtSignInWorkspaceId: z.string().uuid().nullable(),
  rooms: z.array(Room),
  past: z.array(PastRoom),
});

function iso(v: unknown): string | null {
  if (v == null || v === 'infinity' || v === '-infinity') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

const ACTIVE = `m.status = 'active' and m.superseded_at = 'infinity' and g.valid_from <= $2`;
const CURRENT = `${ACTIVE} and m.valid_from <= $2 and $2 < m.valid_to and $2 < g.valid_to`;

const SAME_VISIT_MS = 30 * 60_000;

type PartyKind = z.infer<typeof MyGroup>['partyKind'];

async function groupsOf(tx: SqlClient, person: string, at: string, ws: string, current: boolean) {
  const filter = current ? CURRENT : `${ACTIVE} and m.valid_from <= $2`;
  const { rows } = await tx.query<{ name: string; role: string; kind: string; parent: string | null }>(
    `select g.name, m.role, pa.kind, g.parent_group_id as parent
       from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
      where m.person_id = $1 and g.workspace_id = $3 and ${filter}
      order by g.parent_group_id nulls first, g.name`, [person, at, ws]);
  return rows.map((g) => {
    const known = ['seller', 'bidder', 'financier'].includes(g.kind);
    return { name: g.name, role: g.role, partyKind: (known ? g.kind : 'other') as PartyKind, subgroup: !!g.parent };
  });
}

// caller's own figures only, nothing about other groups
export const myRoomsRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/me/rooms', {
    schema: {
      summary: 'My rooms, current and past, with what needs attention',
      response: { 200: MyRooms },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    if (caller.principal.kind !== 'person') throw forbidden('Only the person themselves can list their rooms.', 'agent_needs_approval');
    const person = caller.principal.personId;
    const now = app.now();
    const at = now.toISOString();

    const me = (await tx.query<{ run_by: string; can_create: boolean; site_admin: boolean; pick: string | null }>(
      `select t.name as run_by, person_can_create_rooms(p.id) as can_create, p.is_site_admin and p.disabled_at is null as site_admin,
              p.open_at_sign_in_workspace_id as pick
         from person p join tenant t on t.id = p.tenant_id where p.id = $1`, [person])).rows[0];
    if (!me) throw forbidden('Only the person themselves can list their rooms.');

    const { rows } = await tx.query<any>(
      `with mine as (
         select g.workspace_id as ws, bool_or(${CURRENT}) as current,
                max(least(m.valid_to, g.valid_to)) filter (where not (${CURRENT})) as ended_at,
                bool_or(pa.kind = 'seller' and ${CURRENT}) as seller,
                bool_or(pa.kind = 'seller') as was_seller,
                array_agg(distinct g.id) filter (where ${CURRENT}) || coalesce(array_agg(distinct g.parent_group_id) filter (where ${CURRENT} and g.parent_group_id is not null), '{}') as group_ids
           from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
          where m.person_id = $1 and ${ACTIVE} and m.valid_from <= $2
          group by g.workspace_id)
       select w.id, w.name, w.state, w.requires_nda, x.current, x.ended_at, x.seller, x.was_seller, x.group_ids,
              x.current and is_workspace_admin($1, w.id, $2) as is_admin,
              exists (select 1 from workspace_logo l where l.workspace_id = w.id and l.variant = 'light') as logo_light,
              exists (select 1 from workspace_logo l where l.workspace_id = w.id and l.variant = 'dark') as logo_dark,
              (select h.valid_from from workspace_state_history h where h.workspace_id = w.id and h.valid_from <= $2
                order by h.valid_from desc, h.id desc limit 1) as state_since,
              (select s.name from party s where s.workspace_id = w.id and s.kind = 'seller' order by s.name limit 1) as seller_name,
              v.last_visit_at, v.previous_visit_at
         from mine x join workspace w on w.id = x.ws
         left join workspace_visit v on v.workspace_id = w.id and v.person_id = $1
        where w.state <> 'deleted'
        order by v.last_visit_at desc nulls last, w.name`, [person, at]);

    const rooms: z.infer<typeof Room>[] = [];
    const past: z.infer<typeof PastRoom>[] = [];
    for (const w of rows) {
      const lastVisitAt = iso(w.last_visit_at);
      if (!w.current) {
        past.push({
          id: w.id,
          name: w.name,
          kind: 'access_ended',
          isAdmin: false,
          sellerName: w.was_seller ? (w.seller_name ?? null) : null,
          logos: { light: false, dark: false },
          groups: await groupsOf(tx, person, at, w.id, false),
          endedAt: iso(w.ended_at),
          lastVisitAt,
          canOpen: false,
        });
        continue;
      }
      const groups = await groupsOf(tx, person, at, w.id, true);
      const isAdmin: boolean = w.is_admin;
      const seller: boolean = w.seller;
      const sellerName = seller ? (w.seller_name ?? null) : null;
      if (w.state === 'closed' || w.state === 'archived') {
        past.push({ id: w.id, name: w.name, kind: 'closed', isAdmin, sellerName, groups,
          logos: { light: isAdmin && w.logo_light, dark: isAdmin && w.logo_dark }, endedAt: iso(w.state_since), lastVisitAt, canOpen: isAdmin });
        continue;
      }
      const state = w.state as 'preparing' | 'open' | 'frozen';
      const base = { id: w.id, name: w.name, state, isAdmin, side: seller ? 'seller' as const : 'buyer' as const, sellerName, groups,
        logos: { light: w.logo_light, dark: w.logo_dark }, lastVisitAt, openAtSignIn: w.id === me.pick };
      // must match requireMember(): no figures for anyone who may not enter
      if (state === 'preparing' && !seller) {
        rooms.push({ ...base, openAtSignIn: false, canEnter: false, nextMilestone: null,
          attention: { newDocuments: null, colleagueRequests: null, draftsWaiting: null, ndaToAccept: false } });
        continue;
      }
      const ndaToAccept = !seller && w.requires_nda
        && !(await tx.query<{ ok: boolean }>(`select nda_accepted($1, $2, record_clock()) as ok`, [person, w.id])).rows[0]?.ok;

      let newDocuments: { count: number; since: string | null } | null = null;
      let colleagueRequests: number | null = null;
      let draftsWaiting: number | null = null;
      if (isAdmin) {
        const a = (await tx.query<{ requests: string; drafts: string }>(
          `select (select count(*) from approval where workspace_id = $1 and kind = 'colleague_request' and status = 'pending') as requests,
                  (select count(*) from node where workspace_id = $1 and kind = 'document' and state = 'draft' and deleted_at is null) as drafts`,
          [w.id])).rows[0]!;
        colleagueRequests = Number(a.requests);
        draftsWaiting = Number(a.drafts);
      } else if (!ndaToAccept) {
        // mid-visit: count from the visit before
        const last = w.last_visit_at ? new Date(w.last_visit_at) : null;
        const sinceRaw = last && now.getTime() - last.getTime() < SAME_VISIT_MS ? w.previous_visit_at : w.last_visit_at;
        const since = iso(sinceRaw);
        const c = (await tx.query<{ fresh: string; drafts: string }>(
          `with docs as materialized (
             select n.state, n.published_at, a.level, a.can_publish
               from readable_nodes($1, $2, $3, record_clock(), false) a join node n on n.id = a.node_id
              where n.kind = 'document' and n.deleted_at is null)
           select count(*) filter (where state = 'published' and level >= 10 and ($4::timestamptz is null or published_at > $4)) as fresh,
                  count(*) filter (where state = 'draft' and can_publish) as drafts
             from docs`, [person, w.id, at, since])).rows[0]!;
        newDocuments = { count: Number(c.fresh), since };
        const publishes = Number(c.drafts);
        if (publishes > 0) draftsWaiting = publishes;
        const leads = groups.some((g) => g.role === 'lead' && g.partyKind !== 'seller' && !g.subgroup);
        if (leads) {
          colleagueRequests = Number((await tx.query<{ n: string }>(
            `select count(*) as n from approval where workspace_id = $1 and requested_by = $2 and kind = 'colleague_request' and status = 'pending'`,
            [w.id, person])).rows[0]!.n);
        }
      }
      let nextMilestone: { title: string; dueAt: string } | null = null;
      if (!ndaToAccept) {
        const ms = (await tx.query<{ title: string; due_at: string }>(
          `select title, due_at from milestone
            where workspace_id = $1 and deleted_at is null and due_at > $2
              and ($3 or cardinality(visible_to_group_ids) = 0 or visible_to_group_ids && $4::uuid[])
            order by due_at limit 1`, [w.id, at, isAdmin || seller, w.group_ids ?? []])).rows[0];
        if (ms) nextMilestone = { title: ms.title, dueAt: new Date(ms.due_at).toISOString() };
      }
      rooms.push({ ...base, canEnter: true, nextMilestone, attention: { newDocuments, colleagueRequests, draftsWaiting, ndaToAccept } });
    }
    rooms.sort((a, b) => Number(b.openAtSignIn) - Number(a.openAtSignIn));
    past.sort((a, b) => {
      const byEnd = (b.endedAt ?? '').localeCompare(a.endedAt ?? '');
      return byEnd || a.name.localeCompare(b.name);
    });
    const pick = rooms.some((x) => x.openAtSignIn) ? me.pick : null;
    return { runBy: me.run_by, canCreateRooms: !!me.can_create, isSiteAdmin: !!me.site_admin, openAtSignInWorkspaceId: pick, rooms, past };
  }));
};
