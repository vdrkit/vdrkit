// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { fromPGlite, migrate, MIGRATIONS_DIR } from '../src/index.js';

let dir: string | undefined;
let lite: PGlite | undefined;
afterEach(async () => {
  await lite?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  lite = undefined; dir = undefined;
});

describe('upgrading notification settings to 0018', () => {
  it('copies documents settings to versions', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vdrkit-0017-'));
    for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < '0018')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    lite = new PGlite({ extensions: { ltree } });
    const db = fromPGlite(lite);
    await migrate(db, dir);

    const one = async (sql: string, params: unknown[] = []) => (await lite!.query<{ id: string }>(sql, params)).rows[0]!.id;
    const t = await one(`insert into tenant (name) values ('Quillmont') returning id`);
    const ws = await one(`insert into workspace (tenant_id, name) values ($1, 'Project Heron') returning id`, [t]);
    const party = await one(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder A', 'bidder') returning id`, [t, ws]);
    const g = await one(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder A') returning id`, [t, ws, party]);
    const p = await one(`insert into person (tenant_id, name, email) values ($1, 'Jan', 'jan@bidder-a.example') returning id`, [t]);
    await lite.query(
      `insert into notification_policy (tenant_id, workspace_id, scope, group_id, person_id, category, mode, mandatory, allowed_modes, digest_times) values
        ($1, $2, 'workspace', null, null, 'documents', 'immediate', true, '{immediate,bundled}', null),
        ($1, $2, 'group', $3, null, 'documents', 'bundled', false, null, null),
        ($1, $2, 'user', null, $4, 'documents', 'off', false, null, '{07:30}'),
        ($1, $2, 'workspace', null, null, 'deadlines', 'digest', false, null, null)`, [t, ws, g, p]);

    expect(await migrate(db)).toEqual(expect.arrayContaining(['0018_notifications_rooms.sql']));
    const rows = (await lite.query<any>(
      `select scope, category, enabled, mode, mandatory, allowed_modes, digest_times from notification_policy
        where category in ('documents', 'versions') order by category, scope`)).rows;
    const documents = rows.filter((r) => r.category === 'documents').map(({ category, ...r }) => r);
    const versions = rows.filter((r) => r.category === 'versions').map(({ category, ...r }) => r);
    expect(versions).toEqual(documents);
    expect(versions).toEqual([
      { scope: 'group', enabled: null, mode: 'bundled', mandatory: false, allowed_modes: null, digest_times: null },
      { scope: 'user', enabled: false, mode: null, mandatory: false, allowed_modes: null, digest_times: ['07:30'] },
      { scope: 'workspace', enabled: null, mode: 'immediate', mandatory: true, allowed_modes: ['immediate', 'bundled'], digest_times: null },
    ]);
    expect((await lite.query(`select 1 from notification_policy where category = 'deadlines'`)).rows).toHaveLength(1);
  });
});
