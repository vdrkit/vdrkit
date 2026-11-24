// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { canSeeVersion, versionAccess } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';


let h: Heron;
let app: FastifyInstance;
let clock: Date;
let v1: string;
let v2: string;
const principal: Record<string, string> = {};

const W = () => `/v1/workspaces/${h.ws}`;
const later = (m: number) => new Date(T.at.getTime() + m * 60_000);
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const shown = (person: string) => h.app((tx) => versionAccess(tx, { kind: 'person', personId: person }, h.node.aud1, { at: clock })).then((v) => v.versionId);

async function version(node: string, no: number, uploader: string, groups: string[] = [], awaiting = false): Promise<string> {
  return (await h.pg.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, visible_to_group_ids, awaiting_release, processing_status)
     values ($1, $2, $3, $4, $5, 1, 'application/pdf', $6, $7::uuid[], $8, 'ready') returning id`,
    [h.t1, node, no, `k/${node}/${no}`, String(no).repeat(64), principal[uploader], groups, awaiting])).rows[0]!.id;
}

beforeEach(async () => {
  h = await heron();
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock });
  for (const p of ['anika', 'maria'] as const) {
    principal[p] = (await h.pg.query<{ id: string }>(`insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, $3) returning id`,
      [h.t1, h.person[p], p])).rows[0]!.id;
  }
  const res = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [
    { nodeId: h.node.fin, groupId: h.group.a, level: 20 },
    { nodeId: h.node.fin, groupId: h.group.b, level: 20 },
    { nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true },
  ] });
  expect(res.statusCode).toBe(200);
  v1 = await version(h.node.aud1, 1, 'anika');
  v2 = await version(h.node.aud1, 2, 'maria', [h.group.admins, h.group.contributors], true);
  clock = later(1);
});
afterEach(async () => { await app.close(); await h.pg.close(); });

describe('release review of new versions', () => {
  it('lists a waiting version while bidders keep version 1', async () => {
    expect(await shown(h.person.jan)).toBe(v1);
    expect(await shown(h.person.maria)).toBe(v2);
    const items = (await call('POST', `${W()}/release-preview`, h.person.anika, {})).json().items;
    const item = items.find((i: any) => i.versionId === v2);
    expect(item).toMatchObject({ id: h.node.aud1, indexNumber: '3.2.1', versionNo: 2 });
    expect(item.groups.map((g: any) => g.name)).toEqual(['Bidder A', 'Bidder B']);
    expect(items.find((i: any) => i.id === h.node.audDraft)).toMatchObject({ versionId: null, versionNo: null });
    const one = (await call('POST', `${W()}/release-preview`, h.person.anika, { versionIds: [v2] })).json().items;
    expect(one.map((i: any) => i.versionId)).toEqual([v2]);
  });

  it('lists the released version behind it', async () => {
    await h.pg.query(`update document_version set page_count = $2 where id = $1`, [v1, 6]);
    await h.pg.query(`update document_version set page_count = $2 where id = $1`, [v2, 7]);
    const row = async (person: string) => (await call('GET', `${W()}/nodes?parent=${h.node.aud}`, person)).json().items.find((i: any) => i.id === h.node.aud1);
    const anika = await row(h.person.anika);
    expect(anika.version).toMatchObject({ id: v2, pageCount: 7 });
    expect(anika.releasedVersion).toEqual({ id: v1, pageCount: 6, noPreview: null });
    const jan = await row(h.person.jan);
    expect(jan.version).toMatchObject({ id: v1, pageCount: 6 });
    expect(jan.releasedVersion).toBeUndefined();
  });

  it('applies the version rule to the groups shown', async () => {
    await h.pg.query(`update document_version set visible_to_group_ids = $2::uuid[] where id = $1`, [v1, [h.group.a]]);
    await version(h.node.audDraft, 1, 'anika', [h.group.b]);
    const items = (await call('POST', `${W()}/release-preview`, h.person.anika, {})).json().items;
    expect(items.find((i: any) => i.versionId === v2).groups.map((g: any) => g.name)).toEqual(['Bidder A']);
    expect(items.find((i: any) => i.id === h.node.audDraft).groups.map((g: any) => g.name)).toEqual(['Bidder B']);
  });
});

describe('publishing a new version', () => {
  it('releases to the groups of the replaced version', async () => {
    await h.pg.query(`update document_version set visible_to_group_ids = $2::uuid[] where id = $1`, [v1, [h.group.a]]);
    const res = await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [v2] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ published: 0, versionsReleased: 1 });
    const row = (await h.pg.query<any>(`select awaiting_release, visible_to_group_ids, released_at, released_by from document_version where id = $1`, [v2])).rows[0];
    expect(row).toMatchObject({ awaiting_release: false, visible_to_group_ids: [h.group.a], released_by: h.person.anika });
    expect(new Date(row.released_at).toISOString()).toBe(T.at.toISOString());
    expect(await shown(h.person.jan)).toBe(v2);
    expect(await shown(h.person.mei)).toBe(null);
    const told = (await h.pg.query<{ person_id: string; version_id: string }>(
      `select n.person_id, i.version_id from notification n join notification_item i on i.notification_id = n.id where i.action = 'document.version_published'`)).rows;
    expect(told.map((t) => t.person_id)).toContain(h.person.jan);
    expect(told.map((t) => t.person_id)).not.toContain(h.person.mei);
    expect(told.every((t) => t.version_id === v2)).toBe(true);
    const ev = (await h.pg.query<{ data: any }>(`select data from event where action = 'document.version_published'`)).rows;
    expect(ev[0]!.data).toMatchObject({ version_id: v2, version_no: 2, index_number: '3.2.1' });
    expect((await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [v2] })).statusCode).toBe(400);
  });

  it('applies the publish right and four-eyes rule', async () => {
    expect((await call('POST', `${W()}/publish`, h.person.jan, { versionIds: [v2] })).json().reason).toBe('no_publish_right');
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true })).statusCode).toBe(200);
    const own = await call('POST', `${W()}/publish`, h.person.maria, { versionIds: [v2] });
    expect([own.statusCode, own.json().reason]).toEqual([403, 'four_eyes']);
    expect(own.json().items).toEqual([{ id: h.node.aud1, indexNumber: '3.2.1', versionId: v2 }]);
    const v3 = await version(h.node.tax1, 2, 'anika', [h.group.admins], true);
    expect((await call('POST', `${W()}/publish`, h.person.maria, { versionIds: [v3] })).json()).toMatchObject({ versionsReleased: 1 });
    expect((await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [v2] })).json()).toMatchObject({ versionsReleased: 1 });
  });

  it('returns 404 for unknown and 400 for non-waiting versions', async () => {
    expect((await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [h.node.aud1] })).statusCode).toBe(404);
    expect((await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [v1] })).statusCode).toBe(400);
    expect((await call('POST', `${W()}/publish`, h.person.anika, {})).statusCode).toBe(400);
  });
});

describe('withdrawing a released version', () => {
  it('falls back to the previous version', async () => {
    await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [v2] });
    expect(await shown(h.person.jan)).toBe(v2);
    const res = await call('POST', `${W()}/versions/${v2}/withdraw`, h.person.anika, { reason: 'Wrong file' });
    expect([res.statusCode, res.json().fallsBackTo]).toEqual([200, 1]);
    expect(await shown(h.person.jan)).toBe(v1);
    expect(await shown(h.person.anika)).toBe(v1);
    const jan = { kind: 'person' as const, personId: h.person.jan };
    expect(await h.app((tx) => canSeeVersion(tx, jan, v2, { at: clock }))).toBe(false);
    const last = await call('POST', `${W()}/versions/${v1}/withdraw`, h.person.anika, {});
    expect([last.statusCode, last.json().detail]).toEqual([400, 'This is the only released version. Withdraw the document instead.']);
    expect((await h.pg.query(`select 1 from event where action = 'document.version_withdrawn'`)).rows).toHaveLength(1);
  });

  it('refuses waiting versions and people without the right', async () => {
    expect((await call('POST', `${W()}/versions/${v2}/withdraw`, h.person.anika, {})).statusCode).toBe(400);
    await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [v2] });
    expect((await call('POST', `${W()}/versions/${v2}/withdraw`, h.person.jan, {})).json().reason).toBe('no_publish_right');  });
});
