// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, effectiveAccess, Level, setGrant, verifyChain } from '../src/index.js';
import { expectListingMatchesSingleChecks, heron, T, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { try { await expectListingMatchesSingleChecks(h); } finally { await h.pg.close(); } });

const at = (minutes: number) => new Date(T.at.getTime() + minutes * 60_000);
const level = (person: string, node: string, when = T.at, knownAt?: Date) =>
  h.app((tx) => effectiveAccess(tx, person, node, { at: when, ...(knownAt ? { knownAt } : {}) }));
const person = async (id: string) =>
  (await h.pg.query<any>(`select name, given_name, family_name, company, job_title from person where id = $1`, [id])).rows[0];

async function grantA(lvl: number) {
  await h.pin(T.grantsSet);
  await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: lvl }));
  await h.pin(T.at);
}

describe('first and last name', () => {
  it('splits existing and legacy names on the first space', async () => {
    expect(await person(h.person.jan)).toMatchObject({ name: 'Jan de Vries', given_name: 'Jan', family_name: 'de Vries' });
    const id = (await h.pg.query<{ id: string }>(
      `insert into person (tenant_id, name, email) values ($1, 'Thandi', 'thandi@example.com') returning id`, [h.t1])).rows[0]!.id;
    expect(await person(id)).toMatchObject({ given_name: 'Thandi', family_name: '' });
  });

  it('derives the display name', async () => {
    const id = (await h.pg.query<{ id: string }>(
      `insert into person (tenant_id, given_name, family_name, email) values ($1, ' Pieter ', 'van der Merwe', 'pieter@example.com') returning id`,
      [h.t1])).rows[0]!.id;
    expect(await person(id)).toMatchObject({ name: 'Pieter van der Merwe', given_name: 'Pieter', family_name: 'van der Merwe' });
    await h.app((tx) => tx.query(`update person set family_name = 'Botha' where id = $1`, [id]));
    expect((await person(id)).name).toBe('Pieter Botha');
  });

  it('ignores an email used as a placeholder name', async () => {
    const id = (await h.pg.query<{ id: string }>(
      `insert into person (tenant_id, name, email) values ($1, 'sven@example.com', 'sven@example.com') returning id`, [h.t1])).rows[0]!.id;
    expect(await person(id)).toMatchObject({ given_name: '', family_name: '' });
  });
});

describe('personal values', () => {
  it('clears them on erasure without breaking the chain', async () => {
    await h.app(async (tx) => {
      await tx.query(`update person set company = 'Orrinby Capital' where id = $1`, [h.person.jan]);
      await appendEvent(tx, {
        action: 'person.details_changed', workspaceId: h.ws, resourceType: 'person', resourceId: h.person.jan,
        data: { person_id: h.person.jan, fields: ['company'] },
        context: { personal: { before: { company: null }, after: { company: 'Orrinby Capital' } }, subjectPersonId: h.person.jan },
      });
    });
    const ctx = async () => (await h.pg.query<any>(`select personal from event_context where subject_person_id = $1`, [h.person.jan])).rows;
    expect((await ctx())[0].personal.after.company).toBe('Orrinby Capital');
    const hashed = (await h.pg.query<any>(`select data from event where action = 'person.details_changed'`)).rows[0].data;
    expect(JSON.stringify(hashed)).not.toContain('Orrinby');

    await h.app((tx) => tx.query(`update person set name = 'Erased user', email = 'erased-' || id || '@invalid', erased_at = now() where id = $1`, [h.person.jan]));
    expect(await ctx()).toEqual([{ personal: null }]);
    expect(await person(h.person.jan)).toMatchObject({ name: 'Erased user', given_name: '', family_name: '', company: null });
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toEqual({ checked: 1, firstBroken: null });
  });
});

describe('room states', () => {
  beforeEach(async () => { await grantA(Level.Pdf); });
  const setState = (state: string) => h.app((tx) => tx.query(`update workspace set state = $2 where id = $1`, [h.ws, state]));

  it('translates the old state names', async () => {
    expect((await h.pg.query<any>(`select state from workspace where id = $1`, [h.ws])).rows[0].state).toBe('open');
    await setState('draft');
    expect((await h.pg.query<any>(`select state from workspace where id = $1`, [h.ws])).rows[0].state).toBe('preparing');
  });

  it('only admits the seller side while preparing', async () => {
    await setState('preparing');
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: 'room_preparing' });
    expect(await level(h.person.lars, h.node.aud1)).toMatchObject({ level: 0, reason: 'room_preparing' });
    expect(await level(h.person.maria, h.node.aud1)).toMatchObject({ level: Level.View, canUpload: true });
    expect((await level(h.person.anika, h.node.aud1)).level).toBe(Level.Original);
  });

  it('allows reading but not uploads when frozen', async () => {
    await h.pin(T.grantsSet);
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.contributors }, level: Level.View,
      canUpload: true, canPublish: true }));
    await h.pin(T.at);
    await setState('frozen');
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.Pdf);
    expect(await level(h.person.maria, h.node.aud1)).toMatchObject({ level: Level.View, canUpload: false, canPublish: true });
  });

  it('only admits room admins when closed', async () => {
    await setState('closed');
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: 'room_closed' });
    expect(await level(h.person.maria, h.node.aud1)).toMatchObject({ level: 0, reason: 'room_closed' });
    expect(await level(h.person.anika, h.node.aud1)).toMatchObject({ level: Level.Original, canUpload: false });
  });

  it('uses the historical state for past dates', async () => {
    await h.pin(at(60));
    await h.app(async (tx) => {
      await tx.query(`select set_config('vdrkit.state_valid_from', $1, true)`, [at(60).toISOString()]);
      await tx.query(`update workspace set state = 'closed' where id = $1`, [h.ws]);
    });
    expect((await level(h.person.jan, h.node.aud1, at(30), at(90))).level).toBe(Level.Pdf);
    expect((await level(h.person.jan, h.node.aud1, at(90), at(90))).reason).toBe('room_closed');
    expect((await level(h.person.jan, h.node.aud1, at(90), at(30))).level).toBe(Level.Pdf);
    const hist = (await h.pg.query<any>(`select state, valid_from, recorded_at from workspace_state_history where workspace_id = $1 order by id`, [h.ws])).rows;
    expect(hist.map((r: any) => r.state)).toEqual(['open', 'closed']);
    expect(new Date(hist[1].recorded_at)).toEqual(at(60));
  });

  it('should keep state history append-only', async () => {
    await expect(h.app((tx) => tx.query(`insert into workspace_state_history (tenant_id, workspace_id, state, valid_from, recorded_at)
      values ($1, $2, 'open', now(), now())`, [h.t1, h.ws]))).rejects.toThrow();
    await expect(h.app((tx) => tx.query(`update workspace_state_history set state = 'closed'`))).rejects.toThrow();
    await expect(h.pg.query(`delete from workspace_state_history`)).rejects.toThrow(/never changed/);
  });

  it('rejects unknown states', async () => {
    await expect(setState('paused')).rejects.toThrow();
  });
});

describe('NDA corrections', () => {
  beforeEach(async () => { await grantA(Level.View); });

  async function publishNda(no: number, everyone: boolean, when: Date) {
    await h.pin(when);
    const id = (await h.pg.query<{ id: string }>(
      `insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at, requires_reacceptance)
       values ($1, $2, $3, 'Text', now(), $4) returning id`, [h.t1, h.nda.agreement, no, everyone])).rows[0]!.id;
    await h.pin(T.at);
    return id;
  }
  async function accept(personId: string, versionId: string, when: Date) {
    await h.pin(when);
    await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values ($1, $2, $3, now())`, [h.t1, versionId, personId]);
    await h.pin(T.at);
  }
  const newBidder = async () => {
    const id = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Sven Lund', 'sven@bidder-a.example') returning id`, [h.t1])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3)`, [h.t1, id, h.group.a]);
    return id;
  };

  it('asks only non-signers to accept a correction', async () => {
    const sven = await newBidder();
    const v2 = await publishNda(2, false, at(-60));
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.View);
    expect(await level(sven, h.node.aud1)).toMatchObject({ level: 0, reason: 'nda_not_accepted' });
    await accept(sven, v2, at(-30));
    expect((await level(sven, h.node.aud1)).level).toBe(Level.View);
  });

  it('requires everyone to accept a full new version', async () => {
    await publishNda(2, true, at(-60));
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: 'nda_not_accepted' });
    const v3 = await publishNda(3, false, at(-30));
    expect((await level(h.person.jan, h.node.aud1)).reason).toBe('nda_not_accepted');
    await accept(h.person.jan, v3, at(-10));
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.View);
  });

  it('treats a first correction as a full version', async () => {
    await h.pg.query(`update agreement_version set requires_reacceptance = false where id = $1`, [h.nda.v1]);
    const sven = await newBidder();
    expect((await level(sven, h.node.aud1)).reason).toBe('nda_not_accepted');
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.View);
  });
});

describe('approvals', () => {
  it('use database time and are immutable once decided', async () => {
    const id = (await h.app((tx) => tx.query<{ id: string }>(
      `insert into approval (tenant_id, workspace_id, kind, requested_by, group_id, payload, created_at)
       values (current_tenant_id(), $1, 'removal_request', $2, $3, $4, '2020-01-01') returning id`,
      [h.ws, h.person.jan, h.group.a, JSON.stringify({ person_id: h.person.lars })]))).rows[0]!.id;
    const row = async () => (await h.pg.query<any>(`select created_at, decided_at, status from approval where id = $1`, [id])).rows[0];
    expect(new Date((await row()).created_at)).toEqual(T.at);
    await h.pin(at(5));
    await h.app((tx) => tx.query(`update approval set status = 'declined', decided_at = '2020-01-01' where id = $1`, [id]));
    expect(new Date((await row()).decided_at)).toEqual(at(5));
    await expect(h.app((tx) => tx.query(`update approval set status = 'approved' where id = $1`, [id]))).rejects.toThrow(/never changes/);
  });

  it('allows one pending removal per person and group', async () => {
    const ask = () => h.app((tx) => tx.query(
      `insert into approval (tenant_id, workspace_id, kind, requested_by, group_id, payload)
       values (current_tenant_id(), $1, 'removal_request', $2, $3, $4)`,
      [h.ws, h.person.jan, h.group.a, JSON.stringify({ person_id: h.person.lars })]));
    await ask();
    await expect(ask()).rejects.toThrow();
  });
});
