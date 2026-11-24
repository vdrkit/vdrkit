// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NoPreview, noPreviewOf, PREVIEW_SKIPPED_COL, ProcessingStatus } from './preview.js';
import { ACTION_MIN_LEVEL, effectiveAccess, versionAccess, type Access, type SqlClient, present } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { notFound } from '../problems.js';
import { blockedLink, capAccess, isWorkspaceAdmin, personOf, recordBlockedLinkInline, renumberedTags } from './util.js';
import { watermarkNote } from './viewer.js';

async function adminFor(tx: SqlClient, caller: Caller, ws: string, at: Date): Promise<boolean> {
  return caller.principal.kind !== 'agent' && (await isWorkspaceAdmin(tx, personOf(caller), ws, at));
}

const Allowed = z.array(z.enum(['view', 'download_encrypted_pdf', 'print', 'download_pdf', 'download_original', 'upload', 'manage', 'publish']));

export const NodeOut = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  kind: z.enum(['folder', 'document']),
  name: z.string(),
  indexNumber: z.string().nullable(),
  state: z.enum(['draft', 'published', 'withdrawn']),
  access: z.object({ level: z.number(), allowed: Allowed }),
  version: z.object({
    id: z.string().uuid(), number: z.number(), pageCount: z.number().nullable(), uploadedAt: z.string(),
    status: ProcessingStatus,
    noPreview: NoPreview.nullable(),
    count: z.number().optional(),
    sizeBytes: z.number().optional(),
    pdfBytes: z.number().nullable().optional(),
    uploadedBy: z.string().nullable().optional(),
  }).nullable().optional(),
  uploadedBy: z.object({ personId: z.string().uuid(), name: z.string() }).nullable().optional(),
  releasedVersion: z.object({ id: z.string().uuid(), pageCount: z.number().nullable(), noPreview: NoPreview.nullable() }).nullable().optional(),
  watermark: z.object({
    name: z.string().nullable(), email: z.string().nullable(), group: z.string().nullable(), dateTime: z.boolean(), ip: z.boolean(),
  }).optional(),
  publishedAt: z.string().nullable().optional(),
  read: z.boolean().optional(),
  renumberedFrom: z.string().nullable().optional(),
});

interface VersionRow {
  version_id: string | null; version_no: number | null; page_count: number | null; uploaded_at: string | Date | null;
  processing_status: string | null; preview_skipped: string | null;
}

// needs dv; per-viewer ordinal, a hidden version must not leave a gap
const versionCols = (person: string, at: string, agent: string) => `case when dv.version_no = 1 then 1 else (
    select count(*) from document_version d2
     where d2.node_id = dv.node_id and d2.version_no <= dv.version_no and can_see_version(${person}, d2.id, ${at}, record_clock(), ${agent})
  ) end as version_no, coalesce(dv.page_count, (dv.metadata ->> 'pageCount')::int) as page_count, dv.created_at as uploaded_at,
  dv.processing_status, ${PREVIEW_SKIPPED_COL}`;

function versionOut(r: VersionRow) {
  if (!r.version_id) return null;
  const pageCount = r.page_count == null ? null : Number(r.page_count);
  return {
    id: r.version_id, number: Number(r.version_no), pageCount, uploadedAt: new Date(r.uploaded_at as string).toISOString(),
    status: ProcessingStatus.catch('pending').parse(r.processing_status), noPreview: noPreviewOf(r.processing_status, pageCount, r.preview_skipped),
  };
}

export function allowedActions(a: Pick<Access, 'level' | 'canUpload' | 'canManage' | 'canPublish'>, isAdmin = false): z.infer<typeof Allowed> {
  const out: z.infer<typeof Allowed> = [];
  for (const [action, min] of Object.entries(ACTION_MIN_LEVEL)) {
    if (action !== 'see_name' && a.level >= min) out.push(action as z.infer<typeof Allowed>[number]);
  }
  if (a.canUpload) out.push('upload');
  if (a.canManage) out.push('manage');
  if (a.canPublish || isAdmin) out.push('publish');
  return out;
}

const WsParams = z.object({ ws: z.string().uuid() });

function canSee(a: Pick<Access, 'level' | 'canUpload' | 'canManage' | 'canPublish'>): boolean {
  return a.level > 0 || a.canUpload || a.canManage || a.canPublish;
}

export const nodeRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/nodes', {
    schema: {
      summary: 'List a folder’s contents',
      params: WsParams,
      querystring: z.object({ parent: z.string().uuid().optional() }),
      response: { 200: z.object({ items: z.array(NodeOut) }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { rows } = await tx.query<{
      id: string; parent_id: string | null; kind: 'folder' | 'document'; name: string; index_number: string | null;
      state: 'draft' | 'published' | 'withdrawn'; level: number; can_upload: boolean; can_manage: boolean; can_publish: boolean; read: boolean;
      uploader_id: string | null; uploader_name: string | null; size_bytes: string | number | null; published_at: string | Date | null;
    } & VersionRow>(
      `select n.id, n.parent_id, n.kind, n.name, n.index_number, n.state, a.level, a.can_upload, a.can_manage, a.can_publish,
              a.version_id, ${versionCols('$1', '$3::timestamptz', '$5::boolean')}, dv.size_bytes, n.published_at,
              up.id as uploader_id, case when up.erased_at is not null then 'Erased user' else up.name end as uploader_name,
              n.kind = 'document' and exists (select 1 from view_session v where v.node_id = n.id and v.person_id = $1) as read
         from readable_nodes_among($1, $2, array(select c.id from node c where c.workspace_id = $2 and c.parent_id is not distinct from $4::uuid),
                                   $3, record_clock(), $5) a join node n on n.id = a.node_id
         left join document_version dv on dv.id = a.version_id
         left join principal upr on upr.id = dv.uploaded_by
         left join person up on up.id = coalesce(upr.person_id, upr.on_behalf_of_person_id)
        where n.parent_id is not distinct from $4
        order by n.sort_key, case when n.index_number ~ '^[0-9]+([.][0-9]+)*$' then string_to_array(n.index_number, '.')::int[] end nulls last, n.name`,
      [personOf(caller), req.params.ws, app.now().toISOString(), req.query.parent ?? null, caller.principal.kind === 'agent'],
    );
    const admin = await adminFor(tx, caller, req.params.ws, app.now());
    let sellerSide = admin;
    if (!sellerSide && caller.principal.kind !== 'agent') {
      const { rows: seller } = await tx.query<{ ok: boolean }>(
        `select exists (select 1 from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
                         where m.person_id = $1 and g.workspace_id = $2 and pa.kind = 'seller' and m.status = 'active'
                           and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= $3 and $3 < m.superseded_at
                           and g.valid_from <= $3 and $3 < g.valid_to) as ok`,
        [personOf(caller), req.params.ws, app.now().toISOString()]);
      sellerSide = !!seller[0]?.ok;
    }
    const released = new Map<string, { id: string; pageCount: number | null; noPreview: NoPreview | null }>();
    const waiting = sellerSide ? rows.filter((n) => n.version_id).map((n) => n.version_id!) : [];
    if (waiting.length) {
      const { rows: rel } = await tx.query<{ shown: string; id: string; page_count: number | null; processing_status: string; preview_skipped: string | null }>(
        `select w.id as shown, r.id, coalesce(r.page_count, (r.metadata ->> 'pageCount')::int) as page_count,
                r.processing_status, r.metadata ->> 'previewSkipped' as preview_skipped
           from document_version w
           join lateral (select * from document_version d where d.node_id = w.node_id and d.version_no < w.version_no
                           and not d.awaiting_release and version_released(d.released_at, d.withdrawn_at, $2::timestamptz)
                         order by d.version_no desc limit 1) r on true
          where w.id = any($1::uuid[]) and w.awaiting_release`,
        [waiting, app.now().toISOString()]);
      for (const r of rel) {
        const pageCount = r.page_count == null ? null : Number(r.page_count);
        released.set(r.shown, { id: r.id, pageCount, noPreview: noPreviewOf(r.processing_status, pageCount, r.preview_skipped) });
      }
    }
    const tags = caller.principal.kind === 'agent' ? new Map<string, string>() : await renumberedTags(tx, personOf(caller), req.params.ws);
    const parent = req.query.parent;
    if (parent && rows.length === 0 && !admin) {
      // hidden == unknown, but still log it
      const pa = capAccess(caller, await effectiveAccess(tx, personOf(caller), parent, present(app.now())));
      if (!canSee(pa)) {
        await recordBlockedLinkInline(tx, caller, { workspaceId: req.params.ws, nodeId: parent, route: 'nodes.list' }, req);
      }
    }
    const items: z.infer<typeof NodeOut>[] = [];
    for (const n of rows) {
      const a = capAccess(caller, { level: Number(n.level), canUpload: n.can_upload, canManage: n.can_manage, canPublish: n.can_publish });
      if (!canSee(a)) continue;
      const item: z.infer<typeof NodeOut> = {
        id: n.id, parentId: n.parent_id, kind: n.kind, name: n.name, indexNumber: n.index_number, state: n.state,
        access: { level: a.level, allowed: allowedActions(a, admin) },
        version: n.version_id ? { ...versionOut(n)!, sizeBytes: Number(n.size_bytes) } : null,
      };
      const isDoc = n.kind === 'document';
      if (isDoc) item.publishedAt = n.published_at == null ? null : new Date(n.published_at).toISOString();
      if (sellerSide) {
        item.uploadedBy = n.version_id && n.uploader_id ? { personId: n.uploader_id, name: n.uploader_name ?? '' } : null;
      }
      const rel = n.version_id ? released.get(n.version_id) : undefined;
      if (rel) item.releasedVersion = rel;
      if (isDoc) item.read = n.read;
      item.renumberedFrom = tags.get(n.id) ?? null;
      items.push(item);
    }
    return { items };
  }));

  r.get('/v1/workspaces/:ws/numbers/:number', {
    schema: {
      summary: 'Resolve an index number to a folder or document, optionally as at a past time',
      params: WsParams.extend({ number: z.string().regex(/^[0-9]{1,9}([.][0-9]{1,9}){0,19}$/) }),
      querystring: z.object({ at: z.string().datetime({ offset: true }).optional() }),
      response: { 200: z.object({ nodeId: z.string().uuid(), kind: z.enum(['folder', 'document']), indexNumber: z.string().nullable(), wasNumber: z.string().nullable() }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const cap = capAccess(caller, { level: 60, canUpload: true, canManage: true, canPublish: true });
    // rank -1: holder of the number at `at` (renumbering shifts siblings)
    const { rows } = await tx.query<{ node_id: string; kind: 'folder' | 'document'; index_number: string | null; was: string | null }>(
      `with seen as materialized (
         select a.node_id from readable_nodes($1, $2, $3, record_clock(), $5) a
          where least(a.level, $6::smallint) > 0 or (a.can_upload and $7) or (a.can_manage and $8) or (a.can_publish and $9))
       (select c.id as node_id, c.kind, c.index_number, nullif($4, c.index_number) as was, -1 as rank, null::timestamptz as at
          from node c join seen s on s.node_id = c.id
         where $10::timestamptz is not null and c.workspace_id = $2 and c.deleted_at is null
           and coalesce(c.published_at, '-infinity'::timestamptz) <= $10::timestamptz
           and (c.index_number = $4 or exists (select 1 from index_renumber r0 where r0.node_id = c.id and r0.workspace_id = $2
                                                  and (r0.from_number = $4 or r0.to_number = $4)))
           and coalesce(
                 (select r.to_number from index_renumber r where r.node_id = c.id and r.renumbered_at <= $10::timestamptz
                   order by r.renumbered_at desc, r.id desc limit 1),
                 (select r.from_number from index_renumber r where r.node_id = c.id and r.renumbered_at > $10::timestamptz
                   order by r.renumbered_at, r.id limit 1),
                 c.index_number) = $4)
       union all
       (select n.id, n.kind, n.index_number, null::text, 0, null::timestamptz
          from node n join seen s on s.node_id = n.id
         where n.workspace_id = $2 and n.deleted_at is null and n.index_number = $4)
       union all
       (select n.id, n.kind, n.index_number, r.from_number, 1, r.renumbered_at
          from index_renumber r join seen s on s.node_id = r.node_id join node n on n.id = r.node_id
         where r.workspace_id = $2 and r.from_number = $4 and n.deleted_at is null)
       order by rank, at desc nulls last limit 1`,
      [personOf(caller), req.params.ws, app.now().toISOString(), req.params.number, caller.principal.kind === 'agent',
        cap.level, cap.canUpload, cap.canManage, cap.canPublish, req.query.at ?? null]);
    const hit = rows[0];
    if (!hit) throw notFound();
    return { nodeId: hit.node_id, kind: hit.kind, indexNumber: hit.index_number, wasNumber: hit.was };
  }));

  r.get('/v1/workspaces/:ws/nodes/:id', {
    schema: {
      summary: 'Get a folder or document, with the caller’s permissions',
      params: WsParams.extend({ id: z.string().uuid() }),
      response: { 200: NodeOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const access = capAccess(caller, await effectiveAccess(tx, personOf(caller), req.params.id, present(app.now())));
    // 404, don't leak existence
    if (!canSee(access)) {
      throw blockedLink({ workspaceId: req.params.ws, nodeId: req.params.id, route: 'nodes.get' });
    }
    const { rows } = await tx.query<{ id: string; parent_id: string | null; kind: 'folder' | 'document'; name: string; index_number: string | null; state: 'draft' | 'published' | 'withdrawn'; published_at: string | Date | null }>(
      `select id, parent_id, kind, name, index_number, state, published_at from node where id = $1 and workspace_id = $2`,
      [req.params.id, req.params.ws],
    );
    const n = rows[0];
    if (!n) throw notFound();
    const admin = await adminFor(tx, caller, req.params.ws, app.now());
    let version: (ReturnType<typeof versionOut> & { count?: number; sizeBytes?: number; pdfBytes?: number | null; uploadedBy?: string | null }) | null = null;
    if (n.kind === 'document') {
      const va = await versionAccess(tx, caller.principal, n.id, present(app.now()));
      if (va.hidden) throw blockedLink({ workspaceId: req.params.ws, nodeId: n.id, route: 'nodes.get', versionHidden: true });
      if (va.versionId) {
        const v = (await tx.query<VersionRow & { version_count: number; size_bytes: string | number; pdf_bytes: string | number | null; uploader: string | null }>(
          `select dv.id as version_id, ${versionCols('$2', '$3::timestamptz', '$4::boolean')},
                  (select count(*) from document_version d2
                    where d2.node_id = dv.node_id and can_see_version($2, d2.id, $3::timestamptz, record_clock(), $4::boolean))::int as version_count,
                  dv.size_bytes,
                  (select (f.metadata ->> 'size')::bigint from derived_file f where f.version_id = dv.id and f.kind = 'pdf'
                    order by f.created_at desc limit 1) as pdf_bytes,
                  (select coalesce(pe.name, pr.name) from principal pr left join person pe on pe.id = pr.person_id where pr.id = dv.uploaded_by) as uploader
             from document_version dv where dv.id = $1`,
          [va.versionId, personOf(caller), app.now().toISOString(), caller.principal.kind === 'agent'])).rows[0];
        const out = v ? versionOut(v) : null;
        if (v && out) {
          version = {
            ...out, count: Math.max(Number(v.version_count), out.number), sizeBytes: Number(v.size_bytes),
            pdfBytes: v.pdf_bytes == null ? null : Number(v.pdf_bytes),
          };
          if (admin) version.uploadedBy = v.uploader;
        }
      }
    }
    const out: z.infer<typeof NodeOut> = {
      id: n.id, parentId: n.parent_id, kind: n.kind, name: n.name, indexNumber: n.index_number, state: n.state,
      access: { level: access.level, allowed: allowedActions(access, admin) },
      version,
    };
    if (n.kind === 'document') {
      out.publishedAt = n.published_at == null ? null : new Date(n.published_at).toISOString();
      out.watermark = await watermarkNote(tx, caller, req.params.ws, app.now());
    }
    return out;
  }));
};
