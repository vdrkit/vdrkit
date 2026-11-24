// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './db.js';

export const Level = {
  None: 0,
  Fence: 10,
  View: 20,
  EncryptedPdf: 30,
  Print: 40,
  Pdf: 50,
  Original: 60,
} as const;
export type LevelValue = (typeof Level)[keyof typeof Level];

export type Action =
  | 'see_name'
  | 'view'
  | 'download_encrypted_pdf'
  | 'print'
  | 'download_pdf'
  | 'download_original'
  | 'upload'
  | 'manage'
  | 'publish';

export const ACTION_MIN_LEVEL: Record<Exclude<Action, 'upload' | 'manage' | 'publish'>, LevelValue> = {
  see_name: Level.Fence,
  view: Level.View,
  download_encrypted_pdf: Level.EncryptedPdf,
  print: Level.Print,
  download_pdf: Level.Pdf,
  download_original: Level.Original,
};

export type Principal =
  | { kind: 'person'; personId: string }
  | { kind: 'agent'; principalId: string; onBehalfOfPersonId: string; maxLevel: LevelValue }
  | { kind: 'service'; principalId: string; onBehalfOfPersonId: string };

export interface Access {
  level: number;
  canUpload: boolean;
  canManage: boolean;
  canPublish: boolean;
  reason: string;
}

export interface Decision extends Access {
  allowed: boolean;
}

export const DATABASE_TIME = 'database' as const;

export interface When {
  at?: Date;
  // default: `at` when given, else the database clock (record times use it; an app clock may lag)
  knownAt?: Date | typeof DATABASE_TIME;
}

export function present(at: Date): When {
  return { at, knownAt: DATABASE_TIME };
}

function timeParams(when: When): [string, string | null, boolean] {
  const known = when.knownAt ?? (when.at ? undefined : DATABASE_TIME);
  const at = (when.at ?? new Date()).toISOString();
  const knownAt = known instanceof Date ? known.toISOString() : null;
  return [at, knownAt, known === DATABASE_TIME];
}

const knownSql = (ts: number, flag: number) => `coalesce($${ts}::timestamptz, case when $${flag}::boolean then record_clock() end)`;

function personOf(p: Principal): string {
  return p.kind === 'person' ? p.personId : p.onBehalfOfPersonId;
}

export async function effectiveAccess(tx: SqlClient, personId: string, nodeId: string, when: When = {}): Promise<Access> {
  const { rows } = await tx.query<{ level: number; can_upload: boolean; can_manage: boolean; can_publish: boolean; reason: string }>(
    `select level, can_upload, can_manage, can_publish, reason from effective_level($1, $2, $3, ${knownSql(4, 5)})`,
    [personId, nodeId, ...timeParams(when)],
  );
  const r = rows[0];
  if (!r) return { level: 0, canUpload: false, canManage: false, canPublish: false, reason: 'no_result' };
  return { level: Number(r.level), canUpload: r.can_upload, canManage: r.can_manage, canPublish: r.can_publish, reason: r.reason };
}

// listings must use accessibleNodes(): same database rule
export async function can(
  tx: SqlClient,
  principal: Principal,
  action: Action,
  nodeId: string,
  when: When = {},
): Promise<Decision> {
  const access = await effectiveAccess(tx, personOf(principal), nodeId, when);

  if (principal.kind === 'agent') {
    access.level = Math.min(access.level, principal.maxLevel);
    if (action === 'upload' || action === 'manage' || action === 'publish') {
      // agents: approval required
      return { ...access, canUpload: false, canManage: false, canPublish: false, allowed: false, reason: 'agent_needs_approval' };
    }
  }

  let allowed: boolean;
  if (action === 'upload') allowed = access.canUpload;
  else if (action === 'manage') allowed = access.canManage;
  else if (action === 'publish') allowed = access.canPublish;
  else if (action === 'see_name') {
    allowed = access.level >= ACTION_MIN_LEVEL.see_name || access.canUpload || access.canManage || access.canPublish;
  }
  else allowed = access.level >= ACTION_MIN_LEVEL[action];

  return { ...access, allowed };
}

export async function accessibleNodes(
  tx: SqlClient,
  personId: string,
  workspaceId: string,
  when: When = {},
): Promise<Map<string, Omit<Access, 'reason'>>> {
  const { rows } = await tx.query<{ node_id: string; level: number; can_upload: boolean; can_manage: boolean; can_publish: boolean }>(
    `select node_id, level, can_upload, can_manage, can_publish from accessible_nodes($1, $2, $3, ${knownSql(4, 5)})`,
    [personId, workspaceId, ...timeParams(when)],
  );
  return new Map(rows.map((r) => [r.node_id, {
    level: Number(r.level), canUpload: r.can_upload, canManage: r.can_manage, canPublish: r.can_publish,
  }]));
}

export interface VersionAccess {
  versionId: string | null;
  /** treat as missing */
  hidden: boolean;
}

export async function versionAccess(tx: SqlClient, principal: Principal, nodeId: string, when: When = {}): Promise<VersionAccess> {
  const [at, knownAt, databaseTime] = timeParams(when);
  const { rows } = await tx.query<{ v: string | null; any: boolean }>(
    `select visible_version($1, $2, $3, ${knownSql(4, 6)}, $5) as v, exists (select 1 from document_version where node_id = $2) as any`,
    [personOf(principal), nodeId, at, knownAt, principal.kind === 'agent', databaseTime],
  );
  const v = rows[0]?.v ?? null;
  return { versionId: v, hidden: v === null && !!rows[0]?.any };
}

export async function canSeeVersion(tx: SqlClient, principal: Principal, versionId: string, when: When = {}): Promise<boolean> {
  const [at, knownAt, databaseTime] = timeParams(when);
  const { rows } = await tx.query<{ ok: boolean }>(
    `select can_see_version($1, $2, $3, ${knownSql(4, 6)}, $5) as ok`,
    [personOf(principal), versionId, at, knownAt, principal.kind === 'agent', databaseTime],
  );
  return !!rows[0]?.ok;
}
