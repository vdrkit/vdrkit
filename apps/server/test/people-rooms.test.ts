// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { effectiveAccess, type Channel, type OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, person: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1, ...extra }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const later = (minutes: number) => new Date(T.at.getTime() + minutes * 60_000);
const level = (person: string, node: string) => h.app((tx) => effectiveAccess(tx, person, node, { at: clock })).then((a) => a.level);
const tokenFrom = (m: OutgoingMessage) => /\/invite\/(\S+)/.exec(m.text!)![1]!;
const accept = (token: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/v1/public/invitations/accept',
  payload: { token, givenName: 'Sven', familyName: 'Lund', company: 'Skjolvik Partners', ...extra } });
const events = async (action: string) => (await call('GET', `${W()}/events?action=${action}`, h.person.anika)).json().items;

async function grant(changes: Record<string, unknown>[]) {
  const res = await call('PUT', `${W()}/grants`, h.person.anika, { changes });
  expect(res.statusCode).toBe(200);
}
async function secondRoomWithJan(): Promise<string> {
  const ws = (await h.pg.query<{ id: string }>(`insert into workspace (tenant_id, name, state) values ($1, 'Project Osprey', 'open') returning id`, [h.t1])).rows[0]!.id;
  const party = (await h.pg.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder', 'bidder') returning id`, [h.t1, ws])).rows[0]!.id;
  const g = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder 1') returning id`, [h.t1, ws, party])).rows[0]!.id;
  await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, h.person.jan, g]);
  return ws;
}
async function colleague(name = 'Pieter Botha', email = 'pieter@bidder-a.example'): Promise<{ personId: string; membershipId: string }> {
  const personId = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, $2, $3) returning id`, [h.t1, name, email])).rows[0]!.id;
  const membershipId = (await h.pg.query<{ id: string }>(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3) returning id`,
    [h.t1, personId, h.group.a])).rows[0]!.id;
  await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id) values ($1, $2, $3)`, [h.t1, h.nda.v1, personId]);
  return { personId, membershipId };
}
const membershipOf = async (person: string, group: string) => (await h.pg.query<{ id: string }>(
  `select id from membership where person_id = $1 and group_id = $2 and superseded_at = 'infinity' order by valid_from desc limit 1`, [person, group])).rows[0]!.id;
const makeLead = async (person: string, group: string) => {
  const res = await call('POST', `${W()}/memberships/${await membershipOf(person, group)}/make-lead`, h.person.anika);
  expect(res.statusCode).toBe(200);
};

describe('profile', () => {
  it('returns my details', async () => {
    expect((await call('GET', '/v1/me', h.person.jan)).json()).toEqual({ personId: h.person.jan, email: 'jan@bidder-a.example',
      givenName: 'Jan', familyName: 'de Vries', name: 'Jan de Vries', company: null, jobTitle: null, timeZone: 'UTC',
      canCreateRooms: false, isSiteAdmin: false, organisation: expect.any(String) });
  });

  it('logs detail changes in every room', async () => {
    const osprey = await secondRoomWithJan();
    const res = await call('PATCH', '/v1/me', h.person.jan, { givenName: 'Johannes', company: 'Orrinby Capital', jobTitle: 'Partner' });
    expect(res.json()).toMatchObject({ name: 'Johannes de Vries', company: 'Orrinby Capital', jobTitle: 'Partner' });
    const rows = (await h.pg.query<any>(`select workspace_id, data from event where action = 'person.details_changed' order by workspace_id`)).rows;
    expect(rows.map((r) => r.workspace_id).sort()).toEqual([h.ws, osprey].sort());
    expect(rows[0].data).toEqual({ person_id: h.person.jan, fields: ['name', 'company', 'job_title'] });
    expect(JSON.stringify(rows)).not.toMatch(/Johannes|Orrinby|Partner/);

    const [e] = await events('person.details_changed');
    expect(e.personal).toEqual({
      before: { givenName: 'Jan', familyName: 'de Vries', company: null, jobTitle: null },
      after: { givenName: 'Johannes', familyName: 'de Vries', company: 'Orrinby Capital', jobTitle: 'Partner' },
    });
    const csv = (await call('GET', `${W()}/events/export.csv?action=person.details_changed`, h.person.anika)).body;
    expect(csv).toContain('Changed personal details');
    expect(csv).toContain('first name: Jan -> Johannes, company: (none) -> Orrinby Capital, job title: (none) -> Partner');
  });

  it('forgets values on erasure', async () => {
    await call('PATCH', '/v1/me', h.person.jan, { company: 'Orrinby Capital' });
    await h.pg.query(`update person set name = 'Erased user', email = 'erased-' || id || '@invalid', erased_at = now() where id = $1`, [h.person.jan]);
    expect((await events('person.details_changed'))[0].personal).toBeNull();
    expect((await call('GET', `${W()}/events/verify`, h.person.anika)).json()).toMatchObject({ intact: true });
  });

  it('stores the time zone without an event', async () => {
    expect((await call('PATCH', '/v1/me', h.person.jan, { timeZone: 'Europe/London' })).json().timeZone).toBe('Europe/London');
    expect(await events('person.details_changed')).toEqual([]);
    expect((await call('PATCH', '/v1/me', h.person.jan, { timeZone: '+02:00' })).statusCode).toBe(400);
    expect((await call('PATCH', '/v1/me', h.person.jan, { timeZone: 'Mars/Olympus' })).statusCode).toBe(400);
  });

  it('rejects empty names, email changes and agents', async () => {
    expect((await call('PATCH', '/v1/me', h.person.jan, { familyName: ' ' })).statusCode).toBe(400);
    expect((await call('PATCH', '/v1/me', h.person.jan, { email: 'other@example.com' })).statusCode).toBe(400);
    const agent = { 'x-dev-agent-max-level': '20' };
    expect((await call('PATCH', '/v1/me', h.person.jan, { company: 'X' }, agent)).statusCode).toBe(403);
    expect((await call('GET', '/v1/me', h.person.jan)).json().email).toBe('jan@bidder-a.example');
  });
});

describe('admin edits a person', () => {
  it('logs the change in every room', async () => {
    const osprey = await secondRoomWithJan();
    const kestrel = (await h.pg.query<{ id: string }>(`insert into workspace (tenant_id, name, state) values ($1, 'Project Kestrel', 'open') returning id`, [h.t1])).rows[0]!.id;
    const party = (await h.pg.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder', 'bidder') returning id`, [h.t1, kestrel])).rows[0]!.id;
    const g = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder 1') returning id`, [h.t1, kestrel, party])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, status) values ($1, $2, $3, 'approved')`, [h.t1, h.person.jan, g]);
    expect((await call('PATCH', `${W()}/people/${h.person.jan}`, h.person.anika, { company: 'Orrinby Capital' })).json().reason).toBe('target_in_other_room');
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);

    const res = await call('PATCH', `${W()}/people/${h.person.jan}`, h.person.anika, { familyName: 'de Vries-Mokoena', company: 'Orrinby Capital' });
    expect(res.json()).toMatchObject({ name: 'Jan de Vries-Mokoena', company: 'Orrinby Capital' });
    const rows = (await h.pg.query<any>(`select workspace_id, data from event where action = 'person.details_changed'`)).rows;
    expect(rows.map((r) => r.workspace_id).sort()).toEqual([h.ws, osprey, kestrel].sort());
    expect(rows[0].data).toEqual({ person_id: h.person.jan, fields: ['name', 'company'] });
    expect((await call('PATCH', `/v1/workspaces/${osprey}/people/${h.person.jan}`, h.person.anika, { company: 'X' })).statusCode).toBe(404);
  });
});

describe('accept invitation', () => {
  it('stores name, company and time zone', async () => {
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'sven@bidder-b.example' }] });
    expect(outbox[0]!.text!.split('\n')[0]).toBe('Dear colleague,');
    const ok = await accept(tokenFrom(outbox[0]!), { jobTitle: 'Analyst', timeZone: 'Europe/Stockholm' });
    expect(ok.statusCode).toBe(200);
    const p = (await h.pg.query<any>(`select name, given_name, family_name, company, job_title, time_zone from person where id = $1`, [ok.json().personId])).rows[0];
    expect(p).toEqual({ name: 'Sven Lund', given_name: 'Sven', family_name: 'Lund', company: 'Skjolvik Partners', job_title: 'Analyst', time_zone: 'Europe/Stockholm' });
    expect(await events('person.details_changed')).toEqual([]);
  });

  it('requires company and names', async () => {
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'sven@bidder-b.example' }] });
    expect((await accept(tokenFrom(outbox[0]!), { company: '' })).statusCode).toBe(400);
    expect((await accept(tokenFrom(outbox[0]!), { familyName: undefined })).statusCode).toBe(400);
  });

  it('logs changes in existing rooms', async () => {
    const osprey = await secondRoomWithJan();
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'jan@bidder-a.example' }] });
    expect(outbox[0]!.text!.split('\n')[0]).toBe('Dear Jan,');
    await accept(tokenFrom(outbox[0]!), { givenName: 'Jan', familyName: 'de Vries', company: 'Orrinby Capital' });
    const rows = (await h.pg.query<any>(`select workspace_id from event where action = 'person.details_changed'`)).rows;
    expect(rows.map((r) => r.workspace_id).sort()).toEqual([h.ws, osprey].sort());
  });
});

describe('colleague requests', () => {
  beforeEach(async () => { await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]); });
  const ask = async (person = h.person.jan, over: Record<string, unknown> = {}) => {
    const res = await call('POST', `${W()}/team-requests`, person,
      { givenName: 'Thandi', familyName: 'Mokoena', email: 'Thandi@Bidder-A.example', company: 'Orrinby Capital', jobTitle: 'Tax adviser', ...over });
    outbox.splice(0, outbox.length, ...outbox.filter((m) => !/asks to add a colleague/.test(m.subject)));
    return res;
  };

  it('invites the approved colleague', async () => {
    await h.pg.query(`update groups set valid_to = '2027-01-31T22:00:00Z' where id = $1`, [h.group.a]);
    const id = (await ask()).json().id;
    const listed = (await call('GET', `${W()}/team-requests`, h.person.jan)).json().items[0];
    expect(listed).toMatchObject({ name: 'Thandi Mokoena', givenName: 'Thandi', familyName: 'Mokoena', company: 'Orrinby Capital', jobTitle: 'Tax adviser' });
    await call('POST', `${W()}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' });
    const inv = (await h.pg.query<any>(`select i.access_expires_at, m.valid_to, p.given_name, p.family_name, p.company, p.job_title
      from invitation i join membership m on m.id = i.membership_id join person p on p.id = i.person_id where p.email = 'thandi@bidder-a.example'`)).rows[0];
    expect(new Date(inv.access_expires_at)).toEqual(new Date('2027-01-31T22:00:00Z'));
    expect(new Date(inv.valid_to)).toEqual(new Date('2027-01-31T22:00:00Z'));
    expect(inv).toMatchObject({ given_name: 'Thandi', family_name: 'Mokoena', company: 'Orrinby Capital', job_title: 'Tax adviser' });
    expect(outbox[0]!.text).toContain('Dear Thandi,\n');
    expect(outbox[0]!.text).toContain('Your access runs until Mon 1 Feb 2027.');
  });

  it('falls back to the lead end date', async () => {
    await h.pg.query(`update membership set valid_to = '2026-12-31T22:00:00Z' where person_id = $1`, [h.person.jan]);
    const id = (await ask()).json().id;
    await call('POST', `${W()}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' });
    const inv = (await h.pg.query<any>(`select access_expires_at from invitation`)).rows[0];
    expect(new Date(inv.access_expires_at)).toEqual(new Date('2026-12-31T22:00:00Z'));
  });

  it('rejects duplicates', async () => {
    expect((await ask()).statusCode).toBe(201);
    expect((await ask()).statusCode).toBe(409);
    expect((await ask(h.person.jan, { email: 'lars@skarvik.example' })).statusCode).toBe(201);
    expect((await ask(h.person.jan, { email: 'jan@bidder-a.example' })).statusCode).toBe(409);
    expect((await ask(h.person.jan, { company: '' })).statusCode).toBe(400);
  });

  it('keeps one pending request per email', async () => {
    const colleagueLead = await colleague('Sipho Dlamini', 'sipho@bidder-a.example');
    await h.pg.query(`update membership set role = 'lead' where id = $1`, [colleagueLead.membershipId]);
    const both = await Promise.all([ask(h.person.jan), ask(colleagueLead.personId, { email: 'thandi@bidder-a.example' })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(both.find((r) => r.statusCode === 409)!.json().title).toBe('Already requested');
    // db constraint
    const first = (await h.pg.query<any>(`select tenant_id, workspace_id, group_id, payload from approval where kind = 'colleague_request'`)).rows[0];
    await expect(h.pg.query(`insert into approval (tenant_id, workspace_id, kind, requested_by, group_id, payload)
      values ($1, $2, 'colleague_request', $3, $4, $5)`, [first.tenant_id, first.workspace_id, h.person.jan, first.group_id,
      JSON.stringify({ ...first.payload, email: 'THANDI@bidder-a.example' })])).rejects.toThrow(/approval_one_pending_colleague/);
    const d = (await call('GET', `${W()}/dashboard`, h.person.anika)).json();
    expect(d.toDo.accessRequests).toHaveLength(1);
  });

  it('lets only group leads withdraw', async () => {
    const id = (await ask()).json().id;
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.mei]);
    const other = await colleague();
    expect((await call('POST', `${W()}/team-requests/${id}/withdraw`, h.person.mei)).statusCode).toBe(404);
    expect((await call('POST', `${W()}/team-requests/${id}/withdraw`, other.personId)).json().reason).toBe('not_group_lead');
    expect((await call('POST', `${W()}/team-requests/${id}/withdraw`, h.person.anika)).statusCode).toBe(403);
    const res = await call('POST', `${W()}/team-requests/${id}/withdraw`, h.person.jan);
    expect(res.json()).toMatchObject({ status: 'withdrawn', decidedAt: T.at.toISOString() });
    expect((await call('POST', `${W()}/team-requests/${id}/withdraw`, h.person.jan)).statusCode).toBe(409);
    expect((await call('POST', `${W()}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' })).statusCode).toBe(409);
    expect(outbox).toEqual([]);
    expect((await call('GET', `${W()}/team-requests?status=withdrawn`, h.person.anika)).json().items).toHaveLength(1);
    expect((await events('team_request.withdrawn'))).toHaveLength(1);
  });

  it('shows the decline note', async () => {
    const id = (await ask()).json().id;
    await call('POST', `${W()}/team-requests/${id}/decide`, h.person.anika, { decision: 'decline', note: 'Use your work address' });
    expect((await call('GET', `${W()}/team-requests`, h.person.jan)).json().items[0]).toMatchObject({ status: 'declined', decisionNote: 'Use your work address' });
  });
});

describe('My team', () => {
  beforeEach(async () => { await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]); });
  const ask = (person = h.person.jan, email = 'thandi@bidder-a.example') => call('POST', `${W()}/team-requests`, person,
    { givenName: 'Thandi', familyName: 'Mokoena', email, company: 'Orrinby Capital' });

  it('returns organisation, end date and admins', async () => {
    await h.pg.query(`update groups set valid_to = '2027-01-29T15:00:00Z', metadata = '{"organisation": "Orrinby Capital"}' where id = $1`, [h.group.a]);
    await h.pg.query(`update person set company = 'Quillmont Advisory' where id = $1`, [h.person.anika]);
    const id = (await ask()).json().id;
    clock = later(5);
    await call('POST', `${W()}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' });
    const res = (await call('GET', `${W()}/my-team`, h.person.jan)).json();
    expect(res.roomAdmins).toEqual([{ name: 'Anika Pillay', company: 'Quillmont Advisory' }]);
    const [g] = res.groups;
    expect(g).toMatchObject({ name: 'Bidder A', isLead: true, organisation: 'Orrinby Capital', accessEndsAt: '2027-01-29T15:00:00.000Z' });
    expect(g.members.find((m: any) => m.email === 'thandi@bidder-a.example')).toMatchObject({ status: 'invited', invitedAt: later(5).toISOString() });
    expect(g.members.find((m: any) => m.personId === h.person.jan)).toMatchObject({ invitedAt: null, status: 'active' });
  });

  it('falls back to the caller end date', async () => {
    await h.pg.query(`update membership set valid_to = '2026-12-31T22:00:00Z' where person_id = $1`, [h.person.jan]);
    const [g] = (await call('GET', `${W()}/my-team`, h.person.jan)).json().groups;
    expect(g).toMatchObject({ organisation: null, accessEndsAt: '2026-12-31T22:00:00.000Z' });
  });

  it('shows requests to admins and leads only', async () => {
    const pieter = await colleague();
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.mei]);
    await ask();
    const member = await call('GET', `${W()}/team-requests`, pieter.personId);
    const missing = await call('GET', `/v1/workspaces/00000000-0000-4000-8000-000000000000/team-requests`, pieter.personId);
    expect(member.statusCode).toBe(404);
    expect(member.json()).toEqual(missing.json());
    expect(member.body).not.toMatch(/Thandi/);
    expect((await call('GET', `${W()}/team-requests`, h.person.maria)).statusCode).toBe(404);
    expect((await call('GET', `${W()}/team-requests`, h.person.lars)).statusCode).toBe(404);
    const other = await call('GET', `${W()}/team-requests`, h.person.mei);
    expect(other.json().items).toEqual([]);
    expect((await call('GET', `${W()}/team-requests`, h.person.jan)).json().items).toHaveLength(1);
    expect((await call('GET', `${W()}/team-requests`, h.person.anika)).json().items).toHaveLength(1);
  });

  it('names who settled each request', async () => {
    const a = (await ask()).json().id;
    const b = (await ask(h.person.jan, 'ruan@thornquist-legal.example')).json().id;
    expect((await call('GET', `${W()}/team-requests`, h.person.jan)).json().items.map((r: any) => r.decidedBy)).toEqual([null, null]);
    await call('POST', `${W()}/team-requests/${a}/decide`, h.person.anika, { decision: 'decline', note: 'A personal address' });
    expect((await call('POST', `${W()}/team-requests/${b}/withdraw`, h.person.jan)).json()).toMatchObject({ status: 'withdrawn', decidedBy: 'Jan de Vries' });
    const items = (await call('GET', `${W()}/team-requests`, h.person.jan)).json().items;
    expect(items.map((r: any) => [r.status, r.decidedBy])).toEqual([['declined', 'Anika Pillay'], ['withdrawn', 'Jan de Vries']]);
  });

  it('counts my team for the buyer side', async () => {
    const pieter = await colleague();
    await ask();
    const id = (await call('GET', `${W()}/team-requests`, h.person.jan)).json().items[0].id;
    await call('POST', `${W()}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' });
    const size = async (p: string) => (await call('GET', `${W()}/shell`, p)).json().me.teamSize;
    expect(await size(h.person.jan)).toBe(3);
    expect(await size(pieter.personId)).toBe(3);
    expect(await size(h.person.lars)).toBe(1);
    expect(await size(h.person.anika)).toBeNull();
    expect(await size(h.person.maria)).toBeNull();
    await call('POST', `${W()}/removal-requests`, h.person.jan, { membershipId: pieter.membershipId, reason: 'Left our firm' });
    const rid = (await call('GET', `${W()}/removal-requests`, h.person.anika)).json().items[0].id;
    clock = later(1);
    await call('POST', `${W()}/removal-requests/${rid}/decide`, h.person.anika, { decision: 'approve' });
    expect(await size(h.person.jan)).toBe(2);
  });

  it('refuses subgroup leads', async () => {
    const lars = await membershipOf(h.person.lars, h.group.aFin);
    const refused = await call('POST', `${W()}/memberships/${lars}/make-lead`, h.person.anika);
    expect([refused.statusCode, refused.json().detail]).toEqual([400, 'Only main groups have leads. People in a subgroup are members.']);
    const invited = await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.aFin, role: 'lead', people: [{ email: 'ola@skarvik.example' }] });
    expect([invited.statusCode, invited.json().detail]).toEqual([400, 'Only main groups have leads. People in a subgroup are members.']);
    const mixed = await call('POST', `${W()}/invitations`, h.person.anika,
      { groupId: h.group.aFin, people: [{ email: 'ola@skarvik.example' }, { email: 'kari@skarvik.example', role: 'lead' }] });
    expect(mixed.statusCode).toBe(400);
    expect((await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.aFin, people: [{ email: 'ola@skarvik.example' }] })).statusCode).toBe(201);
    expect((await events('membership.role_changed'))).toEqual([]);

    // legacy subgroup lead
    await h.pg.query(`update membership set role = 'lead' where id = $1`, [lars]);
    const [g] = (await call('GET', `${W()}/my-team`, h.person.lars)).json().groups;
    expect(g).toMatchObject({ id: h.group.aFin, isLead: false });
    expect(g.members.find((m: any) => m.personId === h.person.lars).role).toBe('member');
    expect(g.members.every((m: any) => !('removalRequested' in m))).toBe(true);
    expect((await call('GET', `${W()}/team-requests`, h.person.lars)).statusCode).toBe(404);
    expect((await call('POST', `${W()}/memberships/${lars}/make-member`, h.person.anika)).json().role).toBe('member');
  });

  it('skips colleagues whose access starts later', async () => {
    const pieter = await colleague();
    await h.pg.query(`update membership set valid_from = $2 where id = $1`, [pieter.membershipId, later(60).toISOString()]);
    const team = async () => (await call('GET', `${W()}/my-team`, h.person.jan)).json().groups[0].members.map((m: any) => m.personId);
    const size = async () => (await call('GET', `${W()}/shell`, h.person.jan)).json().me.teamSize;
    expect(await team()).toEqual([h.person.jan]);
    expect(await size()).toBe(1);
    clock = later(61);
    expect(await team()).toEqual(expect.arrayContaining([h.person.jan, pieter.personId]));
    expect(await size()).toBe(2);
  });
});

describe('removal requests', () => {
  beforeEach(async () => {
    await grant([{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }]);
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]);
  });
  const askRemove = (person: string, membershipId: string, reason = 'Left our firm') =>
    call('POST', `${W()}/removal-requests`, person, { membershipId, reason });

  it('revokes on approval', async () => {
    const pieter = await colleague();
    const res = await askRemove(h.person.jan, pieter.membershipId);
    expect(res.statusCode).toBe(201);
    const team = (await call('GET', `${W()}/my-team`, h.person.jan)).json().groups[0].members;
    expect(team.find((m: any) => m.personId === pieter.personId)).toMatchObject({ removalRequested: true, status: 'active' });
    expect(await level(pieter.personId, h.node.aud1)).toBe(20);

    const pending = (await call('GET', `${W()}/removal-requests?status=pending`, h.person.anika)).json().items;
    expect(pending).toEqual([expect.objectContaining({ name: 'Pieter Botha', requestedBy: 'Jan de Vries', reason: 'Left our firm', groupName: 'Bidder A' })]);
    clock = later(10);
    const done = await call('POST', `${W()}/removal-requests/${res.json().id}/decide`, h.person.anika, { decision: 'approve' });
    expect(done.json()).toMatchObject({ status: 'approved' });
    expect(await level(pieter.personId, h.node.aud1)).toBe(0);
    const actions = (await call('GET', `${W()}/events`, h.person.anika)).json().items.map((e: any) => e.action);
    expect(actions.slice(0, 3)).toEqual(['removal_request.approved', 'membership.revoked', 'removal_request.created']);
    expect((await call('POST', `${W()}/removal-requests/${res.json().id}/decide`, h.person.anika, { decision: 'decline' })).statusCode).toBe(409);
  });

  it('hides removal requests from members', async () => {
    const pieter = await colleague();
    const other = await colleague('Lerato Khumalo', 'lerato@bidder-a.example');
    expect((await askRemove(h.person.jan, pieter.membershipId)).statusCode).toBe(201);
    for (const viewer of [pieter.personId, other.personId]) {
      const res = await call('GET', `${W()}/my-team`, viewer);
      expect(res.statusCode).toBe(200);
      const [group] = res.json().groups;
      expect(group.isLead).toBe(false);
      for (const m of group.members) expect(m).not.toHaveProperty('removalRequested');
      expect(res.body).not.toMatch(/removalRequested/);
    }
    const lead = (await call('GET', `${W()}/my-team`, h.person.jan)).json().groups[0].members;
    expect(lead.find((m: any) => m.personId === pieter.personId).removalRequested).toBe(true);
    expect(lead.find((m: any) => m.personId === other.personId).removalRequested).toBe(false);
  });

  it('lists removal requests for the admin', async () => {
    const pieter = await colleague();
    await call('POST', `${W()}/team-requests`, h.person.jan,
      { givenName: 'Thandi', familyName: 'Mokoena', email: 'thandi@bidder-a.example', company: 'Orrinby Capital' });
    const id = (await askRemove(h.person.jan, pieter.membershipId)).json().id;
    const mine = await call('GET', `${W()}/dashboard`, h.person.jan);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().myRequests).toEqual([expect.objectContaining({ name: 'Thandi Mokoena', status: 'pending' })]);
    const admin = (await call('GET', `${W()}/dashboard`, h.person.anika)).json();
    expect(admin.toDo.accessRequests.map((a: any) => a.name)).toEqual(['Thandi Mokoena']);
    expect(admin.toDo.removalRequests).toEqual([expect.objectContaining({ id, name: 'Pieter Botha', groupName: 'Bidder A', requestedBy: 'Jan de Vries', reason: 'Left our firm' })]);
    await call('POST', `${W()}/removal-requests/${id}/decide`, h.person.anika, { decision: 'decline' });
    expect((await call('GET', `${W()}/dashboard`, h.person.anika)).json().toDo.removalRequests).toEqual([]);
  });

  it('keeps access on decline', async () => {
    const pieter = await colleague();
    const id = (await askRemove(h.person.jan, pieter.membershipId)).json().id;
    await call('POST', `${W()}/removal-requests/${id}/decide`, h.person.anika, { decision: 'decline', note: 'Still on the deal team' });
    expect(await level(pieter.personId, h.node.aud1)).toBe(20);
    expect((await call('GET', `${W()}/removal-requests`, h.person.jan)).json().items[0])
      .toMatchObject({ status: 'declined', decisionNote: 'Still on the deal team' });
  });

  it('lets only leads ask, not about leads', async () => {
    const pieter = await colleague();
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.mei]);
    expect((await askRemove(h.person.mei, pieter.membershipId)).statusCode).toBe(404);
    expect((await askRemove(pieter.personId, await membershipOf(h.person.jan, h.group.a))).json().reason).toBe('not_group_lead');
    expect((await askRemove(h.person.anika, pieter.membershipId)).statusCode).toBe(403);
    expect((await askRemove(h.person.jan, await membershipOf(h.person.jan, h.group.a))).statusCode).toBe(400);
    const second = await colleague('Anna Smit', 'anna@bidder-a.example');
    await makeLead(second.personId, h.group.a);
    expect((await askRemove(h.person.jan, second.membershipId)).statusCode).toBe(400);
    expect((await askRemove(h.person.jan, pieter.membershipId, '')).statusCode).toBe(400);
    expect((await askRemove(h.person.jan, pieter.membershipId)).statusCode).toBe(201);
    expect((await askRemove(h.person.jan, pieter.membershipId)).statusCode).toBe(409);
    const member = await call('GET', `${W()}/removal-requests`, pieter.personId);
    expect(member.statusCode).toBe(404);
    expect(member.json()).toEqual((await call('GET', `/v1/workspaces/00000000-0000-4000-8000-000000000000/removal-requests`, pieter.personId)).json());
    expect((await call('GET', `${W()}/removal-requests`, h.person.mei)).json().items).toEqual([]);
    expect((await call('POST', `${W()}/removal-requests/${(await call('GET', `${W()}/removal-requests`, h.person.jan)).json().items[0].id}/decide`,
      h.person.jan, { decision: 'approve' })).statusCode).toBe(403);
  });
});

describe('leads', () => {
  it('allows several leads and keeps history', async () => {
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]);
    const pieter = await colleague();
    clock = later(30);
    await makeLead(pieter.personId, h.group.a);
    const team = (await call('GET', `${W()}/my-team`, h.person.jan)).json().groups[0].members;
    expect(team.map((m: any) => `${m.name} ${m.role}`)).toEqual(['Jan de Vries lead', 'Pieter Botha lead']);
    expect((await call('POST', `${W()}/team-requests`, pieter.personId,
      { givenName: 'Thandi', familyName: 'Mokoena', email: 'thandi@bidder-a.example', company: 'Orrinby Capital' })).statusCode).toBe(201);
    const history = (await h.pg.query<any>(`select role, valid_from, valid_to from membership where person_id = $1 and superseded_at = 'infinity' order by valid_from`,
      [pieter.personId])).rows;
    expect(history.map((r) => r.role)).toEqual(['member', 'lead']);
    expect(new Date(history[1].valid_from)).toEqual(later(30));
    expect((await events('membership.role_changed'))[0].data).toMatchObject({ person_id: pieter.personId, before: 'member', after: 'lead' });

    clock = later(40);
    const back = await call('POST', `${W()}/memberships/${await membershipOf(pieter.personId, h.group.a)}/make-member`, h.person.anika);
    expect(back.json().role).toBe('member');
    expect((await call('POST', `${W()}/team-requests`, pieter.personId,
      { givenName: 'Anna', familyName: 'Smit', email: 'anna@bidder-a.example', company: 'Orrinby Capital' })).statusCode).toBe(403);
  });

  it('requires room admin', async () => {
    const pieter = await colleague();
    expect((await call('POST', `${W()}/memberships/${pieter.membershipId}/make-lead`, h.person.jan)).statusCode).toBe(403);
    expect((await call('POST', `${W()}/memberships/${await membershipOf(h.person.anika, h.group.admins)}/make-lead`, h.person.anika)).statusCode).toBe(400);
    await makeLead(pieter.personId, h.group.a);
    expect((await call('POST', `${W()}/memberships/${pieter.membershipId}/make-lead`, h.person.anika)).statusCode).toBe(409);
  });
});

describe('room states', () => {
  beforeEach(async () => {
    await grant([
      { nodeId: h.node.fin, groupId: h.group.a, level: 20 },
      { nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true },
    ]);
    clock = later(1);
  });
  const setState = (state: string) => call('PATCH', `${W()}/settings`, h.person.anika, { state });

  it('admits only sellers while preparing', async () => {
    expect((await setState('preparing')).statusCode).toBe(200);
    clock = later(2);
    const res = await call('GET', `${W()}/nda`, h.person.jan);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('room_preparing');
    expect((await call('GET', `${W()}/nodes`, h.person.jan)).json().items ?? []).toEqual([]);
    expect(await level(h.person.jan, h.node.aud1)).toBe(0);
    expect((await call('GET', `${W()}/my-team`, h.person.maria)).statusCode).toBe(200);
    expect(await level(h.person.maria, h.node.aud1)).toBe(20);
    expect((await call('GET', '/v1/me/workspaces', h.person.jan)).json().items[0].state).toBe('preparing');
  });

  it('shows the next milestone only to those who can enter', async () => {
    await h.pg.query(`insert into milestone (tenant_id, workspace_id, title, due_at) values ($1, $2, 'Final binding offers due', '2027-03-01T10:00:00Z')`, [h.t1, h.ws]);
    const next = async (person: string) => (await call('GET', '/v1/me/workspaces', person)).json().items.find((w: any) => w.id === h.ws).nextMilestone;
    expect(await next(h.person.jan)).toMatchObject({ title: 'Final binding offers due' });
    await setState('preparing');
    clock = later(2);
    expect(await next(h.person.jan)).toBeNull();
    expect(await next(h.person.maria)).toMatchObject({ title: 'Final binding offers due' });
    await setState('closed');
    clock = later(3);
    expect(await next(h.person.jan)).toBeNull();
    expect(await next(h.person.maria)).toBeNull();
    expect(await next(h.person.anika)).toMatchObject({ title: 'Final binding offers due' });
  });

  it('allows reading and withdraw when frozen', async () => {
    await setState('frozen');
    clock = later(2);
    expect(await level(h.person.jan, h.node.aud1)).toBe(20);
    expect((await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [h.node.audDraft] })).json().reason).toBe('room_frozen');
    expect((await call('POST', `${W()}/nodes/${h.node.aud1}/withdraw`, h.person.maria, {})).statusCode).toBe(200);
    expect(await level(h.person.jan, h.node.aud1)).toBe(0);
  });

  it('freezes the index', async () => {
    await setState('frozen');
    clock = later(2);
    const frozen = { status: 409, reason: 'room_frozen', detail: 'The room is frozen. Unfreeze it in Room settings to change the index.' };
    const refused = (res: { statusCode: number; json(): any }) => ({ status: res.statusCode, reason: res.json().reason, detail: res.json().detail });
    const before = (await h.pg.query<any>(`select id, parent_id, name, index_number, sort_key from node where workspace_id = $1 order by id`, [h.ws])).rows;

    expect(refused(await call('POST', `${W()}/folders`, h.person.anika, { name: 'Environmental' }))).toEqual(frozen);
    expect(refused(await call('POST', `${W()}/folders`, h.person.anika, { parentId: h.node.fin, name: 'Treasury' }))).toEqual(frozen);
    expect(refused(await call('PATCH', `${W()}/nodes/${h.node.aud}`, h.person.anika, { name: 'Accounts' }))).toEqual(frozen);
    expect(refused(await call('PATCH', `${W()}/nodes/${h.node.tax1}`, h.person.anika, { name: 'Renamed.pdf' }))).toEqual(frozen);
    expect(refused(await call('PATCH', `${W()}/nodes/${h.node.aud}`, h.person.anika, { parentId: h.node.it }))).toEqual(frozen);
    expect(refused(await call('PATCH', `${W()}/nodes/${h.node.tax}`, h.person.anika, { position: 1, confirmRenumberPublished: true }))).toEqual(frozen);
    expect(refused(await call('POST', `${W()}/index/restore`, h.person.anika, { items: [{ id: h.node.aud, indexNumber: '3.9' }] }))).toEqual(frozen);
    expect((await call('PATCH', `${W()}/nodes/${h.node.aud}`, h.person.jan, { name: 'Accounts' })).statusCode).not.toBe(409);
    expect((await call('POST', `${W()}/folders`, h.person.maria, { parentId: h.node.fin, name: 'X' })).statusCode).toBe(403);
    expect((await h.pg.query<any>(`select id, parent_id, name, index_number, sort_key from node where workspace_id = $1 order by id`, [h.ws])).rows).toEqual(before);

    await grant([{ nodeId: h.node.tax, groupId: h.group.a, level: 20 }]);

    await setState('open');
    clock = later(3);
    expect((await call('POST', `${W()}/folders`, h.person.anika, { name: 'Environmental' })).statusCode).toBe(201);
    expect((await call('PATCH', `${W()}/nodes/${h.node.aud}`, h.person.anika, { name: 'Accounts' })).statusCode).toBe(200);
  });

  it('admits only admins when closed', async () => {
    await setState('closed');
    clock = later(2);
    expect((await call('GET', `${W()}/my-team`, h.person.jan)).json().reason).toBe('room_closed');
    expect((await call('GET', `${W()}/my-team`, h.person.maria)).json().reason).toBe('room_closed');
    expect(await level(h.person.maria, h.node.aud1)).toBe(0);
    expect((await call('GET', `${W()}/settings`, h.person.anika)).json().state).toBe('closed');
    expect(await level(h.person.anika, h.node.aud1)).toBe(60);
  });

  it('logs state changes', async () => {
    await setState('frozen');
    clock = later(5);
    await setState('open');
    const changes = (await events('workspace.state_changed')).map((e: any) => e.data);
    expect(changes).toEqual([{ before: 'frozen', after: 'open' }, { before: 'open', after: 'frozen' }]);
    const hist = (await h.pg.query<any>(`select state, valid_from from workspace_state_history where workspace_id = $1 order by id`, [h.ws])).rows;
    expect(hist.map((r) => r.state)).toEqual(['open', 'frozen', 'open']);
    expect(new Date(hist[1].valid_from)).toEqual(later(1));
    expect(new Date(hist[2].valid_from)).toEqual(later(5));
  });

  it('uses the state at a past date', async () => {
    await setState('closed');
    expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, { at: later(0), knownAt: later(10) }))).level).toBe(20);
    expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, { at: later(2), knownAt: later(10) }))).reason).toBe('room_closed');
  });
});

describe('NDA corrections', () => {
  beforeEach(async () => { await grant([{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }]); });
  const publishNda = (mode?: string) =>
    call('PUT', `${W()}/nda`, h.person.anika, { body: 'Confidentiality undertaking, corrected wording of clause 4', ...(mode ? { mode } : {}) });

  it('asks only non-accepters for a correction', async () => {
    const sven = await colleague('Sven Lund', 'sven@bidder-a.example');
    await h.pg.query(`delete from acceptance where person_id = $1`, [sven.personId]);
    clock = later(5);
    expect((await publishNda('correction')).json()).toMatchObject({ versionNo: 2, mode: 'correction' });
    clock = later(6);
    expect((await call('GET', `${W()}/nda`, h.person.jan)).json()).toMatchObject({ versionNo: 2, mode: 'correction', mustAccept: false, acceptedAt: null });
    expect((await call('GET', `${W()}/my-team`, h.person.jan)).statusCode).toBe(200);
    expect(await level(h.person.jan, h.node.aud1)).toBe(20);
    expect((await call('GET', `${W()}/nda`, sven.personId)).json().mustAccept).toBe(true);
    expect((await call('GET', `${W()}/my-team`, sven.personId)).json().reason).toBe('nda_not_accepted');
    expect((await h.pg.query(`select 1 from notification where category = 'agreements'`)).rows).toEqual([]);
    expect((await events('agreement.version_published'))[0].data).toEqual({ version_no: 2, mode: 'correction' });
  });

  it('asks everyone for a new version', async () => {
    clock = later(5);
    expect((await publishNda()).json().mode).toBe('everyone');
    clock = later(6);
    expect((await call('GET', `${W()}/nda`, h.person.jan)).json().mustAccept).toBe(true);
    expect((await call('GET', `${W()}/my-team`, h.person.jan)).json().reason).toBe('nda_not_accepted');
    expect((await call('GET', `${W()}/nda`, h.person.maria)).json().mustAccept).toBe(false);
  });
});

describe('invitation email', () => {
  it('uses the default text', async () => {
    const inv = (await call('GET', `${W()}/settings`, h.person.anika)).json().invitation;
    expect(inv.subject).toBe('Invitation to the Project Heron data room');
    expect(inv.message).toContain('Your access runs until {until}.');
    expect(inv.leadParagraph).toContain('You are invited as a lead for {group}.');
  });

  it('is signed by the sending admin', async () => {
    const inv = (await call('GET', `${W()}/settings`, h.person.anika)).json().invitation;
    expect(inv.message.split('\n').slice(-3)).toEqual(['', 'Kind regards,', '{signature}']);
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'sven@bidder-b.example' }] });
    expect(outbox[0]!.fromName).toBe('Anika Pillay, Quillmont Advisory');
    expect(outbox[0]!.text).toContain('Kind regards,\nAnika Pillay\nQuillmont Advisory');
    expect(outbox[0]!.html).toContain('Kind regards,<br>Anika Pillay<br>Quillmont Advisory');
    expect(outbox[0]!.text).not.toContain('{signature}');

    await call('PATCH', `${W()}/settings`, h.person.anika, { invitation: { senderName: 'Quillmont deal team' } });
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'ola@bidder-b.example' }] });
    expect(outbox[1]!.fromName).toBe('Quillmont deal team');
    expect(outbox[1]!.text).toContain('\nAnika Pillay\n');
  });

  it('adds the lead paragraph for leads', async () => {
    const res = await call('PATCH', `${W()}/settings`, h.person.anika, { invitation: {
      subject: 'Project Heron: your access', message: 'Dear colleague,\n\nWelcome. Your access runs until {until}.',
      leadParagraph: 'As lead of {group} you request colleagues through My team.' } });
    expect(res.json().invitation.subject).toBe('Project Heron: your access');
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, role: 'lead', accessExpiresAt: '2027-01-31T22:00:00Z',
      people: [{ email: 'sven@bidder-b.example', givenName: 'Sven', familyName: 'Lund' }] });
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'ola@bidder-b.example' }] });
    expect(outbox[0]).toMatchObject({ subject: 'Project Heron: your access' });
    expect(outbox[0]!.text!.startsWith('Dear Sven,\n\nWelcome. Your access runs until Mon 1 Feb 2027.\n\n> As lead of Bidder B you request colleagues through My team.')).toBe(true);
    expect(outbox[0]!.html).toMatch(/border-left:3px solid #CFD8E1[^>]*>As lead of Bidder B you request colleagues through My team\.<\/p>/);
    expect(outbox[1]!.text!.startsWith('Dear colleague,\n\nWelcome. Your access runs until the room closes.\n\nOpen the data room: ')).toBe(true);
    expect(outbox[1]!.text!).not.toContain('As lead');
  });

  it('handles empty and null lead paragraphs', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { invitation: { leadParagraph: '' } });
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, role: 'lead', people: [{ email: 'sven@bidder-b.example' }] });
    expect(outbox[0]!.text!).not.toContain('lead');
    const back = await call('PATCH', `${W()}/settings`, h.person.anika, { invitation: { leadParagraph: null } });
    expect(back.json().invitation.leadParagraph).toContain('{group}');
    expect((await events('workspace.settings_changed'))[0].data.invitation_changed).toEqual(['leadParagraph']);
  });

  it('uses the invitation message when given', async () => {
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, message: 'Hello {until}',
      people: [{ email: 'sven@bidder-b.example' }] });
    expect(outbox[0]!.text!.split('\n')[0]).toBe('Hello the room closes');
  });

  it('rejects non-admins and overlong text', async () => {
    expect((await call('PATCH', `${W()}/settings`, h.person.jan, { invitation: { subject: 'Phish' } })).statusCode).toBe(403);
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { invitation: { message: 'x'.repeat(5001) } })).statusCode).toBe(400);
  });
});
