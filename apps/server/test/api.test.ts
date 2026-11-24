// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;

beforeEach(async () => {
  h = await heron();
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const as = (person: string, tenant?: string) => ({ 'x-dev-person': person, 'x-dev-tenant': tenant ?? h.t1 });
const get = (url: string, person: string, tenant?: string) => app.inject({ method: 'GET', url, headers: as(person, tenant) });
const put = (url: string, person: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: as(person), payload });
const post = (url: string, person: string, payload: unknown) => app.inject({ method: 'POST', url, headers: as(person), payload });

async function openFinanceToBidderA(level = 20) {
  const res = await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level }] });
  expect(res.statusCode).toBe(200);
}

describe('request lifecycle', () => {
  it('answers health checks without auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).json()).toEqual({ ok: true });
  });

  it('should require authentication', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/nodes` });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('serves the OpenAPI document to site admins only', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/openapi.json' })).statusCode).toBe(401);
    const bidder = await get('/v1/openapi.json', h.person.jan);
    expect([bidder.statusCode, bidder.json().reason]).toEqual([403, 'not_site_admin']);
    expect((await get('/v1/openapi.json', h.person.anika)).statusCode).toBe(403);

    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    const res = await get('/v1/openapi.json', h.person.anika);
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining([
      '/v1/workspaces/{ws}/nodes', '/v1/workspaces/{ws}/grants', '/v1/workspaces/{ws}/upload-plans', '/v1/workspaces/{ws}/events',
    ]));
  });

  it('returns 400 for invalid input', async () => {
    const res = await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 25 }] });
    expect(res.statusCode).toBe(400);
  });
});

describe('documents', () => {
  it('hides drafts from bidders', async () => {
    await openFinanceToBidderA();
    const top = (await get(`/v1/workspaces/${h.ws}/nodes`, h.person.jan)).json();
    expect(top.items.map((n: any) => `${n.indexNumber} ${n.name}`)).toEqual(['3 Finance']);
    const aud = (await get(`/v1/workspaces/${h.ws}/nodes?parent=${h.node.aud}`, h.person.jan)).json();
    expect(aud.items.map((n: any) => n.indexNumber)).toEqual(['3.2.1']);
    expect(aud.items[0].access).toEqual({ level: 20, allowed: ['view'] });
  });

  it('shows admins everything including drafts', async () => {
    const aud = (await get(`/v1/workspaces/${h.ws}/nodes?parent=${h.node.aud}`, h.person.anika)).json();
    expect(aud.items.map((n: any) => `${n.indexNumber} ${n.state}`)).toEqual(['3.2.1 published', '3.2.5 draft']);
    expect(aud.items[0].access.allowed).toEqual(['view', 'download_encrypted_pdf', 'print', 'download_pdf', 'download_original', 'upload', 'manage', 'publish']);
  });

  it('returns 404 for a document the caller cannot see', async () => {
    const hidden = await get(`/v1/workspaces/${h.ws}/nodes/${h.node.it}`, h.person.jan);
    const missing = await get(`/v1/workspaces/${h.ws}/nodes/00000000-0000-4000-8000-000000000000`, h.person.jan);
    expect([hidden.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect(hidden.json()).toEqual(missing.json());
  });

  it('shows nothing to another tenant', async () => {
    const res = await get(`/v1/workspaces/${h.ws}/nodes`, h.person.anika, h.t2);
    const none = await get(`/v1/workspaces/00000000-0000-4000-8000-000000000000/nodes`, h.person.anika, h.t2);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(none.body);
  });
});

describe('agents', () => {
  it('caps agents and blocks uploads', async () => {
    // agents only view
    expect((await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika,
      { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 60, canUpload: true }] })).statusCode).toBe(200);
    const headers = { ...as(h.person.maria), 'x-dev-agent-max-level': '20' };
    const list = (await app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/nodes?parent=${h.node.aud}`, headers })).json();
    expect(list.items[0].access).toEqual({ level: 20, allowed: ['view'] });
    const plan = await app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/upload-plans`, headers, payload: { targetFolderId: h.node.fin, files: [{ path: 'a.pdf', size: 1 }] } });
    expect(plan.statusCode).toBe(403);
  });
});

describe('permission matrix', () => {
  it('rejects duplicate cells', async () => {
    const res = await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, { changes: [
      { nodeId: h.node.fin, groupId: h.group.a, level: 20 }, { nodeId: h.node.fin, groupId: h.group.a, level: 50 }] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a window that ends before it starts', async () => {
    for (const validTo of ['2026-12-01T00:00:00Z', '2026-11-01T00:00:00Z']) {
      const res = await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, { changes: [
        { nodeId: h.node.fin, groupId: h.group.a, level: 20, validFrom: '2026-12-01T00:00:00Z', validTo }] });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain('must end after it starts');
    }
    expect((await get(`/v1/workspaces/${h.ws}/events`, h.person.anika)).json().items).toEqual([]);
  });

  it('requires room admin', async () => {
    const res = await put(`/v1/workspaces/${h.ws}/grants`, h.person.jan, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 60 }] });
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('not_room_admin');
  });

  it('saves several cells with one audit event', async () => {
    const res = await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, {
      changes: [
        { nodeId: h.node.fin, groupId: h.group.a, level: 50 },
        { nodeId: h.node.tax, groupId: h.group.a, level: 0 },
        { nodeId: h.node.aud, personId: h.person.jan, effect: 'deny' },
      ],
    });
    expect(res.json()).toMatchObject({ changed: 3 });
    const doc = (await get(`/v1/workspaces/${h.ws}/nodes/${h.node.tax1}`, h.person.jan));
    expect(doc.statusCode).toBe(404);
    const log = (await get(`/v1/workspaces/${h.ws}/events`, h.person.anika)).json();
    expect(log.items.map((e: any) => e.action)).toEqual(['access.blocked', 'grants.bulk_changed']);
    expect(log.items[1].data.cells).toHaveLength(3);
  });

  it('rejects ids from outside the room', async () => {
    const res = await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, {
      changes: [
        { nodeId: h.node.fin, groupId: h.group.a, level: 50 },
        { nodeId: h.node.fin, groupId: '00000000-0000-4000-8000-000000000001', level: 50 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect((await get(`/v1/workspaces/${h.ws}/events`, h.person.anika)).json().items).toEqual([]);
  });

  it('reads the matrix at an earlier date', async () => {
    await openFinanceToBidderA(50);
    const before = (await get(`/v1/workspaces/${h.ws}/grants?at=2026-11-05T00:00:00Z`, h.person.anika)).json();
    const now = (await get(`/v1/workspaces/${h.ws}/grants`, h.person.anika)).json();
    const forA = (g: any) => g.grants.filter((x: any) => x.groupId === h.group.a);
    expect([forA(before).length, forA(now).length]).toEqual([0, 1]);
  });
});

describe('upload plans', () => {
  const drop = [
    { path: '03 Finance/05 Treasury/Cash pooling agreement.pdf', size: 120_000 },
    { path: '03 Finance/02 Audited financials/Auditor report FY2023.pdf', size: 80_000 },
    { path: '08 Insurance/01 Policies/Group liability policy.pdf', size: 300_000 },
    { path: '08 Insurance/Thumbs.db', size: 1_000 },
  ];

  it('plans a top-level drop', async () => {
    const res = await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.anika, { files: drop });
    expect(res.statusCode).toBe(200);
    const plan = res.json();
    expect(plan.folders.map((f: any) => `${f.indexNumber} ${f.name}`)).toEqual(['3 Finance', '8 Insurance']);
    expect(plan.folders[0].children.map((f: any) => `${f.indexNumber} ${f.name}`)).toEqual(['3.2 Audited financials', '3.5 Treasury']);
    expect(plan.folders[0].children[0].files[0].indexNumber).toBe('3.2.6');
    expect(plan.summary).toMatchObject({ uploadFiles: 3, newFolders: 3, systemFilesSkipped: 1 });
  });

  it('limits contributors to folders they can upload to', async () => {
    const ok = await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.maria, { targetFolderId: h.node.fin, files: [{ path: 'Q3 cash flow.xlsx', size: 1 }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().files[0].indexNumber).toBe('3.5');
    expect((await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.maria, { targetFolderId: h.node.it, files: [{ path: 'a.pdf', size: 1 }] })).statusCode).toBe(404);
    expect((await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.maria, { files: [{ path: 'a.pdf', size: 1 }] })).statusCode).toBe(403);
  });

  it('flags duplicates', async () => {
    const sha = 'ab'.repeat(32);
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
      values ($1, $2, 1, 'k', $3, 10, 'application/pdf')`, [h.t1, h.node.aud1, sha]);
    const plan = (await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.maria, {
      targetFolderId: h.node.fin, files: [{ path: 'Copy of FS.pdf', size: 10, sha256: sha }],
    })).json();
    expect(plan.files[0]).toMatchObject({ status: 'duplicate_skipped', duplicateOf: '3.2.1' });
  });

  it('ignores duplicates the uploader can only see by name', async () => {
    const sha = 'cd'.repeat(32);
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
      values ($1, $2, 1, 'k', $3, 10, 'application/pdf')`, [h.t1, h.node.aud1, sha]);
    await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, { changes: [{ nodeId: h.node.aud, groupId: h.group.contributors, level: 10 }] });
    const plan = (await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.maria, {
      targetFolderId: h.node.fin, files: [{ path: 'guess.pdf', size: 10, sha256: sha }] })).json();
    expect(plan.files[0].status).toBe('new');
  });

  it('ignores versions the uploader cannot open', async () => {
    const [withdrawn, current] = ['ef'.repeat(32), '12'.repeat(32)];
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, withdrawn_at)
      values ($1, $2, 1, 'k', $3, 10, 'application/pdf', $5), ($1, $2, 2, 'k2', $4, 10, 'application/pdf', null)`,
      [h.t1, h.node.aud1, withdrawn, current, T.grantsSet.toISOString()]);
    await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, { changes: [{ nodeId: h.node.aud, groupId: h.group.contributors, level: 20 }] });
    const plan = (await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.maria, {
      targetFolderId: h.node.fin, files: [{ path: 'guess.pdf', size: 10, sha256: withdrawn }, { path: 'known.pdf', size: 10, sha256: current }] })).json();
    expect(plan.files.map((f: any) => [f.sourcePath, f.status])).toEqual([['guess.pdf', 'new'], ['known.pdf', 'duplicate_skipped']]);
    const admin = (await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.anika, {
      targetFolderId: h.node.fin, files: [{ path: 'guess.pdf', size: 10, sha256: withdrawn }, { path: 'known.pdf', size: 10, sha256: current }] })).json();
    expect(admin.files.map((f: any) => f.status)).toEqual(['duplicate_skipped', 'duplicate_skipped']);
  });

  it('never reveals hidden folders', async () => {
    await put(`/v1/workspaces/${h.ws}/grants`, h.person.anika, { changes: [{ nodeId: h.node.tax, groupId: h.group.contributors, level: 0 }] });
    const res = await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.maria, {
      targetFolderId: h.node.fin, files: [{ path: '04 probe/a.pdf', size: 1 }, { path: 'Tax/b.pdf', size: 1 }] });
    const body = res.body;
    expect(body).not.toContain(h.node.tax);
    expect(res.json().warnings).toEqual([]);
    expect(res.json().folders.map((f: any) => f.indexNumber).sort()).toEqual(['3.5', '3.6']);
    expect(res.json().folders.every((f: any) => f.existingId === null)).toBe(true);
  });

  it('rejects path traversal', async () => {
    const res = await post(`/v1/workspaces/${h.ws}/upload-plans`, h.person.anika, { files: [{ path: '../etc/passwd', size: 1 }] });
    expect(res.statusCode).toBe(400);
  });
});

describe('activity log', () => {
  it('is admin only and verifies its chain', async () => {
    await openFinanceToBidderA();
    expect((await get(`/v1/workspaces/${h.ws}/events`, h.person.jan)).statusCode).toBe(403);
    const v = (await get(`/v1/workspaces/${h.ws}/events/verify`, h.person.anika)).json();
    expect(v).toEqual({ checked: 1, intact: true, firstBroken: null, checkedAt: expect.any(String) });
  });
});
