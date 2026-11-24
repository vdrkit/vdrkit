// SPDX-License-Identifier: AGPL-3.0-only
// "See as": a room admin views the room as one team, read only.
// Runs as a stand-in team member inside a transaction that always rolls back.
import type { FastifyRequest } from 'fastify';
import { appendEvent, type SqlClient } from '@vdrkit/core';
import type { Caller } from './auth.js';
import { HttpProblem, notFound } from './problems.js';
import { personOf, requireRoom } from './routes/util.js';

export const SEE_AS_HEADER = 'x-vdrkit-see-as';

export interface SeeAs {
  groupId: string;
  groupName: string;
  side: 'bidders' | 'seller';
  adminPersonId: string;
}

export const SEE_AS_ROUTES = new Set([
  'GET /v1/workspaces/:ws/shell',
  'GET /v1/workspaces/:ws/nda',
  'GET /v1/workspaces/:ws/logo/:variant',
  'GET /v1/workspaces/:ws/dashboard',
  'GET /v1/workspaces/:ws/nodes',
  'GET /v1/workspaces/:ws/nodes/:id',
  'GET /v1/workspaces/:ws/nodes/:id/details',
  'POST /v1/workspaces/:ws/nodes/:id/open',
  'GET /v1/workspaces/:ws/nodes/:id/pages/:page',
  'GET /v1/workspaces/:ws/search',
  'GET /v1/workspaces/:ws/numbers/:number',
  'GET /v1/workspaces/:ws/milestones',
  'GET /v1/workspaces/:ws/my-team',
  'GET /v1/workspaces/:ws/me/notifications',
  'GET /v1/workspaces/:ws/uploads/recent',
  'GET /v1/workspaces/:ws/release-review',
  'GET /v1/workspaces/:ws/events',
  'GET /v1/workspaces/:ws/events/verify',
  'GET /v1/workspaces/:ws/activity/summary',
  'GET /v1/workspaces/:ws/activity/groups/:group/people',
  'POST /v1/workspaces/:ws/release-preview',
]);

// reads despite the method
export const SEE_AS_POST_READS = new Set(['POST /v1/workspaces/:ws/nodes/:id/open', 'POST /v1/workspaces/:ws/release-preview']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestedSeeAs(req: FastifyRequest): string | null | 'invalid' {
  const h = req.headers[SEE_AS_HEADER];
  // raw URL: route schemas drop unknown query params
  const q = req.url.includes('seeAs') ? new URL(req.url, 'http://localhost').searchParams.getAll('seeAs') : [];
  const raw = typeof h === 'string' ? h : Array.isArray(h) ? h[0] : q[0];
  if (raw === undefined) return null;
  if (q.length > 1 || (q.length === 1 && h !== undefined && q[0] !== raw)) return 'invalid';
  return typeof raw === 'string' && UUID.test(raw) ? raw.toLowerCase() : 'invalid';
}

export const seeAsReadOnly = () => new HttpProblem({
  type: 'https://vdrkit.com/problems/see-as-read-only', title: 'Read only', status: 403, reason: 'see_as_read_only',
  detail: 'Nothing can be changed, downloaded or sent while you see the room as a team.',
});

export function seeAsAllowed(method: string, url: string | undefined): boolean {
  return !!url && SEE_AS_ROUTES.has(`${method === 'HEAD' ? 'GET' : method} ${url}`);
}

export async function maySeeAs(tx: SqlClient, caller: Caller, ws: string, groupId: string, at: Date): Promise<boolean> {
  if (caller.principal.kind !== 'person' || !UUID.test(ws)) return false;
  try { await requireRoom(tx, caller, ws, at); } catch { return false; }
  const row = (await tx.query<{ ok: boolean }>(`select exists (select 1 from see_as_teams($1, $2, $3) where group_id = $4) as ok`,
    [personOf(caller), ws, at.toISOString(), groupId])).rows[0];
  return !!row?.ok;
}

export const SEE_AS_LOG_MINUTES = 30;

// needs its own committing transaction
export async function checkAndRecordSeeAs(tx: SqlClient, caller: Caller, ws: string, groupId: string, at: Date,
  req: { id: string; ip: string; headers: Record<string, unknown> }): Promise<void> {
  if (caller.principal.kind !== 'person') throw notFound();
  const person = personOf(caller);
  const team = (await tx.query<{ name: string }>(`select name from see_as_teams($1, $2, $3) where group_id = $4`,
    [person, ws, at.toISOString(), groupId])).rows[0];
  if (!team) throw notFound();
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`room.seen_as:${person}:${groupId}`]);
  const recent = (await tx.query<{ ok: boolean }>(
    `select exists (select 1 from event e where e.workspace_id = $1 and e.action = 'room.seen_as' and e.resource_id = $2
        and e.data ->> 'personId' = $3::uuid::text and e.occurred_at > record_clock() - make_interval(mins => $4)) as ok`,
    [ws, groupId, person, SEE_AS_LOG_MINUTES])).rows[0]?.ok;
  if (recent) return;
  await appendEvent(tx, {
    action: 'room.seen_as', workspaceId: ws, actorId: caller.actorId, resourceType: 'group', resourceId: groupId,
    data: { groupId, personId: person }, requestId: req.id,
    context: { ip: req.ip, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null },
  });
}

export async function seeAsCaller(tx: SqlClient, caller: Caller, ws: string, groupId: string, at: Date): Promise<Caller> {
  if (caller.principal.kind !== 'person') throw notFound();
  const admin = personOf(caller);
  const row = (await tx.query<{ person_id: string; group_name: string; side: 'bidders' | 'seller' }>(
    `select person_id, group_name, side from see_as_begin($1, $2, $3, $4)`, [admin, ws, groupId, at.toISOString()])).rows[0];
  if (!row) throw notFound();
  return {
    tenantId: caller.tenantId,
    principal: { kind: 'person', personId: row.person_id },
    actorId: null,
    ...(caller.login ? { login: caller.login } : {}),
    seeAs: { groupId, groupName: row.group_name, side: row.side, adminPersonId: admin },
  };
}

export class SeeAsRollback<T> {
  constructor(readonly value: T) {}
}
