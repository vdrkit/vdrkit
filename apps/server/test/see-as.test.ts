// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { encryptBuffer, LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { convertStep, GotenbergClient, MemoryStorage, runPipeline } from '../src/pipeline/pipeline.js';
import { rasteriseStep } from '../src/pipeline/rasterise.js';
import { recordDerived } from '../src/pipeline/record.js';
import { SEE_AS_POST_READS, SEE_AS_ROUTES } from '../src/see-as.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let storage: MemoryStorage;
let keyring: DbKeyring;
let clock: Date;

async function grant(group: string, node: string, level: number, upload = false) {
  await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, can_upload, recorded_at)
    values ($1, $2, $3, $4, $5, $6, $7)`, [h.t1, h.ws, node, group, level, upload, T.grantsSet.toISOString()]);
}

async function seedDocument() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2]) doc.addPage([595, 842]).drawText(`Audited financial statements FY2025, page ${n}`, { x: 50, y: 780, size: 14, font });
  const original = Buffer.from(await doc.save());
  const { key, version } = await h.app((tx) => keyring.dataKey(tx, h.ws));
  const storageKey = `ws/${h.ws}/originals/aud1-v1`;
  await storage.put(storageKey, await encryptBuffer(key, original, storageKey));
  const versionId = await h.app(async (tx) => (await tx.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, key_version)
     values (current_tenant_id(), $1, 1, $2, $3, $4, 'application/pdf', $5) returning id`,
    [h.node.aud1, storageKey, createHash('sha256').update(original).digest('hex'), original.length, version])).rows[0]!.id);
  const result = await runPipeline(
    { versionId, workspaceId: h.ws, storageKey, filename: 'Audited financial statements FY2025.pdf', mime: 'application/pdf' },
    [convertStep(new GotenbergClient('http://127.0.0.1:9')), rasteriseStep], storage, key);
  await h.app((tx) => recordDerived(tx, versionId, result, { keyVersion: version }));
}

beforeEach(async () => {
  h = await heron();
  clock = T.at;
  storage = new MemoryStorage();
  keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, storage, keyring });
  await grant(h.group.a, h.node.fin, 20);
  await grant(h.group.aFin, h.node.aud, 50);
  await grant(h.group.b, h.node.tax, 50);
  await seedDocument();
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const headers = (person: string, seeAs?: string) => ({
  'x-dev-person': person, 'x-dev-tenant': h.t1, 'user-agent': 'vitest', ...(seeAs ? { 'x-vdrkit-see-as': seeAs } : {}),
});
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, person: string, seeAs?: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/workspaces/${h.ws}${url}`, headers: headers(person, seeAs), ...(payload ? { payload } : {}) });

async function roomAsSeen(person: string, seeAs?: string) {
  const shell = await call('GET', '/shell', person, seeAs);
  expect(shell.statusCode, shell.body).toBe(200);
  const s = shell.json();
  const tops = (await call('GET', '/nodes', person, seeAs)).json().items;
  const fin = await call('GET', `/nodes?parent=${h.node.fin}`, person, seeAs);
  const aud = await call('GET', `/nodes?parent=${h.node.aud}`, person, seeAs);
  const strip = (items: any[]) => items.map((i) => ({ id: i.id, name: i.name, state: i.state, access: i.access }));
  return {
    index: s.index, documents: s.documents, isAdmin: s.me.isAdmin, groups: s.me.groups.map((g: any) => g.id),
    tops: strip(tops), fin: fin.statusCode === 200 ? strip(fin.json().items) : fin.statusCode,
    aud: aud.statusCode === 200 ? strip(aud.json().items) : aud.statusCode,
  };
}

const count = async (sql: string, params: unknown[] = []) => Number((await h.pg.query<{ n: string }>(sql, params)).rows[0]!.n);

describe('see as', () => {
  it('shows a room admin what Bidder A sees', async () => {
    const asA = await roomAsSeen(h.person.anika, h.group.a);
    const jan = await roomAsSeen(h.person.jan);
    expect(asA).toEqual(jan);
    expect(asA.isAdmin).toBe(false);
    expect(asA.aud).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: h.node.audDraft })]));
    const own = await roomAsSeen(h.person.anika);
    expect(own.aud).toEqual(expect.arrayContaining([expect.objectContaining({ id: h.node.audDraft })]));
  });

  it('holds a subgroup to its parent group', async () => {
    const asFin = await roomAsSeen(h.person.anika, h.group.aFin);
    expect(asFin).toEqual(await roomAsSeen(h.person.lars));
    const doc = (asFin.aud as any[]).find((i) => i.id === h.node.aud1);
    expect(doc.access.level).toBe(20);
    expect(doc.access.allowed).not.toContain('download_pdf');
  });

  it('shows the seller team its drafts', async () => {
    const asTeam = await roomAsSeen(h.person.anika, h.group.contributors);
    expect(asTeam).toEqual(await roomAsSeen(h.person.maria));
    expect(asTeam.aud).toEqual(expect.arrayContaining([expect.objectContaining({ id: h.node.audDraft })]));
  });

  it("should hide other bidders' folders", async () => {
    const asB = await roomAsSeen(h.person.anika, h.group.b);
    expect(asB).toEqual(await roomAsSeen(h.person.mei));
    expect(asB.index.map((f: any) => f.id)).toEqual([h.node.tax]);
  });

  it('scopes search to the team', async () => {
    const shell = (await call('GET', '/shell', h.person.anika, h.group.a)).json();
    expect(shell.seeAs).toEqual({ groupId: h.group.a, name: 'Bidder A', side: 'bidders', roomNotOpen: false });
    expect(shell.me.name).toBe('Anika Pillay');
    expect(shell.attention).toBeNull();
    expect((await call('GET', '/shell', h.person.anika)).json().seeAs).toBeNull();
    const asB = (await call('GET', `/search?q=${encodeURIComponent('Audited')}`, h.person.anika, h.group.b)).json();
    expect(asB.total).toBe(0);
    const asA = (await call('GET', `/search?q=${encodeURIComponent('Audited')}`, h.person.anika, h.group.a)).json();
    expect(asA.total).toBeGreaterThan(0);
  });

  it('works for rooms in preparation', async () => {
    const open = await roomAsSeen(h.person.jan);
    expect((await call('PATCH', '/settings', h.person.anika, undefined, { state: 'preparing' })).statusCode).toBe(200);
    const jan = await call('GET', '/shell', h.person.jan);
    expect([jan.statusCode, jan.json().reason]).toEqual([403, 'room_preparing']);
    const asA = await roomAsSeen(h.person.anika, h.group.a);
    expect(asA).toEqual(open);
    const shell = (await call('GET', '/shell', h.person.anika, h.group.a)).json();
    expect(shell.seeAs).toEqual({ groupId: h.group.a, name: 'Bidder A', side: 'bidders', roomNotOpen: true });
    expect(shell.room.state).toBe('open');
    expect((await call('GET', '/milestones', h.person.anika, h.group.a)).statusCode).toBe(200);
    expect((await call('GET', '/shell', h.person.jan)).statusCode).toBe(403);
    expect((await call('GET', '/shell', h.person.anika)).json().room.state).toBe('preparing');
  });

  it('lists teams for room admins only', async () => {
    const res = await call('GET', '/see-as', h.person.anika);
    expect(res.statusCode).toBe(200);
    expect(res.json().teams.map((t: any) => [t.name, t.side])).toEqual([
      ['Bidder A', 'bidders'], ['Bidder A financier', 'bidders'], ['Bidder A Q&A team', 'bidders'], ['Bidder B', 'bidders'], ['Seller finance team', 'seller'],
    ]);
    expect(res.json().teams.find((t: any) => t.id === h.group.a).members).toBe(1);
    for (const p of [h.person.jan, h.person.maria]) expect((await call('GET', '/see-as', p)).statusCode).toBe(403);
  });
});

describe('who may see as', () => {
  it('returns 404 for non-admins', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/workspaces/00000000-0000-4000-8000-000000000000/shell', headers: headers(h.person.jan) });
    for (const p of [h.person.jan, h.person.maria, h.person.lars]) {
      const res = await call('GET', '/shell', p, h.group.a);
      expect(res.statusCode, p).toBe(404);
      expect(res.json()).toEqual(missing.json());
    }
  });

  it('returns 404 for invalid groups', async () => {
    for (const g of [h.group.admins, '00000000-0000-4000-8000-000000000000', 'bidder-a']) {
      const res = await call('GET', '/shell', h.person.anika, g);
      expect(res.statusCode, g).toBe(404);
    }
  });

  it('refuses agents', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/shell`,
      headers: { ...headers(h.person.anika, h.group.a), 'x-dev-agent-max-level': '60' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('read only', () => {
  it('refuses writes, downloads and admin reads', async () => {
    const tries = [
      call('PUT', '/grants', h.person.anika, h.group.a, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 60 }] }),
      call('GET', `/nodes/${h.node.aud1}/download?format=pdf`, h.person.anika, h.group.a),
      call('POST', '/visit', h.person.anika, h.group.a),
      call('POST', '/team-requests', h.person.anika, h.group.a, { email: 'x@example.com', givenName: 'X', familyName: 'Y' }),
      call('GET', '/permissions', h.person.anika, h.group.a),
      call('GET', '/events/export.csv', h.person.anika, h.group.a),
    ];
    for (const res of await Promise.all(tries)) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().reason).toBe('see_as_read_only');
    }
    expect((await roomAsSeen(h.person.jan)).fin).toEqual((await roomAsSeen(h.person.anika, h.group.a)).fin);
    expect(await count(`select count(*) as n from access_grant where subject_group_id = $1`, [h.group.a])).toBe(1);
  });

  it('allows only reads and opening documents', () => {
    for (const r of SEE_AS_ROUTES) expect(r.startsWith('GET ') || SEE_AS_POST_READS.has(r), r).toBe(true);
    expect([...SEE_AS_POST_READS].sort()).toEqual(['POST /v1/workspaces/:ws/nodes/:id/open', 'POST /v1/workspaces/:ws/release-preview']);
  });

  it('refuses writes before the body', async () => {
    const res = await app.inject({ method: 'PUT', url: `/v1/workspaces/${h.ws}/grants`,
      headers: { ...headers(h.person.anika, h.group.a), 'content-type': 'application/json' }, payload: '{ not json' });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().reason).toBe('see_as_read_only');
  });

  it('returns not found for non-admin writes', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/workspaces/00000000-0000-4000-8000-000000000000/shell', headers: headers(h.person.jan) });
    const tries = [
      call('PUT', '/grants', h.person.jan, h.group.a, { changes: [] }),
      call('POST', '/visit', h.person.maria, h.group.a),
      app.inject({ method: 'GET', url: '/v1/me/workspaces', headers: headers(h.person.jan, h.group.a) }),
      app.inject({ method: 'GET', url: '/v1/me/workspaces', headers: headers(h.person.anika, h.group.a) }),
    ];
    for (const res of await Promise.all(tries)) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toEqual(missing.json());
    }
  });

  it('shows pages without recording reads', async () => {
    const before = {
      sessions: await count(`select count(*) as n from view_session`),
      opened: await count(`select count(*) as n from event where action in ('document.opened', 'search.performed')`),
      people: await count(`select count(*) as n from person`),
      memberships: await count(`select count(*) as n from membership`),
      acceptances: await count(`select count(*) as n from acceptance`),
    };
    const open = await call('POST', `/nodes/${h.node.aud1}/open`, h.person.anika, h.group.a);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().pageCount).toBe(2);
    // <img> has no headers
    const img = await app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/nodes/${h.node.aud1}/pages/1?session=${open.json().sessionId}&seeAs=${h.group.a}`,
      headers: headers(h.person.anika) });
    expect(img.statusCode, img.body).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    const search = await call('GET', `/search?q=Audited`, h.person.anika, h.group.a);
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().items.map((i: { nodeId: string }) => i.nodeId)).toContain(h.node.aud1);
    const dashboard = await call('GET', '/dashboard', h.person.anika, h.group.a);
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    expect(dashboard.json().role).toBe('member');
    expect({
      sessions: await count(`select count(*) as n from view_session`),
      opened: await count(`select count(*) as n from event where action in ('document.opened', 'search.performed')`),
      people: await count(`select count(*) as n from person`),
      memberships: await count(`select count(*) as n from membership`),
      acceptances: await count(`select count(*) as n from acceptance`),
    }).toEqual(before);
    expect(await count(`select count(*) as n from see_as_preview`)).toBe(0);
    expect(await count(`select count(*) as n from workspace_visit`)).toBe(0);
  });

  it('refuses hidden documents without logging a blocked link', async () => {
    const res = await call('POST', `/nodes/${h.node.aud1}/open`, h.person.anika, h.group.b);
    expect(res.statusCode).toBe(404);
    expect(await count(`select count(*) as n from event where action = 'access.blocked'`)).toBe(0);
  });

  it('logs the start once per half hour', async () => {
    const seen = () => count(`select count(*) as n from event where action = 'room.seen_as'`);
    await call('GET', '/shell', h.person.anika, h.group.a);
    await call('GET', '/dashboard', h.person.anika, h.group.a);
    expect(await seen()).toBe(1);
    await call('GET', '/shell', h.person.anika, h.group.b);
    expect(await seen()).toBe(2);
    await call('GET', '/shell', h.person.jan, h.group.a);
    expect(await seen()).toBe(2);
    clock = new Date(T.at.getTime() + 31 * 60_000);
    await h.pin(clock);
    await call('GET', '/shell', h.person.anika, h.group.a);
    expect(await seen()).toBe(3);

    const log = (await call('GET', '/events?action=room.seen_as', h.person.anika)).json();
    expect(log.items[0]).toMatchObject({ item: 'Saw the room as Bidder A', detail: 'Read only. Nothing they did was recorded.' });
  });

  it('handles API clock lag', async () => {
    clock = new Date(T.at.getTime() - 5);
    const own = await call('GET', '/shell', h.person.anika);
    expect(own.statusCode, own.body).toBe(200);
    const res = await call('GET', '/shell', h.person.anika, h.group.a);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().seeAs.name).toBe('Bidder A');
    const nodes = await call('GET', '/nodes', h.person.anika, h.group.a);
    expect(nodes.statusCode, nodes.body).toBe(200);
    expect(nodes.json().items.map((n: any) => n.id)).toContain(h.node.fin);
    clock = new Date(T.at.getTime() + 60_000);
    expect((await call('GET', '/nodes', h.person.anika, h.group.a)).statusCode).toBe(200);
  });

  it('shows Activity as seller observers see it', async () => {
    const board = (await call('POST', '/groups', h.person.anika, undefined,
      { name: 'Heron board', partyId: h.party.seller, roleTemplate: 'observer' })).json().id as string;
    for (const url of ['/events/verify', '/activity/summary', '/events']) {
      const res = await call('GET', url, h.person.anika, board);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
    }
    expect((await call('GET', '/events', h.person.anika, board)).json().reader).toBe('observer');
  });

  it('leaves My team without the stand-in', async () => {
    const res = await call('GET', '/my-team', h.person.anika, h.group.a);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().groups[0].members.map((m: any) => m.name)).toEqual(['Jan de Vries']);
  });

  it('counts My team without the stand-in', async () => {
    const own = (await call('GET', '/shell', h.person.jan)).json().me.teamSize;
    const seen = (await call('GET', '/shell', h.person.anika, h.group.a)).json().me.teamSize;
    expect(own).toBe(1);
    expect(seen).toBe(own);
  });

  it("counts the admin's own rooms for Switch", async () => {
    const extra = await h.app(async (tx) => (await tx.query<{ id: string }>(
      `insert into workspace (tenant_id, name) values (current_tenant_id(), 'Project Osprey') returning id`)).rows[0]!.id);
    const party = await h.app(async (tx) => (await tx.query<{ id: string }>(
      `insert into party (tenant_id, workspace_id, name, kind) values (current_tenant_id(), $1, 'Quillmont', 'seller') returning id`, [extra])).rows[0]!.id);
    const group = await h.app(async (tx) => (await tx.query<{ id: string }>(
      `insert into groups (tenant_id, workspace_id, party_id, name, role_template) values (current_tenant_id(), $1, $2, 'Admins', 'admin') returning id`, [extra, party])).rows[0]!.id);
    await h.app((tx) => tx.query(`insert into membership (tenant_id, person_id, group_id, role, valid_from) values (current_tenant_id(), $1, $2, 'member', $3)`,
      [h.person.anika, group, T.grantsSet.toISOString()]));
    const own = (await call('GET', '/shell', h.person.anika)).json().room.myRoomCount;
    expect(own).toBeGreaterThan(1);
    expect((await call('GET', '/shell', h.person.anika, h.group.a)).json().room.myRoomCount).toBe(own);
  });

  it('gives My team fields as a member', async () => {
    const own = (await call('GET', '/my-team', h.person.jan)).json();
    const seen = (await call('GET', '/my-team', h.person.anika, h.group.a)).json();
    expect(seen.groups[0].isLead).toBe(false);
    expect(seen.groups[0].organisation).toBe(own.groups[0].organisation);
    expect(seen.groups[0].accessEndsAt).toBe(own.groups[0].accessEndsAt);
    expect(seen.roomAdmins).toEqual(own.roomAdmins);
    expect(seen.groups[0].members.map((m: any) => m.personId)).toEqual(own.groups[0].members.map((m: any) => m.personId));
  });

  it('refuses team requests and notification changes', async () => {
    for (const [method, url] of [['GET', '/team-requests'], ['POST', '/team-requests'], ['POST', '/removal-requests'], ['PUT', '/me/notifications']] as const) {
      const res = await call(method, url, h.person.anika, h.group.a, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${url} ${res.body}`).toBe(403);
      expect(res.json().reason).toBe('see_as_read_only');
    }
  });
});
