// SPDX-License-Identifier: AGPL-3.0-only
// Postgres only: PGlite migrates as superuser, which skips row-level security.
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { fromPgPool, migrate, MIGRATIONS_DIR } from '../src/index.js';
import { emptyOwnerDatabase, TEST_DATABASE_URL } from './real-postgres.js';

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

describe.skipIf(!TEST_DATABASE_URL)('upgrading a database that holds data', () => {
  it('backfills as the owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vdrkit-0014-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < '0015')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    const made = await emptyOwnerDatabase();
    cleanup.push(() => made.drop());
    const owner = new pg.Pool({ connectionString: made.url.owner, max: 2 });
    const su = new pg.Pool({ connectionString: made.url.superuser, max: 1 });
    cleanup.push(() => Promise.all([owner.end(), su.end()]));
    const db = fromPgPool(owner);
    await migrate(db, dir);

    const one = async (sql: string, params: unknown[] = []) => (await su.query<{ id: string }>(sql, params)).rows[0]!.id;
    const t = await one(`insert into tenant (name) values ('Quillmont') returning id`);
    const ws = await one(`insert into workspace (tenant_id, name) values ($1, 'Project Heron') returning id`, [t]);
    const party = await one(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder A', 'bidder') returning id`, [t, ws]);
    const g = await one(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder A') returning id`, [t, ws, party]);
    const jan = await one(`insert into person (tenant_id, name, email) values ($1, 'Jan', 'jan@bidder-a.example') returning id`, [t]);
    const m = await one(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3) returning id`, [t, jan, g]);
    await su.query(
      `insert into approval (tenant_id, workspace_id, kind, requested_by, group_id, payload, created_at) values
        ($1, $2, 'colleague_request', $3, $4, '{"email": "Maria@bidder-a.example"}', '2026-03-01T09:00:00Z'),
        ($1, $2, 'colleague_request', $3, $4, '{"email": "maria@bidder-a.example"}', '2026-03-02T09:00:00Z')`, [t, ws, jan, g]);
    await su.query(
      `insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, mode, mandatory, digest_times)
       values ($1, $2, 'user', $3, 'documents', 'off', false, '{07:30}')`, [t, ws, jan]);
    await su.query(
      `insert into milestone (tenant_id, workspace_id, title, due_at, created_at) values ($1, $2, 'Binding offers', '2026-06-30T15:00:00Z', '2026-03-03T09:00:00Z')`, [t, ws]);
    await su.query(
      `insert into invitation (tenant_id, workspace_id, group_id, person_id, membership_id, token_sha256, expires_at, created_at)
       values ($1, $2, $3, $4, $5, repeat('a', 64), '2026-03-18T09:00:00Z', '2026-03-04T09:00:00Z')`, [t, ws, g, jan, m]);

    const applied = await migrate(db);
    expect(applied).toEqual(expect.arrayContaining(['0015_people_rooms.sql', '0018_notifications_rooms.sql', '0180_notification_sending.sql', '0310_invitation_hold.sql']));

    const rows = async (sql: string) => (await su.query(sql)).rows;
    expect(await rows(`select status from approval order by created_at`)).toEqual([{ status: 'pending' }, { status: 'withdrawn' }]);
    expect(await rows(`select enabled, mode from notification_policy where category = 'documents'`)).toEqual([{ enabled: false, mode: null }]);
    expect(await rows(`select enabled, mode from notification_policy where category = 'versions'`)).toEqual([{ enabled: false, mode: null }]);
    expect(await rows(`select due_set_at = created_at as same from milestone`)).toEqual([{ same: true }]);
    expect(await rows(`select sent_at = created_at as same from invitation`)).toEqual([{ same: true }]);

    const forced = await rows(
      `select relname from pg_class where relname in ('approval', 'notification_policy', 'milestone', 'invitation') and relforcerowsecurity order by relname`);
    expect(forced.map((r) => r.relname)).toEqual(['approval', 'invitation', 'milestone', 'notification_policy']);
  });
});
