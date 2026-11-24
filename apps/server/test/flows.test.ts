// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { effectiveAccess, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

const A2 = { givenName: 'Sven', familyName: 'Lund', company: 'Skjolvik Partners' };


let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
let clock: Date;
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `pm-${outbox.length}` }; } };

beforeEach(async () => {
  h = await heron();
  outbox = [];
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const as = (person: string) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1 });
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: as(person), ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const later = (minutes: number) => new Date(T.at.getTime() + minutes * 60_000);
const level = (person: string, node: string, at = clock, knownAt?: Date) =>
  h.app((tx) => effectiveAccess(tx, person, node, { at, ...(knownAt ? { knownAt } : {}) })).then((a) => a.level);
const tokenFrom = (m: OutgoingMessage) => /\/invite\/(\S+)/.exec(m.text!)![1]!;

async function grant(nodeId: string, groupId: string, lvl: number) {
  const res = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId, groupId, level: lvl }] });
  expect(res.statusCode).toBe(200);
}

describe('rooms', () => {
  it('lists my rooms with groups and next milestone', async () => {
    await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Non-binding offers due', dueAt: '2026-11-27T15:00:00Z' });
    await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Management presentation, Bidder B', dueAt: '2026-11-20T08:00:00Z', visibleToGroupIds: [h.group.b] });
    const rooms = (await call('GET', '/v1/me/workspaces', h.person.jan)).json().items;
    expect(rooms).toEqual([{ id: h.ws, name: 'Project Heron', state: 'open', groups: ['Bidder A'], isAdmin: false,
      nextMilestone: { title: 'Non-binding offers due', dueAt: '2026-11-27T15:00:00.000Z' }, openAtSignIn: false, logos: { light: false, dark: false },
      onBehalfOf: 'Seller', contactName: expect.any(String), stateSince: rooms[0].stateSince }]);
  });

  it('creates a draft room with numbered folders', async () => {
    expect((await call('POST', '/v1/workspaces', h.person.jan, { name: 'Project Osprey' })).statusCode).toBe(404);
    await h.pg.query(`update person set can_create_rooms = true where id = $1`, [h.person.anika]);
    const res = await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Osprey', timeZone: 'Europe/London', topFolders: ['Corporate', 'Legal', 'Finance'] });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    const top = (await call('GET', `/v1/workspaces/${id}/nodes`, h.person.anika)).json().items;
    expect(top.map((n: any) => `${n.indexNumber} ${n.name}`)).toEqual(['1 Corporate', '2 Legal', '3 Finance']);
    expect(top[0].access.allowed).toContain('manage');
    const mine = (await call('GET', '/v1/me/workspaces', h.person.anika)).json().items.find((r: any) => r.id === id);
    expect(mine).toMatchObject({ state: 'preparing', isAdmin: true, groups: ['Room admins'] });
  });

  it('updates settings and rejects invalid state changes', async () => {
    const s = await call('PATCH', `${W()}/settings`, h.person.anika, { watermark: { ip: true },
      notifications: { documents: { mode: 'digest', digestTimes: ['08:00', '17:00'], mandatory: false } } });
    expect(s.json()).toMatchObject({ watermark: { name: true, ip: true }, notifications: { documents: { mode: 'digest' } } });
    expect(s.json()).not.toHaveProperty('hideNamesInEmail');
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { state: 'archived' })).statusCode).toBe(409);
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { state: 'draft' })).statusCode).toBe(400);
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { state: 'closed' })).json().state).toBe('closed');
    expect((await call('PATCH', `${W()}/settings`, h.person.jan, { name: 'Hijack' })).statusCode).toBe(403);
    const actions = (await call('GET', `${W()}/events`, h.person.anika)).json().items.map((e: any) => e.action);
    expect(actions).toEqual(['workspace.state_changed', 'workspace.settings_changed']);
  });

  it('refuses a watermark without the name or the email address', async () => {
    const off = { name: false, email: false, group: false, dateTime: false, ip: false };
    const refused = await call('PATCH', `${W()}/settings`, h.person.anika, { watermark: off });
    expect([refused.statusCode, refused.json().detail]).toEqual([400, 'A watermark must carry at least the name or the email address.']);
    // also when the other switch is already off
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { watermark: { name: false } })).statusCode).toBe(200);
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { watermark: { email: false } })).statusCode).toBe(400);
    const s = (await call('GET', `${W()}/settings`, h.person.anika)).json();
    expect(s.watermark).toMatchObject({ name: false, email: true });
  });

  it('counts visits within 30 minutes as one', async () => {
    expect((await call('POST', `${W()}/visit`, h.person.jan)).json().previousVisitAt).toBeNull();
    clock = later(10);
    expect((await call('POST', `${W()}/visit`, h.person.jan)).json().previousVisitAt).toBeNull();
    clock = later(180);
    expect((await call('POST', `${W()}/visit`, h.person.jan)).json().previousVisitAt).toBe(later(10).toISOString());
  });
});

describe('NDA', () => {
  it('blocks bidders until they accept the new version', async () => {
    await grant(h.node.fin, h.group.a, 20);
    expect(await level(h.person.jan, h.node.aud1)).toBe(20);
    clock = later(5);
    await call('PUT', `${W()}/nda`, h.person.anika, { body: 'Confidentiality undertaking, version 2, with a non-solicitation clause.' });
    clock = later(6);
    expect(await level(h.person.jan, h.node.aud1)).toBe(0);
    const nda = (await call('GET', `${W()}/nda`, h.person.jan)).json();
    expect(nda).toMatchObject({ required: true, versionNo: 2, acceptedAt: null });
    expect((await call('POST', `${W()}/nda/accept`, h.person.jan, { versionId: h.nda.v1 })).statusCode).toBe(409);
    expect((await call('POST', `${W()}/nda/accept`, h.person.jan, { versionId: nda.versionId })).statusCode).toBe(200);
    expect(await level(h.person.jan, h.node.aud1)).toBe(20);
  });

  it('hides the NDA from non-members', async () => {
    const outsider = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'X', 'x@example.com') returning id`, [h.t1])).rows[0]!.id;
    expect((await call('GET', `${W()}/nda`, outsider)).statusCode).toBe(404);
  });
});

describe('invitations', () => {
  it('invites by email', async () => {
    await grant(h.node.fin, h.group.b, 20);
    const res = await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'Sven@Bidder-B.example', name: 'Sven Lund' }] });
    expect(res.statusCode).toBe(201);
    const sven = res.json().invitations[0].personId;
    expect(outbox[0]).toMatchObject({ to: 'sven@bidder-b.example', subject: 'Invitation to the Project Heron data room' });
    expect(outbox[0]!.text!.startsWith(['Dear Sven,', '',
      'Quillmont Advisory has invited you to the Project Heron data room on behalf of Seller. Use the button in this email to sign in. You will be asked to accept the confidentiality agreement before you see any documents.',
      '', 'Your access runs until the room closes.'].join('\n'))).toBe(true);
    expect(outbox[0]!.text).toMatch(/^Open the data room: https:\/\/\S+\/invite\/\S+$/m);
    expect(outbox[0]!.text).toContain('This invitation is for sven@bidder-b.example only and expires after 14 days.');
    expect(outbox[0]!.html).toContain('>Open the data room</a>');
    expect(await level(sven, h.node.aud1)).toBe(0);

    const people = (await call('GET', `${W()}/people`, h.person.anika)).json();
    const bGroup = people.parties.flatMap((p: any) => p.groups).find((g: any) => g.id === h.group.b);
    expect(bGroup.members.find((m: any) => m.personId === sven).status).toBe('invited');

    clock = later(60);
    const token = tokenFrom(outbox[0]!);
    const ok = await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token, ...A2 } });
    expect(ok.json()).toEqual({ workspaceId: h.ws, personId: sven });
    // nothing until the NDA is signed
    expect(await level(sven, h.node.aud1)).toBe(0);
    await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values ($1, $2, $3, $4)`, [h.t1, h.nda.v1, sven, later(61).toISOString()]);
    clock = later(62);
    expect(await level(sven, h.node.aud1)).toBe(20);
    expect(await level(sven, h.node.aud1, later(30), later(62))).toBe(0);

    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token, ...A2 } })).statusCode).toBe(410);
    const log = (await call('GET', `${W()}/events`, h.person.anika)).json().items.map((e: any) => e.action);
    expect(log).toEqual(expect.arrayContaining(['invitation.created', 'invitation.sent', 'invitation.accepted']));
  });

  it('rejects forged and expired links alike', async () => {
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'a@b.example', name: 'A' }] });
    const forged = `${h.t1}.${'x'.repeat(43)}`;
    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token: forged, ...A2 } })).statusCode).toBe(410);
    clock = later(15 * 24 * 60);
    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token: tokenFrom(outbox[0]!), ...A2 } })).statusCode).toBe(410);
  });

  it('revokes a person and keeps history', async () => {
    await grant(h.node.fin, h.group.b, 20);
    const people = (await call('GET', `${W()}/people`, h.person.anika)).json();
    const mei = people.parties.flatMap((p: any) => p.groups).flatMap((g: any) => g.members).find((m: any) => m.personId === h.person.mei);
    clock = later(60);
    expect((await call('POST', `${W()}/memberships/${mei.membershipId}/revoke`, h.person.anika)).statusCode).toBe(200);
    expect(await level(h.person.mei, h.node.aud1)).toBe(0);
    expect(await level(h.person.mei, h.node.aud1, later(30), later(61))).toBe(20);
    const after = (await call('GET', `${W()}/people`, h.person.anika)).json();
    const row = after.parties.flatMap((p: any) => p.groups).flatMap((g: any) => g.members).find((m: any) => m.personId === h.person.mei);
    expect(row.status).toBe('revoked');
  });

  it('revokes a group with its subgroup', async () => {
    await grant(h.node.fin, h.group.a, 20);
    await grant(h.node.fin, h.group.aFin, 20);
    expect(await level(h.person.lars, h.node.aud1)).toBe(20);
    expect((await call('POST', `${W()}/groups/${h.group.a}/revoke`, h.person.anika)).statusCode).toBe(200);
    expect([await level(h.person.jan, h.node.aud1), await level(h.person.lars, h.node.aud1)]).toEqual([0, 0]);
    expect((await call('POST', `${W()}/groups/${h.group.admins}/revoke`, h.person.anika)).statusCode).toBe(400);
  });
});

describe('colleague requests', () => {
  beforeEach(async () => {
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]);
  });

  it('approves a lead request and invites the colleague', async () => {
    const req = await call('POST', `${W()}/team-requests`, h.person.jan, { givenName: 'Thandi', familyName: 'Mokoena', email: 'thandi@bidder-a.example', company: 'Orrinby Capital', jobTitle: 'Tax adviser', reason: 'Tax adviser on our team' });
    expect(req.statusCode).toBe(201);
    const other = await call('GET', `${W()}/team-requests`, h.person.mei);
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toMatch(/Thandi/);
    const pending = (await call('GET', `${W()}/team-requests?status=pending`, h.person.anika)).json().items;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ groupName: 'Bidder A', requestedBy: 'Jan de Vries', name: 'Thandi Mokoena' });

    const done = await call('POST', `${W()}/team-requests/${pending[0].id}/decide`, h.person.anika, { decision: 'approve' });
    expect(done.json().status).toBe('approved');
    expect(outbox.map((m) => m.to)).toEqual(['anika@quillmont.example', 'thandi@bidder-a.example', 'jan@bidder-a.example']);
    expect(outbox[0]!.subject).toBe('Jan de Vries asks to add a colleague to Bidder A');
    expect((await call('POST', `${W()}/team-requests/${pending[0].id}/decide`, h.person.anika, { decision: 'decline' })).statusCode).toBe(409);

    const team = (await call('GET', `${W()}/my-team`, h.person.jan)).json().groups[0];
    expect(team).toMatchObject({ name: 'Bidder A', isLead: true });
    expect(team.members.map((m: any) => `${m.name} ${m.status}`)).toEqual(['Jan de Vries active', 'Thandi Mokoena invited']);
  });

  it('requires a bidder lead', async () => {
    const res = await call('POST', `${W()}/team-requests`, h.person.mei, { givenName: 'X', familyName: 'Y', email: 'x@bidder-b.example', company: 'Z' });
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('not_group_lead');
  });
});

describe('documents', () => {
  it('numbers new folders after the first run', async () => {
    // 6 does not push new folders after it
    expect((await call('POST', `${W()}/folders`, h.person.anika, { name: 'Environmental' })).json().indexNumber).toBe('4');
    expect((await call('POST', `${W()}/folders`, h.person.anika, { parentId: h.node.fin, name: 'Treasury' })).json().indexNumber).toBe('3.3');
    expect((await call('POST', `${W()}/folders`, h.person.maria, { parentId: h.node.fin, name: 'X' })).statusCode).toBe(403);
    expect((await call('POST', `${W()}/folders`, h.person.jan, { parentId: h.node.fin, name: 'X' })).statusCode).toBe(404);
  });

  it('publishes from Release review and notifies groups', async () => {
    await grant(h.node.fin, h.group.a, 20);
    const preview = (await call('POST', `${W()}/release-preview`, h.person.anika, {})).json().items;
    expect(preview.map((d: any) => [d.indexNumber, d.groups.map((g: any) => g.name)])).toEqual([['3.2.5', ['Bidder A']]]);
    expect(await level(h.person.jan, h.node.audDraft)).toBe(0);
    const pub = (await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft] })).json();
    expect(pub).toMatchObject({ published: 1 });
    expect(pub.notified).toBeGreaterThanOrEqual(1);
    expect(await level(h.person.jan, h.node.audDraft)).toBe(20);
    const n = await h.pg.query(`select 1 from notification where person_id = $1`, [h.person.jan]);
    expect(n.rows).toHaveLength(1);
  });

  it('publishes a draft folder with its document', async () => {
    const folder = (await call('POST', `${W()}/folders`, h.person.anika, { parentId: h.node.fin, name: 'Treasury' })).json().id;
    await h.pg.query(`insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state) values ($1, $2, $3, 'document', 'Cash pool.pdf', '3.5.1', 'draft')`, [h.t1, h.ws, folder]);
    const doc = (await h.pg.query<{ id: string }>(`select id from node where name = 'Cash pool.pdf'`)).rows[0]!.id;
    expect((await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [doc] })).json().published).toBe(2);
  });

  it('withdraws a document', async () => {
    await grant(h.node.fin, h.group.a, 20);
    expect((await call('POST', `${W()}/nodes/${h.node.aud1}/withdraw`, h.person.anika, { reason: 'Replaced by restated accounts' })).statusCode).toBe(200);
    expect(await level(h.person.jan, h.node.aud1)).toBe(0);
    expect(await level(h.person.anika, h.node.aud1)).toBe(60);
  });

  it('confirms before renumbering published items', async () => {
    const first = await call('PATCH', `${W()}/nodes/${h.node.tax}`, h.person.anika, { position: 1 });
    expect(first.statusCode).toBe(409);
    expect(first.json().items).toEqual(expect.arrayContaining([{ id: h.node.tax, from: '3.4', to: '3.1' }]));
    const ok = (await call('PATCH', `${W()}/nodes/${h.node.tax}`, h.person.anika, { position: 1, confirmRenumberPublished: true })).json();
    const map = Object.fromEntries(ok.renumbered.map((c: any) => [c.from, c.to]));
    expect(map).toEqual({ '3.4': '3.1', '3.4.6': '3.1.6' });
    const aud = (await call('GET', `${W()}/nodes?parent=${h.node.aud}`, h.person.anika)).json().items.map((n: any) => n.indexNumber);
    expect(aud).toEqual(['3.2.1', '3.2.5']);
  });

  it('moves a folder and renumbers its contents', async () => {
    const ok = (await call('PATCH', `${W()}/nodes/${h.node.tax}`, h.person.anika, { parentId: h.node.it, confirmRenumberPublished: true })).json();
    expect(Object.fromEntries(ok.renumbered.map((c: any) => [c.from, c.to]))).toEqual({ '3.4': '6.1', '3.4.6': '6.1.6' });
    const fin = (await call('GET', `${W()}/nodes?parent=${h.node.fin}`, h.person.anika)).json().items.map((n: any) => n.indexNumber);
    expect(fin).toEqual(['3.2']);
  });
});

describe('timeline', () => {
  it('limits milestones to their groups', async () => {
    const res = await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Management presentation, Bidder A', dueAt: '2026-12-08T08:00:00Z', visibleToGroupIds: [h.group.a] });
    expect(res.statusCode).toBe(201);
    expect((await call('GET', `${W()}/milestones`, h.person.jan)).json().items.map((m: any) => m.title)).toEqual(['Management presentation, Bidder A']);
    expect((await call('GET', `${W()}/milestones`, h.person.lars)).json().items).toHaveLength(1);
    expect((await call('GET', `${W()}/milestones`, h.person.mei)).json().items).toEqual([]);
    const notified = (await h.pg.query<{ person_id: string }>(`select distinct person_id from notification where category = 'deadlines'`)).rows.map((r) => r.person_id);
    expect(notified).toContain(h.person.jan);
    expect(notified).not.toContain(h.person.mei);
    expect((await call('GET', `${W()}/milestones`, h.person.jan)).json().items[0].visibleToGroupIds).toBeUndefined();
  });

  it('requires room admin', async () => {
    expect((await call('POST', `${W()}/milestones`, h.person.jan, { title: 'Mine', dueAt: '2026-12-01T08:00:00Z' })).statusCode).toBe(403);
    const id = (await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Q&A cut-off', dueAt: '2027-01-22T15:00:00Z' })).json().id;
    expect((await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { dueAt: '2027-01-29T15:00:00Z' })).json().dueAt).toBe('2027-01-29T15:00:00.000Z');
    expect((await call('DELETE', `${W()}/milestones/${id}`, h.person.anika)).statusCode).toBe(204);
    expect((await call('GET', `${W()}/milestones`, h.person.anika)).json().items).toEqual([]);
  });
});

describe('dashboard', () => {
  async function opened(person: string, node: string, at: Date) {
    const v = (await h.pg.query<{ id: string }>(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
      values ($1, $2, (select coalesce(max(version_no), 0) + 1 from document_version where node_id = $2), 'k', $3, 1, 'application/pdf') returning id`,
      [h.t1, node, 'ef'.repeat(32)])).rows[0]!.id;
    await h.pg.query(`insert into view_session (tenant_id, workspace_id, node_id, version_id, person_id, opened_at, last_seen_at, page_count, pages_seen)
      values ($1, $2, $3, $4, $5, $6, $6, 2, '{1}')`, [h.t1, h.ws, node, v, person, at.toISOString()]);
  }

  it('shows a bidder new items, deadlines and own reading', async () => {
    await grant(h.node.fin, h.group.a, 20);
    await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Non-binding offers due', dueAt: '2026-11-27T15:00:00Z' });
    await h.pg.query(`update node set published_at = $1 where state = 'published'`, [T.grantsSet.toISOString()]);
    clock = later(0);
    await call('POST', `${W()}/visit`, h.person.jan);
    clock = later(120);
    await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft] });
    clock = later(300);
    await call('POST', `${W()}/visit`, h.person.jan);
    await opened(h.person.jan, h.node.aud1, later(301));

    const d = (await call('GET', `${W()}/dashboard`, h.person.jan)).json();
    expect(d.role).toBe('member');
    expect(d.previousVisitAt).toBe(later(0).toISOString());
    expect(d.newSinceLastVisit).toEqual([{ folder: '3 Finance', folderId: expect.any(String), count: 1, items: [expect.objectContaining({ indexNumber: '3.2.5', read: false })] }]);
    expect(d.teamCoverage).toBeUndefined();
    expect(d.myCoverage).toMatchObject({ opened: 1, total: 3, folders: [{ folder: '3 Finance', opened: 1, total: 3 }] });
    expect(d.milestones.map((m: any) => m.title)).toEqual(['Non-binding offers due']);
    expect(d.toDo).toBeUndefined();
  });

  it('shows admins tasks and activity per group', async () => {
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]);
    await call('POST', `${W()}/team-requests`, h.person.jan, { givenName: 'Thandi', familyName: 'Mokoena', email: 'thandi@bidder-a.example', company: 'Orrinby Capital' });
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, processing_status, processing_error)
      values ($1, $2, 1, 'k', $3, 1, 'application/vnd.ms-excel', 'failed', 'The file is password protected, so VDRkit cannot convert it for viewing.')`,
      [h.t1, h.node.audDraft, 'aa'.repeat(32)]);
    await opened(h.person.jan, h.node.aud1, later(-60));
    await opened(h.person.jan, h.node.tax1, later(-30));
    await opened(h.person.jan, h.node.aud1, new Date('2026-11-10T09:00:00Z'));

    const d = (await call('GET', `${W()}/dashboard`, h.person.anika)).json();
    expect(d.role).toBe('admin');
    expect(d.toDo.drafts).toMatchObject({ count: 1, byFolder: [{ folder: '3.2 Audited financials', count: 1 }] });
    expect(d.toDo.accessRequests).toEqual([expect.objectContaining({ name: 'Thandi Mokoena', groupName: 'Bidder A', requestedBy: 'Jan de Vries' })]);
    expect(d.toDo.failedProcessing[0]).toMatchObject({ indexNumber: '3.2.5', error: expect.stringContaining('password protected') });
    const a = d.activity.find((g: any) => g.groupName === 'Bidder A');
    expect(a).toMatchObject({ members: 1, activeToday: 1, openedToday: 2 });
    expect(a.lastSevenDays).toEqual([0, 0, 0, 0, 1, 0, 2]);   // Tue and Thu, SAST
    expect(d.activity.find((g: any) => g.groupName === 'Bidder B')).toMatchObject({ openedToday: 0, lastSeenAt: null });
  });
});
