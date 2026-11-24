// SPDX-License-Identifier: AGPL-3.0-only
// Every write route needs a decision here, or this test fails.
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { MemoryQueue } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
let clock: Date;
const later = (minutes: number) => new Date(T.at.getTime() + minutes * 60_000);

beforeEach(async () => {
  h = await heron();
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock,
    storage: new MemoryStorage(), keyring: new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64'))), queue: new MemoryQueue() });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

type Decision = 'refused' | 'allowed';
// route: [frozen, archived, kind]; 'closed' means 403 room_closed first
const ROOM: Record<string, [Decision, Decision | 'closed', string]> = {
  'POST /folders': ['refused', 'refused', 'index'],
  'PATCH /nodes/{id}': ['refused', 'refused', 'index'],
  'POST /index/restore': ['refused', 'refused', 'index'],
  'POST /standard-index': ['refused', 'refused', 'index'],
  'POST /nodes/{id}/withdraw': ['allowed', 'refused', 'index'],
  'POST /versions/{id}/withdraw': ['allowed', 'refused', 'index'],
  'POST /versions/{id}/remove-draft': ['allowed', 'refused', 'index'],
  'POST /versions/{id}/process-again': ['allowed', 'refused', 'uploads and publishing'],
  'POST /publish': ['refused', 'refused', 'uploads and publishing'],
  'POST /upload-sessions': ['refused', 'refused', 'uploads and publishing'],
  'POST /upload-sessions/{id}/complete': ['refused', 'refused', 'uploads and publishing'],
  'PUT /upload-sessions/{id}/content': ['allowed', 'allowed', 'own upload, quarantine only'],
  'DELETE /upload-sessions/{id}': ['allowed', 'allowed', 'cancels the caller\'s own upload'],
  // POST, but they only read
  'POST /release-preview': ['allowed', 'allowed', 'reads'],
  'POST /versions/processing': ['allowed', 'allowed', 'reads'],
  'POST /upload-plans': ['allowed', 'allowed', 'reads'],
  'POST /nodes/{id}/open': ['allowed', 'allowed', 'own viewing session'],
  'POST /visit': ['allowed', 'allowed', 'own visit'],
  'POST /nda/accept': ['allowed', 'refused', 'bidders only'],
  // unfreezes; archived rooms can only be deleted
  'PATCH /settings': ['allowed', 'refused', 'room settings'],
  'PUT /logo/{variant}': ['allowed', 'refused', 'room settings'],
  'DELETE /logo/{variant}': ['allowed', 'refused', 'room settings'],
  'PUT /nda': ['allowed', 'refused', 'room settings'],
  'PUT /grants': ['allowed', 'refused', 'access'],
  'POST /groups': ['allowed', 'refused', 'people'],
  'PATCH /groups/{id}': ['allowed', 'refused', 'people'],
  'POST /groups/{id}/revoke': ['allowed', 'allowed', 'removes access'],
  'POST /invitations': ['allowed', 'refused', 'people'],
  'PATCH /memberships/{id}': ['allowed', 'refused', 'people'],
  'POST /memberships/{id}/revoke': ['allowed', 'allowed', 'removes access'],
  'POST /memberships/{id}/restore': ['allowed', 'refused', 'people'],
  'POST /memberships/{id}/remind': ['allowed', 'refused', 'people'],
  'POST /memberships/{id}/make-lead': ['allowed', 'refused', 'people'],
  'POST /memberships/{id}/make-member': ['allowed', 'refused', 'people'],
  'POST /team-requests': ['allowed', 'closed', 'bidders only'],
  'POST /team-requests/{id}/decide': ['allowed', 'refused', 'people'],
  'POST /team-requests/{id}/withdraw': ['allowed', 'closed', 'bidders only'],
  'POST /removal-requests': ['allowed', 'closed', 'bidders only'],
  'POST /removal-requests/{id}/decide': ['allowed', 'refused', 'people'],
  'PATCH /people/{personId}': ['allowed', 'refused', 'people'],
  'POST /people/{personId}/email-change': ['allowed', 'refused', 'people'],
  'POST /people/{personId}/reset-two-factor': ['allowed', 'refused', 'people'],
  'POST /milestones': ['allowed', 'refused', 'timeline'],
  'PATCH /milestones/{id}': ['allowed', 'refused', 'timeline'],
  'DELETE /milestones/{id}': ['allowed', 'refused', 'timeline'],
  'POST /nodes/{id}/ask-for-copy': ['allowed', 'refused', 'mail'],
  'PUT /me/notifications': ['allowed', 'allowed', 'own settings'],
  'POST /v1/site/rooms/{ws}/join': ['allowed', 'allowed', 'a room left without admins can still be deleted'],
  'POST /v1/public/invitations/accept': ['allowed', 'refused', 'invitation'],
  'PUT /v1/me/open-at-sign-in': ['allowed', 'allowed', 'own setting'],
  'POST /v1/workspaces': ['allowed', 'allowed', 'copying from a room only reads it and logs that it was copied'],
};

// write routes that name no room
const NO_ROOM: Record<string, string> = {
  'PATCH /v1/me': 'own details',
  'POST /v1/public/email-change/approve': 'sign-in address',
  'POST /v1/public/email-change/confirm': 'sign-in address',
  'POST /v1/public/email-change/decline': 'sign-in address',
  'POST /v1/site/accounts/{personId}/email-change': 'sign-in address',
  'POST /v1/site/accounts/{personId}/reset-two-factor': 'sign-in',
  'POST /v1/site/accounts/{personId}/disable': 'removes access, never adds any',
  'POST /v1/site/accounts/{personId}/enable': 'memberships stay revoked',
  'PATCH /v1/site/settings': 'installation',
  'DELETE /v1/site/settings/mail': 'installation',
  'PUT /v1/site/branding/logos/{variant}': 'installation',
  'DELETE /v1/site/branding/logos/{variant}': 'installation',
  'POST /v1/site/mail/test': 'installation',
  'POST /v1/site/room-creators': 'installation',
  'DELETE /v1/site/room-creators/{personId}': 'installation',
  'POST /v1/site/admins': 'installation',
  'POST /v1/setup/unlock': 'first-run setup',
  'PUT /v1/setup/admin': 'first-run setup',
  'PUT /v1/setup/organisation': 'first-run setup',
  'PUT /v1/setup/logos/{variant}': 'first-run setup',
  'DELETE /v1/setup/logos/{variant}': 'first-run setup',
  'PUT /v1/setup/mail': 'first-run setup',
  'POST /v1/setup/test-email': 'first-run setup',
  'POST /v1/setup/finish': 'first-run setup',
};

// file and test title
const FROZEN_PROOF: Record<string, [string, string]> = {
  'POST /folders': ['people-rooms', 'freezes the index'],
  'PATCH /nodes/{id}': ['people-rooms', 'freezes the index'],
  'POST /index/restore': ['people-rooms', 'freezes the index'],
  'POST /standard-index': ['standard-index', 'refuses while the room is frozen'],
  'POST /publish': ['people-rooms', 'allows reading and withdraw when frozen'],
  'POST /upload-sessions': ['upload-receipt', 'frozen rooms'],
  'POST /upload-sessions/{id}/complete': ['upload-receipt', 'frozen rooms'],
};

const WS = '/v1/workspaces/{ws}';
const short = (path: string) => (path.startsWith(`${WS}/`) ? path.slice(WS.length) : path);

describe('write routes', () => {
  it('has a decision for every route that writes', () => {
    const doc = app.swagger() as { paths: Record<string, Record<string, unknown>> };
    const writes: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        if (['post', 'put', 'patch', 'delete'].includes(method)) writes.push(`${method.toUpperCase()} ${short(path)}`);
      }
    }
    const decided = [...Object.keys(ROOM), ...Object.keys(NO_ROOM)];
    expect(writes.filter((w) => !decided.includes(w))).toEqual([]);
    expect(decided.filter((d) => !writes.includes(d))).toEqual([]);
    // a path that names a room needs a room decision
    expect(Object.keys(NO_ROOM).filter((r) => r.includes('{ws}'))).toEqual([]);
  });

  it('cites an existing test for each frozen refusal', async () => {
    const refused = Object.entries(ROOM).filter(([, [frozen]]) => frozen === 'refused').map(([route]) => route);
    expect(Object.keys(FROZEN_PROOF).sort()).toEqual(refused.sort());
    for (const [route, [file, title]] of Object.entries(FROZEN_PROOF)) {
      const src = await readFile(new URL(`./${file}.test.ts`, import.meta.url), 'utf8');
      expect([route, src.includes(`it('${title}'`) || src.includes(`describe('${title}'`)]).toEqual([route, true]);
    }
  });
});

describe('archived rooms', () => {
  const W = () => `/v1/workspaces/${h.ws}`;
  type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  const call = (method: Method, url: string, person: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
  const archived = { status: 409, reason: 'room_archived', detail: 'This room is archived and can no longer be changed.' };
  const closed = { status: 403, reason: 'room_closed', detail: 'This room is closed. Only room admins can enter it.' };
  const outcome = (res: { statusCode: number; body: string }) => {
    const b = res.body.startsWith('{') ? JSON.parse(res.body) : {};
    return { status: res.statusCode, reason: b.reason, detail: b.detail };
  };
  // every row of every table
  const snapshot = async () => {
    const tables = (await h.pg.query<{ t: string }>(
      `select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.t);
    const out: Record<string, string> = {};
    for (const t of tables) {
      out[t] = (await h.pg.query<{ s: string }>(
        `select count(*) || ':' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as s from "${t}" x`)).rows[0]!.s;
    }
    return out;
  };
  const current = async (person: string, group: string) => (await h.pg.query<{ id: string }>(
    `select id from membership where person_id = $1 and group_id = $2 and superseded_at = 'infinity' order by valid_from desc, recorded_at desc limit 1`,
    [person, group])).rows[0]!.id;
  const one = async (sql: string, params: unknown[]) => (await h.pg.query<{ id: string }>(sql, params)).rows[0]!.id;
  const ok = async (res: Promise<{ statusCode: number; body: string }>, status: number) => {
    const r = await res;
    expect(r.statusCode, r.body).toBe(status);
    return r.body ? JSON.parse(r.body) : null;
  };
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const bytes = Buffer.from('%PDF-1.4 facility letter');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const token = () => `${h.t1}.${'x'.repeat(43)}`;

  async function prepare() {
    const version = (node: string, no: number) => one(
      `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
       values ($1, $2, $3, $4, $5, 1, 'application/pdf') returning id`, [h.t1, node, no, `k/${node}/${no}`, 'a'.repeat(64)]);
    await version(h.node.aud1, 1);
    const released = await version(h.node.aud1, 2);
    const draft = await version(h.node.audDraft, 1);
    const session = async (name: string) => (await ok(call('POST', `${W()}/upload-sessions`, h.person.anika,
      { targetFolderId: h.node.aud, path: name, size: bytes.length, sha256: sha, mime: 'application/pdf' }), 201)).id as string;
    const toComplete = await session('Facility letter.pdf');
    expect((await app.inject({ method: 'PUT', url: `${W()}/upload-sessions/${toComplete}/content`, payload: bytes,
      headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1, 'content-type': 'application/octet-stream' } })).statusCode).toBe(204);
    const toSend = await session('Guarantee.pdf');
    const toCancel = await session('Side letter.pdf');
    await ok(call('PUT', `${W()}/logo/light`, h.person.anika, { contentType: 'image/png', data: PNG }), 200);
    const milestone = (await ok(call('POST', `${W()}/milestones`, h.person.anika, { title: 'Final bids', dueAt: '2026-12-08T08:00:00Z', notify: false }), 201)).id;
    await ok(call('POST', `${W()}/memberships/${await current(h.person.jan, h.group.a)}/make-lead`, h.person.anika), 200);
    const teamRequest = (await ok(call('POST', `${W()}/team-requests`, h.person.jan,
      { email: 'ola@bidder-a.example', givenName: 'Ola', familyName: 'Berg', company: 'Bidder A', reason: 'Our counsel' }), 201)).id;
    const sven = await one(`insert into person (tenant_id, name, email) values ($1, 'Sven Lund', 'sven@bidder-a.example') returning id`, [h.t1]);
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, sven, h.group.a, T.setup.toISOString()]);
    const removalRequest = (await ok(call('POST', `${W()}/removal-requests`, h.person.jan,
      { membershipId: await current(sven, h.group.a), reason: 'Left the firm' }), 201)).id;
    await ok(call('POST', `${W()}/memberships/${await current(h.person.mei, h.group.b)}/revoke`, h.person.anika), 200);
    const invited = (await ok(call('POST', `${W()}/invitations`, h.person.anika,
      { groupId: h.group.aQna, people: [{ email: 'nina@bidder-a.example', givenName: 'Nina', familyName: 'Holm' }] }), 201)).invitations[0].personId;
    return {
      released, draft, toComplete, toSend, toCancel, milestone, teamRequest, removalRequest, sven,
      jan: await current(h.person.jan, h.group.a),
      lars: await current(h.person.lars, h.group.aFin),
      mei: await current(h.person.mei, h.group.b),
      invited: await current(invited, h.group.aQna),
    };
  }
  type Prepared = Awaited<ReturnType<typeof prepare>>;

  async function archive() {
    clock = later(1);
    await ok(call('PATCH', `${W()}/settings`, h.person.anika, { state: 'closed' }), 200);
    clock = later(2);
    await ok(call('PATCH', `${W()}/settings`, h.person.anika, { state: 'archived' }), 200);
    clock = later(3);
  }

  interface Request { as: string; params?: Record<string, string>; body?: unknown; headers?: Record<string, string>; ok?: number }
  const REQUESTS: Record<string, (x: Prepared) => Request | Request[]> = {
    'POST /folders': () => [{ as: h.person.anika, body: { name: 'Environmental' } }, { as: h.person.anika, body: { parentId: h.node.fin, name: 'Insurance' } }],
    'PATCH /nodes/{id}': () => ({ as: h.person.anika, params: { id: h.node.aud }, body: { name: 'Accounts' } }),
    'POST /index/restore': () => ({ as: h.person.anika, body: { moved: { id: h.node.aud1, parentId: h.node.tax }, items: [{ id: h.node.aud1, indexNumber: '3.4.7' }] } }),
    'POST /standard-index': () => ({ as: h.person.anika }),
    'POST /nodes/{id}/withdraw': () => ({ as: h.person.anika, params: { id: h.node.aud1 }, body: {} }),
    'POST /versions/{id}/withdraw': (x) => ({ as: h.person.anika, params: { id: x.released }, body: {} }),
    'POST /versions/{id}/remove-draft': (x) => ({ as: h.person.anika, params: { id: x.draft }, body: {} }),
    'POST /versions/{id}/process-again': (x) => ({ as: h.person.anika, params: { id: x.draft }, body: {} }),
    'POST /publish': (x) => [{ as: h.person.anika, body: { nodeIds: [h.node.audDraft] } }, { as: h.person.anika, body: { versionIds: [x.draft] } }],
    'POST /upload-sessions': () => ({ as: h.person.anika, body: { targetFolderId: h.node.aud, path: 'Facility letter 2.pdf', size: bytes.length, sha256: sha } }),
    'POST /upload-sessions/{id}/complete': (x) => ({ as: h.person.anika, params: { id: x.toComplete }, body: {} }),
    'PUT /upload-sessions/{id}/content': (x) => ({ as: h.person.anika, params: { id: x.toSend }, body: bytes,
      headers: { 'content-type': 'application/octet-stream' }, ok: 204 }),
    'DELETE /upload-sessions/{id}': (x) => ({ as: h.person.anika, params: { id: x.toCancel }, ok: 204 }),
    'POST /release-preview': () => ({ as: h.person.anika, body: { nodeIds: [h.node.audDraft] }, ok: 200 }),
    'POST /versions/processing': (x) => ({ as: h.person.anika, body: { ids: [x.draft] }, ok: 200 }),
    'POST /upload-plans': () => ({ as: h.person.anika, body: { targetFolderId: h.node.aud, files: [{ path: 'Letter.pdf', size: 10 }] } }),
    'POST /nodes/{id}/open': () => ({ as: h.person.anika, params: { id: h.node.aud1 } }),
    'POST /visit': () => ({ as: h.person.anika, ok: 200 }),
    'POST /nda/accept': () => ({ as: h.person.anika, body: { versionId: h.nda.v1 } }),
    'PATCH /settings': () => [{ name: 'Project Heron II' }, { state: 'deleted', name: 'Gone' }, { state: 'open' }, { requiresNda: false }]
      .map((body) => ({ as: h.person.anika, body })),
    'PUT /logo/{variant}': () => ({ as: h.person.anika, params: { variant: 'dark' }, body: { contentType: 'image/png', data: PNG } }),
    'DELETE /logo/{variant}': () => ({ as: h.person.anika, params: { variant: 'light' } }),
    'PUT /nda': () => ({ as: h.person.anika, body: { body: 'Everything you read here stays confidential.' } }),
    'PUT /grants': () => ({ as: h.person.anika, body: { changes: [{ nodeId: h.node.fin, groupId: h.group.b, level: 20 }] } }),
    'POST /groups': () => ({ as: h.person.anika, body: { name: 'Bidder C', newParty: { name: 'Bidder C', kind: 'bidder' } } }),
    'PATCH /groups/{id}': () => ({ as: h.person.anika, params: { id: h.group.b }, body: { name: 'Bidder B (Skarvik)' } }),
    'POST /groups/{id}/revoke': () => ({ as: h.person.anika, params: { id: h.group.aFin }, body: {}, ok: 200 }),
    'POST /invitations': () => ({ as: h.person.anika,
      body: { groupId: h.group.a, people: [{ email: 'ida@bidder-a.example', givenName: 'Ida', familyName: 'Moe' }] } }),
    'PATCH /memberships/{id}': (x) => ({ as: h.person.anika, params: { id: x.jan }, body: { accessEndsAt: '2027-01-31T00:00:00Z' } }),
    'POST /memberships/{id}/revoke': (x) => ({ as: h.person.anika, params: { id: x.jan }, ok: 200 }),
    'POST /memberships/{id}/restore': (x) => ({ as: h.person.anika, params: { id: x.mei } }),
    'POST /memberships/{id}/remind': (x) => ({ as: h.person.anika, params: { id: x.invited } }),
    'POST /memberships/{id}/make-lead': (x) => ({ as: h.person.anika, params: { id: x.lars } }),
    'POST /memberships/{id}/make-member': (x) => ({ as: h.person.anika, params: { id: x.jan } }),
    'POST /team-requests': () => ({ as: h.person.jan,
      body: { email: 'per@bidder-a.example', givenName: 'Per', familyName: 'Dahl', company: 'Bidder A', reason: 'Our auditor' } }),
    'POST /team-requests/{id}/decide': (x) => ({ as: h.person.anika, params: { id: x.teamRequest }, body: { decision: 'approve' } }),
    'POST /team-requests/{id}/withdraw': (x) => ({ as: h.person.jan, params: { id: x.teamRequest } }),
    'POST /removal-requests': (x) => ({ as: h.person.jan, body: { membershipId: x.sven, reason: 'Left' } }),
    'POST /removal-requests/{id}/decide': (x) => ({ as: h.person.anika, params: { id: x.removalRequest }, body: { decision: 'approve' } }),
    'PATCH /people/{personId}': () => ({ as: h.person.anika, params: { personId: h.person.jan }, body: { givenName: 'Jan', familyName: 'Visser' } }),
    'POST /people/{personId}/email-change': () => ({ as: h.person.anika, params: { personId: h.person.jan }, body: { email: 'jan@bidder-a2.example' } }),
    'POST /people/{personId}/reset-two-factor': () => ({ as: h.person.anika, params: { personId: h.person.jan } }),
    'POST /milestones': () => ({ as: h.person.anika, body: { title: 'Signing', dueAt: '2026-12-18T08:00:00Z', notify: false } }),
    'PATCH /milestones/{id}': (x) => ({ as: h.person.anika, params: { id: x.milestone }, body: { title: 'Final offers' } }),
    'DELETE /milestones/{id}': (x) => ({ as: h.person.anika, params: { id: x.milestone } }),
    'POST /nodes/{id}/ask-for-copy': () => ({ as: h.person.anika, params: { id: h.node.audDraft } }),
    'PUT /me/notifications': () => ({ as: h.person.anika, body: { events: {} }, ok: 200 }),
    'POST /v1/site/rooms/{ws}/join': () => ({ as: h.person.maria, body: { reason: 'To delete the room' }, ok: 200 }),
    'POST /v1/public/invitations/accept': () => ({ as: '', body: { token: token(), givenName: 'Nina', familyName: 'Holm', company: 'Bidder A' } }),
    'PUT /v1/me/open-at-sign-in': () => ({ as: h.person.anika, body: { workspaceId: h.ws }, ok: 200 }),
    'POST /v1/workspaces': () => ({ as: h.person.anika, body: { name: 'Project Heron copy', start: 'copy', copyFrom: { workspaceId: h.ws } }, ok: 201 }),
  };

  const send = (route: string, r: Request) => {
    const [method, path] = route.split(' ') as [Method, string];
    const params: Record<string, string> = { ws: h.ws, ...r.params };
    const url = (path.startsWith('/v1/') ? path : `${WS}${path}`).replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
    const headers = { ...(r.as ? { 'x-dev-person': r.as, 'x-dev-tenant': h.t1 } : {}), ...r.headers };
    return app.inject({ method, url, headers, ...(r.body !== undefined ? { payload: r.body as string } : {}) });
  };
  const requests = (route: string, x: Prepared) => [REQUESTS[route]!(x)].flat();

  async function ready() {
    const x = await prepare();
    await archive();
    // the invitation sent before the archive, with a token the test knows
    await h.pg.query(`update invitation set token_sha256 = encode(sha256(convert_to($1, 'UTF8')), 'hex'), waits_for_room = false
      where status = 'pending'`, [token()]);
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.maria]);
    await h.pg.query(`update person set can_create_rooms = true where id = $1`, [h.person.anika]);
    return x;
  }

  it('has a request for every route that names a room', () => {
    expect(Object.keys(ROOM).filter((route) => !REQUESTS[route])).toEqual([]);
    expect(Object.keys(REQUESTS).filter((route) => !ROOM[route])).toEqual([]);
  });

  it('refuses every change and writes nothing', async () => {
    const x = await ready();
    const before = await snapshot();
    const got: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    for (const [route, [, decision]] of Object.entries(ROOM)) {
      if (decision === 'allowed') continue;
      for (const [i, r] of requests(route, x).entries()) {
        got[`${route} #${i + 1}`] = outcome(await send(route, r));
        want[`${route} #${i + 1}`] = decision === 'closed' ? closed : archived;
      }
    }
    expect(got).toEqual(want);
    expect(await snapshot()).toEqual(before);
  });

  it('still allows what the table allows', async () => {
    const x = await ready();
    const got: Record<string, unknown> = {};
    for (const [route, [, decision]] of Object.entries(ROOM)) {
      if (decision !== 'allowed') continue;
      for (const [i, r] of requests(route, x).entries()) {
        const res = await send(route, r);
        const { status, reason } = outcome(res);
        expect(reason, `${route}: ${res.body}`).not.toBe('room_archived');
        expect(status, `${route}: ${res.body}`).toBeLessThan(500);
        if (r.ok) got[`${route} #${i + 1}`] = status === r.ok ? 'ok' : res.body;
      }
    }
    expect(Object.entries(got).filter(([, v]) => v !== 'ok')).toEqual([]);
  });

  it('still removes access and lets an admin delete the room', async () => {
    await archive();
    expect((await call('POST', `${W()}/memberships/${await current(h.person.lars, h.group.aFin)}/revoke`, h.person.anika, {})).statusCode).toBe(200);
    expect((await call('POST', `${W()}/groups/${h.group.b}/revoke`, h.person.anika, {})).statusCode).toBe(200);
    expect((await call('PUT', `${W()}/me/notifications`, h.person.anika, { events: {} })).statusCode).toBe(200);
    clock = later(4);
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { state: 'closed' })).statusCode).toBe(409);
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { state: 'deleted' })).statusCode).toBe(200);
    expect((await h.pg.query(`select state from workspace where id = $1`, [h.ws])).rows[0]).toEqual({ state: 'deleted' });
  });

  it('lets a site admin delete a room with no admin', async () => {
    await archive();
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.maria]);
    expect((await call('POST', `/v1/site/rooms/${h.ws}/join`, h.person.maria, { reason: 'To delete the room' })).statusCode).toBe(200);
    expect((await call('POST', `${W()}/milestones`, h.person.maria, { title: 'Final bids', dueAt: '2026-12-08T08:00:00Z', notify: false })).statusCode).toBe(409);
    expect((await call('PATCH', `${W()}/settings`, h.person.maria, { state: 'deleted' })).statusCode).toBe(200);
  });
});
