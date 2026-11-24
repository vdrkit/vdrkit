// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { effectiveAccess, planUpload, type ExistingFolder, type SqlClient, present } from '@vdrkit/core';
import { forbidden, notFound } from '../problems.js';
import { isWorkspaceAdmin, personOf, requireWorkspaceAdmin } from './util.js';
import { uploadSessionRoutes } from './upload-sessions.js';

interface Row { id: string; parent_id: string | null; kind: string; name: string; index_number: string | null; deleted: boolean }

function lastSegment(index: string | null): number {
  if (!index) return 0;
  const n = Number(index.split('.').pop());
  return Number.isFinite(n) ? n : 0;
}

async function loadTree(tx: SqlClient, ws: string, rootId: string | null, visible: Set<string>) {
  const { rows } = await tx.query<Row>(
    rootId
      // deleted docs: for their numbers only
      ? `select n.id, n.parent_id, n.kind, n.name, n.index_number, n.deleted_at is not null as deleted from node n, node r
          where r.id = $2 and n.workspace_id = $1 and n.path <@ r.path and n.id <> r.id and (n.deleted_at is null or n.kind = 'document')`
      : `select id, parent_id, kind, name, index_number, deleted_at is not null as deleted from node
          where workspace_id = $1 and (deleted_at is null or kind = 'document')`,
    rootId ? [ws, rootId] : [ws],
  );
  const folders = new Map<string, ExistingFolder>();
  for (const r of rows) {
    if (r.kind !== 'folder') continue;
    const hidden = !visible.has(r.id);
    // hidden: number only
    folders.set(r.id, {
      id: hidden ? '' : r.id, number: lastSegment(r.index_number), name: hidden ? '' : r.name, children: [], lastDocumentNumber: 0, hidden,
    });
  }
  const target: { children: ExistingFolder[]; lastDocumentNumber: number; hiddenDocuments?: boolean } = { children: [], lastDocumentNumber: 0 };
  for (const r of rows) {
    const parent = r.parent_id && r.parent_id !== rootId ? folders.get(r.parent_id) : target;
    if (!parent) continue;
    if (r.kind === 'folder') {
      parent.children.push(folders.get(r.id)!);
      continue;
    }
    parent.lastDocumentNumber = Math.max(parent.lastDocumentNumber, lastSegment(r.index_number));
    if (!r.deleted && !visible.has(r.id)) parent.hiddenDocuments = true;
  }
  return target;
}

const DroppedFile = z.object({
  path: z.string().min(1).max(1024).refine((p) => !p.split('/').includes('..'), 'Paths may not contain ..'),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  await app.register(uploadSessionRoutes);

  r.post('/v1/workspaces/:ws/upload-plans', {
    schema: {
      summary: 'Plan an upload: target folders, numbers and duplicates',
      params: z.object({ ws: z.string().uuid() }),
      body: z.object({
        targetFolderId: z.string().uuid().nullable().default(null),
        numbering: z.enum(['from_names', 'alphabetical']).default('from_names'),
        duplicates: z.enum(['skip', 'keep']).default('skip'),
        files: z.array(DroppedFile).min(1).max(5000),
      }),
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws } = req.params;
    const { targetFolderId, numbering, duplicates, files } = req.body;
    const now = app.now();
    if (caller.principal.kind === 'agent') throw forbidden('Agents cannot upload. Ask the person to approve it.', 'agent_needs_approval');
    let prefix = '';
    if (targetFolderId) {
      const access = await effectiveAccess(tx, personOf(caller), targetFolderId, present(now));
      if (access.level === 0 && !access.canUpload && !access.canManage && !access.canPublish) throw notFound();
      if (!access.canUpload) throw forbidden('You cannot upload to this folder.', 'no_upload_right');
      const t = await tx.query<{ index_number: string | null }>(`select index_number from node where id = $1 and workspace_id = $2`, [targetFolderId, ws]);
      if (!t.rows[0]) throw notFound();
      prefix = t.rows[0].index_number ?? '';
    } else {
      await requireWorkspaceAdmin(tx, caller, ws, now);
    }
    const access = await tx.query<{ node_id: string; level: number; can_upload: boolean; can_manage: boolean; can_publish: boolean }>(
      `select node_id, level, can_upload, can_manage, can_publish from accessible_nodes($1, $2, $3, record_clock())`, [personOf(caller), ws, now.toISOString()]);
    const visible = new Set(access.rows.filter((a) => Number(a.level) >= 10 || a.can_upload || a.can_manage || a.can_publish).map((a) => a.node_id));
    const readable = access.rows.filter((a) => Number(a.level) >= 20).map((a) => a.node_id);
    const tree = await loadTree(tx, ws, targetFolderId, visible);
    // only versions the person can open, or a match gives away drafts (same rule as can_see_version)
    const allVersions = access.rows.filter((a) => a.can_upload || a.can_manage || a.can_publish).map((a) => a.node_id);
    const hashes = await tx.query<{ sha256: string; index_number: string; name: string }>(
      `select distinct on (dv.sha256) dv.sha256, n.index_number, n.name
         from node n join document_version dv on dv.node_id = n.id
        where n.id = any($1::uuid[]) and not coalesce((dv.metadata ->> 'removed_draft')::boolean, false)
          and (n.id = any($2::uuid[]) or $3::boolean
               or (version_released(dv.released_at, dv.withdrawn_at, $4::timestamptz, record_clock())
                   and version_visible($5, $6, dv.visible_to_group_ids, $4::timestamptz, record_clock())))
        order by dv.sha256, dv.version_no desc`,
      [readable, allVersions, await isWorkspaceAdmin(tx, personOf(caller), ws, now), now.toISOString(), personOf(caller), ws],
    );
    const numberByHash = new Map(hashes.rows.map((h) => [h.sha256, h.index_number]));
    const nameByHash = new Map(hashes.rows.map((h) => [h.sha256, h.name]));
    return planUpload(tree, files, { numbering, duplicates }, numberByHash, prefix, nameByHash);
  }));
};
