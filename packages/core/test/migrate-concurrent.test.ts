// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { fromPgPool, migrate } from '../src/index.js';
import { TEST_DATABASE_URL } from './real-postgres.js';

describe.skipIf(!TEST_DATABASE_URL)('migrations started by several instances at once', () => {
  it('should run each migration once', async () => {
    const schema = `vdrkit_mig_${randomBytes(6).toString('hex')}`;
    const dir = await mkdtemp(join(tmpdir(), 'vdrkit-mig-'));
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const pools: pg.Pool[] = [];
    try {
      await admin.query(`create schema ${schema}`);
      // slow enough for the instances to overlap
      await writeFile(join(dir, '0001_a.sql'), `create table counter (n int); select pg_sleep(0.3); insert into counter values (1);`);
      await writeFile(join(dir, '0002_b.sql'), `select pg_sleep(0.3); insert into counter values (2);`);
      for (let i = 0; i < 4; i++) pools.push(new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2, options: `-c search_path=${schema}` }));
      const results = await Promise.all(pools.map((p) => migrate(fromPgPool(p), dir)));
      expect(results.flat().sort()).toEqual(['0001_a.sql', '0002_b.sql']);
      expect((await admin.query(`select n from ${schema}.counter order by n`)).rows).toEqual([{ n: 1 }, { n: 2 }]);
      expect((await admin.query(`select name from ${schema}.schema_migrations order by name`)).rows.map((r) => r.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
