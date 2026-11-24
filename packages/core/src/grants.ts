// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './db.js';
import { appendEvent } from './events.js';
import type { LevelValue } from './permissions.js';

export type Subject = { groupId: string } | { personId: string };

export interface GrantInput {
  workspaceId: string;
  nodeId: string;
  subject: Subject;
  effect?: 'allow' | 'deny';
  level?: LevelValue;
  canUpload?: boolean;
  canManage?: boolean;
  canPublish?: boolean;
  validFrom?: Date | null;
  validTo?: Date | null;
  actorId?: string | null;
  onBehalfOfId?: string | null;
  requestId?: string | null;
  /** ignored, database clock */
  now?: Date;
  audit?: boolean;
}

interface GrantRow {
  id: string;
  level: number;
  can_upload: boolean;
  can_manage: boolean;
  can_publish: boolean;
  effect: string;
  valid_from: string;
  valid_to: string;
}

function subjectCols(s: Subject): [string | null, string | null] {
  return 'groupId' in s ? [s.groupId, null] : [null, s.personId];
}

function summary(g: GrantRow | undefined) {
  if (!g) return null;
  return {
    grant_id: g.id, effect: g.effect, level: Number(g.level),
    can_upload: g.can_upload, can_manage: g.can_manage, can_publish: g.can_publish,
  };
}

async function supersede(tx: SqlClient, nodeId: string, s: Subject, effect: string, now: Date): Promise<GrantRow | undefined> {
  const [groupId, personId] = subjectCols(s);
  // serialise saves of one cell, else the unique index fails the second
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`grant:${nodeId}:${groupId ?? personId}:${effect}`]);
  const { rows } = await tx.query<GrantRow>(
    `update access_grant set superseded_at = $5
      where node_id = $1 and subject_group_id is not distinct from $2 and subject_person_id is not distinct from $3
        and effect = $4 and superseded_at = 'infinity'
      returning id, level, can_upload, can_manage, can_publish, effect, valid_from, valid_to`,
    [nodeId, groupId, personId, effect, now.toISOString()],
  );
  return rows[0];
}

export async function setGrant(tx: SqlClient, g: GrantInput): Promise<string> {
  const now = g.now ?? new Date();
  const effect = g.effect ?? 'allow';
  const before = await supersede(tx, g.nodeId, g.subject, effect, now);
  const [groupId, personId] = subjectCols(g.subject);
  const validFrom = g.validFrom?.toISOString() ?? null;
  const validTo = g.validTo?.toISOString() ?? null;
  const { rows } = await tx.query<GrantRow>(
    `insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, subject_person_id, effect, level,
        can_upload, can_manage, can_publish, valid_from, valid_to, recorded_at, recorded_by)
     values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
        coalesce($10::timestamptz, '-infinity'), coalesce($11::timestamptz, 'infinity'), $12, $13)
     returning id, level, can_upload, can_manage, can_publish, effect, valid_from, valid_to`,
    [
      g.workspaceId, g.nodeId, groupId, personId, effect, effect === 'deny' ? 0 : (g.level ?? 0),
      g.canUpload ?? false, g.canManage ?? false, g.canPublish ?? false,
      validFrom, validTo,
      now.toISOString(), g.actorId ?? null,
    ],
  );
  const after = rows[0];
  if (!after) throw new Error('Grant insert returned nothing');
  if (g.audit === false) return after.id;
  await appendEvent(tx, {
    action: 'grant.changed',
    workspaceId: g.workspaceId,
    actorId: g.actorId,
    onBehalfOfId: g.onBehalfOfId,
    resourceType: 'node',
    resourceId: g.nodeId,
    data: {
      subject_group_id: groupId,
      subject_person_id: personId,
      before: summary(before),
      after: { ...summary(after), valid_from: validFrom, valid_to: validTo },
    },
    requestId: g.requestId,
    occurredAt: now,
  });
  return after.id;
}

export async function resetGrant(
  tx: SqlClient,
  g: Pick<GrantInput, 'workspaceId' | 'nodeId' | 'subject' | 'effect' | 'actorId' | 'onBehalfOfId' | 'requestId' | 'now' | 'audit'>,
): Promise<boolean> {
  const now = g.now ?? new Date();
  const before = await supersede(tx, g.nodeId, g.subject, g.effect ?? 'allow', now);
  if (!before) return false;
  if (g.audit === false) return true;
  const [groupId, personId] = subjectCols(g.subject);
  await appendEvent(tx, {
    action: 'grant.reset',
    workspaceId: g.workspaceId,
    actorId: g.actorId,
    onBehalfOfId: g.onBehalfOfId,
    resourceType: 'node',
    resourceId: g.nodeId,
    data: { subject_group_id: groupId, subject_person_id: personId, before: summary(before), after: null },
    requestId: g.requestId,
    occurredAt: now,
  });
  return true;
}
