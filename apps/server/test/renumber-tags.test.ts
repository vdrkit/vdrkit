// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let clock: Date;

beforeEach(async () => {
  h = await heron();
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, rateLimit: false });
  const g = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] });
  expect(g.statusCode).toBe(200);
});
afterEach(async () => { await app.close(); await h.pg.close(); });

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
const call = (method: Method, url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const DAY = 86_400_000;
async function at(ms: number) {
  clock = new Date(T.at.getTime() + ms);
  await h.pin(clock);
}
async function colleague(): Promise<string> {
  const id = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Pieter Botha', 'pieter@bidder-a.example') returning id`, [h.t1])).rows[0]!.id;
  await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, id, h.group.a]);
  await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id) values ($1, $2, $3)`, [h.t1, h.nda.v1, id]);
  return id;
}
const renumberTax = () => call('PATCH', `${W()}/nodes/${h.node.tax}`, h.person.anika, { position: 1, confirmRenumberPublished: true });
const shellTag = async (person: string, node: string) =>
  (await call('GET', `${W()}/shell`, person)).json().index.find((f: any) => f.id === node)?.renumberedFrom;
const listTag = async (person: string, parent: string, node: string) =>
  (await call('GET', `${W()}/nodes?parent=${parent}`, person)).json().items.find((n: any) => n.id === node)?.renumberedFrom;

describe('old numbers', () => {
  it('records old and new numbers for published items only', async () => {
    await at(60_000);
    expect((await renumberTax()).statusCode).toBe(200);
    const rows = (await h.pg.query<{ node_id: string; from_number: string; to_number: string }>(
      `select node_id, from_number, to_number from index_renumber order by from_number`)).rows;
    expect(rows).toEqual([
      { node_id: h.node.tax, from_number: '3.4', to_number: '3.1' },
      { node_id: h.node.tax1, from_number: '3.4.6', to_number: '3.1.6' },
    ]);
    await expect(h.pg.query(`delete from index_renumber`)).rejects.toThrow(/never changed/);
  });

  it('returns the tag duration from the database setting', async () => {
    const ask = await call('PATCH', `${W()}/nodes/${h.node.tax}`, h.person.anika, { position: 1 });
    expect(ask.statusCode).toBe(409);
    expect(ask.json().tagDays).toBe(3);
    await h.pg.query(`update workspace set renumbered_tag_days = 5 where id = $1`, [h.ws]);
    expect((await call('PATCH', `${W()}/nodes/${h.node.tax}`, h.person.anika, { position: 1 })).json().tagDays).toBe(5);
  });
});

describe('Renumbered tag', () => {
  it("starts at each person's first visit and lasts 3 days", async () => {
    const pieter = await colleague();
    await at(60_000);
    await renumberTax();
    await at(DAY);
    expect(await shellTag(h.person.jan, h.node.tax)).toBe('3.4');
    expect(await listTag(h.person.jan, h.node.tax, h.node.tax1)).toBe('3.4.6');
    await at(DAY + 3 * DAY - 60_000);
    expect(await shellTag(h.person.jan, h.node.tax)).toBe('3.4');
    await at(DAY + 3 * DAY + 60_000);
    expect(await shellTag(h.person.jan, h.node.tax)).toBeNull();
    expect(await listTag(h.person.jan, h.node.tax, h.node.tax1)).toBeNull();
    // a folder listing is not a visit; the room shell is
    expect(await listTag(pieter, h.node.fin, h.node.tax)).toBeNull();
    expect(await shellTag(pieter, h.node.tax)).toBe('3.4');
    expect(await listTag(pieter, h.node.fin, h.node.tax)).toBe('3.4');
  });

  it('follows the database setting', async () => {
    await h.pg.query(`update workspace set renumbered_tag_days = 1 where id = $1`, [h.ws]);
    await at(60_000);
    await renumberTax();
    await at(2 * 60_000);
    expect(await shellTag(h.person.jan, h.node.tax)).toBe('3.4');
    await at(DAY + 3 * 60_000);
    expect(await shellTag(h.person.jan, h.node.tax)).toBeNull();
  });

  it('shows nothing to later joiners or after undo', async () => {
    await at(60_000);
    await renumberTax();
    await at(2 * 60_000);
    const pieter = await colleague();
    await at(3 * 60_000);
    expect(await shellTag(pieter, h.node.tax)).toBeNull();

    await h.pg.query(`update node set index_number = '3.4' where id = $1`, [h.node.tax]);
    expect((await h.pg.query(`select 1 from index_renumber where node_id = $1 and from_number = '3.1'`, [h.node.tax])).rows).toHaveLength(1);
    await at(4 * 60_000);
    expect(await shellTag(h.person.jan, h.node.tax)).toBeNull();
  });

  it('shows nothing to people who never saw the old number', async () => {
    await at(60_000);
    await renumberTax();
    await at(2 * 60_000);
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.b, level: 20 }] })).statusCode).toBe(200);
    await at(3 * 60_000);
    expect((await call('GET', `${W()}/nodes?parent=${h.node.fin}`, h.person.mei)).json().items.map((n: any) => n.id)).toContain(h.node.tax);
    expect(await shellTag(h.person.mei, h.node.tax)).toBeNull();
    expect(await listTag(h.person.mei, h.node.tax, h.node.tax1)).toBeNull();
    expect(await shellTag(h.person.jan, h.node.tax)).toBe('3.4');
  });

  it('never names an item the person cannot see', async () => {
    await at(60_000);
    await renumberTax();
    await at(2 * 60_000);
    const shell = (await call('GET', `${W()}/shell`, h.person.mei)).json();
    expect(shell.index).toEqual([]);
    expect((await call('GET', `${W()}/nodes?parent=${h.node.fin}`, h.person.mei)).json().items).toEqual([]);
  });
});

describe('lookup by old number', () => {
  beforeEach(async () => { await at(60_000); await renumberTax(); await at(2 * 60_000); });

  it('resolves old numbers, current numbers first', async () => {
    const old = await call('GET', `${W()}/numbers/3.4.6`, h.person.jan);
    expect(old.json()).toEqual({ nodeId: h.node.tax1, kind: 'document', indexNumber: '3.1.6', wasNumber: '3.4.6' });
    expect((await call('GET', `${W()}/numbers/3.1.6`, h.person.jan)).json()).toEqual({ nodeId: h.node.tax1, kind: 'document', indexNumber: '3.1.6', wasNumber: null });
    expect((await call('GET', `${W()}/numbers/3.4`, h.person.jan)).json()).toMatchObject({ nodeId: h.node.tax, kind: 'folder', wasNumber: '3.4' });
    expect((await call('GET', `${W()}/numbers/3.2`, h.person.jan)).json()).toMatchObject({ nodeId: h.node.aud, wasNumber: null });
  });

  it('finds the document that had the number at a given moment', async () => {
    const other = (await h.pg.query<{ id: string }>(
      `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
       values ($1, $2, $3, 'document', 'Tax return 2025.pdf', '3.1.7', 'published') returning id`, [h.t1, h.ws, h.node.tax])).rows[0]!.id;
    await at(3 * 60_000);
    await h.pg.query(`update node set index_number = '3.1.7' where id = $1`, [h.node.tax1]);
    await h.pg.query(`update node set index_number = '3.1.6' where id = $1`, [other]);
    await at(4 * 60_000);
    const quoted = (ms: number) => encodeURIComponent(new Date(T.at.getTime() + ms).toISOString());
    expect((await call('GET', `${W()}/numbers/3.1.6?at=${quoted(150_000)}`, h.person.jan)).json())
      .toEqual({ nodeId: h.node.tax1, kind: 'document', indexNumber: '3.1.7', wasNumber: '3.1.6' });
    expect((await call('GET', `${W()}/numbers/3.1.7?at=${quoted(150_000)}`, h.person.jan)).json())
      .toEqual({ nodeId: other, kind: 'document', indexNumber: '3.1.6', wasNumber: '3.1.7' });
    expect((await call('GET', `${W()}/numbers/3.4.6?at=${quoted(30_000)}`, h.person.jan)).json())
      .toMatchObject({ nodeId: h.node.tax1, wasNumber: '3.4.6' });
    expect((await call('GET', `${W()}/numbers/3.1.6?at=${quoted(200_000)}`, h.person.jan)).json()).toMatchObject({ nodeId: other, wasNumber: null });
    expect((await call('GET', `${W()}/numbers/3.1.6`, h.person.jan)).json()).toMatchObject({ nodeId: other, wasNumber: null });
    expect((await call('GET', `${W()}/numbers/3.1.6?at=${quoted(150_000)}`, h.person.mei)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/numbers/3.1.6?at=yesterday`, h.person.jan)).statusCode).toBe(400);
  });

  it('returns not found for unknown, hidden or invalid numbers', async () => {
    expect((await call('GET', `${W()}/numbers/9.9`, h.person.jan)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/numbers/3.4.6`, h.person.mei)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/numbers/3.4.6`, h.person.mei)).json()).toEqual((await call('GET', `${W()}/numbers/9.9`, h.person.mei)).json());
    expect((await call('GET', `${W()}/numbers/abc`, h.person.jan)).statusCode).toBe(400);
  });

  it('finds old numbers in search', async () => {
    for (const match of ['all', 'names']) {
      const res = (await call('GET', `${W()}/search?q=3.4.6&match=${match}`, h.person.jan)).json();
      expect(res.items[0]).toMatchObject({ nodeId: h.node.tax1, indexNumber: '3.1.6', wasNumber: '3.4.6' });
    }
    const current = (await call('GET', `${W()}/search?q=3.1.6`, h.person.jan)).json();
    expect(current.items[0]).toMatchObject({ nodeId: h.node.tax1, wasNumber: null });
    expect((await call('GET', `${W()}/search?q=3.4.6`, h.person.mei)).json().items).toEqual([]);
  });
});
