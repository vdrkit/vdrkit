// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { personOf, renumberedTags, requireMember } from './util.js';

const WsParams = z.object({ ws: z.string().uuid() });

const ShellGroup = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: z.string(),
  partyKind: z.enum(['seller', 'bidder', 'financier', 'observer', 'other']),
  parentGroupId: z.string().uuid().nullable(),
});

const IndexFolder = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  indexNumber: z.string().nullable(),
  name: z.string(),
  documents: z.number(),
  drafts: z.number(),
  canUpload: z.boolean(),
  noBidderAccess: z.boolean().nullable(),
  renumberedFrom: z.string().nullable(),
});

export const RoomShellOut = z.object({
  room: z.object({
    id: z.string().uuid(),
    name: z.string(),
    timeZone: z.string(),
    state: z.string(),
    runBy: z.string(),
    // admins only, don't leak bidder count
    bidderGroups: z.number().nullable(),
    myRoomCount: z.number(),
    logos: z.object({ light: z.boolean(), dark: z.boolean(), version: z.string().nullable() }),
  }),
  me: z.object({
    personId: z.string().uuid(),
    name: z.string(),
    timeZone: z.string(),
    isAdmin: z.boolean(),
    canReadActivity: z.boolean(),
    groups: z.array(ShellGroup),
    teamSize: z.number().nullable(),
  }),
  documents: z.object({ published: z.number() }),
  index: z.array(IndexFolder),
  attention: z.object({ accessRequests: z.number(), foldersWithoutBidderAccess: z.number() }).nullable(),
  // see-as: preparing rooms report open
  seeAs: z.object({ groupId: z.string().uuid(), name: z.string(), side: z.enum(['bidders', 'seller']), roomNotOpen: z.boolean() }).nullable(),
});

export const roomShellRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/shell', {
    schema: {
      summary: 'Room shell: room, person, counts and folder index',
      params: WsParams,
      response: { 200: RoomShellOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    const at = now.toISOString();
    const me = await requireMember(tx, caller, ws, now, { beforeNda: true });
    const person = personOf(caller);
    const agent = caller.principal.kind === 'agent';
    const count = async (sql: string, params: unknown[]) => Number((await tx.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
    // agents excluded
    if (!agent) await tx.query(`select mark_renumbers_seen($1, $2)`, [person, ws]);

    const room = (await tx.query<{ name: string; time_zone: string; state: string; run_by: string }>(
      `select w.name, w.time_zone, w.state, t.name as run_by from workspace w join tenant t on t.id = w.tenant_id where w.id = $1`, [ws])).rows[0]!;
    const logoRows = (await tx.query<{ variant: 'light' | 'dark'; sha256: string }>(
      `select variant, sha256 from workspace_logo where workspace_id = $1 order by variant`, [ws])).rows;
    const logos = {
      light: logoRows.some((l) => l.variant === 'light'),
      dark: logoRows.some((l) => l.variant === 'dark'),
      version: logoRows.length ? logoRows.map((l) => l.sha256.slice(0, 8)).join('') : null,
    };
    const p = (await tx.query<{ name: string; time_zone: string | null }>(
      `select case when erased_at is not null then 'Erased user' else name end as name, time_zone from person where id = $1`, [person])).rows[0]!;

    const groups = (await tx.query<{ id: string; name: string; role: string; kind: z.infer<typeof ShellGroup>['partyKind']; parent_group_id: string | null }>(
      `select g.id, g.name, m.role, pa.kind, g.parent_group_id
         from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
        where m.person_id = $1 and g.workspace_id = $2 and m.status = 'active'
          and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= $3 and $3 < m.superseded_at
          and g.valid_from <= $3 and $3 < g.valid_to
        order by g.name`, [person, ws, at])).rows;

    const roomCount = await count(
      `select count(distinct g.workspace_id) as n
         from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
        where m.person_id = $1 and m.status = 'active' and m.valid_from <= $2 and $2 < m.valid_to
          and m.superseded_at = 'infinity' and g.valid_from <= $2 and $2 < g.valid_to and w.state <> 'deleted'`,
      [caller.seeAs?.adminPersonId ?? person, at]);

    const folders = (await tx.query<{
      id: string; parent_id: string | null; index_number: string | null; name: string; level: number;
      can_upload: boolean; can_manage: boolean; can_publish: boolean; documents: string; drafts: string; published: string; no_bidder_access: boolean;
    }>(
      `with vis as materialized (
         select n.id, n.parent_id, n.kind, n.name, n.index_number, n.state, n.path, n.sort_key,
                a.level, a.can_upload, a.can_manage, a.can_publish,
                (a.level > 0 or (not $4 and (a.can_upload or a.can_manage or a.can_publish))) as seen
           from readable_nodes($1, $2, $3, record_clock(), $4) a join node n on n.id = a.node_id
          where n.deleted_at is null and n.state <> 'withdrawn')
       select f.id, f.parent_id, f.index_number, f.name, f.level, f.can_upload, f.can_manage, f.can_publish,
              (select count(*) from vis d where d.kind = 'document' and d.seen and d.path <@ f.path) as documents,
              (select count(*) from vis d where d.kind = 'document' and d.seen and d.state = 'draft' and d.path <@ f.path) as drafts,
              (select count(*) from vis d where d.kind = 'document' and d.state = 'published' and d.level > 0) as published,
              not exists (
                select 1 from access_grant g join node gn on gn.id = g.node_id
                  join groups gr on gr.id = g.subject_group_id join party pa on pa.id = gr.party_id
                 where g.workspace_id = $2 and pa.kind in ('bidder', 'financier') and g.effect = 'allow' and g.level > 0
                   and g.superseded_at = 'infinity' and g.valid_from <= $3 and $3 < g.valid_to
                   and (gn.path @> f.path or gn.path <@ f.path)) as no_bidder_access
         from vis f
        where f.kind = 'folder' and f.seen
        order by nlevel(f.path), f.sort_key,
                 case when f.index_number ~ '^[0-9]+([.][0-9]+)*$' then string_to_array(f.index_number, '.')::int[] end nulls last, f.name`,
      [person, ws, at, agent])).rows;

    const tags = await renumberedTags(tx, person, ws);

    const buyerGroups = groups.filter((g) => g.kind === 'bidder' || g.kind === 'financier');
    buyerGroups.sort((a, b) => Number(!!a.parent_group_id) - Number(!!b.parent_group_id));
    const team = buyerGroups[0];
    let teamSize: number | null = null;
    if (team && !me.isAdmin) {
      teamSize = await count(
        `select count(distinct m.person_id) as n from membership m
          where m.group_id = $1 and m.superseded_at = 'infinity' and $2 < m.valid_to
            and (m.status = 'approved' or (m.status = 'active' and m.valid_from <= $2))
            and not coalesce((m.metadata ->> 'revoked')::boolean, false)
            and ($3::uuid is null or m.person_id <> $3)`, [team.id, at, caller.seeAs ? person : null]);
    }

    const published = Number(folders[0]?.published ?? 0);

    let bidderGroups: number | null = null;
    let attention: z.infer<typeof RoomShellOut>['attention'] = null;
    if (me.isAdmin) {
      bidderGroups = await count(
        `select count(*) as n from groups g join party pa on pa.id = g.party_id
          where g.workspace_id = $1 and pa.kind in ('bidder', 'financier') and g.valid_from <= $2 and $2 < g.valid_to`, [ws, at]);
      const requests = await count(
        `select count(*) as n from approval where workspace_id = $1 and kind = 'colleague_request' and status = 'pending'`, [ws]);
      const bare = folders.filter((f) => f.parent_id === null && f.no_bidder_access);
      attention = { accessRequests: requests, foldersWithoutBidderAccess: bare.length };
    }

    let reader: string | null = null;
    if (!agent) {
      const { rows } = await tx.query<{ role: string | null }>('select activity_reader($1, $2, $3) as role', [person, ws, at]);
      reader = rows[0]?.role ?? null;
    }
    const state = caller.seeAs && room.state === 'preparing' ? 'open' : room.state;

    return {
      room: { id: ws, name: room.name, timeZone: room.time_zone, state, runBy: room.run_by, bidderGroups, myRoomCount: roomCount, logos },
      me: {
        personId: person, name: p.name, timeZone: p.time_zone ?? room.time_zone, isAdmin: me.isAdmin, canReadActivity: reader !== null, teamSize,
        groups: groups.map((g) => ({ id: g.id, name: g.name, role: g.role, partyKind: g.kind, parentGroupId: g.parent_group_id })),
      },
      documents: { published },
      index: folders.map((f) => ({
        id: f.id, parentId: f.parent_id, indexNumber: f.index_number, name: f.name,
        documents: Number(f.documents), drafts: Number(f.drafts), canUpload: !agent && f.can_upload,
        noBidderAccess: me.isAdmin ? f.no_bidder_access : null,
        renumberedFrom: tags.get(f.id) ?? null,
      })),
      attention,
      seeAs: caller.seeAs ? { groupId: caller.seeAs.groupId, name: caller.seeAs.groupName, side: caller.seeAs.side, roomNotOpen: room.state === 'preparing' } : null,
    };
  }));
};
