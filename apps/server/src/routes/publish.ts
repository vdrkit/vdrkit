// SPDX-License-Identifier: AGPL-3.0-only
import { appendEvent, enqueueForEvent, type SqlClient } from '@vdrkit/core';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { downloadOnlyAllowed } from './preview.js';
import { publishableNodes, releaseList, roomFrozenForPublishing } from './documents.js';
import { isWorkspaceAdmin, roomArchived } from './util.js';

export interface PublishRequest {
  person_id: string;
  actor_id: string | null;
  quiet: boolean;
  at: string;
}

export interface PublishInput {
  ws: string;
  person: string;
  actorId: string | null;
  nodeIds: string[];
  versionIds: string[];
  quiet: boolean;
  downloadOnly: boolean;
  now: Date;
  requestId?: string;
  whenReady?: boolean;
  // every check, no write: a large selection is checked as a whole before it is published in batches
  checkOnly?: boolean;
}

export interface PublishOutcome { published: number; versionsReleased: number; notified: number; quiet: boolean; waiting: number }

type NotReady = { id: string; index_number: string | null; name: string; version_id: string | null; newest_id: string; status: string;
  failed_step: string | null; virus_scan: string | null };

function itemRef(id: string, indexNumber: string | null, versionId: string | null) {
  const ref: { id: string; indexNumber: string | null; versionId?: string } = { id, indexNumber };
  if (versionId) ref.versionId = versionId;
  return ref;
}

export function notReadyToRelease(
  items: { id: string; index_number: string | null; name: string; version_id: string | null; status: string }[], asked: number,
): HttpProblem {
  const failed = items.filter((i) => i.status === 'failed').length;
  const busy = items.length - failed;
  const name = (i: { index_number: string | null; name: string }) => [i.index_number, i.name].filter(Boolean).join(' ');
  const one = items.length === 1 ? items[0]! : null;
  const nothing = asked > 1 ? ' Nothing was released.' : '';
  let detail: string;
  if (one && one.status === 'failed') {
    detail = `${name(one)} could not be prepared for viewing, so it cannot be released. Upload a new copy first.${nothing}`;
  } else if (one) {
    detail = `${name(one)} is still being prepared for viewing. Release it once it is ready, in about a minute.${nothing}`;
  } else if (failed && busy) {
    const needs = failed === 1 ? 'needs' : 'need';
    const is = busy === 1 ? 'is' : 'are';
    detail = `${items.length} of the selected files are not ready: ${failed} could not be prepared for viewing and ${needs} a new copy, and ${busy} ${is} still being prepared. Nothing was released.`;
  } else if (failed) {
    detail = `${items.length} of the selected files could not be prepared for viewing and need a new copy. Nothing was released.`;
  } else {
    detail = `${items.length} of the selected files are still being prepared for viewing. Release them once they are ready, in about a minute. Nothing was released.`;
  }
  return new HttpProblem({
    type: 'https://vdrkit.com/problems/not-ready', title: 'Not ready to release', status: 409, detail, reason: 'not_ready',
    items: items.map((i) => ({ ...itemRef(i.id, i.index_number, i.version_id), status: i.status === 'failed' ? 'failed' : 'processing' })),
  });
}

// all checks before any write
export async function publishItems(tx: SqlClient, p: PublishInput): Promise<PublishOutcome> {
  const { ws, person, now, quiet } = p;
  let { nodeIds, versionIds } = p;
  const isAdmin = await isWorkspaceAdmin(tx, person, ws, now);
  const w = (await tx.query<{ state: string; four_eyes_publish: boolean }>(
    `select state, four_eyes_publish from workspace where id = $1 for share`, [ws])).rows[0]!;
  const allowed: Set<string> | null = isAdmin ? null : await publishableNodes(tx, person, ws, now);
  if (allowed && allowed.size === 0) throw forbidden('You cannot publish in this room.', 'no_publish_right');
  if (w.state === 'frozen') throw roomFrozenForPublishing();
  if (w.state === 'archived') throw roomArchived();
  if (w.state === 'closed') throw badRequest('This room is closed. Open it again before publishing.');

  let versions = (await tx.query<{ id: string; node_id: string; version_no: number; awaiting_release: boolean; index_number: string | null; state: string }>(
    `select dv.id, dv.node_id, dv.version_no, dv.awaiting_release, n.index_number, n.state from document_version dv
       join node n on n.id = dv.node_id where dv.id = any($1::uuid[]) and n.workspace_id = $2 and n.deleted_at is null`,
    [versionIds, ws])).rows;
  if (versions.length !== new Set(versionIds).size) throw notFound();

  if (allowed) {
    const wanted = [...nodeIds, ...versions.map((v) => v.node_id)];
    const seen = (await tx.query<{ node_id: string }>(
      `select node_id from accessible_nodes_among($1, $2, $4::uuid[], $3, record_clock())`,
      [person, ws, now.toISOString(), wanted])).rows.map((x) => x.node_id);
    if (wanted.some((id) => !seen.includes(id))) throw notFound();
  }
  const notWaiting = versions.filter((v) => !v.awaiting_release || v.state !== 'published');
  if (notWaiting.length) {
    throw badRequest(notWaiting.length === 1
      ? `Version ${notWaiting[0]!.version_no} of ${notWaiting[0]!.index_number ?? 'this document'} is not waiting for release.`
      : `${notWaiting.length} of the selected versions are not waiting for release.`);
  }

  const targetsOf = async (ids: string[]) => (await tx.query<{ id: string; kind: string; index_number: string | null; state: string }>(
    `select distinct a.id, a.kind, a.index_number, a.state, nlevel(a.path) as depth
       from node n join node a on a.path @> n.path
      where n.workspace_id = $1 and n.id = any($2::uuid[]) and a.state = 'draft' and a.deleted_at is null
      order by depth`, [ws, ids])).rows;
  let targets = await targetsOf(nodeIds);
  if (targets.length === 0 && versions.length === 0) return { published: 0, versionsReleased: 0, notified: 0, quiet, waiting: 0 };
  if (allowed) {
    const refused = [
      ...targets.filter((t) => !allowed.has(t.id)).map((t) => ({ id: t.id, indexNumber: t.index_number })),
      ...versions.filter((v) => !allowed.has(v.node_id)).map((v) => ({ id: v.node_id, indexNumber: v.index_number, versionId: v.id })),
    ];
    if (refused.length) {
      const what = refused.length === 1 ? 'this item' : `these ${refused.length} items`;
      throw forbidden(`You cannot publish ${what}. Ask a room admin, or someone with the publish right on the folder.`, 'no_publish_right', refused);
    }
  }
  if (w.four_eyes_publish && !isAdmin) {
    const own = (await tx.query<{ id: string; index_number: string | null; version_id: string | null }>(
      `select n.id, n.index_number, null::uuid as version_id from node n
        where n.id = any($1::uuid[]) and n.kind = 'document'
          and exists (select 1 from document_version dv join principal p on p.id = dv.uploaded_by
                       where dv.node_id = n.id and dv.withdrawn_at is null and (p.person_id = $2 or p.on_behalf_of_person_id = $2))
       union all
       select n.id, n.index_number, dv.id from document_version dv join node n on n.id = dv.node_id
         join principal p on p.id = dv.uploaded_by
        where dv.id = any($3::uuid[]) and (p.person_id = $2 or p.on_behalf_of_person_id = $2)`,
      [targets.map((t) => t.id), person, versions.map((v) => v.id)])).rows;
    if (own.length) {
      const what = own.length === 1 ? (own[0]!.version_id ? 'this version' : 'this document') : 'these items';
      throw forbidden(`This room needs a second person to publish. You uploaded ${what} yourself.`,
        'four_eyes', own.map((t) => itemRef(t.id, t.index_number, t.version_id)));
    }
  }
  // never release a file that won't open; admins may publish download-only
  const notReady = (await tx.query<NotReady>(
    `select n.id, n.index_number, n.name, null::uuid as version_id, v.id as newest_id, v.processing_status as status, v.failed_step, v.virus_scan from node n
       join lateral (select dv.id, dv.processing_status, dv.failed_step, dv.metadata ->> 'virusScan' as virus_scan from document_version dv
                      where dv.node_id = n.id and dv.withdrawn_at is null order by dv.version_no desc limit 1) v on true
      where n.id = any($1::uuid[]) and n.kind = 'document' and v.processing_status <> 'ready'
     union all
     select n.id, n.index_number, n.name, dv.id, dv.id, dv.processing_status, dv.failed_step, dv.metadata ->> 'virusScan' from document_version dv
       join node n on n.id = dv.node_id
      where dv.id = any($2::uuid[]) and dv.processing_status <> 'ready'`,
    [targets.map((t) => t.id), versions.map((v) => v.id)])).rows;
  const keyOf = (x: NotReady) => x.version_id ?? x.id;
  const asOriginal = new Set<string>();
  if (p.downloadOnly && isAdmin) {
    for (const x of notReady) if (downloadOnlyAllowed(x)) asOriginal.add(keyOf(x));
  }
  let unready = notReady.filter((x) => !asOriginal.has(keyOf(x)));
  const later = p.whenReady ? unready.filter((x) => x.status === 'pending' || x.status === 'processing') : [];
  const asked = targets.filter((t) => t.kind === 'document').length + versions.length;
  if (p.checkOnly) {
    const blocked = unready.filter((x) => !later.includes(x));
    if (blocked.length) throw notReadyToRelease(blocked, asked);
    return { published: 0, versionsReleased: 0, notified: 0, quiet, waiting: later.length };
  }
  if (later.length) {
    unready = unready.filter((x) => !later.includes(x));
    if (unready.length) throw notReadyToRelease(unready, asked);
    const laterNodes = new Set(later.filter((x) => !x.version_id).map((x) => x.id));
    const laterVersions = new Set(later.filter((x) => x.version_id).map((x) => x.version_id!));
    nodeIds = nodeIds.filter((id) => !laterNodes.has(id));
    versionIds = versionIds.filter((id) => !laterVersions.has(id));
    versions = versions.filter((v) => !laterVersions.has(v.id));
    targets = await targetsOf(nodeIds);
    const request: PublishRequest = { person_id: person, actor_id: p.actorId, quiet, at: now.toISOString() };
    for (const x of later) {
      await tx.query(`update document_version set publish_when_ready = $2::jsonb where id = $1`, [x.newest_id, JSON.stringify(request)]);
      await appendEvent(tx, { action: 'document.publish_requested', workspaceId: ws, actorId: p.actorId, resourceType: 'node', resourceId: x.id,
        data: { index_number: x.index_number, version_id: x.newest_id, person_id: person, quiet }, occurredAt: now, requestId: p.requestId });
    }
  } else if (unready.length) {
    throw notReadyToRelease(unready, asked);
  }

  let notified = 0;
  // someone else, or the worker's publish-when-ready, may have published these since the checks above
  const fresh = new Set<string>();
  for (const t of targets) {
    const { rows } = await tx.query(
      `update node set state = 'published', published_at = $2, published_by = $3, updated_at = $2 where id = $1 and state = 'draft' and deleted_at is null returning id`,
      [t.id, now.toISOString(), person]);
    if (rows.length) fresh.add(t.id);
  }
  targets = targets.filter((t) => fresh.has(t.id));
  for (const t of targets) {
    const action = t.kind === 'document' ? 'document.published' : 'folder.published';
    const ev = await appendEvent(tx, { action, workspaceId: ws, actorId: p.actorId, resourceType: 'node', resourceId: t.id,
      data: { index_number: t.index_number, person_id: person, ...(t.kind === 'document' ? { quiet } : {}), ...(asOriginal.has(t.id) ? { download_only: true } : {}) },
      occurredAt: now, requestId: p.requestId });
    if (t.kind === 'document') {
      notified += await enqueueForEvent(tx, { id: ev.id, action, workspaceId: ws, resourceId: t.id, occurredAt: now, actorPersonId: person, quiet });
    }
  }
  if (targets.length) {
    await tx.query(`update document_version set publish_when_ready = null where node_id = any($1::uuid[]) and publish_when_ready is not null`,
      [targets.filter((t) => t.kind === 'document').map((t) => t.id)]);
  }
  let versionsReleased = 0;
  for (const v of versions.sort((a, b) => a.version_no - b.version_no)) {
    const list = await releaseList(tx, v.node_id, Number(v.version_no));
    const released = await tx.query(
      `update document_version set awaiting_release = false, visible_to_group_ids = $2::uuid[], released_at = now(), released_by = $3,
              publish_when_ready = null where id = $1 and awaiting_release and withdrawn_at is null returning id`,
      [v.id, list, person]);
    if (released.rows.length === 0) continue;
    versionsReleased++;
    const action = 'document.version_published';
    const ev = await appendEvent(tx, { action, workspaceId: ws, actorId: p.actorId, resourceType: 'node', resourceId: v.node_id,
      data: { index_number: v.index_number, version_id: v.id, version_no: Number(v.version_no), visible_to_group_ids: list, person_id: person, quiet,
        ...(asOriginal.has(v.id) ? { download_only: true } : {}) },
      occurredAt: now, requestId: p.requestId });
    // versionId: tell only people who may see this version
    notified += await enqueueForEvent(tx, { id: ev.id, action, workspaceId: ws, resourceId: v.node_id, occurredAt: now, actorPersonId: person, versionId: v.id, quiet });
    // discard older waiting versions: releasing one later would replace this one
    const older = (await tx.query<{ id: string; version_no: number }>(
      `update document_version set awaiting_release = false, withdrawn_at = now(), withdrawn_by = $3, publish_when_ready = null,
              metadata = metadata || jsonb_build_object('removed_draft', true, 'superseded_by', $2::text)
        where node_id = $1 and awaiting_release and withdrawn_at is null and version_no < $4 returning id, version_no`,
      [v.node_id, v.id, person, v.version_no])).rows;
    for (const o of older) {
      await appendEvent(tx, { action: 'document.draft_removed', workspaceId: ws, actorId: p.actorId, resourceType: 'node', resourceId: v.node_id,
        data: { index_number: v.index_number, version_id: o.id, version_no: Number(o.version_no), removed: 'version', reason: null, person_id: person,
          superseded_by: Number(v.version_no) },
        occurredAt: now, requestId: p.requestId });
    }
  }
  return { published: targets.length, versionsReleased, notified, quiet, waiting: later.length };
}
