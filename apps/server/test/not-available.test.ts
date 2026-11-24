// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database, SqlClient } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { MemoryQueue } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let queries = 0;
let osprey: { ws: string; folder: string; doc: string; version: string };
let heronVersion: string;

function counting(db: Database): Database {
  const wrap = (tx: SqlClient): SqlClient => ({ query: (text, params) => { queries++; return tx.query(text, params); } }) as SqlClient;
  return { transaction: (fn) => db.transaction((tx) => fn(wrap(tx))), exec: (sql) => db.exec(sql) };
}

const one = async (sql: string, params: unknown[]) => (await h.pg.query<{ id: string }>(sql, params)).rows[0]!.id;
const SHA = 'a'.repeat(64);

beforeEach(async () => {
  h = await heron();
  app = await buildApp({
    db: counting(h.db), auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, rateLimit: false,
    storage: new MemoryStorage(), queue: new MemoryQueue(), keyring: new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64'))),
  });
  // keep start-up queries out of the counts
  await app.ready();
  const ws = await one(`insert into workspace (tenant_id, name, state) values ($1, 'Project Osprey', 'active') returning id`, [h.t1]);
  const folder = await one(`insert into node (tenant_id, workspace_id, kind, name, index_number, state) values ($1, $2, 'folder', 'Legal', '1', 'published') returning id`, [h.t1, ws]);
  const doc = await one(`insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state) values ($1, $2, $3, 'document', 'SPA.pdf', '1.1', 'published') returning id`, [h.t1, ws, folder]);
  const version = await one(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime) values ($1, $2, 1, 'k1', $3, 1, 'application/pdf') returning id`, [h.t1, doc, SHA]);
  osprey = { ws, folder, doc, version };
  heronVersion = await one(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime) values ($1, $2, 1, 'k2', $3, 1, 'application/pdf') returning id`, [h.t1, h.node.aud1, SHA]);
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

async function janInOsprey() {
  const party = await one(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Seller', 'seller') returning id`, [h.t1, osprey.ws]);
  const group = await one(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Sellers', 'member') returning id`, [h.t1, osprey.ws, party]);
  await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, h.person.jan, group]);
  await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, can_upload, can_manage, can_publish)
    values ($1, $2, $3, $4, 60, true, true, true)`, [h.t1, osprey.ws, osprey.folder, group]);
}

type Method = 'GET' | 'POST' | 'PATCH';
const call = (person: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const ROUTES: { name: string; kind: 'node' | 'folder' | 'version'; build: (ws: string, id: string) => [Method, string, unknown?] }[] = [
  { name: 'GET nodes/{id}', kind: 'node', build: (ws, id) => ['GET', `/v1/workspaces/${ws}/nodes/${id}`] },
  { name: 'GET nodes?parent', kind: 'folder', build: (ws, id) => ['GET', `/v1/workspaces/${ws}/nodes?parent=${id}`] },
  { name: 'PATCH nodes/{id}', kind: 'node', build: (ws, id) => ['PATCH', `/v1/workspaces/${ws}/nodes/${id}`, { name: 'Renamed' }] },
  { name: 'POST folders', kind: 'folder', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/folders`, { parentId: id, name: 'New' }] },
  { name: 'POST nodes/{id}/open', kind: 'node', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/nodes/${id}/open`] },
  { name: 'GET nodes/{id}/pages/1', kind: 'node', build: (ws, id) => ['GET', `/v1/workspaces/${ws}/nodes/${id}/pages/1?session=${randomUUID()}`] },
  { name: 'GET nodes/{id}/download', kind: 'node', build: (ws, id) => ['GET', `/v1/workspaces/${ws}/nodes/${id}/download`] },
  { name: 'GET nodes/{id}/coverage', kind: 'node', build: (ws, id) => ['GET', `/v1/workspaces/${ws}/nodes/${id}/coverage`] },
  { name: 'POST nodes/{id}/withdraw', kind: 'node', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/nodes/${id}/withdraw`, {}] },
  { name: 'POST versions/{id}/withdraw', kind: 'version', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/versions/${id}/withdraw`, {}] },
  { name: 'POST publish (nodeIds)', kind: 'node', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/publish`, { nodeIds: [id] }] },
  { name: 'POST publish (versionIds)', kind: 'version', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/publish`, { versionIds: [id] }] },
  { name: 'POST release-preview', kind: 'node', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/release-preview`, { nodeIds: [id] }] },
  { name: 'GET search?folder', kind: 'folder', build: (ws, id) => ['GET', `/v1/workspaces/${ws}/search?q=audited&folder=${id}`] },
  { name: 'POST upload-plans', kind: 'folder', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/upload-plans`, { targetFolderId: id, files: [{ path: 'a.pdf', size: 1 }] }] },
  { name: 'POST upload-sessions (folder)', kind: 'folder', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/upload-sessions`, { targetFolderId: id, path: 'a.pdf', size: 1, sha256: SHA }] },
  { name: 'POST upload-sessions (new version)', kind: 'node', build: (ws, id) => ['POST', `/v1/workspaces/${ws}/upload-sessions`, { replacesNodeId: id, path: 'a.pdf', size: 1, sha256: SHA }] },
];

const ids = () => ({
  node: { forbidden: h.node.aud1, other: osprey.doc },
  folder: { forbidden: h.node.aud, other: osprey.folder },
  version: { forbidden: heronVersion, other: osprey.version },
});

async function answer(person: string, r: (typeof ROUTES)[number], ws: string, id: string) {
  const [m, url, body] = r.build(ws, id);
  const res = await call(person, m, url, body);
  return { status: res.statusCode, type: res.headers['content-type'], body: res.body };
}

describe('not available', () => {
  for (const r of ROUTES) {
    it(`${r.name}: missing, foreign and refused ids look the same`, async () => {
      await janInOsprey();
      const k = ids()[r.kind];
      const missing = await answer(h.person.jan, r, h.ws, randomUUID());
      const other = await answer(h.person.jan, r, h.ws, k.other);
      const refused = await answer(h.person.jan, r, h.ws, k.forbidden);
      expect(other).toEqual(missing);
      expect(refused).toEqual(missing);
      if (r.name !== 'GET nodes?parent') expect(missing.status).toBeGreaterThanOrEqual(400);
    });

    it(`${r.name}: unknown room and non-member look the same`, async () => {
      const k = ids()[r.kind];
      queries = 0;
      const none = await answer(h.person.mei, r, randomUUID(), k.other);
      const nNone = queries;
      queries = 0;
      const notMine = await answer(h.person.mei, r, osprey.ws, k.other);
      const nNotMine = queries;
      expect(notMine).toEqual(none);
      expect(none.status).toBe(404);
      expect(nNotMine).toBe(nNone);
    });
  }

  it('gives admins the same 404 for missing and foreign ids', async () => {
    for (const r of ROUTES) {
      const k = ids()[r.kind];
      const missing = await answer(h.person.anika, r, h.ws, randomUUID());
      const other = await answer(h.person.anika, r, h.ws, k.other);
      expect({ route: r.name, ...other }).toEqual({ route: r.name, ...missing });
    }
  });

  it('answers non-members like a missing node', async () => {
    const room = await call(h.person.mei, 'GET', `/v1/workspaces/${osprey.ws}/nodes/${osprey.doc}`);
    const node = await call(h.person.jan, 'GET', `/v1/workspaces/${h.ws}/nodes/${randomUUID()}`);
    expect(room.statusCode).toBe(404);
    expect(room.body).toBe(node.body);
    expect(room.headers['content-length']).toBe(node.headers['content-length']);
  });

  it('runs the room gate first', async () => {
    queries = 0;
    expect((await call(h.person.mei, 'POST', `/v1/workspaces/${osprey.ws}/nodes/${osprey.doc}/open`)).statusCode).toBe(404);
    // set tenant and gate only
    const outsider = queries;
    queries = 0;
    expect((await call(h.person.jan, 'POST', `/v1/workspaces/${h.ws}/nodes/${randomUUID()}/open`)).statusCode).toBe(404);
    expect(outsider).toBeLessThan(queries);
    const ev = await h.pg.query(`select 1 from event where action = 'access.blocked'`);
    expect(ev.rows).toHaveLength(0);
  });

  it('treats a deleted room as missing', async () => {
    await h.pg.query(`update workspace set state = 'deleted' where id = $1`, [h.ws]);
    const res = await call(h.person.anika, 'GET', `/v1/workspaces/${h.ws}/settings`);
    const none = await call(h.person.anika, 'GET', `/v1/workspaces/${randomUUID()}/settings`);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(none.body);
  });

  it('refuses upload plans into another room', async () => {
    await janInOsprey();
    await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, can_upload) values ($1, $2, $3, $4, 20, true)`,
      [h.t1, h.ws, h.node.fin, h.group.a]);
    const res = await call(h.person.jan, 'POST', `/v1/workspaces/${h.ws}/upload-plans`, { targetFolderId: osprey.folder, files: [{ path: 'a.pdf', size: 1 }] });
    expect(res.statusCode).toBe(404);
  });
});
