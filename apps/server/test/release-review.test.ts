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
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted' }; } };

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, person: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1, ...extra }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const later = (m: number) => new Date(T.at.getTime() + m * 60_000);
const review = (person: string, extra: Record<string, string> = {}) => call('GET', `${W()}/release-review`, person, undefined, extra);
const level = (p: string, n: string) => h.app((tx) => effectiveAccess(tx, p, n, { at: clock })).then((a) => a.level);

async function node(parent: string, name: string, idx: string, kind = 'document', state = 'draft'): Promise<string> {
  return (await h.pg.query<{ id: string }>(
    `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [h.t1, h.ws, parent, kind, name, idx, state])).rows[0]!.id;
}

const principals = new Map<string, string>();
async function version(nodeId: string, personId: string, opts: { no?: number; status?: string; pages?: number; awaiting?: boolean } = {}) {
  let principal = principals.get(personId);
  if (!principal) {
    principal = (await h.pg.query<{ id: string }>(
      `insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'test') returning id`, [h.t1, personId])).rows[0]!.id;
    principals.set(personId, principal);
  }
  return (await h.pg.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, processing_status, page_count, awaiting_release)
     values ($1, $2, $3, 'k', $4, 1, 'application/pdf', $5, $6, $7, $8) returning id`,
    [h.t1, nodeId, opts.no ?? 1, 'a'.repeat(64), principal, opts.status ?? 'ready', opts.pages ?? 7, opts.awaiting ?? false])).rows[0]!.id;
}

beforeEach(async () => {
  h = await heron();
  principals.clear();
  outbox = [];
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer });
  const res = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [
    { nodeId: h.node.fin, groupId: h.group.a, level: 40 },
    { nodeId: h.node.fin, groupId: h.group.aFin, level: 20 },
    { nodeId: h.node.fin, groupId: h.group.b, level: 20 },
    { nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true },
  ] });
  expect(res.statusCode).toBe(200);
  await version(h.node.audDraft, h.person.maria, { pages: 12 });
  clock = later(1);
});
afterEach(async () => { await app.close(); await h.pg.close(); });

describe('access', () => {
  it('gives room admins every draft', async () => {
    const itDraft = await node(h.node.it, 'Network diagram.pdf', '6.1');
    await version(itDraft, h.person.anika, { pages: 3 });
    const res = await review(h.person.anika);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.me).toEqual({ isAdmin: true, scope: null, canPublishFolder: null });
    expect(body.room).toEqual({ state: 'open', fourEyes: false, summaryTimes: ['08:00'], noticeMandatory: false });
    expect(body.groups.map((g: any) => g.name)).toEqual(['Bidder A', 'Bidder A financier', 'Bidder A Q&A team', 'Bidder B']);
    expect(body.folders.map((f: any) => f.indexNumber)).toEqual(['3.2', '6']);
    const [aud, it] = body.folders;
    expect(aud.groups).toEqual([{ id: h.group.a, level: 40 }, { id: h.group.aFin, level: 20 }, { id: h.group.b, level: 20 }]);
    expect(it.groups).toEqual([]);
    expect(body.items.map((i: any) => [i.indexNumber, i.folderId, i.uploadedBy, i.pageCount, i.blocked, i.groups])).toEqual([
      ['3.2.5', h.node.aud, 'Maria Botha', 12, null, null],
      ['6.1', h.node.it, 'Anika Pillay', 3, null, null],
    ]);
    expect(body.items[1].uploadedByMe).toBe(true);
  });

  it('limits a publisher to her folders', async () => {
    await node(h.node.it, 'Network diagram.pdf', '6.1');
    const body = (await review(h.person.maria)).json();
    expect(body.me).toEqual({ isAdmin: false, scope: [{ id: h.node.fin, indexNumber: '3', name: 'Finance' }], canPublishFolder: null });
    expect(body.items.map((i: any) => i.indexNumber)).toEqual(['3.2.5']);
    expect(body.folders.map((f: any) => f.indexNumber)).toEqual(['3.2']);
  });

  it('returns 404 for bidders, contributors and agents', async () => {
    const missing = await call('GET', `/v1/workspaces/${crypto.randomUUID()}/release-review`, h.person.jan);
    expect(missing.statusCode).toBe(404);
    for (const p of [h.person.jan, h.person.lars, h.person.mei]) {
      const res = await review(p);
      expect([res.statusCode, res.json()]).toEqual([404, missing.json()]);
    }
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true }] });
    clock = later(2);
    expect((await review(h.person.maria)).json()).toEqual(missing.json());
    const agent = await review(h.person.anika, { 'x-dev-agent-max-level': '60' });
    expect([agent.statusCode, agent.json()]).toEqual([404, missing.json()]);
  });

  it('stays closed to bidders with the publish switch', async () => {
    // not possible through the API
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 40, canPublish: true }] })).statusCode).toBe(400);
    await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, can_publish, recorded_at)
      values ($1, $2, $3, $4, 40, true, $5)`, [h.t1, h.ws, h.node.aud, h.group.a, T.grantsSet.toISOString()]);
    clock = later(2);
    expect((await review(h.person.jan)).statusCode).toBe(404);
    const preview = await call('POST', `${W()}/release-preview`, h.person.jan, {});
    expect([preview.statusCode, preview.json().reason]).toEqual([403, 'no_publish_right']);
  });
});

describe('draft details', () => {
  it('marks unfinished files', async () => {
    const proc = await node(h.node.aud, "Auditor's report FY2025.pdf", '3.2.6');
    await version(proc, h.person.maria, { status: 'processing', pages: undefined });
    const failed = await node(h.node.aud, 'Scan.pdf', '3.2.7');
    await version(failed, h.person.maria, { status: 'failed' });
    const items = (await review(h.person.anika)).json().items;
    expect(items.map((i: any) => [i.indexNumber, i.blocked])).toEqual([['3.2.5', null], ['3.2.6', 'processing'], ['3.2.7', 'failed']]);
  });

  it("applies four-eyes to a publisher's uploads", async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true });
    const mine = await node(h.node.aud, 'Board pack.pdf', '3.2.6');
    await version(mine, h.person.anika);
    clock = later(2);
    const maria = (await review(h.person.maria)).json();
    expect(maria.room.fourEyes).toBe(true);
    expect(maria.items.map((i: any) => [i.indexNumber, i.uploadedByMe, i.blocked])).toEqual([['3.2.5', true, 'four_eyes'], ['3.2.6', false, null]]);
    const anika = (await review(h.person.anika)).json();
    expect(anika.items.map((i: any) => i.blocked)).toEqual([null, null]);
  });

  it('shows which version is replaced', async () => {
    await version(h.node.aud1, h.person.anika);
    const v2 = await version(h.node.aud1, h.person.maria, { no: 2, awaiting: true, pages: 9 });
    const items = (await review(h.person.anika)).json().items;
    expect(items.find((i: any) => i.versionId === v2)).toMatchObject({ id: h.node.aud1, indexNumber: '3.2.1', replacesVersionNo: 1, pageCount: 9, uploadedBy: 'Maria Botha' });
  });

  it('should show restricted groups', async () => {
    const custom = await node(h.node.aud, 'Side letter.pdf', '3.2.6');
    await version(custom, h.person.anika);
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: custom, groupId: h.group.b, level: 50 }] });
    const limited = await node(h.node.aud, 'Bidder A only.pdf', '3.2.7');
    const v = await version(limited, h.person.anika);
    await h.pg.query(`update document_version set visible_to_group_ids = $2::uuid[] where id = $1`, [v, [h.group.a]]);
    clock = later(2);
    const items = (await review(h.person.anika)).json().items;
    expect(items.find((i: any) => i.id === custom).groups).toEqual([{ id: h.group.a, level: 40 }, { id: h.group.aFin, level: 20 }, { id: h.group.b, level: 50 }]);
    expect(items.find((i: any) => i.id === limited).groups).toEqual([{ id: h.group.a, level: 40 }, { id: h.group.aFin, level: 20 }]);
  });

  it('names individual bidders', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.it, personId: h.person.mei, level: 20 }] });
    const itDraft = await node(h.node.it, 'Network diagram.pdf', '6.1');
    clock = later(2);
    const item = (await review(h.person.anika)).json().items.find((i: any) => i.id === itDraft);
    expect(item.groups).toBeNull();
    expect(item.people).toEqual([{ id: h.person.mei, name: 'Mei Tanaka', level: 20 }]);
  });
});

describe('publishing', () => {
  const notifications = async (person: string) =>
    (await h.pg.query<{ mode: string }>(`select mode from notification where person_id = $1 order by created_at`, [person])).rows.map((r) => r.mode);

  const eventData = async (action: string, node: string) =>
    (await h.pg.query<{ data: any }>(`select data from event where action = $1 and resource_id = $2`, [action, node])).rows[0]!.data;

  it("should use each person's settings", async () => {
    const res = await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft] });
    expect(res.json()).toMatchObject({ published: 1, versionsReleased: 0, quiet: false });
    expect(await notifications(h.person.jan)).toEqual(['bundled']);
    expect(await notifications(h.person.maria)).toEqual(['bundled']);
    const data = await eventData('document.published', h.node.audDraft);
    expect([data.quiet, 'notify' in data]).toEqual([false, false]);
  });

  it("keeps a bidder's chosen frequency", async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, mode)
      values ($1, $2, 'user', $3, 'documents', 'digest')`, [h.t1, h.ws, h.person.jan]);
    await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft] });
    expect(await notifications(h.person.jan)).toEqual(['digest']);
    expect(await notifications(h.person.lars)).toEqual(['bundled']);
  });

  it('quiet release sends nothing', async () => {
    const res = await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [h.node.audDraft], quiet: true });
    expect(res.json()).toEqual({ published: 1, versionsReleased: 0, notified: 0, quiet: true });
    expect(await level(h.person.jan, h.node.audDraft)).toBe(40);
    for (const p of [h.person.jan, h.person.mei, h.person.lars, h.person.anika]) expect(await notifications(p)).toEqual([]);
    expect((await eventData('document.published', h.node.audDraft)).quiet).toBe(true);
  });

  it('sends mandatory emails even when quiet', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, category, mode, mandatory)
      values ($1, $2, 'workspace', 'documents', 'digest', true)`, [h.t1, h.ws]);
    expect((await review(h.person.anika)).json().room.noticeMandatory).toBe(true);
    await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft], quiet: true });
    expect(await notifications(h.person.jan)).toEqual(['digest']);
  });

  it('rejects a notify option', async () => {
    for (const notify of ['digest', 'now', 'none']) {
      const res = await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft], notify });
      expect(res.statusCode).toBe(400);
    }
    expect(await level(h.person.jan, h.node.audDraft)).toBe(0);
    expect((await call('GET', `${W()}/settings`, h.person.anika)).json()).not.toHaveProperty('publishNotify');
    expect((await review(h.person.anika)).json().room).not.toHaveProperty('publishNotify');
    const cols = await h.pg.query(`select 1 from information_schema.columns where table_name = 'workspace' and column_name = 'publish_notify'`);
    expect(cols.rows).toHaveLength(0);
  });

  it('refuses unfinished files', async () => {
    const proc = await node(h.node.aud, 'Auditor’s report FY2025.pdf', '3.2.6');
    await version(proc, h.person.maria, { status: 'processing' });
    const failed = await node(h.node.aud, 'Scan.pdf', '3.2.7');
    await version(failed, h.person.maria, { status: 'failed' });
    const pending = await node(h.node.aud, 'Board pack.pdf', '3.2.8');
    await version(pending, h.person.maria, { status: 'pending' });
    clock = later(2);
    const one = await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [proc] });
    expect([one.statusCode, one.json().reason, one.json().detail]).toEqual([409, 'not_ready',
      '3.2.6 Auditor’s report FY2025.pdf is still being prepared for viewing. Release it once it is ready, in about a minute.']);
    const bad = await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [failed] });
    expect([bad.statusCode, bad.json().detail]).toEqual([409, '3.2.7 Scan.pdf could not be prepared for viewing, so it cannot be released. Upload a new copy first.']);
    const mixed = await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft, proc, failed, pending] });
    expect([mixed.statusCode, mixed.json().detail]).toEqual([409,
      '3 of the selected files are not ready: 1 could not be prepared for viewing and needs a new copy, and 2 are still being prepared. Nothing was released.']);
    expect(mixed.json().items.map((i: any) => [i.indexNumber, i.status]).sort()).toEqual([['3.2.6', 'processing'], ['3.2.7', 'failed'], ['3.2.8', 'processing']]);
    for (const n of [h.node.audDraft, proc, failed, pending]) expect(await level(h.person.jan, n)).toBe(0);
    expect(await notifications(h.person.jan)).toEqual([]);
    await version(h.node.aud1, h.person.anika);
    const v2 = await version(h.node.aud1, h.person.anika, { no: 2, awaiting: true, status: 'processing' });
    const ver = await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [v2] });
    expect([ver.statusCode, ver.json().reason]).toEqual([409, 'not_ready']);
    expect((await h.pg.query<{ awaiting_release: boolean }>(`select awaiting_release from document_version where id = $1`, [v2])).rows[0]!.awaiting_release).toBe(true);
    await h.pg.query(`update document_version set processing_status = 'ready' where node_id = $1`, [proc]);
    expect((await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [proc] })).statusCode).toBe(200);
  });

  it('refuses frozen rooms', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { state: 'frozen' });
    clock = later(2);
    for (const p of [h.person.anika, h.person.maria]) {
      const res = await call('POST', `${W()}/publish`, p, { nodeIds: [h.node.audDraft] });
      expect([res.statusCode, res.json().reason, res.json().detail]).toEqual([409, 'room_frozen',
        'The room is frozen. Nobody can publish until a room admin opens it again in Room settings.']);
    }
    const jan = await call('POST', `${W()}/publish`, h.person.jan, { nodeIds: [h.node.audDraft] });
    expect([jan.statusCode, jan.json().reason]).toEqual([403, 'no_publish_right']);
    expect((await review(h.person.maria)).json().room.state).toBe('frozen');
    expect(await level(h.person.jan, h.node.audDraft)).toBe(0);
  });
});

describe('single release', () => {
  const one = (person: string, folder: string, extra: Record<string, string> = {}) =>
    call('GET', `${W()}/release-review?folder=${folder}`, person, undefined, extra);
  const state = async (id: string) => (await h.pg.query<{ state: string }>(`select state from node where id = $1`, [id])).rows[0]!.state;

  it('lists direct children only', async () => {
    const itDraft = await node(h.node.it, 'Network diagram.pdf', '6.1');
    await version(itDraft, h.person.anika);
    await version(h.node.aud1, h.person.anika);
    const v2 = await version(h.node.aud1, h.person.anika, { no: 2, awaiting: true });
    clock = later(2);
    const body = (await one(h.person.anika, h.node.aud)).json();
    expect(body.room).toEqual({ state: 'open', fourEyes: false, summaryTimes: ['08:00'], noticeMandatory: false });
    expect(body.me.canPublishFolder).toBe(true);
    expect(body.items.map((i: any) => [i.indexNumber, i.versionId])).toEqual([['3.2.1', v2], ['3.2.5', null]]);
    expect(body.folders.map((f: any) => f.indexNumber)).toEqual(['3.2']);
    expect((await one(h.person.anika, h.node.fin)).json().items).toEqual([]);
    expect((await one(h.person.maria, h.node.it)).json().items).toEqual([]);
    expect((await call('GET', `${W()}/release-review?folder=nope`, h.person.anika)).statusCode).toBe(400);
  });

  it('publishes one draft', async () => {
    const res = await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [h.node.audDraft] });
    expect([res.statusCode, res.json()]).toEqual([200, expect.objectContaining({ published: 1, versionsReleased: 0, quiet: false })]);
    expect(await state(h.node.audDraft)).toBe('published');
    expect(await level(h.person.jan, h.node.audDraft)).toBe(40);

    await version(h.node.aud1, h.person.maria);
    const v2 = await version(h.node.aud1, h.person.maria, { no: 2, awaiting: true });
    clock = later(3);
    const rel = await call('POST', `${W()}/publish`, h.person.anika, { versionIds: [v2], quiet: true });
    expect(rel.json()).toMatchObject({ published: 0, versionsReleased: 1, notified: 0, quiet: true });
    expect((await h.pg.query<{ awaiting_release: boolean }>(`select awaiting_release from document_version where id = $1`, [v2])).rows[0]!.awaiting_release).toBe(false);
  });

  it('says if the caller may publish', async () => {
    expect((await one(h.person.maria, h.node.aud)).json().me.canPublishFolder).toBe(true);
    // publish right on one draft only
    const g = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [
      { nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true },
      { nodeId: h.node.audDraft, personId: h.person.maria, level: 20, canUpload: true, canPublish: true },
    ] });
    expect(g.statusCode).toBe(200);
    clock = later(2);
    const body = (await one(h.person.maria, h.node.aud)).json();
    expect(body.me.canPublishFolder).toBe(false);
    expect(body.items.map((i: any) => i.id)).toEqual([h.node.audDraft]);
    expect((await review(h.person.maria)).json().me.canPublishFolder).toBeNull();
    expect((await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [h.node.audDraft] })).statusCode).toBe(200);
  });

  it('should respect four-eyes', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true });
    clock = later(2);
    expect((await one(h.person.maria, h.node.aud)).json().items.map((i: any) => i.blocked)).toEqual(['four_eyes']);
    const res = await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [h.node.audDraft] });
    expect([res.statusCode, res.json().reason, res.json().detail]).toEqual([403, 'four_eyes', 'This room needs a second person to publish. You uploaded this document yourself.']);
    expect(await state(h.node.audDraft)).toBe('draft');
    expect((await one(h.person.anika, h.node.aud)).json().items.map((i: any) => i.blocked)).toEqual([null]);
    expect((await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft] })).statusCode).toBe(200);
  });

  it('refuses when frozen', async () => {
    await call('PATCH', `${W()}/settings`, h.person.anika, { state: 'frozen' });
    clock = later(2);
    expect((await one(h.person.anika, h.node.aud)).json().room.state).toBe('frozen');
    const res = await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft] });
    expect([res.statusCode, res.json().reason]).toEqual([409, 'room_frozen']);
    expect(await state(h.node.audDraft)).toBe('draft');
  });

  it('refuses contributors without the switch', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true }] });
    clock = later(2);
    expect((await one(h.person.maria, h.node.aud)).statusCode).toBe(404);
    const res = await call('POST', `${W()}/publish`, h.person.maria, { nodeIds: [h.node.audDraft] });
    expect([res.statusCode, res.json().reason]).toEqual([403, 'no_publish_right']);
    const bidder = await call('POST', `${W()}/publish`, h.person.jan, { nodeIds: [h.node.audDraft] });
    expect([bidder.statusCode, bidder.json().reason]).toEqual([403, 'no_publish_right']);
    expect(await state(h.node.audDraft)).toBe('draft');
  });

  it('refuses in see-as mode', async () => {
    const res = await call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft] }, { 'x-vdrkit-see-as': h.group.contributors });
    expect([res.statusCode, res.json().reason]).toEqual([403, 'see_as_read_only']);
    expect(await state(h.node.audDraft)).toBe('draft');
  });
});
