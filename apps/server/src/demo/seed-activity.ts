// SPDX-License-Identifier: AGPL-3.0-only
// audit log can't be back-dated (db clock); earlier days are viewing sessions only
import { appendEvent, withTenant, type Database } from '@vdrkit/core';
import { stableId, type PersonKey } from './seed-demo.js';

const DB_ROLE = { role: 'vdrkit_app' } as const;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const READERS: { key: PersonKey; perDay: number[]; downloads: number }[] = [
  { key: 'jan', perDay: [2, 0, 6, 7, 5, 9, 4], downloads: 3 },
  { key: 'pieter', perDay: [0, 0, 3, 4, 2, 5, 3], downloads: 1 },
  { key: 'mei', perDay: [0, 0, 1, 2, 3, 3, 2], downloads: 0 },
  { key: 'sipho', perDay: [0, 0, 1, 1, 0, 0, 0], downloads: 0 },
  { key: 'lars', perDay: [0, 0, 0, 0, 0, 6, 1], downloads: 0 },
];

export async function seedDevActivity(db: Database, tenantId: string, log: (m: string) => void): Promise<void> {
  if (process.env.VDRKIT_DEV_ACTIVITY === '0') return;
  const ws = stableId(tenantId, 'workspace');
  await withTenant(db, tenantId, async (tx) => {
    const seeded = await tx.query(`select 1 from event where workspace_id = $1 and action = 'demo.activity_seeded' limit 1`, [ws]);
    if (seeded.rows.length) return;
    const now = new Date();
    const random = rng(20261114);
    let sessions = 0;
    let events = 0;
    for (const reader of READERS) {
      const person = stableId(tenantId, `person:${reader.key}`);
      const docs = (await tx.query<{ id: string; version_id: string; pages: number }>(
        `select n.id, v.id as version_id,
                coalesce(nullif((select count(*)::int from derived_file f where f.version_id = v.id and f.kind = 'page_image'), 0),
                         8 + (abs(hashtext(n.id::text)) % 40)) as pages
           from readable_nodes($1, $2, $3, record_clock(), false) a join node n on n.id = a.node_id
           join lateral (select dv.id from document_version dv where dv.node_id = n.id order by dv.version_no desc limit 1) v on true
          where n.kind = 'document' and n.state = 'published' and a.level >= 20
          order by n.path`, [person, ws, now.toISOString()])).rows;
      if (!docs.length) continue;
      for (let day = 0; day < 7; day++) {
        const back = 6 - day;
        for (let i = 0; i < reader.perDay[day]!; i++) {
          const doc = docs[Math.floor(random() * docs.length)]!;
          const opened = back === 0
            ? new Date(now.getTime() - (10 + Math.floor(random() * 240)) * 60_000)
            : new Date(now.getTime() - back * 86_400_000 - Math.floor(random() * 8 * 3_600_000));
          const share = random() < 0.35 ? 1 : 0.2 + random() * 0.8;
          const seen = Array.from({ length: Math.max(1, Math.round(doc.pages * share)) }, (_, k) => k + 1);
          const minutes = Math.max(1, Math.round(seen.length * (0.4 + random())));
          const sessionId = (await tx.query<{ id: string }>(
            `insert into view_session (tenant_id, workspace_id, node_id, version_id, person_id, opened_at, last_seen_at, page_count, pages_seen)
             values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
            [ws, doc.id, doc.version_id, person, opened.toISOString(), new Date(opened.getTime() + minutes * 60_000).toISOString(), doc.pages, seen])).rows[0]!.id;
          sessions++;
          if (back === 0) {
            await appendEvent(tx, { action: 'document.opened', workspaceId: ws, resourceType: 'node', resourceId: doc.id,
              data: { version_id: doc.version_id, page_count: doc.pages, person_id: person, session_id: sessionId } });
            events++;
          }
        }
      }
      for (let i = 0; i < reader.downloads; i++) {
        const doc = docs[Math.floor(random() * docs.length)]!;
        await appendEvent(tx, { action: 'document.downloaded', workspaceId: ws, resourceType: 'node', resourceId: doc.id,
          data: { format: i === 0 ? 'original' : 'pdf', version_id: doc.version_id, person_id: person } });
        events++;
      }
    }
    const hidden = stableId(tenantId, 'node:6.1.1');
    const exists = (await tx.query(`select 1 from node where id = $1`, [hidden])).rows.length;
    if (exists) {
      await appendEvent(tx, { action: 'access.blocked', workspaceId: ws, resourceType: 'node', resourceId: hidden,
        data: { nodeId: hidden, route: 'viewer.open', reason: 'no_access', previouslySeen: false, personId: stableId(tenantId, 'person:mei') } });
      events++;
    }
    await appendEvent(tx, { action: 'demo.activity_seeded', workspaceId: ws, resourceType: 'workspace', resourceId: ws, data: { sessions, events } });
    log(`Seeded a week of reading for F1 Activity: ${sessions} viewing sessions, ${events} log entries.`);
  }, DB_ROLE);
}
