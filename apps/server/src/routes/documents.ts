// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishItems, type PublishOutcome } from './publish.js';
import { appendEvent, effectiveAccess, type SqlClient, present } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { grantAdminsOnTopFolder } from './rooms.js';
import { blockedLink, lockIndex, NodeName, personOf, refuseIfArchived, refuseIfFrozen, renumberedTagDays, requireMember, requireWorkspaceAdmin } from './util.js';

const WsParams = z.object({ ws: z.string().uuid() });

interface TreeNode { id: string; parent_id: string | null; kind: string; name: string; index_number: string | null; sort_key: number; state: string }

async function loadNodes(tx: SqlClient, ws: string): Promise<TreeNode[]> {
  return (await tx.query<TreeNode>(
    `select id, parent_id, kind, name, index_number, sort_key, state from node where workspace_id = $1 and deleted_at is null`, [ws])).rows;
}

const numericOrder = (a: TreeNode, b: TreeNode) => {
  const pa = (a.index_number ?? '').split('.').map(Number);
  const pb = (b.index_number ?? '').split('.').map(Number);
  return (pa.at(-1) ?? 0) - (pb.at(-1) ?? 0);
};

const lastSeg = (ix: string | null) => {
  const n = Number((ix ?? '').split('.').at(-1));
  return Number.isFinite(n) ? n : 0;
};

// Documents stay consecutive; folders may have gaps and only move up on a collision
interface Renumbered { id: string; from: string | null; to: string; published: boolean }

function renumberPlan(nodes: TreeNode[], parents: (string | null)[], moved?: { id: string; wanted?: number }): Renumbered[] {
  const kids = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    const list = kids.get(n.parent_id);
    if (list) list.push(n);
    else kids.set(n.parent_id, [n]);
  }
  const parentNumber = (id: string | null) => (id ? nodes.find((n) => n.id === id)?.index_number ?? '' : '');
  const changes = new Map<string, { id: string; from: string | null; to: string; published: boolean }>();
  const carry = (n: TreeNode, to: string) => {
    if (n.index_number !== to) changes.set(n.id, { id: n.id, from: n.index_number, to, published: n.state === 'published' });
    for (const c of kids.get(n.id) ?? []) {
      const own = (c.index_number ?? '').split('.').at(-1) || '1';
      carry(c, `${to}.${own}`);
    }
  };
  for (const parent of new Set(parents)) {
    const prefix = changes.get(parent ?? '')?.to ?? parentNumber(parent);
    const list = (kids.get(parent) ?? []).sort((a, b) => a.sort_key - b.sort_key || numericOrder(a, b) || a.name.localeCompare(b.name));
    let at = 0;
    for (const n of list) {
      const own = lastSeg(n.index_number);
      let to: number;
      if (n.id === moved?.id) to = n.kind === 'folder' && moved.wanted && moved.wanted > at ? moved.wanted : at + 1;
      else to = n.kind === 'folder' && own > at ? own : at + 1;
      at = to;
      carry(n, prefix ? `${prefix}.${to}` : String(to));
    }
  }
  return [...changes.values()];
}

export async function resortChildren(tx: SqlClient, ws: string, parentId: string | null): Promise<void> {
  await tx.query(
    `update node n set sort_key = r.rn
       from (select id, row_number() over (
               order by case when index_number ~ '^[0-9]{1,9}([.][0-9]{1,9})*$' then string_to_array(index_number, '.')::int[] end nulls last,
                        sort_key, name) as rn
               from node where workspace_id = $1 and parent_id is not distinct from $2 and deleted_at is null) r
      where n.id = r.id and n.sort_key is distinct from r.rn`, [ws, parentId]);
}

async function publisherOf(tx: SqlClient, caller: Caller, ws: string, at: Date): Promise<{ isAdmin: boolean }> {
  const member = await requireMember(tx, caller, ws, at);
  if (caller.principal.kind === 'agent') throw forbidden('Agents cannot publish. Ask the person to do it.', 'agent_needs_approval');
  return { isAdmin: member.isAdmin };
}

export async function personPassesLists(tx: SqlClient, personId: string, ws: string, lists: string[][], now: Date): Promise<boolean> {
  for (const l of lists) {
    if (l.length === 0) return true;
    const ok = (await tx.query<{ ok: boolean }>(`select version_visible($1, $2, $3::uuid[], $4, record_clock()) as ok`,
      [personId, ws, l, now.toISOString()])).rows[0]!.ok;
    if (ok) return true;
  }
  return false;
}

export async function publishableNodes(tx: SqlClient, personId: string, ws: string, at: Date): Promise<Set<string>> {
  const { rows } = await tx.query<{ node_id: string }>(
    `select node_id from accessible_nodes($1, $2, $3, record_clock()) where can_publish`, [personId, ws, at.toISOString()]);
  return new Set(rows.map((r) => r.node_id));
}

async function applyNumbers(tx: SqlClient, changes: { id: string; to: string }[], now: Date) {
  for (const c of changes) await tx.query(`update node set index_number = $2, updated_at = $3 where id = $1`, [c.id, c.to, now.toISOString()]);
}

export async function releaseList(tx: SqlClient, nodeId: string, versionNo: number): Promise<string[]> {
  const prev = (await tx.query<{ groups: string[] }>(
    `select visible_to_group_ids as groups from document_version
      where node_id = $1 and version_no < $2 and not awaiting_release and withdrawn_at is null
      order by version_no desc limit 1`, [nodeId, versionNo])).rows[0];
  return prev?.groups ?? [];
}

// must match version_visible()
export const listAdmits = (lists: string[][], g: { id: string; parent_group_id: string | null }) =>
  lists.some((l) => l.length === 0 || l.includes(g.id) || (g.parent_group_id !== null && l.includes(g.parent_group_id)));

export async function draftLists(tx: SqlClient, nodeId: string): Promise<string[][]> {
  const { rows } = await tx.query<{ groups: string[] }>(
    `select visible_to_group_ids as groups from document_version where node_id = $1 and withdrawn_at is null`, [nodeId]);
  return rows.length ? rows.map((r) => r.groups) : [[]];
}

export async function namedPeople(tx: SqlClient, nodeId: string, lists: string[][], ws: string, now: Date): Promise<{ id: string; name: string; level: number }[]> {
  const named = (await tx.query<{ id: string; name: string; level: number }>(
    `select p.id, case when p.erased_at is not null then 'Erased user' else p.name end as name, x.level
       from (select distinct ag.subject_person_id as pid from access_grant ag join node a on a.id = ag.node_id join node n on n.id = $1
              where ag.subject_person_id is not null and ag.effect = 'allow' and a.path @> n.path
                and ag.valid_from <= $2 and $2 < ag.valid_to and ag.recorded_at <= $2 and $2 < ag.superseded_at) d
       join person p on p.id = d.pid
       cross join lateral (select ag.level from access_grant ag join node a on a.id = ag.node_id join node n on n.id = $1
                            where ag.subject_person_id = d.pid and ag.effect = 'allow' and a.path @> n.path
                              and ag.valid_from <= $2 and $2 < ag.valid_to and ag.recorded_at <= $2 and $2 < ag.superseded_at
                            order by nlevel(a.path) desc limit 1) x
      where x.level >= 20
        and not exists (select 1 from access_grant dg join node a on a.id = dg.node_id join node n on n.id = $1
                         where dg.subject_person_id = d.pid and dg.effect = 'deny' and a.path @> n.path
                           and dg.valid_from <= $2 and $2 < dg.valid_to and dg.recorded_at <= $2 and $2 < dg.superseded_at)
        and not exists (select 1 from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
                         where m.person_id = d.pid and g.workspace_id = $3 and pa.kind = 'seller' and m.superseded_at = 'infinity')`,
    [nodeId, now.toISOString(), ws])).rows.map((p) => ({ id: p.id, name: p.name, level: Number(p.level) }));
  const out = [];
  for (const p of named) {
    if (await personPassesLists(tx, p.id, ws, lists, now)) out.push(p);
  }
  return out;
}

// gates release review: it names bidder groups
export async function onSellerSide(tx: SqlClient, personId: string, ws: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  return !!(await tx.query<{ ok: boolean }>(
    `select exists (select 1 from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
                     where m.person_id = $1 and g.workspace_id = $2 and pa.kind = 'seller' and m.status = 'active'
                       and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= $3 and $3 < m.superseded_at
                       and g.valid_from <= $3 and $3 < g.valid_to) as ok`, [personId, ws, at])).rows[0]?.ok;
}

export const PUBLISH_BATCH = 50;
const batches = <T>(all: T[], size: number): T[][] => Array.from({ length: Math.ceil(all.length / size) }, (_, i) => all.slice(i * size, (i + 1) * size));

export const roomFrozenForPublishing = () => new HttpProblem({ type: 'https://vdrkit.com/problems/room-frozen', title: 'Room frozen', status: 409,
  detail: 'The room is frozen. Nobody can publish until a room admin opens it again in Room settings.', reason: 'room_frozen' });

export const documentRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/v1/workspaces/:ws/folders', {
    schema: {
      summary: 'Create a folder. 409 room_frozen while the room is frozen',
      params: WsParams,
      body: z.object({ parentId: z.string().uuid().nullable().default(null), name: NodeName }),
      response: { 201: z.object({ id: z.string().uuid(), indexNumber: z.string() }) },
    },
  }, async (req, reply) => reply.code(201).send(await app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    const parentId = req.body.parentId;
    let prefix = '';
    if (parentId) {
      const a = await effectiveAccess(tx, personOf(caller), parentId, present(now));
      if (a.level === 0 && !a.canUpload && !a.canManage && !a.canPublish) throw blockedLink({ workspaceId: ws, nodeId: parentId, route: 'folders.create' });
      if (!a.canManage || caller.principal.kind === 'agent') throw forbidden('You cannot add folders here.', 'no_manage_right');
    } else {
      await requireWorkspaceAdmin(tx, caller, ws, now);
    }
    // room before index, everywhere
    await refuseIfFrozen(tx, ws);
    await lockIndex(tx, ws);
    if (parentId) {
      const p = (await tx.query<{ index_number: string; kind: string }>(`select index_number, kind from node where id = $1 and workspace_id = $2`, [parentId, ws])).rows[0];
      if (!p) throw notFound();
      if (p.kind !== 'folder') throw badRequest('Folders can only be created inside folders.');
      prefix = p.index_number;
    }
    // deleted rows count, numbers are never reused
    const used = new Set((await tx.query<{ n: number | null }>(
      `select nullif(case when deleted_at is null then split_part(index_number, '.', $3)
                          else substring(index_number from '([0-9]+)$') end, '')::int as n
         from node where workspace_id = $1 and parent_id is not distinct from $2 and index_number ~ '^[0-9]{1,9}([.][0-9]{1,9})*$'`,
      [ws, parentId, prefix ? prefix.split('.').length + 1 : 1])).rows.map((r) => Number(r.n)).filter((n) => n > 0));
    let free = used.size ? Math.min(...used) : 0;
    while (used.has(free + 1)) free++;
    free++;
    const sortKey = Number((await tx.query<{ s: number }>(
      `select coalesce(max(sort_key), 0) + 1 as s from node where workspace_id = $1 and parent_id is not distinct from $2`, [ws, parentId])).rows[0]!.s);
    const indexNumber = prefix ? `${prefix}.${free}` : String(free);
    const id = (await tx.query<{ id: string }>(
      `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state)
       values (current_tenant_id(), $1, $2, 'folder', $3, $4, $5, 'draft') returning id`,
      [ws, parentId, req.body.name, indexNumber, sortKey])).rows[0]!.id;
    await resortChildren(tx, ws, parentId);
    if (!parentId) await grantAdminsOnTopFolder(tx, ws, id, now);
    await appendEvent(tx, { action: 'folder.created', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: id,
      data: { index_number: indexNumber, parent_id: parentId }, occurredAt: now, requestId: req.id });
    return { id, indexNumber };
  })));

  r.patch('/v1/workspaces/:ws/nodes/:id', {
    schema: {
      summary: 'Rename, move or reorder. 409 room_frozen while the room is frozen',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({
        name: NodeName.optional(),
        parentId: z.string().uuid().nullable().optional(),
        position: z.number().int().min(1).optional(),
        beforeId: z.string().uuid().optional(),
        number: z.number().int().min(1).max(999_999).optional(),
        confirmRenumberPublished: z.boolean().default(false),
      }),
      response: { 200: z.object({ renumbered: z.array(z.object({ id: z.string().uuid(), from: z.string().nullable(), to: z.string() })) }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    await refuseIfFrozen(tx, ws);
    await lockIndex(tx, ws);
    const nodes = await loadNodes(tx, ws);
    const node = nodes.find((n) => n.id === req.params.id);
    if (!node) throw notFound();
    const b = req.body;

    if (b.name && b.name !== node.name) {
      await tx.query(`update node set name = $2, updated_at = $3 where id = $1`, [node.id, b.name, now.toISOString()]);
      await appendEvent(tx, { action: 'node.renamed', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: node.id,
        data: { index_number: node.index_number }, occurredAt: now, requestId: req.id });
    }
    if (b.parentId === undefined && b.position === undefined && b.beforeId === undefined && b.number === undefined) return { renumbered: [] };

    const newParent = b.parentId === undefined ? node.parent_id : b.parentId;
    if (newParent) {
      const p = nodes.find((n) => n.id === newParent);
      if (!p) throw badRequest('The target folder is not part of this room.');
      if (p.kind !== 'folder') throw badRequest('Items can only be moved into folders.');
      for (let at: TreeNode | undefined = p; at; at = nodes.find((n) => n.id === at!.parent_id)) {
        if (at.id === node.id) throw badRequest('A folder cannot be moved into itself or one of its own subfolders.');
      }
    }
    const siblings = nodes.filter((n) => n.parent_id === newParent && n.id !== node.id)
      .sort((a, c) => numericOrder(a, c) || a.sort_key - c.sort_key);
    let pos: number;
    if (b.number !== undefined) {
      const i = siblings.findIndex((s) => lastSeg(s.index_number) >= b.number!);
      pos = (i < 0 ? siblings.length : i) + 1;
    } else if (b.beforeId !== undefined) {
      const i = siblings.findIndex((s) => s.id === b.beforeId);
      if (i < 0) throw badRequest('The item to place it above is not in that folder.');
      pos = i + 1;
    } else {
      pos = Math.min(b.position ?? siblings.length + 1, siblings.length + 1);
    }
    siblings.splice(pos - 1, 0, { ...node, parent_id: newParent });
    const simulated = nodes.map((n) => {
      const i = siblings.findIndex((s) => s.id === n.id);
      return i >= 0 ? { ...n, parent_id: newParent, sort_key: i + 1 } : n;
    });
    const changes = renumberPlan(simulated, [newParent], { id: node.id, wanted: b.number });
    const publishedChanges = changes.filter((c) => c.published);
    if (publishedChanges.length && !b.confirmRenumberPublished) {
      throw new HttpProblem({ type: 'https://vdrkit.com/problems/confirm-renumber', title: 'Published numbers would change', status: 409,
        detail: `${publishedChanges.length} published item${publishedChanges.length === 1 ? '' : 's'} would get a new index number. Bidders may already refer to the old ones.`,
        items: publishedChanges.map(({ id, from, to }) => ({ id, from, to })),
        tagDays: await renumberedTagDays(tx, ws) });
    }
    if (newParent !== node.parent_id) await tx.query(`update node set parent_id = $2 where id = $1`, [node.id, newParent]);
    for (const s of siblings) await tx.query(`update node set sort_key = $2 where id = $1`, [s.id, siblings.indexOf(s) + 1]);
    await applyNumbers(tx, changes, now);
    await appendEvent(tx, { action: 'index.renumbered', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: node.id,
      data: { moved_to: newParent, position: pos, changes: changes.map(({ id, from, to }) => ({ id, from, to })) }, occurredAt: now, requestId: req.id });
    return { renumbered: changes.map(({ id, from, to }) => ({ id, from, to })) };
  }));

  r.post('/v1/workspaces/:ws/index/restore', {
    schema: {
      summary: 'Undo a move. Room admins only; 409 room_frozen while the room is frozen',
      params: WsParams,
      body: z.object({
        moved: z.object({ id: z.string().uuid(), parentId: z.string().uuid().nullable() }).optional(),
        items: z.array(z.object({ id: z.string().uuid(), indexNumber: z.string().regex(/^[0-9]{1,9}([.][0-9]{1,9})*$/) })).max(5000),
      }),
      response: { 200: z.object({ restored: z.number() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, ws, now);
    await refuseIfFrozen(tx, ws);
    await lockIndex(tx, ws);
    const nodes = await loadNodes(tx, ws);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const { moved, items } = req.body;
    if ((moved && !byId.has(moved.id)) || items.some((i) => !byId.has(i.id))) throw notFound();
    if (moved?.parentId && byId.get(moved.parentId)?.kind !== 'folder') throw badRequest('Items can only be moved into folders.');
    const parents = new Set<string | null>(items.map((i) => byId.get(i.id)!.parent_id));
    if (moved) {
      parents.add(moved.parentId);
      await tx.query(`update node set parent_id = $2 where id = $1`, [moved.id, moved.parentId]);
    }
    const changes = items.map((i) => ({ id: i.id, from: byId.get(i.id)!.index_number, to: i.indexNumber })).filter((c) => c.from !== c.to);
    await applyNumbers(tx, changes, now);
    const clash = (await tx.query<{ index_number: string }>(
      `select index_number from node where workspace_id = $1 and deleted_at is null and index_number is not null
        group by parent_id, index_number having count(*) > 1 limit 1`, [ws])).rows[0];
    if (clash) throw badRequest(`The numbers could not be put back: ${clash.index_number} would be used twice. Change it by hand instead.`);
    for (const parent of parents) await resortChildren(tx, ws, parent);
    await appendEvent(tx, { action: 'index.renumbered', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: moved?.id ?? changes[0]?.id ?? ws,
      data: { undo: true, ...(moved ? { moved_to: moved.parentId } : {}), changes }, occurredAt: now, requestId: req.id });
    return { restored: changes.length };
  }));

  r.post('/v1/workspaces/:ws/release-preview', {
    schema: {
      summary: 'Release review: groups that will see each draft',
      params: WsParams,
      body: z.object({
        nodeIds: z.array(z.string().uuid()).max(2000).optional(),
        versionIds: z.array(z.string().uuid()).max(2000).optional(),
      }),
      response: {
        200: z.object({
          items: z.array(z.object({
            id: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string(), kind: z.string(),
            versionId: z.string().uuid().nullable(), versionNo: z.number().nullable(),
            uploadedAt: z.string(), groups: z.array(z.object({ id: z.string().uuid(), name: z.string(), level: z.number() })),
            people: z.array(z.object({ id: z.string().uuid(), name: z.string(), level: z.number() })),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    const { isAdmin } = await publisherOf(tx, caller, ws, now);
    let mine: string[] | null = null;
    if (!isAdmin) {
      if (!(await onSellerSide(tx, personOf(caller), ws, now))) throw forbidden('You cannot publish in this room.', 'no_publish_right');
      const allowed = await publishableNodes(tx, personOf(caller), ws, now);
      if (allowed.size === 0) throw forbidden('You cannot publish in this room.', 'no_publish_right');
      mine = [...allowed];
    }
    const filtered = req.body.nodeIds !== undefined || req.body.versionIds !== undefined;
    const nodeFilter = filtered ? req.body.nodeIds ?? [] : null;
    const drafts = (await tx.query<any>(
      `select id, index_number, name, kind, created_at, null::uuid as version_id, null::int as version_no from node
        where workspace_id = $1 and state = 'draft' and deleted_at is null and ($2::uuid[] is null or id = any($2::uuid[]))
          and ($3::uuid[] is null or id = any($3::uuid[]))
        order by case when index_number ~ '^[0-9]+([.][0-9]+)*$' then string_to_array(index_number, '.')::int[] end nulls last`,
      [ws, nodeFilter, mine])).rows;
    const versions = (await tx.query<any>(
      `select n.id, n.index_number, n.name, n.kind, dv.created_at, dv.id as version_id, dv.version_no from document_version dv
         join node n on n.id = dv.node_id
        where n.workspace_id = $1 and n.state = 'published' and n.deleted_at is null and dv.awaiting_release
          and (not $2::boolean or n.id = any($3::uuid[]) or dv.id = any($4::uuid[]))
          and ($5::uuid[] is null or n.id = any($5::uuid[]))
        order by case when n.index_number ~ '^[0-9]+([.][0-9]+)*$' then string_to_array(n.index_number, '.')::int[] end nulls last, dv.version_no`,
      [ws, filtered, req.body.nodeIds ?? [], req.body.versionIds ?? [], mine])).rows;
    const groups = (await tx.query<{ id: string; name: string; parent_group_id: string | null }>(
      `select g.id, g.name, g.parent_group_id from groups g join party pa on pa.id = g.party_id
        where g.workspace_id = $1 and pa.kind <> 'seller' and g.valid_from <= $2 and $2 < g.valid_to order by g.name`, [ws, now.toISOString()])).rows;
    const items = [];
    for (const d of [...drafts, ...versions]) {
      let lists: string[][] = [[]];
      if (d.version_id) lists = [await releaseList(tx, d.id, Number(d.version_no))];
      else if (d.kind === 'document') lists = await draftLists(tx, d.id);
      const seen = [];
      for (const g of groups) {
        if (!listAdmits(lists, g)) continue;
        const lvl = Number((await tx.query<{ l: number }>(`select group_level($1, $2, $3) as l`, [g.id, d.id, now.toISOString()])).rows[0]!.l);
        if (lvl >= 20) seen.push({ id: g.id, name: g.name, level: lvl });
      }
      const people = await namedPeople(tx, d.id, lists, ws, now);
      items.push({ id: d.id, indexNumber: d.index_number, name: d.name, kind: d.kind, versionId: d.version_id,
        versionNo: d.version_no == null ? null : Number(d.version_no), uploadedAt: new Date(d.created_at).toISOString(), groups: seen, people });
    }
    return { items };
  }));

  r.post('/v1/workspaces/:ws/publish', {
    schema: {
      summary: 'Publish drafts and release new versions',
      params: WsParams,
      body: z.object({
        nodeIds: z.array(z.string().uuid()).max(2000).default([]),
        versionIds: z.array(z.string().uuid()).max(2000).default([]),
        quiet: z.boolean().default(false),
        // still refuses infected, mismatched and unscanned files
        downloadOnly: z.boolean().default(false),
        whenReady: z.boolean().default(false),
      }).strict().refine((b) => b.nodeIds.length + b.versionIds.length > 0, { message: 'Name at least one draft or new version.' }),
      response: { 200: z.object({ published: z.number(), versionsReleased: z.number(), notified: z.number(), quiet: z.boolean(),
        waiting: z.number().optional() }) },
    },
  }, async (req) => {
    const ws = req.params.ws;
    const now = app.now();
    const { nodeIds, versionIds, quiet, downloadOnly, whenReady } = req.body;
    const run = (part: { nodeIds: string[]; versionIds: string[] }, checkOnly = false) => app.inTenant(req, async (tx, caller) => {
      await publisherOf(tx, caller, ws, now);
      return publishItems(tx, { ws, person: personOf(caller), actorId: caller.actorId, ...part, quiet, downloadOnly, now, requestId: req.id, whenReady, checkOnly });
    });
    const answer = ({ waiting, ...out }: PublishOutcome) => (whenReady ? { ...out, waiting } : out);
    if (nodeIds.length + versionIds.length <= PUBLISH_BATCH) return answer(await run({ nodeIds, versionIds }));

    // One big transaction would block every log write in the room (views, downloads, sign-ins) until it ends.
    // Check everything first, then publish in batches.
    await run({ nodeIds, versionIds }, true);
    const parts = [
      ...batches(nodeIds, PUBLISH_BATCH).map((ids) => ({ nodeIds: ids, versionIds: [] as string[] })),
      ...batches(versionIds, PUBLISH_BATCH).map((ids) => ({ nodeIds: [] as string[], versionIds: ids })),
    ];
    const total: PublishOutcome = { published: 0, versionsReleased: 0, notified: 0, quiet, waiting: 0 };
    for (const part of parts) {
      let out: PublishOutcome;
      try {
        out = await run(part);
      } catch (e) {
        // something changed between the check and this batch; the batches before it stay published
        const done = total.published + total.versionsReleased;
        if (!(e instanceof HttpProblem) || done === 0) throw e;
        throw new HttpProblem({ ...e.problem, detail: `${done} were published before this stopped. ${e.problem.detail ?? ''}`.trim() });
      }
      total.published += out.published;
      total.versionsReleased += out.versionsReleased;
      total.notified += out.notified;
      total.waiting += out.waiting;
    }
    return answer(total);
  });

  r.post('/v1/workspaces/:ws/versions/:id/withdraw', {
    schema: {
      summary: 'Withdraw a released version',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().max(500).optional() }),
      response: { 200: z.object({ withdrawnAt: z.string(), fallsBackTo: z.number() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, id } = req.params;
    const now = app.now();
    const { isAdmin } = await publisherOf(tx, caller, ws, now);
    const v = (await tx.query<{ node_id: string; version_no: number; awaiting_release: boolean; withdrawn_at: string | null; index_number: string | null }>(
      `select dv.node_id, dv.version_no, dv.awaiting_release, dv.withdrawn_at, n.index_number from document_version dv
         join node n on n.id = dv.node_id where dv.id = $1 and n.workspace_id = $2 and n.deleted_at is null`, [id, ws])).rows[0];
    if (!v) throw notFound();
    if (!isAdmin) {
      const a = await effectiveAccess(tx, personOf(caller), v.node_id, present(now));
      if (a.level === 0 && !a.canUpload && !a.canManage && !a.canPublish) throw blockedLink({ workspaceId: ws, nodeId: v.node_id, route: 'versions.withdraw' });
      if (!a.canPublish) throw forbidden('You cannot withdraw this version.', 'no_publish_right');
    }
    await refuseIfArchived(tx, ws);
    await lockIndex(tx, ws);
    if (v.awaiting_release) throw badRequest('This version has not been released. Nothing to withdraw.');
    if (v.withdrawn_at) throw badRequest('This version is already withdrawn.');
    const fallback = (await tx.query<{ version_no: number }>(
      `select version_no from document_version where node_id = $1 and id <> $2 and not awaiting_release and withdrawn_at is null
        order by version_no desc limit 1`, [v.node_id, id])).rows[0];
    if (!fallback) throw badRequest('This is the only released version. Withdraw the document instead.');
    const at = (await tx.query<{ withdrawn_at: string }>(
      `update document_version set withdrawn_at = now(), withdrawn_by = $2 where id = $1 and withdrawn_at is null returning withdrawn_at`,
      [id, personOf(caller)])).rows[0];
    if (!at) throw badRequest('This version is already withdrawn.');
    await appendEvent(tx, { action: 'document.version_withdrawn', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: v.node_id,
      data: { index_number: v.index_number, version_id: id, version_no: Number(v.version_no), falls_back_to: Number(fallback.version_no), reason: req.body.reason ?? null },
      occurredAt: now, requestId: req.id });
    return { withdrawnAt: new Date(at.withdrawn_at).toISOString(), fallsBackTo: Number(fallback.version_no) };
  }));

  r.post('/v1/workspaces/:ws/nodes/:id/withdraw', {
    schema: {
      summary: 'Withdraw a published item',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().max(500).optional() }),
      response: { 200: z.object({ withdrawnAt: z.string() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    const { isAdmin } = await publisherOf(tx, caller, req.params.ws, now);
    if (!isAdmin) {
      const a = await effectiveAccess(tx, personOf(caller), req.params.id, present(now));
      if (a.level === 0 && !a.canUpload && !a.canManage && !a.canPublish) {
        throw blockedLink({ workspaceId: req.params.ws, nodeId: req.params.id, route: 'nodes.withdraw' });
      }
      if (!a.canPublish) throw forbidden('You cannot withdraw this item.', 'no_publish_right');
    }
    await refuseIfArchived(tx, req.params.ws);
    await lockIndex(tx, req.params.ws);
    const n = (await tx.query<{ state: string; index_number: string | null }>(`select state, index_number from node where id = $1 and workspace_id = $2`,
      [req.params.id, req.params.ws])).rows[0];
    if (!n) throw notFound();
    if (n.state !== 'published') throw badRequest('Only published items can be withdrawn.');
    await tx.query(`update node set state = 'withdrawn', withdrawn_at = $2, updated_at = $2 where id = $1`, [req.params.id, now.toISOString()]);
    await appendEvent(tx, { action: 'document.withdrawn', workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'node', resourceId: req.params.id,
      data: { index_number: n.index_number, reason: req.body.reason ?? null }, occurredAt: now, requestId: req.id });
    return { withdrawnAt: now.toISOString() };
  }));
};
