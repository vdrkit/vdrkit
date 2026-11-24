// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NoPreview, noPreviewOf } from './preview.js';
import { appendEvent, canSeeVersion, effectiveAccess, versionAccess, type SqlClient, present } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { capAccess, isWorkspaceAdmin, lockIndex, personOf, refuseIfArchived, requireMember } from './util.js';
import { onSellerSide } from './documents.js';

const WsParams = z.object({ ws: z.string().uuid() });
const Step = z.enum(['done', 'failed', 'waiting', 'skipped']);

export const DetailsOut = z.object({
  document: z.object({
    id: z.string().uuid(), name: z.string(), indexNumber: z.string().nullable(), state: z.enum(['draft', 'published', 'withdrawn']),
    path: z.array(z.object({ id: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string() })),
    publishedAt: z.string().nullable(),
    withdrawnAt: z.string().nullable(),
  }),
  me: z.object({
    isAdmin: z.boolean(),
    canUpload: z.boolean(),
    canPublish: z.boolean(),
    viewerVersionId: z.string().uuid().nullable(),
  }),
  versions: z.array(z.object({
    id: z.string().uuid(),
    number: z.number(),
    fileName: z.string(),
    sizeBytes: z.number(),
    pageCount: z.number().nullable(),
    sha256: z.string(),
    uploadedAt: z.string(),
    uploadedBy: z.object({ personId: z.string().uuid(), name: z.string() }).nullable(),
    status: z.enum(['draft', 'waiting', 'current', 'replaced', 'withdrawn', 'removed']),
    canRemove: z.boolean(),
    releasedAt: z.string().nullable(),
    releasedBy: z.string().nullable(),
    withdrawnAt: z.string().nullable(),
    withdrawnBy: z.string().nullable(),
    processing: z.object({
      status: z.enum(['pending', 'processing', 'ready', 'failed']),
      error: z.string().nullable(),
      steps: z.object({ received: Step, virus: Step, pages: Step, images: Step, text: Step }),
      virusSkip: z.object({ reason: z.enum(['not_configured', 'too_large']), limitBytes: z.number().nullable() }).nullable(),
      noPreview: NoPreview.nullable(),
    }),
  })),
  access: z.object({
    folder: z.object({ id: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string() }).nullable(),
    parties: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
    groups: z.array(z.object({
      id: z.string().uuid(), name: z.string(), partyId: z.string().uuid(), partyKind: z.enum(['bidder', 'financier', 'seller']),
      parentGroupId: z.string().uuid().nullable(), parentName: z.string().nullable(),
      level: z.number(),
      custom: z.boolean(),
      ownLevel: z.number().nullable(),
      folderLevel: z.number(),
    })),
  }).nullable(),
  publishers: z.array(z.object({ personId: z.string().uuid(), name: z.string(), isAdmin: z.boolean() })),
  reads: z.object({
    versionNumber: z.number(),
    groups: z.array(z.object({ groupId: z.string().uuid(), name: z.string(), opened: z.number(), members: z.number(), lastAt: z.string().nullable() })),
  }).nullable(),
});

const iso = (d: unknown) => (d == null ? null : new Date(d as string).toISOString());
const NAME = (alias: string) => `case when ${alias}.erased_at is not null then 'Erased user' else ${alias}.name end`;

const FAILED_AT: Record<string, number> = { hash: 0, virus: 1, convert: 2, image: 2, rasterise: 3, extract: 4 };

function stepsOf(v: { processing_status: string; failed_step: string | null; page_count: number | null; steps: string[] | null; metadata?: any }) {
  type S = z.infer<typeof Step>;
  const derived = new Set(v.steps ?? []);
  const scan = v.metadata?.virusScan as string | undefined;
  const passedScan = v.processing_status === 'ready' || (v.failed_step != null && (FAILED_AT[v.failed_step] ?? -1) > 1);
  let virus: S = 'waiting';
  if (v.failed_step === 'virus') virus = 'failed';
  else if (scan === 'clean') virus = 'done';
  else if (scan || passedScan) virus = 'skipped';
  const done = [true, false, derived.has('convert') || derived.has('rasterise') || v.page_count != null, derived.has('rasterise'), derived.has('extract')];
  let out: S[];
  if (v.processing_status === 'ready') {
    const preview = (v.page_count ?? 0) > 0 || derived.has('rasterise');
    const shown = preview ? 'done' : 'skipped';
    const searchable = derived.has('extract') || (preview && !v.metadata?.searchSkipped);
    out = ['done', virus, shown, shown, searchable ? 'done' : 'skipped'];
  } else if (v.processing_status === 'failed') {
    let at: number;
    if (v.failed_step != null && v.failed_step in FAILED_AT) at = FAILED_AT[v.failed_step]!;
    else at = done.findIndex((d, i) => i >= 2 && !d);
    if (at < 0) at = 4;
    out = [0, 1, 2, 3, 4].map((i): S => {
      if (i === at) return 'failed';
      if (i === 1) return virus;
      return i < at ? 'done' : 'waiting';
    });
  } else {
    out = done.map((d, i): S => (i === 1 ? virus : d ? 'done' : 'waiting'));
  }
  return { received: out[0]!, virus: out[1]!, pages: out[2]!, images: out[3]!, text: out[4]! };
}

function processingError(status: string, error: string | null): string | null {
  if (status !== 'failed') return null;
  return error ?? 'The file could not be prepared for viewing.';
}

async function mayRemoveDraft(tx: SqlClient, caller: Caller, ws: string, nodeId: string, versionId: string, now: Date) {
  const member = await requireMember(tx, caller, ws, now);
  if (caller.principal.kind === 'agent') throw forbidden('Agents cannot publish. Ask the person to do it.', 'agent_needs_approval');
  if (member.isAdmin) return;
  // 404, not 403: don't reveal the version
  if (!(await canSeeVersion(tx, caller.principal, versionId, present(now)))) throw notFound();
  const a = await effectiveAccess(tx, personOf(caller), nodeId, present(now));
  if (a.canPublish) return;
  const own = (await uploadedBy(tx, versionId)) === personOf(caller) && (await onSellerSide(tx, personOf(caller), ws, now));
  if (own && a.canUpload) return;
  if (own && (await tx.query<{ state: string }>(`select state from workspace where id = $1`, [ws])).rows[0]?.state === 'frozen') {
    throw new HttpProblem({ type: 'https://vdrkit.com/problems/room-frozen', title: 'Room frozen', status: 409,
      detail: 'The room is frozen, so you cannot remove your draft until a room admin unfreezes it.', reason: 'room_frozen' });
  }
  throw forbidden('Only the person who uploaded this draft, people who may publish here and room admins can remove it.', 'no_publish_right');
}

async function uploadedBy(tx: SqlClient, versionId: string): Promise<string | null> {
  return (await tx.query<{ person: string | null }>(
    `select coalesce(pr.person_id, pr.on_behalf_of_person_id) as person
       from document_version dv left join principal pr on pr.id = dv.uploaded_by where dv.id = $1`, [versionId])).rows[0]?.person ?? null;
}

export const detailsRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/nodes/:id/details', {
    schema: {
      summary: 'Document details (seller side): versions, processing, visibility and readers',
      params: WsParams.extend({ id: z.string().uuid() }),
      response: { 200: DetailsOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, id } = req.params;
    const now = app.now();
    const at = now.toISOString();
    const person = personOf(caller);
    if (caller.principal.kind === 'agent') throw notFound();
    const n = (await tx.query<{ id: string; name: string; index_number: string | null; state: 'draft' | 'published' | 'withdrawn'; parent_id: string | null;
      published_at: string | null; withdrawn_at: string | null; publisher: string | null; path: string }>(
      `select n.id, n.name, n.index_number, n.state, n.parent_id, n.published_at, n.withdrawn_at, n.path::text as path,
              (select ${NAME('p')} from person p where p.id = n.published_by) as publisher
         from node n where n.id = $1 and n.workspace_id = $2 and n.kind = 'document' and n.deleted_at is null`, [id, ws])).rows[0];
    if (!n) throw notFound();
    const access = capAccess(caller, await effectiveAccess(tx, person, id, present(now)));
    if (access.level === 0 && !access.canUpload && !access.canManage && !access.canPublish) throw notFound();
    const admin = await isWorkspaceAdmin(tx, person, ws, now);
    if (!admin && !(await onSellerSide(tx, person, ws, now))) throw notFound();
    const va = await versionAccess(tx, caller.principal, id, present(now));
    if (va.hidden) throw notFound();
    const switches = access.canUpload || access.canManage || access.canPublish;

    const path = (await tx.query<{ id: string; index_number: string | null; name: string }>(
      `select a.id, a.index_number, a.name from node a, node n where n.id = $1 and a.id = any (path_ids(n.path)) and a.path @> n.path and a.id <> n.id and a.deleted_at is null
        order by nlevel(a.path)`, [id])).rows;

    const rows = (await tx.query<{
      id: string; version_no: number; size_bytes: string; page_count: number | null; sha256: string; created_at: string; metadata: any;
      awaiting_release: boolean; released_at: string | null; withdrawn_at: string | null; processing_status: string; processing_error: string | null;
      failed_step: string | null; uploader_id: string | null; uploader: string | null; released_by: string | null; withdrawn_by: string | null;
      steps: string[] | null; visible: boolean;
    }>(
      `select dv.id, dv.version_no, dv.size_bytes, coalesce(dv.page_count, (dv.metadata ->> 'pageCount')::int) as page_count, dv.sha256,
              dv.created_at, dv.metadata, dv.awaiting_release, dv.released_at, dv.withdrawn_at, dv.processing_status, dv.processing_error, dv.failed_step,
              case when up.erased_at is null then up.id end as uploader_id, ${NAME('up')} as uploader,
              (select ${NAME('p')} from person p where p.id = dv.released_by) as released_by,
              (select ${NAME('p')} from person p where p.id = dv.withdrawn_by) as withdrawn_by,
              (select array_agg(distinct f.step) from derived_file f where f.version_id = dv.id) as steps,
              can_see_version($2, dv.id, $3::timestamptz, record_clock(), false) as visible
         from document_version dv
         left join principal pr on pr.id = dv.uploaded_by
         left join person up on up.id = coalesce(pr.person_id, pr.on_behalf_of_person_id)
        where dv.node_id = $1 order by dv.version_no desc`, [id, person, at])).rows.filter((v) => v.visible);

    const live = rows.filter((v) => !v.withdrawn_at && !v.awaiting_release);
    const bidderVersion = n.state === 'published' ? live[0] ?? null : null;
    const versions = rows.map((v) => {
      let status: z.infer<typeof DetailsOut>['versions'][number]['status'];
      if (v.withdrawn_at) status = v.metadata?.removed_draft ? 'removed' : 'withdrawn';
      else if (v.awaiting_release) status = 'waiting';
      else if (n.state === 'draft') status = v.id === live[0]?.id ? 'draft' : 'replaced';
      else if (n.state === 'withdrawn') status = v.id === live[0]?.id ? 'withdrawn' : 'replaced';
      else status = v.id === bidderVersion?.id ? 'current' : 'replaced';
      const steps = stepsOf(v);
      let virusSkip: z.infer<typeof DetailsOut>['versions'][number]['processing']['virusSkip'] = null;
      if (steps.virus === 'skipped') {
        if (v.metadata?.virusScan === 'too_large') {
          virusSkip = { reason: 'too_large', limitBytes: typeof v.metadata?.virusScanLimit === 'number' ? v.metadata.virusScanLimit : null };
        } else {
          virusSkip = { reason: 'not_configured', limitBytes: null };
        }
      }
      const viaNode = !v.released_at && !v.awaiting_release && !!n.published_at
        && (status === 'current' || status === 'withdrawn' || new Date(v.created_at) <= new Date(n.published_at));
      return {
        id: v.id, number: Number(v.version_no),
        fileName: (v.metadata?.filename as string | undefined) ?? n.name,
        sizeBytes: Number(v.size_bytes), pageCount: v.page_count == null ? null : Number(v.page_count), sha256: v.sha256,
        uploadedAt: iso(v.created_at)!,
        uploadedBy: v.uploader_id ? { personId: v.uploader_id, name: v.uploader ?? '' } : null,
        status,
        canRemove: (status === 'draft' || status === 'waiting')
          && (admin || access.canPublish || (access.canUpload && !!v.uploader_id && v.uploader_id === person)),
        releasedAt: iso(v.released_at) ?? (viaNode ? iso(n.published_at) : null),
        releasedBy: v.released_by ?? (viaNode ? n.publisher : null),
        withdrawnAt: iso(v.withdrawn_at) ?? (status === 'withdrawn' ? iso(n.withdrawn_at) : null),
        withdrawnBy: v.withdrawn_by,
        processing: {
          status: v.processing_status as 'pending' | 'processing' | 'ready' | 'failed',
          error: processingError(v.processing_status, v.processing_error),
          steps,
          virusSkip,
          noPreview: noPreviewOf(v.processing_status, v.page_count, v.metadata?.previewSkipped),
        },
      };
    });

    let accessOut: z.infer<typeof DetailsOut>['access'] = null;
    if (admin || switches) {
      const parties = (await tx.query<{ id: string; name: string }>(
        `select id, name from party where workspace_id = $1 and kind in ('bidder', 'financier') order by name, id`, [ws])).rows;
      const groups = (await tx.query<{ id: string; name: string; party_id: string; party_kind: 'bidder' | 'financier' | 'seller'; parent_group_id: string | null;
        parent_name: string | null; level: number; own_level: number | null; folder_level: number }>(
        `select g.id, g.name, g.party_id, pa.kind as party_kind, g.parent_group_id, pg.name as parent_name,
                group_level(g.id, $2, $3::timestamptz) as level,
                (select ag.level from access_grant ag where ag.node_id = $2 and ag.subject_group_id = g.id and ag.effect = 'allow'
                    and ag.valid_from <= $3 and $3 < ag.valid_to and ag.recorded_at <= $3 and $3 < ag.superseded_at limit 1) as own_level,
                case when $4::uuid is null then 0 else group_level(g.id, $4::uuid, $3::timestamptz) end as folder_level
           from groups g join party pa on pa.id = g.party_id left join groups pg on pg.id = g.parent_group_id
          where g.workspace_id = $1 and g.valid_from <= $3 and $3 < g.valid_to
            and (pa.kind in ('bidder', 'financier') or (pa.kind = 'seller' and g.role_template is distinct from 'admin'))
          order by pa.kind = 'seller', pa.name, coalesce(g.parent_group_id, g.id), g.parent_group_id nulls first, g.name`, [ws, id, at, n.parent_id])).rows;
      const folder = path.at(-1);
      accessOut = {
        folder: folder ? { id: folder.id, indexNumber: folder.index_number, name: folder.name } : null,
        parties,
        groups: groups.map((g) => ({ id: g.id, name: g.name, partyId: g.party_id, partyKind: g.party_kind, parentGroupId: g.parent_group_id,
          parentName: g.parent_name, level: Number(g.level), custom: g.own_level != null,
          ownLevel: g.own_level == null ? null : Number(g.own_level), folderLevel: Number(g.folder_level) })),
      };
    }

    const sellers = (await tx.query<{ id: string; name: string }>(
      `select distinct p.id, p.name from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
         join person p on p.id = m.person_id
        where g.workspace_id = $1 and pa.kind = 'seller' and m.status = 'active' and p.erased_at is null
          and m.valid_from <= $2 and $2 < m.valid_to and m.recorded_at <= $2 and $2 < m.superseded_at
          and g.valid_from <= $2 and $2 < g.valid_to`, [ws, at])).rows;
    const publishers: z.infer<typeof DetailsOut>['publishers'] = [];
    for (const s of sellers) {
      const isAdmin = await isWorkspaceAdmin(tx, s.id, ws, now);
      if (isAdmin || (await effectiveAccess(tx, s.id, id, present(now))).canPublish) publishers.push({ personId: s.id, name: s.name, isAdmin });
    }
    publishers.sort((a, b) => Number(a.isAdmin) - Number(b.isAdmin) || a.name.localeCompare(b.name, 'en-GB'));

    let reads: z.infer<typeof DetailsOut>['reads'] = null;
    if (admin && bidderVersion) {
      const groups = (await tx.query<{ id: string; name: string; members: number; opened: number; last_at: string | null; level: number }>(
        `with tops as (
           select g.id, g.name, pa.name as party from groups g join party pa on pa.id = g.party_id
            where g.workspace_id = $1 and pa.kind in ('bidder', 'financier') and g.parent_group_id is null and g.valid_from <= $3 and $3 < g.valid_to),
         people as (
           select t.id as top, m.person_id from tops t join groups g on g.id = t.id or g.parent_group_id = t.id
             join membership m on m.group_id = g.id
            where m.status = 'active' and m.valid_from <= $3 and $3 < m.valid_to and m.superseded_at = 'infinity')
         select t.id, t.name,
                (select count(distinct p.person_id) from people p where p.top = t.id)::int as members,
                (select count(distinct v.person_id) from view_session v where v.version_id = $2 and v.person_id in (select p.person_id from people p where p.top = t.id))::int as opened,
                (select max(v.opened_at) from view_session v where v.version_id = $2 and v.person_id in (select p.person_id from people p where p.top = t.id)) as last_at,
                group_level(t.id, $4, $3::timestamptz) as level
           from tops t order by t.party, t.name`, [ws, bidderVersion.id, at, id])).rows;
      reads = {
        versionNumber: Number(bidderVersion.version_no),
        groups: groups.filter((g) => Number(g.level) >= 20 || g.opened > 0)
          .map((g) => ({ groupId: g.id, name: g.name, opened: g.opened, members: g.members, lastAt: iso(g.last_at) })),
      };
    }

    return {
      document: { id: n.id, name: n.name, indexNumber: n.index_number, state: n.state,
        path: path.map((p) => ({ id: p.id, indexNumber: p.index_number, name: p.name })), publishedAt: iso(n.published_at), withdrawnAt: iso(n.withdrawn_at) },
      me: { isAdmin: admin, canUpload: access.canUpload, canPublish: admin || access.canPublish, viewerVersionId: access.level >= 20 || switches || admin ? va.versionId : null },
      versions,
      access: accessOut,
      publishers,
      reads,
    };
  }));

  r.post('/v1/workspaces/:ws/versions/:id/remove-draft', {
    schema: {
      summary: 'Delete a draft or an unreleased version',
      params: WsParams.extend({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().max(500).optional() }).default({}),
      response: { 200: z.object({ removed: z.enum(['version', 'document']), fallsBackTo: z.number().nullable(), filesDeleted: z.number() }) },
    },
  }, async (req) => {
    const out = await app.inTenant(req, async (tx, caller) => {
      const { ws, id } = req.params;
      const now = app.now();
      const found = (await tx.query<{ node_id: string }>(
        `select dv.node_id from document_version dv join node n on n.id = dv.node_id
          where dv.id = $1 and n.workspace_id = $2 and n.deleted_at is null`, [id, ws])).rows[0];
      if (!found) throw notFound();
      await mayRemoveDraft(tx, caller, ws, found.node_id, id, now);
      await refuseIfArchived(tx, ws);
      await lockIndex(tx, ws);
      // node first, as a publish does, then re-read under the lock
      const n = (await tx.query<{ index_number: string | null; state: string; deleted: boolean }>(
        `select index_number, state, deleted_at is not null as deleted from node where id = $1 for update`, [found.node_id])).rows[0]!;
      const v = { ...n, ...(await tx.query<{ node_id: string; version_no: number; awaiting_release: boolean; released_at: string | null;
        withdrawn_at: string | null; storage_key: string }>(
        `select node_id, version_no, awaiting_release, released_at, withdrawn_at, storage_key from document_version where id = $1 for update`, [id])).rows[0]! };
      if (v.withdrawn_at) throw badRequest('This version has already been removed or withdrawn.');
      if (v.deleted) throw notFound();
      const isDraft = v.awaiting_release || (v.state === 'draft' && !v.released_at);
      if (!isDraft) throw badRequest('This version has been published. Withdraw it instead.');
      const others = (await tx.query<{ version_no: number }>(
        `select version_no from document_version where node_id = $1 and id <> $2 and withdrawn_at is null order by version_no desc for update`,
        [v.node_id, id])).rows;
      const person = personOf(caller);
      let removed: 'version' | 'document' = 'version';
      // row kept for audit
      const marked = await tx.query(
        `update document_version set awaiting_release = false, withdrawn_at = now(), withdrawn_by = $2, publish_when_ready = null,
                metadata = metadata || jsonb_build_object('removed_draft', true, 'files_deleted', true) where id = $1 and withdrawn_at is null returning id`,
        [id, person]);
      if (!marked.rows.length) throw badRequest('This version has already been removed or withdrawn.');
      if (!others.length && v.state === 'draft') {
        // soft delete: numbers are never reused
        await tx.query(`update node set deleted_at = $2, updated_at = $2 where id = $1`, [v.node_id, now.toISOString()]);
        removed = 'document';
      }
      // bytes deleted after commit
      const derived = (await tx.query<{ key: string }>(`select k as key from forget_removed_draft_files($1) k`, [id])).rows.map((r) => r.key);
      const keys = [v.storage_key, ...derived];
      await appendEvent(tx, { action: 'document.draft_removed', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: v.node_id,
        data: { index_number: v.index_number, version_id: id, version_no: Number(v.version_no), removed, reason: req.body.reason ?? null, person_id: person,
          files_deleted: keys.length },
        occurredAt: now, requestId: req.id });
      let fallsBackTo: number | null = null;
      if (removed === 'version' && others[0]) fallsBackTo = Number(others[0].version_no);
      return { removed, fallsBackTo, keys };
    });
    const storage = app.deps.storage;
    for (const key of out.keys) await storage?.delete?.(key).catch(() => undefined);
    return { removed: out.removed, fallsBackTo: out.fallsBackTo, filesDeleted: out.keys.length };
  });

  r.post('/v1/workspaces/:ws/versions/processing', {
    schema: {
      summary: 'Processing state of uploaded versions',
      params: WsParams,
      body: z.object({ ids: z.array(z.string().uuid()).min(1).max(5000) }),
      response: {
        200: z.object({
          items: z.array(z.object({
            versionId: z.string().uuid(), nodeId: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string(),
            status: z.enum(['pending', 'processing', 'ready', 'failed']), error: z.string().nullable(), pageCount: z.number().nullable(),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws } = req.params;
    const now = app.now();
    const member = await requireMember(tx, caller, ws, now);
    if (caller.principal.kind === 'agent') throw forbidden('Agents cannot upload. Ask the person to approve it.', 'agent_needs_approval');
    const { rows } = await tx.query<{ id: string; node_id: string; index_number: string | null; name: string; processing_status: string;
      processing_error: string | null; page_count: number | null }>(
      `select dv.id, dv.node_id, n.index_number, n.name, dv.processing_status, dv.processing_error, dv.page_count
         from document_version dv join node n on n.id = dv.node_id
         left join principal pr on pr.id = dv.uploaded_by
        where dv.id = any($1::uuid[]) and n.workspace_id = $2 and n.deleted_at is null
          and ($3::boolean or coalesce(pr.person_id, pr.on_behalf_of_person_id) = $4)`,
      [req.body.ids, ws, member.isAdmin, personOf(caller)]);
    return {
      items: rows.map((v) => ({ versionId: v.id, nodeId: v.node_id, indexNumber: v.index_number, name: v.name,
        status: v.processing_status as 'pending' | 'processing' | 'ready' | 'failed',
        error: processingError(v.processing_status, v.processing_error),
        pageCount: v.page_count == null ? null : Number(v.page_count) })),
    };
  }));

  r.get('/v1/workspaces/:ws/uploads/recent', {
    schema: {
      summary: 'Recent uploads, by person and sitting',
      params: WsParams,
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(20).default(3) }),
      response: {
        200: z.object({
          items: z.array(z.object({
            at: z.string(), person: z.object({ personId: z.string().uuid(), name: z.string() }).nullable(),
            files: z.number(), drafts: z.number(),
            folders: z.array(z.object({ indexNumber: z.string().nullable(), name: z.string() })),
            first: z.boolean(),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws } = req.params;
    const now = app.now();
    const member = await requireMember(tx, caller, ws, now);
    if (caller.principal.kind === 'agent') throw forbidden('Agents cannot upload. Ask the person to approve it.', 'agent_needs_approval');
    const { rows } = await tx.query<{ person_id: string | null; batch: string; at: string; files: number; drafts: number; parents: (string | null)[]; first: boolean }>(
      `with v as (
         select dv.created_at, coalesce(pr.person_id, pr.on_behalf_of_person_id) as person_id, n.parent_id,
                row_number() over (order by dv.created_at, dv.id) as rn,
                ((n.state = 'draft' or dv.awaiting_release) and dv.withdrawn_at is null) as draft
           from document_version dv join node n on n.id = dv.node_id left join principal pr on pr.id = dv.uploaded_by
          where n.workspace_id = $1 and n.deleted_at is null and coalesce((dv.metadata ->> 'removed_draft')::boolean, false) = false),
       s as (
         select v.*, case when lag(created_at) over w is null or created_at - lag(created_at) over w > interval '30 minutes' then 1 else 0 end as brk
           from v window w as (partition by person_id order by created_at)),
       b as (select s.*, sum(brk) over (partition by person_id order by created_at rows unbounded preceding) as batch from s)
       select person_id, batch::text, min(created_at) as at, count(*)::int as files, count(*) filter (where draft)::int as drafts,
              array_agg(distinct parent_id) as parents, bool_or(rn = 1) as first
         from b where ($2::boolean or person_id = $3)
        group by person_id, batch order by at desc limit $4`,
      [ws, member.isAdmin, personOf(caller), req.query.limit]);
    const parentIds = [...new Set(rows.flatMap((r) => r.parents).filter((p): p is string => !!p))];
    const folders = new Map((await tx.query<{ id: string; index_number: string | null; name: string }>(
      member.isAdmin
        ? `select id, index_number, name from node where id = any($1::uuid[])`
        : `select n.id, n.index_number, n.name from node n
             join accessible_nodes_among($2, $3, $1::uuid[], $4, record_clock()) a on a.node_id = n.id and (a.level >= 10 or a.can_upload or a.can_manage or a.can_publish)
            where n.id = any($1::uuid[])`,
      member.isAdmin ? [parentIds] : [parentIds, personOf(caller), ws, now.toISOString()])).rows.map((f) => [f.id, f]));
    const people = new Map((await tx.query<{ id: string; name: string }>(
      `select id, ${NAME('p')} as name from person p where id = any($1::uuid[])`, [rows.map((r) => r.person_id).filter(Boolean)])).rows.map((p) => [p.id, p.name]));
    const order = (ix: string | null) => (ix ?? '').split('.').map((x) => Number(x) || 0);
    const cmp = (a: number[], b: number[]) => {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? -1;
        const y = b[i] ?? -1;
        if (x !== y) return x - y;
      }
      return 0;
    };
    return {
      items: rows.map((r) => ({
        at: iso(r.at)!,
        person: r.person_id ? { personId: r.person_id, name: people.get(r.person_id) ?? '' } : null,
        files: r.files, drafts: r.drafts,
        folders: r.parents.flatMap((p) => {
          if (!p) return [{ indexNumber: null, name: 'Top level' }];
          const f = folders.get(p);
          return f ? [{ indexNumber: f.index_number, name: f.name }] : [];
        }).sort((a, b) => cmp(order(a.indexNumber), order(b.indexNumber))),
        // admins only: reveals others' uploads
        first: member.isAdmin && !!r.first,
      })),
    };
  }));
};
