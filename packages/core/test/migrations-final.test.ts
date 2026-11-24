// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectiveAccess, Level, MIGRATIONS_DIR, present, setGrant } from '../src/index.js';
import { expectListingMatchesSingleChecks, heron, T, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { try { await expectListingMatchesSingleChecks(h); } finally { await h.pg.close(); } });

const at = (minutes: number) => new Date(T.at.getTime() + minutes * 60_000);
const level = (person: string, node: string) => h.app((tx) => effectiveAccess(tx, person, node, { at: T.at }));
const listed = async (person: string) => (await h.app((tx) => tx.query<{ node_id: string }>(
  `select node_id from accessible_nodes($1, $2, $3, null)`, [person, h.ws, T.at.toISOString()]))).rows.map((r) => r.node_id);
const setState = (state: string) => h.app((tx) => tx.query(`update workspace set state = $2 where id = $1`, [h.ws, state]));

async function grant(groupId: string, lvl: number, opts: { canUpload?: boolean } = {}) {
  await h.pin(T.grantsSet);
  await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId }, level: lvl, ...opts }));
  await h.pin(T.at);
}

async function functionsByFile(): Promise<Map<string, string[]>> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const out = new Map<string, string[]>();
  for (const f of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    const names = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi)].map((m) => m[1]!.toLowerCase());
    for (const n of names) out.set(n, [...(out.get(n) ?? []), f]);
  }
  return out;
}

describe('final function definitions', () => {
  it('defines each function once in 0015-0018', async () => {
    const recent = (f: string) => f >= '0015' && f < '0019';
    const twice = [...(await functionsByFile())].filter(([, files]) => files.filter(recent).length > 1);
    expect(twice).toEqual([]);
    for (const f of (await readdir(MIGRATIONS_DIR)).filter((x) => recent(x))) {
      expect(await readFile(join(MIGRATIONS_DIR, f), 'utf8'), f).not.toMatch(/pg_get_functiondef/);
    }
  });

  it('keeps all rules in effective_level and nda_accepted', async () => {
    const def = async (sig: string) => (await h.pg.query<{ d: string }>(`select pg_get_functiondef($1::regprocedure) as d`, [sig])).rows[0]!.d;
    const level = await def('effective_level(uuid, uuid, timestamptz, timestamptz)');
    expect(level).toContain('workspace_state_at(ws_id, p_at, k)');
    expect(level).toContain('public.nda_accepted(p_person, ws.id, k)');
    expect(level).not.toMatch(/accepted_at <= p_at|published_at <= p_at/);
    const nda = await def('nda_accepted(uuid, uuid, timestamptz)');
    expect(nda).toContain('requires_reacceptance');
    expect(nda).toMatch(/published_at <= p_known_at/);
    expect(nda).toMatch(/accepted_at <= p_known_at/);
  });
});

describe('room states', () => {
  it('hides a preparing room from bidders', async () => {
    await grant(h.group.a, Level.Pdf);
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.Pdf);
    await setState('preparing');
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: 'room_preparing' });
    expect(await listed(h.person.jan)).toEqual([]);
    expect((await level(h.person.anika, h.node.aud1)).level).toBe(Level.Original);
  });

  it('blocks uploads in a frozen room', async () => {
    await grant(h.group.contributors, Level.View, { canUpload: true });
    expect((await level(h.person.maria, h.node.aud1)).canUpload).toBe(true);
    await setState('frozen');
    expect(await level(h.person.maria, h.node.aud1)).toMatchObject({ level: Level.View, canUpload: false });
  });
});

describe('the NDA gate', () => {
  beforeEach(async () => { await grant(h.group.a, Level.View); });

  async function publishNda(no: number, everyone: boolean, when: Date) {
    await h.pin(when);
    const id = (await h.pg.query<{ id: string }>(
      `insert into agreement_version (tenant_id, agreement_id, version_no, body, requires_reacceptance)
       values ($1, $2, $3, 'Text', $4) returning id`, [h.t1, h.nda.agreement, no, everyone])).rows[0]!.id;
    await h.pin(T.at);
    return id;
  }

  it('only asks everyone again for a full NDA version', async () => {
    await publishNda(2, false, at(-60));
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.View);
    await publishNda(3, true, at(-30));
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: 'nda_not_accepted' });
  });

  it('uses the database clock for NDA acceptance', async () => {
    const appNow = new Date('2026-11-12T08:00:00Z');
    await h.pin(new Date('2026-11-12T08:01:00Z'));
    const v2 = (await h.app((tx) => tx.query<{ id: string }>(
      `insert into agreement_version (tenant_id, agreement_id, version_no, body) values (current_tenant_id(), $1, 2, 'Version 2') returning id`,
      [h.nda.agreement]))).rows[0]!.id;
    expect(await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, present(appNow)))).toMatchObject({ level: 0, reason: 'nda_not_accepted' });
    await h.app((tx) => tx.query(`insert into acceptance (tenant_id, agreement_version_id, person_id) values (current_tenant_id(), $1, $2)`, [v2, h.person.jan]));
    expect((await h.app((tx) => effectiveAccess(tx, h.person.jan, h.node.aud1, present(appNow)))).level).toBe(Level.View);
    expect((await h.app((tx) => tx.query<{ ok: boolean }>(`select nda_accepted($1, $2, record_clock()) as ok`, [h.person.jan, h.ws]))).rows[0]!.ok).toBe(true);
  });
});

describe('grants and rooms', () => {
  it('refuses a grant on a node in another room', async () => {
    const other = (await h.pg.query<{ id: string }>(`insert into workspace (tenant_id, name, state, time_zone)
      values ($1, 'Project Osprey', 'open', 'Africa/Johannesburg') returning id`, [h.t1])).rows[0]!.id;
    const node = (await h.pg.query<{ id: string }>(`insert into node (tenant_id, workspace_id, kind, name, index_number, state)
      values ($1, $2, 'folder', 'Legal', '1', 'published') returning id`, [h.t1, other])).rows[0]!.id;
    const insert = (ws: string) => h.app((tx) => tx.query(
      `insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level) values (current_tenant_id(), $1, $2, $3, 20)`,
      [ws, node, h.group.a]));
    await expect(insert(h.ws)).rejects.toThrow(/access_grant_node_in_workspace/);
    await expect(insert(other)).resolves.toBeDefined();
  });
});
