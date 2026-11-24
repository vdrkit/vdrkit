// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { downloadOnlyAllowed, NoPreview, noPreviewOf } from './preview.js';
import { CATEGORY_OF, loadPolicies, roomDefault, roomTiming, type SqlClient } from '@vdrkit/core';
import { notFound } from '../problems.js';
import { draftLists, listAdmits, namedPeople, onSellerSide, publishableNodes, releaseList } from './documents.js';
import { isWorkspaceAdmin, personOf, requireMember } from './util.js';

const WsParams = z.object({ ws: z.string().uuid() });
const GroupLevel = z.object({ id: z.string().uuid(), level: z.number() });

export const ReleaseReviewOut = z.object({
  room: z.object({
    state: z.string(),
    fourEyes: z.boolean(),
    summaryTimes: z.array(z.string()),
    // mandatory means no quiet release
    noticeMandatory: z.boolean(),
  }),
  me: z.object({
    isAdmin: z.boolean(),
    scope: z.array(z.object({ id: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string() })).nullable(),
    canPublishFolder: z.boolean().nullable(),
  }),
  parties: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  groups: z.array(z.object({ id: z.string().uuid(), name: z.string(), partyId: z.string().uuid(), parentGroupId: z.string().uuid().nullable() })),
  folders: z.array(z.object({
    id: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string(),
    groups: z.array(GroupLevel),
  })),
  items: z.array(z.object({
    id: z.string().uuid(),
    folderId: z.string().uuid(),
    versionId: z.string().uuid().nullable(),
    replacesVersionNo: z.number().nullable(),
    indexNumber: z.string().nullable(),
    name: z.string(),
    pageCount: z.number().nullable(),
    uploadedBy: z.string().nullable(),
    uploadedByMe: z.boolean(),
    uploadedAt: z.string(),
    blocked: z.enum(['processing', 'failed', 'four_eyes']).nullable(),
    noPreview: NoPreview.nullable(),
    downloadOnly: z.boolean(),
    groups: z.array(GroupLevel).nullable(),
    people: z.array(z.object({ id: z.string().uuid(), name: z.string(), level: z.number() })),
  })),
});

const ixOrder = (a: string | null, b: string | null) => {
  const pa = (a ?? '').split('.').map(Number);
  const pb = (b ?? '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
};

interface Row {
  id: string; parent_id: string; index_number: string | null; name: string; created_at: string | Date;
  version_id: string | null; version_no: number | null; page_count: number | null; status: string | null;
  uploader: string | null; uploader_id: string | null; preview_skipped: string | null; failed_step: string | null; virus_scan: string | null;
}

async function levels(tx: SqlClient, nodes: string[], groups: string[], at: Date): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!nodes.length || !groups.length) return out;
  const { rows } = await tx.query<{ n: string; g: string; l: number }>(
    `select n.id as n, g.id as g, group_level(g.id, n.id, $3::timestamptz) as l
       from unnest($1::uuid[]) as n(id) cross join unnest($2::uuid[]) as g(id)`, [nodes, groups, at.toISOString()]);
  for (const r of rows) {
    if (!out.has(r.n)) out.set(r.n, new Map());
    out.get(r.n)!.set(r.g, Number(r.l));
  }
  return out;
}

// 404 without a publish right: don't leak drafts
export const releaseReviewRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/release-review', {
    schema: {
      summary: 'Release review: drafts and new versions to publish. 404 unless room admin or publisher',
      params: WsParams,
      querystring: z.object({
        folder: z.string().uuid().optional(),
      }),
      response: { 200: ReleaseReviewOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    const at = now.toISOString();
    if (caller.principal.kind === 'agent') throw notFound();
    await requireMember(tx, caller, ws, now);
    const person = personOf(caller);
    const isAdmin = await isWorkspaceAdmin(tx, person, ws, now);
    let mine: Set<string> | null = null;
    if (!isAdmin) {
      if (!(await onSellerSide(tx, person, ws, now))) throw notFound();
      mine = await publishableNodes(tx, person, ws, now);
      if (mine.size === 0) throw notFound();
    }
    const mineList = mine ? [...mine] : null;
    const only = req.query.folder ?? null;

    const w = (await tx.query<{ state: string; four_eyes_publish: boolean }>(
      `select state, four_eyes_publish from workspace where id = $1`, [ws])).rows[0]!;
    const fourEyes = w.four_eyes_publish;

    const uploader = `case when p.erased_at is not null then 'Erased user' else p.name end as uploader, p.id as uploader_id`;
    const drafts = (await tx.query<Row>(
      `select n.id, n.parent_id, n.index_number, n.name,
              case when v.version_no > 1 then v.created_at else n.created_at end as created_at,
              null::uuid as version_id, null::int as version_no, coalesce(v.page_count, (v.metadata ->> 'pageCount')::int) as page_count,
              v.processing_status as status, v.metadata ->> 'previewSkipped' as preview_skipped, v.failed_step, v.metadata ->> 'virusScan' as virus_scan, ${uploader}
         from node n
         left join lateral (select dv.* from document_version dv where dv.node_id = n.id and dv.withdrawn_at is null
                             order by dv.version_no desc limit 1) v on true
         left join principal pr on pr.id = v.uploaded_by
         left join person p on p.id = coalesce(pr.person_id, pr.on_behalf_of_person_id)
        where n.workspace_id = $1 and n.kind = 'document' and n.state = 'draft' and n.deleted_at is null and n.parent_id is not null
          and ($2::uuid[] is null or n.id = any($2::uuid[])) and ($3::uuid is null or n.parent_id = $3)`, [ws, mineList, only])).rows;
    const versions = (await tx.query<Row>(
      `select n.id, n.parent_id, n.index_number, n.name, dv.created_at, dv.id as version_id, dv.version_no,
              coalesce(dv.page_count, (dv.metadata ->> 'pageCount')::int) as page_count, dv.processing_status as status,
              dv.metadata ->> 'previewSkipped' as preview_skipped, dv.failed_step, dv.metadata ->> 'virusScan' as virus_scan, ${uploader}
         from document_version dv join node n on n.id = dv.node_id
         left join principal pr on pr.id = dv.uploaded_by
         left join person p on p.id = coalesce(pr.person_id, pr.on_behalf_of_person_id)
        where n.workspace_id = $1 and n.state = 'published' and n.deleted_at is null and n.parent_id is not null
          and dv.awaiting_release and dv.withdrawn_at is null
          and ($2::uuid[] is null or n.id = any($2::uuid[])) and ($3::uuid is null or n.parent_id = $3)`, [ws, mineList, only])).rows;
    const rows = [...drafts, ...versions].sort((a, b) =>
      ixOrder(a.index_number, b.index_number) || Number(a.version_no ?? 0) - Number(b.version_no ?? 0));

    const parties = (await tx.query<{ id: string; name: string }>(
      `select id, name from party where workspace_id = $1 and kind in ('bidder', 'financier') order by name, id`, [ws])).rows;
    const groups = (await tx.query<{ id: string; name: string; party_id: string; parent_group_id: string | null }>(
      `select g.id, g.name, g.party_id, g.parent_group_id from groups g join party pa on pa.id = g.party_id
         left join groups top on top.id = g.parent_group_id
        where g.workspace_id = $1 and pa.kind in ('bidder', 'financier') and g.valid_from <= $2 and $2 < g.valid_to
        order by pa.name, pa.id, coalesce(top.name, g.name), coalesce(g.parent_group_id, g.id), g.parent_group_id nulls first, g.name, g.id`, [ws, at])).rows;
    const groupIds = groups.map((g) => g.id);

    const folderIds = [...new Set(rows.map((x) => x.parent_id))];
    const folderRows = (await tx.query<{ id: string; index_number: string | null; name: string }>(
      `select id, index_number, name from node where id = any($1::uuid[])`, [folderIds])).rows
      .sort((a, b) => ixOrder(a.index_number, b.index_number) || a.name.localeCompare(b.name, 'en-GB'));
    const folderLevels = await levels(tx, folderIds, groupIds, now);
    const own = (await tx.query<{ node_id: string }>(
      `select distinct node_id from access_grant where node_id = any($1::uuid[]) and subject_group_id is not null
          and valid_from <= $2 and $2 < valid_to and recorded_at <= $2 and $2 < superseded_at`, [rows.map((x) => x.id), at])).rows.map((x) => x.node_id);
    const ownLevels = await levels(tx, [...new Set(own)], groupIds, now);
    const personGrantNodes = new Set((await tx.query<{ node_id: string }>(
      `select distinct ag.node_id from access_grant ag
        where ag.workspace_id = $1 and ag.subject_person_id is not null and ag.effect = 'allow'
          and ag.valid_from <= $2 and $2 < ag.valid_to and ag.recorded_at <= $2 and $2 < ag.superseded_at`, [ws, at])).rows.map((x) => x.node_id));
    const paths = new Map<string, string[]>();
    if (personGrantNodes.size) {
      const { rows: pathRows } = await tx.query<{ id: string; ids: string[] }>(
        `select id, path_ids(path) as ids from node where id = any($1::uuid[])`, [rows.map((x) => x.id)]);
      for (const x of pathRows) paths.set(x.id, x.ids);
    }
    const listRows = (await tx.query<{ node_id: string; groups: string[] }>(
      `select node_id, visible_to_group_ids as groups from document_version where node_id = any($1::uuid[]) and withdrawn_at is null`,
      [drafts.map((d) => d.id)])).rows;
    const listsOf = new Map<string, string[][]>();
    for (const l of listRows) listsOf.set(l.node_id, [...(listsOf.get(l.node_id) ?? []), l.groups]);

    const folders = folderRows.map((f) => ({
      id: f.id, indexNumber: f.index_number, name: f.name,
      groups: groups.map((g) => ({ id: g.id, level: folderLevels.get(f.id)?.get(g.id) ?? 0 })).filter((g) => g.level >= 20),
    }));
    const folderGroups = new Map(folders.map((f) => [f.id, f.groups]));
    const same = (a: { id: string; level: number }[], b: { id: string; level: number }[]) =>
      a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.level === b[i]!.level);

    const items = [];
    for (const x of rows) {
      const lists = x.version_id ? [await releaseList(tx, x.id, Number(x.version_no))] : listsOf.get(x.id) ?? (await draftLists(tx, x.id));
      const base = ownLevels.get(x.id) ?? folderLevels.get(x.parent_id);
      const seen = groups
        .filter((g) => listAdmits(lists, g))
        .map((g) => ({ id: g.id, level: base?.get(g.id) ?? 0 }))
        .filter((g) => g.level >= 20);
      const fg = folderGroups.get(x.parent_id) ?? [];
      const reachable = (paths.get(x.id) ?? []).some((id) => personGrantNodes.has(id));
      const people = reachable ? await namedPeople(tx, x.id, lists, ws, now) : [];
      let replaces: number | null = null;
      if (x.version_id) {
        const { rows: prev } = await tx.query<{ n: number | null }>(
          `select max(version_no) as n from document_version where node_id = $1 and version_no < $2 and not awaiting_release and withdrawn_at is null`,
          [x.id, x.version_no]);
        replaces = prev[0]?.n ?? null;
      }
      const byMe = x.uploader_id === person;
      let blocked: 'processing' | 'failed' | 'four_eyes' | null = null;
      if (x.status === 'pending' || x.status === 'processing') blocked = 'processing';
      else if (x.status === 'failed') blocked = 'failed';
      else if (fourEyes && !isAdmin && byMe) blocked = 'four_eyes';
      items.push({
        id: x.id, folderId: x.parent_id, versionId: x.version_id, replacesVersionNo: replaces === null ? null : Number(replaces),
        indexNumber: x.index_number, name: x.name, pageCount: x.page_count === null ? null : Number(x.page_count),
        uploadedBy: x.uploader, uploadedByMe: byMe, uploadedAt: new Date(x.created_at).toISOString(),
        blocked, noPreview: noPreviewOf(x.status, x.page_count, x.preview_skipped),
        downloadOnly: isAdmin && blocked === 'failed' && downloadOnlyAllowed(x),
        groups: same(seen, fg) ? null : seen, people,
      });
    }

    let scope: z.infer<typeof ReleaseReviewOut>['me']['scope'] = null;
    if (mine) {
      const tops = (await tx.query<{ id: string; index_number: string | null; name: string; parent_id: string | null }>(
        `select id, index_number, name, parent_id from node where id = any($1::uuid[]) and kind = 'folder' and deleted_at is null`, [mineList])).rows;
      scope = tops.filter((t) => !t.parent_id || !mine!.has(t.parent_id))
        .sort((a, b) => ixOrder(a.index_number, b.index_number))
        .map((t) => ({ id: t.id, indexNumber: t.index_number, name: t.name }));
    }

    const timing = await roomTiming(tx, ws);
    const category = CATEGORY_OF['document.published']!;
    const noticeMandatory = roomDefault(await loadPolicies(tx, ws, category), category, timing).mandatory;
    return {
      room: { state: w.state, fourEyes, summaryTimes: timing.summaryTimes, noticeMandatory },
      me: { isAdmin, scope, canPublishFolder: only ? isAdmin || !!mine?.has(only) : null },
      parties,
      groups: groups.map((g) => ({ id: g.id, name: g.name, partyId: g.party_id, parentGroupId: g.parent_group_id })),
      folders,
      items,
    };
  }));
};
