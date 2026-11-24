// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { setGrant, STANDARD_MA_INDEX, type LevelValue, type SqlClient, type TemplateFolder } from '@vdrkit/core';
import { InvalidLogo, logoToPng, type LogoPng, type LogoSource } from '../logo-png.js';
import { badRequest } from '../problems.js';

type GrantAdmins = (tx: SqlClient, workspaceId: string, nodeId: string, now: Date) => Promise<void>;

async function insertFolder(tx: SqlClient, ws: string, parentId: string | null, name: string, indexNumber: string, sortKey: number): Promise<string> {
  return (await tx.query<{ id: string }>(
    `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state)
     values (current_tenant_id(), $1, $2, 'folder', $3, $4, $5, 'draft') returning id`,
    [ws, parentId, name, indexNumber, sortKey])).rows[0]!.id;
}

export async function createFolders(tx: SqlClient, ws: string, folders: readonly TemplateFolder[], now: Date, grantAdmins: GrantAdmins): Promise<number> {
  let count = 0;
  const walk = async (list: readonly TemplateFolder[], parentId: string | null, prefix: string) => {
    let i = 0;
    for (const f of list) {
      i++;
      const ix = prefix ? `${prefix}.${i}` : String(i);
      const id = await insertFolder(tx, ws, parentId, f.name, ix, i);
      count++;
      if (!parentId) await grantAdmins(tx, ws, id, now);
      if (f.children) await walk(f.children, id, ix);
    }
  };
  await walk(folders, null, '');
  return count;
}

export const createStandardIndex = (tx: SqlClient, ws: string, now: Date, grantAdmins: GrantAdmins) =>
  createFolders(tx, ws, STANDARD_MA_INDEX, now, grantAdmins);

export interface CopyParts {
  folders: boolean;
  settings: boolean;
  nda: boolean;
  invitationEmail: boolean;
  sellerGroups: boolean;
}

export interface CopyResult {
  folders: number;
  sellerGroups: number;
  grants: number;
  settings: boolean;
  nda: boolean;
  invitationEmail: boolean;
}

export async function copyRoom(
  tx: SqlClient, a: { from: string; to: string; toSellerParty: string; parts: CopyParts; now: Date; actorId: string | null; personId?: string | null; requestId: string },
  grantAdmins: GrantAdmins,
): Promise<CopyResult> {
  const { from, to, parts, now } = a;
  const out: CopyResult = { folders: 0, sellerGroups: 0, grants: 0, settings: false, nda: false, invitationEmail: false };
  const folderMap = new Map<string, string>();
  const groupMap = new Map<string, string>();

  if (parts.folders) {
    const src = (await tx.query<{ id: string; parent_id: string | null; name: string; index_number: string | null; sort_key: number }>(
      `select id, parent_id, name, index_number, sort_key from node
        where workspace_id = $1 and kind = 'folder' and deleted_at is null order by nlevel(path), sort_key, index_number`, [from])).rows;
    for (const f of src) {
      if (f.parent_id && !folderMap.has(f.parent_id)) continue;   // under a deleted folder
      const id = await insertFolder(tx, to, f.parent_id ? folderMap.get(f.parent_id)! : null, f.name, f.index_number ?? '', Number(f.sort_key));
      folderMap.set(f.id, id);
      if (!f.parent_id) await grantAdmins(tx, to, id, now);
    }
    out.folders = folderMap.size;
  }

  if (parts.sellerGroups) {
    const src = (await tx.query<{ id: string; parent_group_id: string | null; name: string; role_template: string }>(
      `select g.id, g.parent_group_id, g.name, g.role_template from groups g join party pa on pa.id = g.party_id
        where g.workspace_id = $1 and pa.kind = 'seller' and g.role_template <> 'admin' and g.valid_from <= $2 and $2 < g.valid_to
        order by g.parent_group_id nulls first, g.name`, [from, now.toISOString()])).rows;
    for (const g of src) {
      if (g.parent_group_id && !groupMap.has(g.parent_group_id)) continue;
      const id = (await tx.query<{ id: string }>(
        `insert into groups (tenant_id, workspace_id, party_id, name, parent_group_id, role_template)
         values (current_tenant_id(), $1, $2, $3, $4, $5) returning id`,
        [to, a.toSellerParty, g.name, g.parent_group_id ? groupMap.get(g.parent_group_id)! : null, g.role_template])).rows[0]!.id;
      groupMap.set(g.id, id);
    }
    out.sellerGroups = groupMap.size;
    if (folderMap.size && groupMap.size) {
      const grants = (await tx.query<{ node_id: string; subject_group_id: string; level: number; can_upload: boolean; can_manage: boolean; can_publish: boolean }>(
        `select node_id, subject_group_id, level, can_upload, can_manage, can_publish from access_grant
          where workspace_id = $1 and subject_group_id = any($2::uuid[]) and node_id = any($3::uuid[]) and effect = 'allow'
            and superseded_at = 'infinity' and valid_from <= $4 and $4 < valid_to`,
        [from, [...groupMap.keys()], [...folderMap.keys()], now.toISOString()])).rows;
      for (const g of grants) {
        await setGrant(tx, {
          workspaceId: to, nodeId: folderMap.get(g.node_id)!, subject: { groupId: groupMap.get(g.subject_group_id)! },
          level: Number(g.level) as LevelValue, canUpload: g.can_upload, canManage: g.can_manage, canPublish: g.can_publish,
          actorId: a.actorId, requestId: a.requestId, now,
        });
      }
      out.grants = grants.length;
    }
  }

  const src = (await tx.query<{ four_eyes_publish: boolean; requires_nda: boolean; metadata: Record<string, unknown> }>(
    `select four_eyes_publish, requires_nda, metadata from workspace where id = $1`, [from])).rows[0]!;
  const meta: Record<string, unknown> = {};

  if (parts.settings) {
    if (src.metadata.watermark) meta.watermark = src.metadata.watermark;
    await tx.query(`update workspace set four_eyes_publish = $2 where id = $1`, [to, src.four_eyes_publish]);
    await tx.query(
      `insert into notification_policy (tenant_id, workspace_id, scope, category, enabled, mode, mandatory, allowed_modes, digest_times)
       select current_tenant_id(), $2, 'workspace', category, enabled, mode, mandatory, allowed_modes, digest_times
         from notification_policy where workspace_id = $1 and scope = 'workspace'`, [from, to]);
    await tx.query(
      `insert into notification_room_setting (tenant_id, workspace_id, bundle_quiet_minutes, bundle_max_minutes, summary_times)
       select current_tenant_id(), $2, bundle_quiet_minutes, bundle_max_minutes, summary_times
         from notification_room_setting where workspace_id = $1`, [from, to]);
    await tx.query(
      `update workspace t set (require_two_factor, allow_trusted_browser, trusted_browser_days, idle_sign_out_minutes) =
              (select require_two_factor, allow_trusted_browser, trusted_browser_days, idle_sign_out_minutes from workspace f where f.id = $1)
        where t.id = $2`, [from, to]);
    out.settings = true;
  }

  if (parts.nda) {
    const v = (await tx.query<{ name: string; body: string; version_name: string | null }>(
      `select a.name, v.body, v.name as version_name from agreement a join agreement_version v on v.agreement_id = a.id
        where a.workspace_id = $1 and a.kind = 'nda' and v.published_at <= record_clock()
        order by v.published_at desc, v.version_no desc limit 1`, [from])).rows[0];
    if (v) {
      const agreement = (await tx.query<{ id: string }>(
        `insert into agreement (tenant_id, workspace_id, kind, name) values (current_tenant_id(), $1, 'nda', $2) returning id`, [to, v.name])).rows[0]!.id;
      await tx.query(`insert into agreement_version (tenant_id, agreement_id, version_no, body, name, published_by) values (current_tenant_id(), $1, 1, $2, $3, $4)`,
        [agreement, v.body, v.version_name, a.personId ?? null]);
      await tx.query(`update workspace set requires_nda = $2 where id = $1`, [to, src.requires_nda]);
      out.nda = true;
    }
  }

  if (parts.invitationEmail && src.metadata.invitation !== undefined) {
    meta.invitation = src.metadata.invitation;
    out.invitationEmail = true;
  }
  if (Object.keys(meta).length) await tx.query(`update workspace set metadata = metadata || $2::jsonb where id = $1`, [to, JSON.stringify(meta)]);
  return out;
}

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];
export const LOGO_MAX_BYTES = 256 * 1024;

const TYPE_NAME: Record<LogoType, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/svg+xml': 'SVG' };
const SOURCE: Record<LogoType, LogoSource> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

// SVG rasterised without external loads, scripts inert
export async function checkLogo(variant: 'light' | 'dark', contentType: LogoType, base64: string): Promise<LogoPng> {
  const what = variant === 'light' ? 'The logo' : 'The dark-mode logo';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw badRequest(`${what} is not valid base64.`);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw badRequest(`${what} is empty.`);
  if (bytes.length > LOGO_MAX_BYTES) throw badRequest(`${what} is larger than 256 KB. Use a smaller image.`);
  try {
    return await logoToPng(bytes, SOURCE[contentType]);
  } catch (err) {
    if (err instanceof InvalidLogo && err.message === 'too large') throw badRequest(`${what} is too large. Use an image of at most 4096 by 4096 pixels.`);
    if (err instanceof InvalidLogo) throw badRequest(`${what} is not a valid ${TYPE_NAME[contentType]} file.`);
    throw err;
  }
}

export async function legacyLogoPng(bytes: Buffer, contentType: string): Promise<Buffer | null> {
  const kind = SOURCE[contentType as LogoType];
  if (!kind) return null;
  return logoToPng(bytes, kind).then((logo) => logo.png, () => null);
}

export async function storeLogo(tx: SqlClient, ws: string, variant: 'light' | 'dark', bytes: Buffer): Promise<string> {
  const contentType = 'image/png';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await tx.query(
    `insert into workspace_logo (tenant_id, workspace_id, variant, content_type, bytes, sha256) values (current_tenant_id(), $1, $2, $3, $4, $5)
     on conflict (workspace_id, variant) do update set content_type = excluded.content_type, bytes = excluded.bytes, sha256 = excluded.sha256, created_at = now()`,
    [ws, variant, contentType, bytes, sha256]);
  return sha256;
}
