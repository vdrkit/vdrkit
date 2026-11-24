// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
let osprey: string;
let ospreyAdmins: string;
let ospreyBidders: string;

beforeEach(async () => {
  h = await heron();
  const one = async (sql: string, args: unknown[]) => (await h.pg.query<{ id: string }>(sql, args)).rows[0]!.id;
  osprey = await one(`insert into workspace (tenant_id, name, state, time_zone) values ($1, 'Project Osprey', 'open', 'Africa/Johannesburg') returning id`, [h.t1]);
  const seller = await one(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Seller', 'seller') returning id`, [h.t1, osprey]);
  const bidder = await one(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder C', 'bidder') returning id`, [h.t1, osprey]);
  ospreyAdmins = await one(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Room admins', 'admin') returning id`,
    [h.t1, osprey, seller]);
  ospreyBidders = await one(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Bidder C', 'member') returning id`,
    [h.t1, osprey, bidder]);
  // Anika runs Heron only
  await join(h.person.jan, ospreyBidders);
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, rateLimit: false });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const join = (person: string, group: string, status = 'active') => h.pg.query(
  `insert into membership (tenant_id, person_id, group_id, status, recorded_at) values ($1, $2, $3, $4, $5)`,
  [h.t1, person, group, status, new Date(T.at.getTime() - 86_400_000).toISOString()]);
const as = (person: string) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1 });
const changeEmail = (person: string, email: string) => app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/people/${person}/email-change`,
  headers: as(h.person.anika), payload: { email } });
const resetTwoFactor = (person: string) => app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/people/${person}/reset-two-factor`,
  headers: as(h.person.anika), payload: {} });
const editDetails = (person: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/v1/workspaces/${h.ws}/people/${person}`,
  headers: as(h.person.anika), payload });
const refusal = (res: { statusCode: number; json(): any }) => [res.statusCode, res.json().reason];

describe('sign-in changes by a room admin', () => {
  it('needs a site admin for people in other rooms', async () => {
    expect(refusal(await changeEmail(h.person.jan, 'takeover@attacker.example'))).toEqual([403, 'target_in_other_room']);
    expect(refusal(await resetTwoFactor(h.person.jan))).toEqual([403, 'target_in_other_room']);
    expect((await h.pg.query(`select 1 from email_change where person_id = $1`, [h.person.jan])).rows).toHaveLength(0);
    expect((await h.pg.query<{ email: string }>(`select email from person where id = $1`, [h.person.jan])).rows[0]!.email).toBe('jan@bidder-a.example');
  });

  it('applies to name, company and role as well', async () => {
    const details = async () => (await h.pg.query(`select given_name, family_name, company, job_title from person where id = $1`, [h.person.jan])).rows[0];
    const before = await details();
    expect(refusal(await editDetails(h.person.jan, { givenName: 'Janneke', company: 'Attacker Holdings' }))).toEqual([403, 'target_in_other_room']);
    expect(await details()).toEqual(before);
    expect((await editDetails(h.person.mei, { company: 'Bidder B Holdings' })).statusCode).toBe(200);
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    expect((await editDetails(h.person.jan, { company: 'Orrinby Capital' })).statusCode).toBe(200);
  });

  it('flags people only a site admin can change', async () => {
    const flags = async () => {
      const body = (await app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/people`, headers: as(h.person.anika) })).json();
      const out: Record<string, boolean> = {};
      for (const p of body.parties) for (const g of p.groups) for (const m of g.members) out[m.name] = m.otherRooms;
      return out;
    };
    expect(await flags()).toMatchObject({ 'Jan de Vries': true, 'Mei Tanaka': false, 'Anika Pillay': false });
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    expect(await flags()).toMatchObject({ 'Jan de Vries': false });
  });

  it('counts a room they are only invited to', async () => {
    await join(h.person.mei, ospreyBidders, 'approved');
    expect(refusal(await changeEmail(h.person.mei, 'mei@elsewhere.example'))).toEqual([403, 'target_in_other_room']);
    expect(refusal(await resetTwoFactor(h.person.mei))).toEqual([403, 'target_in_other_room']);
  });

  it('allows changes to people only in their own rooms', async () => {
    expect((await changeEmail(h.person.mei, 'mei@elsewhere.example')).statusCode).toBe(200);
    expect((await resetTwoFactor(h.person.mei)).statusCode).toBe(200);
    // running both rooms is enough
    await join(h.person.anika, ospreyAdmins);
    expect((await changeEmail(h.person.jan, 'jan@new.example')).statusCode).toBe(200);
    expect((await resetTwoFactor(h.person.jan)).statusCode).toBe(200);
  });

  it('lets a site admin who runs the room do it', async () => {
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    expect((await changeEmail(h.person.jan, 'jan@new.example')).statusCode).toBe(200);
    expect((await resetTwoFactor(h.person.jan)).statusCode).toBe(200);
  });
});
