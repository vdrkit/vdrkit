// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectiveAccess, Level, setGrant } from '../src/index.js';
import { heron, T, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { await h.pg.close(); });

async function grant(input: Omit<Parameters<typeof setGrant>[1], 'workspaceId'>, at = T.grantsSet) {
  await h.pin(at);
  try {
    return await h.app((tx) => setGrant(tx, { workspaceId: h.ws, ...input }));
  } finally {
    await h.pin(T.at);
  }
}

type Row = { group_id: string; node_id: string; level: number; can_upload: boolean; can_publish: boolean; source_node_id: string | null; capped: boolean };
async function matrix(at = T.at): Promise<Row[]> {
  return h.app(async (tx) => (await tx.query<Row>(`select * from group_access_matrix($1, $2)`, [h.ws, at.toISOString()])).rows
    .map((r) => ({ ...r, level: Number(r.level) })));
}
const cell = (rows: Row[], g: string, n: string) => rows.find((r) => r.group_id === g && r.node_id === n);

describe('group_access_matrix', () => {
  beforeEach(async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Print, canUpload: true });
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.aFin }, level: Level.Pdf, canUpload: true });
    await grant({ nodeId: h.node.tax, subject: { groupId: h.group.a }, level: Level.None });
    await grant({ nodeId: h.node.aud, subject: { groupId: h.group.b }, level: Level.View });
    await grant({ nodeId: h.node.tax1, subject: { groupId: h.group.b }, level: Level.Original });
  });

  it('should match effective_level for single-group members', async () => {
    const rows = await matrix();
    const people: [string, string][] = [[h.person.jan, h.group.a], [h.person.lars, h.group.aFin], [h.person.mei, h.group.b], [h.person.maria, h.group.contributors]];
    const nodes: [string, string][] = [[h.node.fin, h.node.fin], [h.node.aud, h.node.aud], [h.node.tax, h.node.tax], [h.node.it, h.node.it],
      // tax1 has its own grant for Bidder B
      [h.node.aud1, h.node.aud], [h.node.tax1, h.node.tax1]];
    for (const [person, group] of people) {
      for (const [node, row] of nodes) {
        const e = await h.app((tx) => effectiveAccess(tx, person, node, { at: T.at }));
        const m = cell(rows, group, row);
        if (row === h.node.tax1 && group !== h.group.b) {
          expect(m, 'only Bidder B has its own grant on 3.4.6, but every group gets a row for it').toBeDefined();
        }
        expect({ level: m?.level, up: m?.can_upload }, `${person} on ${node}`).toEqual({ level: e.level, up: e.canUpload });
      }
    }
  });

  it('marks source folder, blocks and capped subgroups', async () => {
    const rows = await matrix();
    expect(cell(rows, h.group.a, h.node.aud)).toMatchObject({ level: Level.Print, source_node_id: h.node.fin, capped: false });
    expect(cell(rows, h.group.a, h.node.tax)).toMatchObject({ level: Level.None, source_node_id: h.node.tax });
    expect(cell(rows, h.group.aFin, h.node.fin)).toMatchObject({ level: Level.Print, capped: true, can_upload: true });
    expect(cell(rows, h.group.aFin, h.node.tax)).toMatchObject({ level: 0, source_node_id: h.node.fin, capped: true });
    expect(cell(rows, h.group.b, h.node.it)).toMatchObject({ level: 0, source_node_id: null, capped: false });
  });

  it('lists folders and documents with their own grant', async () => {
    const nodes = new Set((await matrix()).map((r) => r.node_id));
    expect(nodes).toEqual(new Set([h.node.fin, h.node.aud, h.node.tax, h.node.it, h.node.tax1]));
  });

  it('uses the grants in force at a past date', async () => {
    const later = new Date(T.at.getTime() + 3_600_000);
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Original }, later);
    await h.pin(new Date(later.getTime() + 60_000));
    expect(cell(await matrix(T.at), h.group.a, h.node.fin)?.level).toBe(Level.Print);
    expect(cell(await matrix(new Date(later.getTime() + 60_000)), h.group.a, h.node.fin)?.level).toBe(Level.Original);
  });

  it('skips expired groups', async () => {
    await h.pg.query(`update groups set valid_to = $2 where id = $1`, [h.group.b, new Date(T.at.getTime() - 1000).toISOString()]);
    expect((await matrix()).some((r) => r.group_id === h.group.b)).toBe(false);
  });
});
