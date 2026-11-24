// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canSeeVersion, versionAccess } from '../src/index.js';
import { heron, T, type Heron } from './fixture.js';

let h: Heron;
let v1: string;
let v2: string;

const version = async (no: number, groups: string[]) => (await h.pg.query<{ id: string }>(
  `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, visible_to_group_ids)
   values ($1, $2, $3, $4, $5, 1, 'application/pdf', $6::uuid[]) returning id`,
  [h.t1, h.node.aud1, no, `k${no}`, String(no).repeat(64), groups])).rows[0]!.id;

beforeEach(async () => {
  h = await heron();
  await h.pin(T.grantsSet);
  for (const g of [h.group.a, h.group.aFin, h.group.b]) {
    await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level)
      values ($1, $2, $3, $4, 20)`, [h.t1, h.ws, h.node.fin, g]);
  }
  await h.pin(T.at);
  v1 = await version(1, []);
  v2 = await version(2, [h.group.a]);
});
afterEach(async () => { await h.pg.close(); });

const person = (personId: string) => ({ kind: 'person' as const, personId });
const at = { at: T.at };

describe('version visibility', () => {
  it('picks the newest visible version', async () => {
    expect(await h.app((tx) => versionAccess(tx, person(h.person.jan), h.node.aud1, at))).toEqual({ versionId: v2, hidden: false });
    expect(await h.app((tx) => versionAccess(tx, person(h.person.lars), h.node.aud1, at))).toEqual({ versionId: v2, hidden: false });
    expect(await h.app((tx) => versionAccess(tx, person(h.person.mei), h.node.aud1, at))).toEqual({ versionId: v1, hidden: false });
    expect(await h.app((tx) => canSeeVersion(tx, person(h.person.mei), v2, at))).toBe(false);
    expect(await h.app((tx) => canSeeVersion(tx, person(h.person.mei), v1, at))).toBe(true);
  });

  it('hides the document when no version is visible', async () => {
    await h.pg.query(`update document_version set visible_to_group_ids = $2::uuid[] where id = $1`, [v1, [h.group.a]]);
    expect(await h.app((tx) => versionAccess(tx, person(h.person.mei), h.node.aud1, at))).toEqual({ versionId: null, hidden: true });
    const rows = await h.app((tx) => tx.query<{ node_id: string }>(`select node_id from readable_nodes($1, $2, $3)`, [h.person.mei, h.ws, T.at.toISOString()]));
    expect(rows.rows.map((r) => r.node_id)).not.toContain(h.node.aud1);
    expect(await h.app((tx) => versionAccess(tx, person(h.person.mei), h.node.tax1, at))).toEqual({ versionId: null, hidden: false });
  });

  it('shows admins and uploaders every version', async () => {
    await h.pg.query(`update document_version set visible_to_group_ids = $1::uuid[]`, [[h.group.b]]);
    expect((await h.app((tx) => versionAccess(tx, person(h.person.anika), h.node.aud1, at))).versionId).toBe(v2);
    expect((await h.app((tx) => versionAccess(tx, person(h.person.maria), h.node.aud1, at))).versionId).toBe(v2);
    const agent = { kind: 'agent' as const, principalId: h.person.maria, onBehalfOfPersonId: h.person.maria, maxLevel: 60 as const };
    expect(await h.app((tx) => versionAccess(tx, agent, h.node.aud1, at))).toEqual({ versionId: null, hidden: true });
  });

  it('ignores ended memberships', async () => {
    const ended = new Date(T.at.getTime() - 3_600_000);
    await h.pin(T.setup);
    const first = (await h.pg.query<{ id: string }>(`insert into membership (tenant_id, person_id, group_id) values ($1, $2, $3) returning id`,
      [h.t1, h.person.mei, h.group.a])).rows[0]!.id;
    await h.pin(ended);
    await h.pg.query(`update membership set superseded_at = now() where id = $1`, [first]);
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, valid_to) values ($1, $2, $3, $4)`,
      [h.t1, h.person.mei, h.group.a, ended.toISOString()]);
    await h.pin(T.at);
    expect((await h.app((tx) => versionAccess(tx, person(h.person.mei), h.node.aud1, at))).versionId).toBe(v1);
    expect(await h.app((tx) => canSeeVersion(tx, person(h.person.mei), v2, at))).toBe(false);
    expect((await h.app((tx) => versionAccess(tx, person(h.person.mei), h.node.aud1, { at: T.ndaAccepted }))).versionId).toBe(v2);
  });
});
