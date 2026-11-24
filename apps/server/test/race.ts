// SPDX-License-Identifier: AGPL-3.0-only
import pg from 'pg';
import { TEST_DATABASE_URL, type Heron } from '../../../packages/core/test/fixture.js';

export const CAN_RACE = !!TEST_DATABASE_URL;

const WAIT_MS = 10_000;

// Don't use h.pg inside `start`.
export async function together<T>(h: Heron, start: () => Promise<T>[]): Promise<T[]> {
  if (!TEST_DATABASE_URL) throw new Error('together() needs TEST_DATABASE_URL: PGlite cannot run two requests at once');
  const { rows: [{ db }] } = await h.pg.query<{ db: string }>(`select current_database() as db`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${db}`;
  const holder = new pg.Client({ connectionString: url.toString() });
  await holder.connect();
  try {
    await holder.query(`begin`);
    await holder.query(`insert into event_counter (tenant_id) values ($1) on conflict do nothing`, [h.t1]);
    await holder.query(`select 1 from event_counter where tenant_id = $1 for update`, [h.t1]);
    const { rows: [{ pid }] } = await holder.query<{ pid: number }>(`select pg_backend_pid() as pid`);

    const running = start();
    const all = Promise.all(running);
    all.catch(() => undefined);
    let settled = 0;
    for (const p of running) p.then(() => { settled++; }, () => { settled++; });

    // or wait for a pool connection
    const queued = () => h.appPool?.waitingCount ?? 0;
    let waiting = 0;
    const until = Date.now() + WAIT_MS;
    for (;;) {
      const r = await h.pg.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = $1 and pid <> $2 and pid <> pg_backend_pid() and wait_event_type = 'Lock'`, [db, pid]);
      waiting = r.rows[0]!.n;
      if (waiting + queued() >= running.length || settled > 0 || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const overlapped = waiting + queued() >= running.length && settled === 0;
    await holder.query(overlapped ? `commit` : `rollback`);
    const out = await Promise.allSettled(running);
    if (!overlapped) {
      throw new Error(`The requests did not overlap: ${waiting} of ${running.length} waited on a lock, ${settled} finished while the log was held`
        + ` (${out.map((o) => (o.status === 'fulfilled' ? String((o.value as { statusCode?: number })?.statusCode ?? 'done') : 'failed')).join(', ')})`);
    }
    return await all;
  } finally {
    await holder.query(`rollback`).catch(() => undefined);
    await holder.end();
  }
}
