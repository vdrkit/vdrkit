// SPDX-License-Identifier: AGPL-3.0-only
import { partsIn, zonedToUtc, type SqlClient } from '@vdrkit/core';
import { EVENT_PERSON } from './activity-log.js';

export async function roomZone(tx: SqlClient, ws: string): Promise<string> {
  return (await tx.query<{ tz: string }>(`select coalesce((select time_zone from workspace where id = $1), 'UTC') as tz`, [ws])).rows[0]!.tz;
}

export function dayStart(now: Date, tz: string, daysBack: number): Date {
  const p = partsIn(now, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - daysBack));
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, tz);
}

// oldest first, ending today
export function lastSevenDays(now: Date, tz: string): Date[] {
  return Array.from({ length: 7 }, (_, i) => dayStart(now, tz, 6 - i));
}

export function weekStart(now: Date, tz: string): Date {
  const p = partsIn(now, tz);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();   // 0 is Sunday
  return dayStart(now, tz, (weekday + 6) % 7);
}

// group id -> person ids
export async function currentMembers(tx: SqlClient, groupIds: string[], now: Date): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(groupIds.map((g) => [g, new Set<string>()]));
  if (!groupIds.length) return out;
  const { rows } = await tx.query<{ group_id: string; person_id: string }>(
    `select distinct m.group_id, m.person_id from membership m
      where m.group_id = any($1::uuid[]) and m.superseded_at = 'infinity' and m.status in ('active', 'approved')
        and m.valid_from <= $2 and $2 < m.valid_to and not coalesce((m.metadata ->> 'revoked')::boolean, false)`,
    [groupIds, now.toISOString()]);
  for (const r of rows) out.get(r.group_id)!.add(r.person_id);
  return out;
}

export interface Reading { person_id: string; node_id: string; at: Date; pages: number }
export interface Download { person_id: string; node_id: string; at: Date }

// documents opened in [from, to]
export async function readingBetween(tx: SqlClient, ws: string, from: Date, to: Date): Promise<Reading[]> {
  return (await tx.query<{ person_id: string; node_id: string; opened_at: string | Date; pages: number }>(
    `select v.person_id, v.node_id, v.opened_at, cardinality(v.pages_seen) as pages from view_session v
      where v.workspace_id = $1 and v.opened_at >= $2 and v.opened_at <= $3`, [ws, from.toISOString(), to.toISOString()])).rows
    .map((r) => ({ person_id: r.person_id, node_id: r.node_id, at: new Date(r.opened_at), pages: Number(r.pages) }));
}

// documents downloaded in [from, to]
export async function downloadsBetween(tx: SqlClient, ws: string, from: Date, to: Date): Promise<Download[]> {
  return (await tx.query<{ person_id: string | null; node_id: string; occurred_at: string | Date }>(
    `select pe.id as person_id, e.resource_id as node_id, e.occurred_at from event e
       left join principal pr on pr.id = e.actor_id
       left join person pe on pe.id = coalesce(pr.person_id, pr.on_behalf_of_person_id, ${EVENT_PERSON})
      where e.workspace_id = $1 and e.action = 'document.downloaded' and e.occurred_at >= $2 and e.occurred_at <= $3`,
    [ws, from.toISOString(), to.toISOString()])).rows
    .filter((r) => r.person_id)
    .map((r) => ({ person_id: r.person_id!, node_id: r.node_id, at: new Date(r.occurred_at) }));
}

// members who opened or downloaded anything in [from, to)
export function activeIn(people: Set<string>, reading: Reading[], downloads: Download[], from: Date, to: Date): Set<string> {
  const out = new Set<string>();
  const inside = (t: Date) => t >= from && t < to;
  for (const r of reading) if (people.has(r.person_id) && inside(r.at)) out.add(r.person_id);
  for (const d of downloads) if (people.has(d.person_id) && inside(d.at)) out.add(d.person_id);
  return out;
}
