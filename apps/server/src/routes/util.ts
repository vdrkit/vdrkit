// SPDX-License-Identifier: AGPL-3.0-only
import { appendEvent, type SqlClient } from '@vdrkit/core';
import { z } from 'zod';
import type { Caller } from '../auth.js';
import { forbidden, HttpProblem, notFound } from '../problems.js';

export function personOf(caller: Caller): string {
  const p = caller.principal;
  return p.kind === 'person' ? p.personId : p.onBehalfOfPersonId;
}

// Every access check goes through here, or agents get the person's full rights
export function capAccess<T extends { level: number; canUpload: boolean; canManage: boolean; canPublish: boolean }>(caller: Caller, a: T): T {
  if (caller.principal.kind !== 'agent') return a;
  return { ...a, level: Math.min(a.level, caller.principal.maxLevel), canUpload: false, canManage: false, canPublish: false };
}

export async function requireWorkspaceAdmin(tx: SqlClient, caller: Caller, workspaceId: string, at: Date): Promise<void> {
  if (caller.principal.kind === 'agent') throw forbidden('Agents cannot administer a room.', 'agent_needs_approval');
  const { rows } = await tx.query<{ ok: boolean }>('select is_workspace_admin($1, $2, $3) as ok', [personOf(caller), workspaceId, at.toISOString()]);
  if (!rows[0]?.ok) throw forbidden('Only room admins can do this.', 'not_room_admin');
}

export async function requireActivityReader(tx: SqlClient, caller: Caller, workspaceId: string, at: Date): Promise<'admin' | 'observer'> {
  if (caller.principal.kind === 'agent') throw forbidden('Agents cannot read the activity log.', 'agent_needs_approval');
  const { rows } = await tx.query<{ role: 'admin' | 'observer' | null }>('select activity_reader($1, $2, $3) as role', [personOf(caller), workspaceId, at.toISOString()]);
  const role = rows[0]?.role;
  if (!role) throw forbidden('Only room admins and seller observers can read the activity log.', 'not_activity_reader');
  // observers follow the room's state, as when they read the documents
  if (role === 'observer') await requireMember(tx, caller, workspaceId, at);
  return role;
}

export async function isWorkspaceAdmin(tx: SqlClient, personId: string, workspaceId: string, at: Date): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>('select is_workspace_admin($1, $2, $3) as ok', [personId, workspaceId, at.toISOString()]);
  return !!rows[0]?.ok;
}

// same 404 and same work for missing, deleted and foreign rooms
export async function requireRoom(tx: SqlClient, caller: Caller, workspaceId: string, at: Date): Promise<void> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `select exists (
       select 1 from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
        where m.person_id = $1 and g.workspace_id = $2 and m.status = 'active'
          and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= $3 and $3 < m.superseded_at
          and g.valid_from <= $3 and $3 < g.valid_to and w.state <> 'deleted') as ok`,
    [personOf(caller), workspaceId, at.toISOString()],
  );
  if (!rows[0]?.ok) throw notFound();
}

export interface MemberInfo {
  groupIds: string[];
  groupAndParentIds: string[];
  partyKinds: string[];
  roles: string[];
  leadGroupIds: string[];
  isAdmin: boolean;
}

export async function requireMember(tx: SqlClient, caller: Caller, workspaceId: string, at: Date, opts: { beforeNda?: boolean } = {}): Promise<MemberInfo> {
  const { rows } = await tx.query<{ group_id: string; parent_group_id: string | null; kind: string; role: string }>(
    `select g.id as group_id, g.parent_group_id, pa.kind, m.role
       from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
      where m.person_id = $1 and g.workspace_id = $2 and m.status = 'active'
        and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= $3 and $3 < m.superseded_at
        and g.valid_from <= $3 and $3 < g.valid_to`,
    [personOf(caller), workspaceId, at.toISOString()],
  );
  if (rows.length === 0) throw notFound();
  const room = (await tx.query<{ deleted: boolean; state: string; requires_nda: boolean }>(
    `select state = 'deleted' as deleted, workspace_state_at(id, $2, record_clock()) as state, requires_nda from workspace where id = $1`,
    [workspaceId, at.toISOString()])).rows[0];
  if (!room || room.deleted) throw notFound();
  const seller = rows.some((r) => r.kind === 'seller');
  const isAdmin = caller.principal.kind !== 'agent' && (await isWorkspaceAdmin(tx, personOf(caller), workspaceId, at));
  // room state and NDA gates must match effective_level()
  if (room.state === 'preparing' && !seller) {
    throw forbidden('This room is not open yet. The room admin emails you when it opens.', 'room_preparing');
  }
  if ((room.state === 'closed' || room.state === 'archived') && !isAdmin) {
    throw forbidden('This room is closed. Only room admins can enter it.', 'room_closed');
  }
  // db-stamped: compare with record_clock(), not request time
  if (room.requires_nda && !opts.beforeNda && !seller) {
    const ok = (await tx.query<{ ok: boolean }>(`select nda_accepted($1, $2, record_clock()) as ok`, [personOf(caller), workspaceId])).rows[0]?.ok;
    if (!ok) throw forbidden('Accept the current NDA of this room first.', 'nda_not_accepted');
  }
  const withParents = new Set<string>();
  const leads = new Set<string>();
  for (const r of rows) {
    withParents.add(r.group_id);
    if (r.parent_group_id) withParents.add(r.parent_group_id);
    if (r.role === 'lead' && r.kind !== 'seller' && !r.parent_group_id) leads.add(r.group_id);
  }
  return {
    groupIds: rows.map((r) => r.group_id),
    groupAndParentIds: [...withParents],
    partyKinds: [...new Set(rows.map((r) => r.kind))],
    roles: [...new Set(rows.map((r) => r.role))],
    leadGroupIds: [...leads],
    isAdmin,
  };
}

export type BlockedReason = 'no_access' | 'version_hidden' | 'withdrawn' | 'draft';

export interface BlockedAttempt {
  workspaceId: string;
  nodeId: string;
  route: string;
  versionHidden?: boolean;
}

export class BlockedLink extends HttpProblem {
  constructor(readonly attempt: BlockedAttempt) {
    super(notFound().problem);
  }
}

export const blockedLink = (attempt: BlockedAttempt) => new BlockedLink(attempt);

const SEEN_ACTIONS = ['document.opened', 'document.viewed', 'document.downloaded', 'document.printed'];

export const BLOCKED_THROTTLE_MINUTES = 10;

// Members and existing nodes only, so the log is no oracle and can't be flooded
export async function recordBlockedLink(
  tx: SqlClient, caller: Caller, a: BlockedAttempt, req: { id: string; ip: string; headers: Record<string, unknown> },
): Promise<boolean> {
  const person = personOf(caller);
  const agentId = caller.principal.kind === 'agent' ? caller.principal.principalId : null;
  // lock, or concurrent refusals all pass the throttle
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`access.blocked:${person}:${agentId ?? ''}:${a.nodeId}`]);
  const { rows } = await tx.query<{ withdrawn: boolean; draft: boolean; member: boolean; recent: boolean; seen: boolean }>(
    `select exists (select 1 from node x where x.path @> n.path and x.state = 'withdrawn') as withdrawn,
            exists (select 1 from node x where x.path @> n.path and x.state = 'draft') as draft,
            exists (select 1 from membership m join groups g on g.id = m.group_id
                     where m.person_id = $3 and g.workspace_id = n.workspace_id) as member,
            exists (select 1 from event e
                     where e.workspace_id = n.workspace_id and e.resource_id = n.id and e.action = 'access.blocked'
                       and e.data ->> 'personId' = $3::uuid::text and coalesce(e.data ->> 'agentId', '') = $4
                       and e.occurred_at > record_clock() - make_interval(mins => $5)) as recent,
            exists (select 1 from view_session s where s.node_id = n.id and s.person_id = $3)
              or exists (select 1 from event e
                          where e.workspace_id = n.workspace_id and e.resource_id = n.id and e.action = any($6::text[])
                            and (e.data ->> 'person_id' = $3::uuid::text or exists (
                                   select 1 from principal p where p.id = e.actor_id and (p.person_id = $3 or p.on_behalf_of_person_id = $3)))) as seen
       from node n where n.id = $1 and n.workspace_id = $2 and n.deleted_at is null`,
    [a.nodeId, a.workspaceId, person, agentId ?? '', BLOCKED_THROTTLE_MINUTES, SEEN_ACTIONS],
  );
  const r = rows[0];
  if (!r || !r.member || r.recent) return false;
  let reason: BlockedReason = 'no_access';
  if (a.versionHidden) reason = 'version_hidden';
  else if (r.withdrawn) reason = 'withdrawn';
  else if (r.draft) reason = 'draft';
  await appendEvent(tx, {
    action: 'access.blocked', workspaceId: a.workspaceId, actorId: caller.actorId,
    onBehalfOfId: agentId ? person : null,
    resourceType: 'node', resourceId: a.nodeId,
    data: { nodeId: a.nodeId, route: a.route, reason, previouslySeen: r.seen, personId: person, ...(agentId ? { agentId } : {}) },
    requestId: req.id,
    context: { ip: req.ip, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null },
  });
  return true;
}

export async function recordBlockedLinkInline(
  tx: SqlClient, caller: Caller, a: BlockedAttempt, req: { id: string; ip: string; headers: Record<string, unknown>; log: { error(o: unknown): void } },
): Promise<void> {
  await tx.query('savepoint blocked_link');
  try {
    await recordBlockedLink(tx, caller, a, req);
    await tx.query('release savepoint blocked_link');
  } catch (err) {
    await tx.query('rollback to savepoint blocked_link');
    req.log.error(err);
  }
}

export const roomFrozenForUploading = () => new HttpProblem({ type: 'https://vdrkit.com/problems/room-frozen', title: 'Room frozen', status: 409,
  detail: 'The room is frozen. Nobody can upload until a room admin opens it again in Room settings.', reason: 'room_frozen' });
export const roomArchived = () => new HttpProblem({ type: 'https://vdrkit.com/problems/room-archived', title: 'Room archived', status: 409,
  detail: 'This room is archived and can no longer be changed.', reason: 'room_archived' });

// 'update' if the route then updates the room row, or two share holders deadlock
async function lockedState(tx: SqlClient, workspaceId: string, lock: 'share' | 'update'): Promise<string | undefined> {
  return (await tx.query<{ state: string }>(
    `select state from workspace where id = $1 ${lock === 'update' ? 'for no key update' : 'for share'}`, [workspaceId])).rows[0]?.state;
}

// Call after the rights check. `for share` makes a freeze wait for changes in flight
export async function refuseIfFrozen(tx: SqlClient, workspaceId: string, lock: 'share' | 'update' = 'share'): Promise<void> {
  const state = await lockedState(tx, workspaceId, lock);
  if (state === 'archived') throw roomArchived();
  if (state === 'frozen') {
    throw new HttpProblem({ type: 'https://vdrkit.com/problems/room-frozen', title: 'Room frozen', status: 409,
      detail: 'The room is frozen. Unfreeze it in Room settings to change the index.', reason: 'room_frozen' });
  }
}

// One at a time per room for whatever numbers or withdraws: each reads the index, then writes by what it read
export async function lockIndex(tx: SqlClient, workspaceId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`index:${workspaceId}`]);
}

export async function refuseIfArchived(tx: SqlClient, workspaceId: string, lock: 'share' | 'update' = 'share'): Promise<void> {
  if (await lockedState(tx, workspaceId, lock) === 'archived') throw roomArchived();
}

// node id -> previous number. Only for nodes already listed to the person
export async function renumberedTags(tx: SqlClient, personId: string, workspaceId: string): Promise<Map<string, string>> {
  const { rows } = await tx.query<{ node_id: string; from_number: string }>(
    `select node_id, from_number from renumbered_tags($1, $2)`, [personId, workspaceId]);
  return new Map(rows.map((r) => [r.node_id, r.from_number]));
}

export async function renumberedTagDays(tx: SqlClient, workspaceId: string): Promise<number> {
  const { rows } = await tx.query<{ d: number }>(`select renumbered_tag_days as d from workspace where id = $1`, [workspaceId]);
  return Number(rows[0]?.d ?? 3);
}

// actorId is empty for people until here
export async function withActor(tx: SqlClient, caller: Caller): Promise<Caller> {
  if (caller.actorId || caller.principal.kind !== 'person' || caller.seeAs) return caller;
  const person = caller.principal.personId;
  const found = (await tx.query<{ id: string }>(
    `select id from principal where kind = 'person' and person_id = $1 and revoked_at is null order by created_at limit 1`, [person])).rows[0];
  if (found) return { ...caller, actorId: found.id };
  const made = (await tx.query<{ id: string }>(
    `insert into principal (tenant_id, kind, person_id, name) select current_tenant_id(), 'person', id, name from person where id = $1 returning id`,
    [person])).rows[0];
  return made ? { ...caller, actorId: made.id } : caller;
}

// control characters and bidi/zero-width marks
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
export const HIDDEN_CHARACTERS_MESSAGE = 'Names may not contain control characters or invisible formatting characters. Type the name again.';
export const NAME_MAX = 255;
export const hasHiddenCharacters = (s: string) => HIDDEN_CHARACTERS.test(s);
export const NodeName = z.string().trim().min(1).max(NAME_MAX).refine((s) => !hasHiddenCharacters(s), HIDDEN_CHARACTERS_MESSAGE);
export const visibleText = (s: z.ZodString) => s.refine((v) => !hasHiddenCharacters(v), HIDDEN_CHARACTERS_MESSAGE);
