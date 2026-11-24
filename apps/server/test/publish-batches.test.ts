// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { PUBLISH_BATCH } from '../src/routes/documents.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;

beforeEach(async () => {
  h = await heron();
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const publish = (nodeIds: string[]) => app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/publish`,
  headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 }, payload: { nodeIds, quiet: true } });

async function drafts(n: number): Promise<string[]> {
  const { rows } = await h.pg.query<{ id: string }>(
    `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
     select $1, $2, $3, 'document', 'Board pack ' || i || '.pdf', '3.2.' || (100 + i), 'draft' from generate_series(1, $4::int) i returning id`,
    [h.t1, h.ws, h.node.aud, n]);
  return rows.map((r) => r.id);
}
const states = async (ids: string[]) => (await h.pg.query<{ state: string; n: number }>(
  `select state, count(*)::int as n from node where id = any($1::uuid[]) group by state order by state`, [ids])).rows;

describe('large publish', () => {
  it('should commit in batches', async () => {
    const ids = await drafts(2 * PUBLISH_BATCH + 20);
    const res = await publish(ids);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ published: ids.length, versionsReleased: 0 });
    expect(await states(ids)).toEqual([{ state: 'published', n: ids.length }]);
    expect((await h.pg.query(`select 1 from event where action = 'document.published'`)).rows).toHaveLength(ids.length);
    const written = (await h.pg.query<{ n: number }>(`select count(distinct xmin::text)::int as n from node where id = any($1::uuid[])`, [ids])).rows[0]!.n;
    expect(written).toBe(3);
  });

  it('uses one transaction for a small selection', async () => {
    const ids = await drafts(PUBLISH_BATCH);
    expect((await publish(ids)).json()).toMatchObject({ published: PUBLISH_BATCH });
    const written = (await h.pg.query<{ n: number }>(`select count(distinct xmin::text)::int as n from node where id = any($1::uuid[])`, [ids])).rows[0]!.n;
    expect(written).toBe(1);
  });

  it('rolls back when a file is not ready', async () => {
    const ids = await drafts(2 * PUBLISH_BATCH + 20);
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, processing_status, processing_error, failed_step)
      values ($1, $2, 1, 'k', $3, 10, 'application/pdf', 'failed', 'The PDF could not be opened for viewing. It may be damaged.', 'rasterise')`,
      [h.t1, ids.at(-1), 'ab'.repeat(32)]);
    const res = await publish(ids);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('not_ready');
    expect(await states(ids)).toEqual([{ state: 'draft', n: ids.length }]);
    expect((await h.pg.query(`select 1 from event where action = 'document.published'`)).rows).toEqual([]);
  });
});
