// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessibleNodes, appendEvent, effectiveAccess, Level, present, setGrant, verifyChain, withTenant } from '../src/index.js';
import { heron, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => {
  h = await heron();
  await h.pin(null);
});
afterEach(async () => { await h.pg.close(); });

const BACKDATED = '2020-01-01T00:00:00Z';
const iso = (v: unknown) => new Date(v as string).toISOString();

describe('record time from the database clock', () => {
  it('ignores a backdated recorded_at on grants', async () => {
    const r = await h.app(async (tx) => {
      const g = (await tx.query<{ recorded_at: string }>(
        `insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, recorded_at)
         values (current_tenant_id(), $1, $2, $3, 20, $4) returning recorded_at`, [h.ws, h.node.fin, h.group.a, BACKDATED])).rows[0]!;
      const db = (await tx.query<{ now: string }>('select now()')).rows[0]!;
      return { recorded: iso(g.recorded_at), db: iso(db.now) };
    });
    expect(r.recorded).toBe(r.db);
    expect(r.recorded).not.toBe(new Date(BACKDATED).toISOString());
  });

  it('ignores backdated times on memberships and versions', async () => {
    const r = await h.app(async (tx) => {
      const m = (await tx.query<{ recorded_at: string }>(
        `insert into membership (tenant_id, person_id, group_id, recorded_at) values (current_tenant_id(), $1, $2, $3) returning recorded_at`,
        [h.person.jan, h.group.aQna, BACKDATED])).rows[0]!;
      const v = (await tx.query<{ created_at: string }>(
        `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, created_at)
         values (current_tenant_id(), $1, 1, 'k', $2, 1, 'application/pdf', $3) returning created_at`,
        [h.node.aud1, 'a'.repeat(64), BACKDATED])).rows[0]!;
      const db = (await tx.query<{ now: string }>('select now()')).rows[0]!;
      return { m: iso(m.recorded_at), v: iso(v.created_at), db: iso(db.now) };
    });
    expect(r).toEqual({ m: r.db, v: r.db, db: r.db });
  });

  it('stamps NDA versions and acceptances with database time', async () => {
    const r = await h.app(async (tx) => {
      const av = (await tx.query<{ id: string; published_at: string }>(
        `insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at)
         values (current_tenant_id(), $1, 2, 'Version 2', $2) returning id, published_at`, [h.nda.agreement, BACKDATED])).rows[0]!;
      const ac = (await tx.query<{ accepted_at: string }>(
        `insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at)
         values (current_tenant_id(), $1, $2, $3) returning accepted_at`, [av.id, h.person.jan, BACKDATED])).rows[0]!;
      const db = (await tx.query<{ now: string }>('select now()')).rows[0]!;
      return { id: av.id, published: iso(av.published_at), accepted: iso(ac.accepted_at), db: iso(db.now) };
    });
    expect([r.published, r.accepted]).toEqual([r.db, r.db]);
    await expect(h.app((tx) => tx.query(`update agreement_version set published_at = $2 where id = $1`, [r.id, BACKDATED])))
      .rejects.toThrow(/published_at is set by the database/);
    await expect(h.pg.query(`update acceptance set accepted_at = $2 where agreement_version_id = $1`, [r.id, BACKDATED]))
      .rejects.toThrow(/accepted_at is set by the database/);
  });

  it('uses the database clock for present-time checks', async () => {
    // app clock a minute behind the database
    const appNow = new Date('2026-11-12T08:00:00Z');
    await h.pin(new Date('2026-11-12T08:01:00Z'));
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View }));
    expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, present(appNow)))).level).toBe(Level.View);
    expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, { at: appNow }))).level).toBe(0);
  });

  describe('NDA gate', () => {
    const appNow = new Date('2026-11-12T08:00:00Z');
    const dbNow = new Date('2026-11-12T08:01:00Z');
    beforeEach(async () => {
      await h.pin(new Date('2026-11-11T08:00:00Z'));
      await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View }));
      await h.pin(dbNow);
    });
    const publishV2 = () => h.app((tx) => tx.query<{ id: string }>(
      `insert into agreement_version (tenant_id, agreement_id, version_no, body) values (current_tenant_id(), $1, 2, 'Version 2') returning id`,
      [h.nda.agreement])).then((r) => r.rows[0]!.id);

    it('closes the room as soon as a new NDA is published', async () => {
      await publishV2();
      const a = await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, present(appNow)));
      expect([a.level, a.reason]).toEqual([0, 'nda_not_accepted']);
    });

    it('reopens the room once the new NDA is accepted', async () => {
      const v2 = await publishV2();
      await h.app((tx) => tx.query(`insert into acceptance (tenant_id, agreement_version_id, person_id) values (current_tenant_id(), $1, $2)`, [v2, h.person.jan]));
      expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, present(appNow)))).level).toBe(Level.View);
    });

    it('gives the same answer with skewed app clocks', async () => {
      const behind = new Date(dbNow.getTime() - 5 * 60_000);
      const ahead = new Date(dbNow.getTime() + 5 * 60_000);
      const ask = (appNow: Date) => h.app(async (tx) => {
        const one = await effectiveAccess(tx, h.person.jan, h.node.aud1, present(appNow));
        const all = await accessibleNodes(tx, h.person.jan, h.ws, present(appNow));
        const gate = (await tx.query<{ ok: boolean }>(`select nda_accepted($1, $2, record_clock()) as ok`, [h.person.jan, h.ws])).rows[0]!.ok;
        return { level: one.level, reason: one.reason, listed: (all.get(h.node.aud1)?.level ?? 0) > 0, gate };
      });
      const v2 = await publishV2();
      const closed = { level: 0, reason: 'nda_not_accepted', listed: false, gate: false };
      expect([await ask(behind), await ask(ahead)]).toEqual([closed, closed]);
      await h.app((tx) => tx.query(`insert into acceptance (tenant_id, agreement_version_id, person_id) values (current_tenant_id(), $1, $2)`, [v2, h.person.jan]));
      const [b, a] = [await ask(behind), await ask(ahead)];
      expect([b.level, b.listed, b.gate, a.level, a.listed, a.gate]).toEqual([Level.View, true, true, Level.View, true, true]);
    });

    it('answers as-at questions with the NDA at that time', async () => {
      await publishV2();
      const before = new Date('2026-11-12T07:00:00Z');
      expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, { at: before }))).level).toBe(Level.View);
      expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, { at: new Date('2026-11-12T08:02:00Z') }))).reason).toBe('nda_not_accepted');
    });

    it('effective_level uses nda_accepted()', async () => {
      const def = (await h.pg.query<{ d: string }>(`select pg_get_functiondef('effective_level(uuid, uuid, timestamptz, timestamptz)'::regprocedure) as d`)).rows[0]!.d;
      expect(def).toContain('public.nda_accepted(p_person, ws.id, k)');
      expect(def).not.toMatch(/accepted_at <= p_at|published_at <= p_at/);
    });
  });

  it('should not allow updating recorded_at', async () => {
    const id = await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View }));
    await expect(h.app((tx) => tx.query(`update access_grant set recorded_at = $2 where id = $1`, [id, BACKDATED])))
      .rejects.toThrow(/recorded_at is set by the database/);
    await expect(h.pg.query(`update access_grant set recorded_at = $2 where id = $1`, [id, BACKDATED]))
      .rejects.toThrow(/recorded_at is set by the database/);
    await expect(h.app((tx) => tx.query(`update membership set recorded_at = $2 where person_id = $1`, [h.person.jan, BACKDATED])))
      .rejects.toThrow(/recorded_at is set by the database/);
    const v = (await h.pg.query<{ id: string }>(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
      values ($1, $2, 1, 'k', $3, 1, 'application/pdf') returning id`, [h.t1, h.node.aud1, 'b'.repeat(64)])).rows[0]!.id;
    await expect(h.app((tx) => tx.query(`update document_version set created_at = $2 where id = $1`, [v, BACKDATED])))
      .rejects.toThrow(/created_at is set by the database/);
  });

  it('supersedes rows at database time, only once', async () => {
    const first = await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View }));
    const r = await h.app(async (tx) => {
      await setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf, now: new Date(BACKDATED) });
      const rows = (await tx.query<{ id: string; recorded_at: string; superseded_at: string }>(
        `select id, recorded_at, superseded_at from access_grant where subject_group_id = $1 order by recorded_at`, [h.group.a])).rows;
      const db = (await tx.query<{ now: string }>('select now()')).rows[0]!;
      return { rows, db: iso(db.now) };
    });
    const old = r.rows.find((x) => x.id === first)!;
    const replacement = r.rows.find((x) => x.id !== first)!;
    expect(iso(old.superseded_at)).toBe(r.db);
    expect(iso(replacement.recorded_at)).toBe(r.db);
    await expect(h.app((tx) => tx.query(`update membership set superseded_at = now() where person_id = $1`, [h.person.jan])))
      .resolves.toBeDefined();
    await expect(h.app((tx) => tx.query(`update membership set superseded_at = $2 where person_id = $1`, [h.person.jan, BACKDATED])))
      .rejects.toThrow(/already superseded/);
  });

  it('stamps events with database time', async () => {
    const r = await h.app(async (tx) => {
      const start = (await tx.query<{ t: string }>('select now() as t')).rows[0]!.t;
      const evs = [];
      for (let i = 0; i < 5; i++) {
        evs.push(await appendEvent(tx, { action: 'document.opened', workspaceId: h.ws, data: { i }, occurredAt: new Date(BACKDATED) }));
      }
      const stored = (await tx.query<{ occurred_at: string }>(
        `select occurred_at from event where chain_key = $1 order by chain_pos`, [h.ws])).rows.map((x) => new Date(x.occurred_at).getTime());
      return { start: new Date(start).getTime(), evs, stored };
    });
    expect(r.evs.every((e) => e.occurredAt.getTime() >= r.start)).toBe(true);
    expect(r.evs.map((e) => e.occurredAt.getTime())).toEqual(r.stored);
    expect(r.stored).toEqual([...r.stored].sort((a, b) => a - b));
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toEqual({ checked: 5, firstBroken: null });
  });

  it('ignores a shadowing record_clock() on the search path', async () => {
    await h.pg.exec(`create schema shadow;
      create function shadow.record_clock() returns timestamptz language sql stable as $$ select '2020-01-01'::timestamptz $$;
      create function shadow.db_clock_pin() returns timestamptz language sql stable as $$ select '2020-01-01'::timestamptz $$;
      grant usage on schema shadow to vdrkit_app;
      grant execute on all functions in schema shadow to vdrkit_app;`);
    const r = await h.app(async (tx) => {
      await tx.query('set local search_path = shadow, public');
      const g = (await tx.query<{ recorded_at: string }>(
        `insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level) values (current_tenant_id(), $1, $2, $3, 20) returning recorded_at`,
        [h.ws, h.node.fin, h.group.a])).rows[0]!;
      const e = await appendEvent(tx, { action: 'document.opened', workspaceId: h.ws });
      const db = (await tx.query<{ now: string }>('select pg_catalog.now() as now')).rows[0]!;
      return { recorded: iso(g.recorded_at), event: e.occurredAt.getTime(), db: iso(db.now) };
    });
    expect(r.recorded).toBe(r.db);
    expect(r.event).toBeGreaterThanOrEqual(new Date(r.db).getTime());
  });

  it('rejects events for a workspace in another tenant', async () => {
    const other = await withTenant(h.db, h.t2, (tx) => appendEvent(tx, { action: 'document.opened', workspaceId: h.ws }), { role: 'vdrkit_app' })
      .then(() => 'written', (e: Error) => e.message);
    expect(other).toMatch(/does not belong to the current tenant/);
    expect((await h.pg.query(`select 1 from event where tenant_id = $1`, [h.t2])).rows).toHaveLength(0);
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toMatchObject({ firstBroken: null });
  });

  it('only allows inserts through append_event()', async () => {
    await expect(h.app((tx) => tx.query(
      `insert into event (id, tenant_id, seq, chain_key, chain_pos, occurred_at, action, prev_hash, hash)
       values (gen_random_uuid(), current_tenant_id(), 99, $1, 99, $2, 'forged', 'x', 'y')`, [h.ws, BACKDATED])))
      .rejects.toThrow(/permission denied/);
  });

  it('should not let the app pin the clock', async () => {
    await expect(h.app((tx) => tx.query(
      `create or replace function db_clock_pin() returns timestamptz language sql stable as $$ select '2020-01-01'::timestamptz $$`)))
      .rejects.toThrow(/must be owner|permission denied/);
  });
});
