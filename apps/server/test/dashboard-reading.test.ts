// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
let lead: string;

beforeEach(async () => {
  h = await heron();
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, publicUrl: 'https://dataroom.example' });
  lead = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Sipho Dlamini', 'sipho@bidder-a.example') returning id`, [h.t1])).rows[0]!.id;
  await h.pg.query(`insert into membership (tenant_id, person_id, group_id, role, recorded_at) values ($1, $2, $3, 'lead', $4)`, [h.t1, lead, h.group.a, T.setup.toISOString()]);
  await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values ($1, $2, $3, $4)`,
    [h.t1, h.nda.v1, lead, T.ndaAccepted.toISOString()]);
  const grant = await call('PUT', '/grants', h.person.anika, { changes: [
    { nodeId: h.node.fin, groupId: h.group.a, level: 20 }, { nodeId: h.node.fin, groupId: h.group.aFin, level: 20 }] });
  expect(grant.statusCode).toBe(200);
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const call = (method: 'GET' | 'POST' | 'PUT', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/workspaces/${h.ws}${url}`, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });

async function read(person: string, node: string, pages: number, seen: number[]) {
  const v = (await h.pg.query<{ id: string }>(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, page_count)
    values ($1, $2, (select coalesce(max(version_no), 0) + 1 from document_version where node_id = $2), 'k', $3, 2048, 'application/pdf', $4)
    returning id`, [h.t1, node, 'ab'.repeat(32), pages])).rows[0]!.id;
  await h.pg.query(`insert into view_session (tenant_id, workspace_id, node_id, version_id, person_id, opened_at, last_seen_at, page_count, pages_seen)
    values ($1, $2, $3, $4, $5, $6, $6, $7, $8)`, [h.t1, h.ws, node, v, person, new Date(T.at.getTime() - 60_000).toISOString(), pages, seen]);
  return v;
}

describe('reading figures', () => {
  it("shows a member only their own reading", async () => {
    await read(h.person.jan, h.node.aud1, 10, [1, 2, 2, 3]);
    await read(lead, h.node.tax1, 4, [1]);
    const jan = (await call('GET', '/dashboard', h.person.jan)).json();
    expect(jan.role).toBe('member');
    expect(jan).not.toHaveProperty('teamCoverage');
    // excludes the lead's reading of 3.4.6
    expect(jan.myCoverage).toEqual({ opened: 1, total: 2, pagesRead: 3, pagesShared: 14,
      folders: [{ folder: '3 Finance', opened: 1, total: 2, pagesRead: 3, pagesShared: 14 }] });
  });

  it("gives leads team reading for their own group", async () => {
    await read(h.person.jan, h.node.aud1, 10, [1, 2]);
    await read(h.person.lars, h.node.tax1, 4, [1, 2, 3, 4]);   // financier subgroup
    const sipho = (await call('GET', '/dashboard', lead)).json();
    expect(sipho.teamCoverage).toEqual({ opened: 1, total: 2, folders: [{ folder: '3 Finance', opened: 1, total: 2 }] });
    expect(sipho.myCoverage).toMatchObject({ opened: 0, total: 2, pagesRead: 0, pagesShared: 14 });
    const lars = (await call('GET', '/dashboard', h.person.lars)).json();
    expect(lars).not.toHaveProperty('teamCoverage');
    expect(lars.myCoverage).toMatchObject({ opened: 1, pagesRead: 4 });
  });

  it('gives no team reading to non-bidder leads', async () => {
    await h.pg.query(`update membership set role = 'lead' where person_id = any($1) and superseded_at = 'infinity'`, [[h.person.maria, h.person.lars]]);
    await read(h.person.jan, h.node.aud1, 10, [1, 2]);
    for (const person of [h.person.maria, h.person.lars]) {
      const res = await call('GET', '/dashboard', person);
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('teamCoverage');
    }
  });

  it('counts pages of the shown version only', async () => {
    await read(h.person.jan, h.node.aud1, 2, [1, 2, 7]);   // 7 is out of range
    const jan = (await call('GET', '/dashboard', h.person.jan)).json();
    expect(jan.myCoverage).toMatchObject({ pagesRead: 2 });
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, page_count)
      values ($1, $2, 2, 'k2', $3, 1, 'application/pdf', 5)`, [h.t1, h.node.aud1, 'cd'.repeat(32)]);
    const again = (await call('GET', '/dashboard', h.person.jan)).json();
    expect(again.myCoverage).toMatchObject({ opened: 1, pagesRead: 0, pagesShared: 5 });
  });
});

describe('request and listing fields', () => {
  it("shows reason and group on access requests", async () => {
    const asked = await call('POST', '/team-requests', lead, { givenName: 'Ruan', familyName: 'Venter', email: 'ruan@bidder-a.example',
      company: 'Bidder A', jobTitle: 'Analyst', reason: 'Joins the valuation workstream.' });
    expect(asked.statusCode).toBe(201);
    await call('POST', '/team-requests', lead, { givenName: 'Thandi', familyName: 'Mokoena', email: 'thandi@bidder-a.example', company: 'Bidder A' });
    const admin = (await call('GET', '/dashboard', h.person.anika)).json();
    expect(admin.toDo.accessRequests).toEqual([
      expect.objectContaining({ name: 'Ruan Venter', groupId: h.group.a, groupName: 'Bidder A', requestedBy: 'Sipho Dlamini', reason: 'Joins the valuation workstream.' }),
      expect.objectContaining({ name: 'Thandi Mokoena', groupId: h.group.a, reason: null }),
    ]);
  });

  it('lists size and published date', async () => {
    const maria = (await h.pg.query<{ id: string }>(`insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'maria') returning id`,
      [h.t1, h.person.maria])).rows[0]!.id;
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by)
      values ($1, $2, 1, 'k', $3, 734003, 'application/pdf', $4)`, [h.t1, h.node.aud1, 'ef'.repeat(32), maria]);
    await h.pg.query(`update node set published_at = $2 where id = $1`, [h.node.aud1, T.grantsSet.toISOString()]);

    const doc = (person: string) => call('GET', `/nodes?parent=${h.node.aud}`, person).then((r) => r.json().items.find((i: any) => i.id === h.node.aud1));
    const jan = await doc(h.person.jan);
    expect(jan.version).toMatchObject({ number: 1, sizeBytes: 734003 });
    expect(jan.publishedAt).toBe(T.grantsSet.toISOString());
    expect(jan).not.toHaveProperty('uploadedBy');
    const anika = await doc(h.person.anika);
    expect(anika).toMatchObject({ publishedAt: T.grantsSet.toISOString(), uploadedBy: { personId: h.person.maria, name: 'Maria Botha' } });
    const draft = (await call('GET', `/nodes?parent=${h.node.aud}`, h.person.anika)).json().items.find((i: any) => i.id === h.node.audDraft);
    expect(draft).toMatchObject({ version: null, publishedAt: null });
  });
});
