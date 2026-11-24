// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SIGN_IN_SETTINGS, signInPolicy, strictestSignInPolicy, type RoomSignInSettings } from '../src/index.js';
import { heron, T, type Heron } from './fixture.js';

const room = (o: Partial<RoomSignInSettings> = {}): RoomSignInSettings => ({ ...DEFAULT_SIGN_IN_SETTINGS, ...o });

describe('strictestSignInPolicy', () => {
  it('returns defaults with no rooms', () => {
    expect(strictestSignInPolicy([])).toEqual({ requireTwoFactor: true, allowTrustedBrowser: true, trustedBrowserDays: 30, idleSignOutMinutes: 240, rooms: 0 });
  });

  it('requires 2FA if any room does', () => {
    expect(strictestSignInPolicy([room({ requireTwoFactor: false }), room()]).requireTwoFactor).toBe(true);
    expect(strictestSignInPolicy([room({ requireTwoFactor: false }), room({ requireTwoFactor: false })]).requireTwoFactor).toBe(false);
  });

  it('takes the shortest trust and idle periods', () => {
    const p = strictestSignInPolicy([room({ trustedBrowserDays: 60, idleSignOutMinutes: 1440 }), room({ trustedBrowserDays: 7, idleSignOutMinutes: 30 })]);
    expect(p).toMatchObject({ trustedBrowserDays: 7, idleSignOutMinutes: 30, rooms: 2 });
  });

  it('allows trusted browsers only if every 2FA room does', () => {
    expect(strictestSignInPolicy([room(), room({ allowTrustedBrowser: false })]).allowTrustedBrowser).toBe(false);
    const p = strictestSignInPolicy([room(), room({ requireTwoFactor: false, allowTrustedBrowser: false, trustedBrowserDays: 1, idleSignOutMinutes: 60 })]);
    expect(p).toMatchObject({ requireTwoFactor: true, allowTrustedBrowser: true, trustedBrowserDays: 30, idleSignOutMinutes: 60 });
  });

  it('uses all rooms when none requires 2FA', () => {
    const p = strictestSignInPolicy([room({ requireTwoFactor: false, trustedBrowserDays: 10 }), room({ requireTwoFactor: false, allowTrustedBrowser: false })]);
    expect(p).toMatchObject({ requireTwoFactor: false, allowTrustedBrowser: false, trustedBrowserDays: 10 });
  });
});

describe('signInPolicy', () => {
  let h: Heron;
  beforeEach(async () => { h = await heron(); });
  afterEach(async () => { await h.pg.close(); });

  async function secondRoom(settings: string) {
    const ws = (await h.pg.query<{ id: string }>(
      `insert into workspace (tenant_id, name, state, ${Object.keys(JSON.parse(settings)).join(', ')})
       values ($1, 'Project Osprey', 'active', ${Object.keys(JSON.parse(settings)).map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
      [h.t1, ...Object.values(JSON.parse(settings))])).rows[0]!.id;
    const party = (await h.pg.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values ($1, $2, 'Bidder', 'bidder') returning id`, [h.t1, ws])).rows[0]!.id;
    const group = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name) values ($1, $2, $3, 'Bidder') returning id`, [h.t1, ws, party])).rows[0]!.id;
    return { ws, group };
  }

  it('reads the default settings', async () => {
    const p = await h.app((tx) => signInPolicy(tx, h.person.jan, T.at));
    expect(p).toEqual({ ...DEFAULT_SIGN_IN_SETTINGS, rooms: 1 });
  });

  it('ignores rooms left or only invited to', async () => {
    const strict = await secondRoom(JSON.stringify({ trusted_browser_days: 5, idle_sign_out_minutes: 30, allow_trusted_browser: false }));
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, h.person.jan, strict.group, T.at.toISOString()]);
    expect(await h.app((tx) => signInPolicy(tx, h.person.jan, T.at)))
      .toEqual({ requireTwoFactor: true, allowTrustedBrowser: false, trustedBrowserDays: 5, idleSignOutMinutes: 30, rooms: 2 });

    const invited = await secondRoom(JSON.stringify({ idle_sign_out_minutes: 60 }));
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, status, recorded_at) values ($1, $2, $3, 'approved', $4)`, [h.t1, h.person.mei, invited.group, T.at.toISOString()]);
    expect((await h.app((tx) => signInPolicy(tx, h.person.mei, T.at))).idleSignOutMinutes).toBe(240);

    await h.pg.query(`update membership set valid_to = $3 where person_id = $1 and group_id = $2`, [h.person.jan, strict.group, T.at.toISOString()]);
    expect((await h.app((tx) => signInPolicy(tx, h.person.jan, T.at))).idleSignOutMinutes).toBe(240);
  });

  it('ignores deleted rooms', async () => {
    const gone = await secondRoom(JSON.stringify({ idle_sign_out_minutes: 30 }));
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, h.person.jan, gone.group, T.at.toISOString()]);
    await h.pg.query(`update workspace set state = 'deleted' where id = $1`, [gone.ws]);
    expect((await h.app((tx) => signInPolicy(tx, h.person.jan, T.at))).idleSignOutMinutes).toBe(240);
  });

  it('rejects invalid settings', async () => {
    await expect(h.pg.query(`update workspace set trusted_browser_days = 91 where id = $1`, [h.ws])).rejects.toThrow();
    await expect(h.pg.query(`update workspace set trusted_browser_days = 0 where id = $1`, [h.ws])).rejects.toThrow();
    await expect(h.pg.query(`update workspace set idle_sign_out_minutes = 45 where id = $1`, [h.ws])).rejects.toThrow();
  });

  it('should not read rooms of another tenant', async () => {
    const other = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'X', 'x@example.com') returning id`, [h.t2])).rows[0]!.id;
    expect((await h.app((tx) => signInPolicy(tx, other, T.at))).rooms).toBe(0);
  });
});
