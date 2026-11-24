// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessibleNodes, can, verifyChain, versionAccess, withTenant, type Database, type SqlClient } from '@vdrkit/core';
import { D, DEFAULT_DEMO_DOMAINS, DEMO_DOMAINS, demoDomains, demoShiftMs, roomDay, seedDemo, seedDemoRooms, seedSiteDemo, type DemoRoom } from '../src/demo/seed-demo.js';
import { freshDatabase, type TestPg } from '../../../packages/core/test/fixture.js';

let at: Date;
let pg: TestPg;
let db: Database;
let room: DemoRoom;
const app = <R>(fn: (tx: SqlClient) => Promise<R>) => withTenant(db, room.tenantId, fn, { role: 'vdrkit_app' });
const person = (personId: string) => ({ kind: 'person' as const, personId });

beforeAll(async () => {
  ({ db, pg } = await freshDatabase());
  room = await seedDemo(db, { role: 'vdrkit_app' });
  at = new Date(Date.now() + 1000);
}, 120_000);
afterAll(async () => { await pg.close(); });

describe('demo seed: Project Heron', () => {
  it('loads the demo counts', async () => {
    expect(room.counts).toEqual({ folders: 22, published: 1248, drafts: 441, newVersions: 1 });
    const rows = (await pg.query<{ kind: string; state: string; n: number }>(
      `select kind, state, count(*)::int n from node where tenant_id = $1 group by kind, state order by kind, state`, [room.tenantId])).rows;
    expect(rows).toEqual([
      { kind: 'document', state: 'draft', n: 441 },
      { kind: 'document', state: 'published', n: 1248 },
      { kind: 'folder', state: 'published', n: 22 },
    ]);
    const top = (await pg.query<{ index_number: string; name: string }>(
      `select index_number, name from node where tenant_id = $1 and parent_id is null order by sort_key`, [room.tenantId])).rows;
    expect(top.map((t) => `${t.index_number} ${t.name}`)).toEqual([
      '1 Corporate', '2 Legal', '3 Finance', '4 Commercial', '5 HR', '6 IT', '7 Property',
      '8 Insurance', '9 Environmental', '10 Intellectual property', '11 Data protection']);
    const versions = (await pg.query<{ status: string; n: number }>(
      `select processing_status status, count(*)::int n from document_version where tenant_id = $1 group by 1 order by 1`, [room.tenantId])).rows;
    expect(versions).toEqual([{ status: 'pending', n: 1 }, { status: 'ready', n: 1689 }]);
  });

  it('holds version 2 of 2.4.3 in draft', async () => {
    const v = (await pg.query<{ id: string; version_no: number; awaiting_release: boolean }>(
      `select id, version_no, awaiting_release from document_version where node_id = $1 order by version_no`, [room.node['2.4.3']])).rows;
    expect(v.map((x) => [x.version_no, x.awaiting_release])).toEqual([[1, false], [2, true]]);
    const shown = (p: string) => app((tx) => versionAccess(tx, person(p), room.node['2.4.3']!, { at }));
    expect((await shown(room.person.anika)).versionId).toBe(v[1]!.id);
    expect((await shown(room.person.jan)).versionId).toBe(v[0]!.id);
    expect((await shown(room.person.mei)).versionId).toBe(v[0]!.id);
  });

  it("keeps the demo room's names and numbers", async () => {
    const name = async (ix: string) => (await pg.query<{ name: string; state: string }>(`select name, state from node where id = $1`, [room.node[ix]])).rows[0];
    expect(await name('2.4.2')).toEqual({ name: 'Tarnley Logistics supply agreement.pdf', state: 'published' });
    expect(await name('2.4.13')).toEqual({ name: 'Framework agreement Velarail Freight Rail.pdf', state: 'draft' });
    expect(await name('3.2.6')).toEqual({ name: 'Audited financial statements FY2023.pdf', state: 'draft' });
  });

  it('writes through RLS with an unbroken audit chain', async () => {
    expect(await app((tx) => verifyChain(tx, room.workspaceId))).toMatchObject({ firstBroken: null });
    const other = await withTenant(db, '00000000-0000-4000-8000-0000000000ff', (tx) => tx.query(`select 1 from node`), { role: 'vdrkit_app' });
    expect(other.rows).toHaveLength(0);
  });

  it('Bidder B sees only folders it has a grant on', async () => {
    const mei = room.person.mei;
    expect(await app((tx) => can(tx, person(mei), 'see_name', room.node['8']!, { at }))).toMatchObject({ allowed: false, level: 0 });
    expect(await app((tx) => can(tx, person(mei), 'view', room.node['2.4.2']!, { at }))).toMatchObject({ allowed: true, level: 20 });
    expect(await app((tx) => can(tx, person(mei), 'print', room.node['3.2.1']!, { at }))).toMatchObject({ allowed: true, level: 40 });
    expect(await app((tx) => can(tx, person(mei), 'see_name', room.node['2.4.13']!, { at }))).toMatchObject({ allowed: false });   // a draft
    const visible = await app((tx) => accessibleNodes(tx, mei, room.workspaceId, { at }));
    expect(visible.has(room.node['8']!)).toBe(false);
    expect(visible.has(room.node['1']!)).toBe(true);
  });

  it('caps Bidder C financiers at Bidder C', async () => {
    expect(await app((tx) => can(tx, person(room.person.lars), 'view', room.node['3.2.1']!, { at }))).toMatchObject({ allowed: true, level: 20 });
    expect(await app((tx) => can(tx, person(room.person.jan), 'download_pdf', room.node['3.2.1']!, { at }))).toMatchObject({ allowed: true, level: 50 });
  });

  it('Johan publishes in 3 Finance; Maria only uploads', async () => {
    const johan = person(room.person.johan);
    for (const ix of ['3', '3.2', '3.2.6', '3.5.1']) {
      expect(await app((tx) => can(tx, johan, 'publish', room.node[ix]!, { at })), ix).toMatchObject({ allowed: true });
    }
    for (const ix of ['2', '2.4.13', '4', '8']) {
      expect(await app((tx) => can(tx, johan, 'publish', room.node[ix]!, { at })), ix).toMatchObject({ allowed: false });
    }
    const maria = person(room.person.maria);
    expect(await app((tx) => can(tx, maria, 'upload', room.node['3.2']!, { at }))).toMatchObject({ allowed: true });
    expect(await app((tx) => can(tx, maria, 'publish', room.node['3.2.6']!, { at }))).toMatchObject({ allowed: false });
    expect(await app((tx) => can(tx, maria, 'upload', room.node['2.4']!, { at }))).toMatchObject({ allowed: false });
  });

  it('is idempotent', async () => {
    const again = await seedDemo(db, { role: 'vdrkit_app' });
    expect(again).toMatchObject({ skipped: true, workspaceId: room.workspaceId });
    expect((await pg.query<{ n: number }>(`select count(*)::int n from workspace`)).rows[0]!.n).toBe(1);
  });
});

// last: the other seeds add rooms to the same tenant
describe('demo seed: the people', () => {
  it('gives every demo person a company, role and address', async () => {
    await seedDemoRooms(db, { role: 'vdrkit_app' });
    await seedSiteDemo(db, { role: 'vdrkit_app' });
    const people = (await pg.query<{ name: string; email: string; company: string | null; job_title: string | null; side: string | null }>(
      `select p.name, p.email, p.company, p.job_title,
              (select string_agg(distinct coalesce(g.organisation, pa.kind), ',') from membership m join groups g on g.id = m.group_id
                 join party pa on pa.id = g.party_id where m.person_id = p.id and g.workspace_id = $2) side
         from person p where p.tenant_id = $1 order by p.name`, [room.tenantId, room.workspaceId])).rows;
    expect(people.length).toBe(13);
    const domainOf: Record<string, string> = {
      'Quillmont Advisory': DEMO_DOMAINS.seller, 'Drosvelt Holdings': DEMO_DOMAINS.seller, 'Orrinby Capital': DEMO_DOMAINS.a,
      'Delmora Partners': DEMO_DOMAINS.b, 'Seratwe Equity': DEMO_DOMAINS.c, 'Skarvik Bank': DEMO_DOMAINS.c,
    };
    const four = new Set(Object.values(DEMO_DOMAINS));
    for (const p of people) {
      const [local, domain] = p.email.split('@');
      expect(four.has(domain as never), p.email).toBe(true);
      expect(local, p.email).toBe(p.name.split(' ')[0]!.toLowerCase());
      expect(p.company, p.name).toBeTruthy();
      expect(p.job_title, p.name).toBeTruthy();
      if (p.side) expect(p.side, p.name).toBe(p.company);
      expect(domain, p.name).toBe(domainOf[p.company!]);
    }
    expect(people.find((p) => p.name === 'Lars Eriksen')).toMatchObject({ email: 'lars@bidder-c.example.com', company: 'Skarvik Bank' });
    expect(people.find((p) => p.name === 'Mei Tanaka')?.email).toBe('mei@bidder-b.example.com');
  });
});

describe('demo seed: the email domains', () => {
  it('defaults to example.com subdomains', () => {
    expect(DEMO_DOMAINS).toEqual(DEFAULT_DEMO_DOMAINS);
    expect(demoDomains(undefined)).toEqual({ seller: 'seller.example.com', a: 'bidder-a.example.com', b: 'bidder-b.example.com', c: 'bidder-c.example.com' });
    expect(demoDomains('  ')).toEqual(DEFAULT_DEMO_DOMAINS);
  });

  it('accepts one domain or side=domain pairs', () => {
    expect(demoDomains('Mail.Test')).toEqual({ seller: 'mail.test', a: 'mail.test', b: 'mail.test', c: 'mail.test' });
    expect(demoDomains('seller=s.test, a=a.test,b=b.test,c=c.test')).toEqual({ seller: 's.test', a: 'a.test', b: 'b.test', c: 'c.test' });
    expect(demoDomains('a=a.test')).toEqual({ ...DEFAULT_DEMO_DOMAINS, a: 'a.test' });
  });

  it('refuses a malformed value', () => {
    expect(() => demoDomains('not a domain')).toThrow(/not a domain/);
    expect(() => demoDomains('bidder=a.test')).toThrow(/unknown side/);
    expect(() => demoDomains('a=')).toThrow(/not a domain/);
  });
});

describe('demo seed: dates', () => {
  const WEEK = 7 * 86_400_000;
  const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10));

  it('shifts the story by whole weeks', () => {
    for (const d of days('2026-11-13', 7)) expect(demoShiftMs(d)).toBe(0);
    expect(demoShiftMs('2026-11-12')).toBe(-WEEK);
    expect(demoShiftMs('2026-11-20')).toBe(WEEK);
    expect(demoShiftMs('2026-11-26')).toBe(WEEK);
    expect(demoShiftMs('2026-11-27')).toBe(2 * WEEK);
    expect(demoShiftMs('2027-03-01')).toBe(15 * WEEK);
  });

  it('keeps past events past and Q&A round 1 ahead', () => {
    const qa1 = Date.parse('2026-11-20T15:00:00Z');
    for (const d of days('2026-11-01', 800)) {
      const shift = demoShiftMs(d);
      const start = Date.parse(`${d}T00:00:00+02:00`);
      const end = start + 86_400_000;
      expect(D.thu12.getTime() + shift, d).toBeLessThan(start);
      expect(qa1 + shift, d).toBeGreaterThan(end);
      expect(new Date(qa1 + shift).getUTCDay(), d).toBe(5);
    }
  });

  it('takes VDRKIT_DEMO_TODAY, and refuses a malformed day', () => {
    const was = process.env.VDRKIT_DEMO_TODAY;
    try {
      process.env.VDRKIT_DEMO_TODAY = '2026-12-03';
      expect(demoShiftMs()).toBe(2 * WEEK);
      delete process.env.VDRKIT_DEMO_TODAY;
      expect(demoShiftMs()).toBe(demoShiftMs(roomDay(new Date())));
    } finally {
      if (was === undefined) delete process.env.VDRKIT_DEMO_TODAY; else process.env.VDRKIT_DEMO_TODAY = was;
    }
    expect(() => demoShiftMs('12 Nov 2026')).toThrow(/YYYY-MM-DD/);
    expect(() => demoShiftMs('2026-02-30')).toThrow(/YYYY-MM-DD/);
  });

  it('reads the day in room time, SAST', () => {
    expect(roomDay(new Date('2026-11-19T21:59:00Z'))).toBe('2026-11-19');
    expect(roomDay(new Date('2026-11-19T22:00:00Z'))).toBe('2026-11-20');
  });

  it('loads the shifted timeline', async () => {
    const shift = demoShiftMs();
    const ms = (await pg.query<{ title: string; due_at: Date | string; phase_starts_on: string | null }>(
      `select title, due_at, to_char(phase_starts_on, 'YYYY-MM-DD') phase_starts_on from milestone where workspace_id = $1 order by due_at`, [room.workspaceId])).rows
      .map((m) => ({ ...m, due: new Date(m.due_at) }));
    const moved = (iso: string) => new Date(Date.parse(iso) + shift).toISOString();
    expect(ms.map((m) => [m.title, m.due.toISOString()])).toEqual([
      ['Room opened', moved('2026-11-03T07:00:00Z')], ['Q&A round 1 closes', moved('2026-11-20T15:00:00Z')],
      ['Non-binding offers due', moved('2026-11-27T15:00:00Z')], ['Management presentation, Bidder A', moved('2026-12-08T08:00:00Z')],
      ['Management presentation, Bidder C', moved('2026-12-09T08:00:00Z')], ['Q&A cut-off', moved('2027-01-22T15:00:00Z')],
      ['Binding offers due', moved('2027-02-12T15:00:00Z')]]);
    expect(ms.find((m) => m.title === 'Binding offers due')!.phase_starts_on).toBe(moved('2026-11-30T00:00:00Z').slice(0, 10));
    const loaded = Date.parse(`${process.env.VDRKIT_DEMO_TODAY || roomDay()}T00:00:00+02:00`);
    expect(ms[0]!.due.getTime()).toBeLessThan(loaded);
    expect(ms[1]!.due.getTime()).toBeGreaterThan(loaded + 86_400_000);
  });
});
