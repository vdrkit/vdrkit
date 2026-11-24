// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
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

const as = (person: string) => ({ 'x-dev-person': person, 'x-dev-tenant': h.t1 });
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: as(person), ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;

async function opened(person: string, node: string, at: Date) {
  const v = (await h.pg.query<{ id: string }>(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
    values ($1, $2, (select coalesce(max(version_no), 0) + 1 from document_version where node_id = $2), 'k', $3, 1, 'application/pdf') returning id`,
    [h.t1, node, 'ef'.repeat(32)])).rows[0]!.id;
  await h.pg.query(`insert into view_session (tenant_id, workspace_id, node_id, version_id, person_id, opened_at, last_seen_at, page_count, pages_seen)
    values ($1, $2, $3, $4, $5, $6, $6, 2, '{1}')`, [h.t1, h.ws, node, v, person, at.toISOString()]);
}

describe('timeline phases', () => {
  it('makes a milestone a phase deadline', async () => {
    const res = await call('POST', `${W()}/milestones`, h.person.anika,
      { title: 'Non-binding offers due', dueAt: '2026-11-27T15:00:00Z', phase: { name: 'First round', startsOn: '2026-11-03' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: 'Non-binding offers due', phase: { name: 'First round', startsOn: '2026-11-03' }, visibleToGroupIds: [] });
    const narrowed = await call('POST', `${W()}/milestones`, h.person.anika,
      { title: 'Binding offers due', dueAt: '2027-02-12T15:00:00Z', phase: { name: 'Second round' }, visibleToGroupIds: [h.group.a] });
    expect(narrowed.statusCode).toBe(400);
    await call('POST', `${W()}/milestones`, h.person.anika, { title: 'Q&A round 1 closes', dueAt: '2026-11-20T15:00:00Z' });

    const mine = (await call('GET', `${W()}/milestones`, h.person.jan)).json().items;
    expect(mine.map((m: any) => [m.title, m.phase])).toEqual([
      ['Q&A round 1 closes', null], ['Non-binding offers due', { name: 'First round', startsOn: '2026-11-03' }]]);
    const dash = (await call('GET', `${W()}/dashboard`, h.person.jan)).json();
    expect(dash.milestones[1].phase).toEqual({ name: 'First round', startsOn: '2026-11-03' });

    // a deadline stays for every group
    const id = res.json().id;
    expect((await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { visibleToGroupIds: [h.group.a] })).statusCode).toBe(400);
    const back = await call('PATCH', `${W()}/milestones/${id}`, h.person.anika, { phase: null });
    expect(back.json().phase).toBeNull();
  });
});

describe('dashboard', () => {
  it("shows members only their own reading", async () => {
    const grant = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [
      { nodeId: h.node.fin, groupId: h.group.a, level: 20 }, { nodeId: h.node.fin, groupId: h.group.aFin, level: 20 }] });
    expect(grant.statusCode).toBe(200);
    await opened(h.person.jan, h.node.aud1, new Date(T.at.getTime() - 60_000));
    await opened(h.person.lars, h.node.tax1, new Date(T.at.getTime() - 30_000));
    const jan = (await call('GET', `${W()}/dashboard`, h.person.jan)).json();
    expect(jan.myCoverage.opened).toBe(1);
    expect(jan.myCoverage.folders).toEqual([{ folder: '3 Finance', opened: 1, total: jan.myCoverage.total, pagesRead: 0, pagesShared: 0 }]);
    expect(jan.teamCoverage).toBeUndefined();
    const lars = (await call('GET', `${W()}/dashboard`, h.person.lars)).json();
    expect(lars.myCoverage.opened).toBe(1);
  });

  it('asks the uploader to replace a failed file', async () => {
    const maria = (await h.pg.query<{ id: string }>(`insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'maria') returning id`,
      [h.t1, h.person.maria])).rows[0]!.id;
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, created_at, processing_status, processing_error)
      values ($1, $2, 1, 'k', $3, 1, 'application/vnd.ms-excel', $4, $5, 'failed', 'The file is password protected, so VDRkit cannot convert it for viewing.')`,
      [h.t1, h.node.audDraft, 'aa'.repeat(32), maria, '2026-11-12T07:40:00Z']);

    const failed = (await call('GET', `${W()}/dashboard`, h.person.anika)).json().toDo.failedProcessing;
    expect(failed).toEqual([expect.objectContaining({ nodeId: h.node.audDraft, uploadedBy: 'Maria Botha', uploadedById: h.person.maria, uploadedAt: expect.stringMatching(/^2026-11-12T/) })]);

    expect((await call('POST', `${W()}/nodes/${h.node.audDraft}/ask-for-copy`, h.person.jan)).statusCode).toBe(403);
    const res = await call('POST', `${W()}/nodes/${h.node.audDraft}/ask-for-copy`, h.person.anika);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'Maria Botha', status: 'accepted' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe('maria@drosvelt.example');
    expect(outbox[0]!.subject).toContain('please upload a new copy of');
    expect(outbox[0]!.text!).toContain('password protected');
    const logged = await h.pg.query<{ data: any }>(`select data from event where action = 'document.copy_requested'`);
    expect(logged.rows[0]!.data).toMatchObject({ recipient_person_id: h.person.maria, delivery_status: 'accepted' });
    await h.pg.query(`update document_version set processing_error = 'Conversion to PDF failed (503): no converter. Set GOTENBERG_URL.' where node_id = $1`, [h.node.audDraft]);
    expect((await call('POST', `${W()}/nodes/${h.node.audDraft}/ask-for-copy`, h.person.anika)).statusCode).toBe(200);
    expect(outbox[1]!.text!).toContain('> The file could not be converted for viewing.');
    expect(outbox[1]!.text!).not.toMatch(/GOTENBERG|503|password/i);

    const lars = (await h.pg.query<{ id: string }>(`insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'lars') returning id`,
      [h.t1, h.person.lars])).rows[0]!.id;
    await h.pg.query(`insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, created_at, processing_status, processing_error)
      values ($1, $2, 2, 'k2', $3, 1, 'application/vnd.ms-excel', $4, $5, 'failed', 'The file is damaged.')`,
      [h.t1, h.node.audDraft, 'bb'.repeat(32), lars, '2026-11-12T08:40:00Z']);
    const refused = await call('POST', `${W()}/nodes/${h.node.audDraft}/ask-for-copy`, h.person.anika);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().detail ?? refused.body).toContain('can no longer see this document');
    expect(outbox).toHaveLength(2);

    expect((await call('POST', `${W()}/nodes/${h.node.aud1}/ask-for-copy`, h.person.anika)).statusCode).toBe(400);
  });

  it('lists observers last and counts quiet members', async () => {
    const observers = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Seller observers', 'observer') returning id`,
      [h.t1, h.ws, h.party.seller])).rows[0]!.id;
    await opened(h.person.jan, h.node.aud1, new Date(T.at.getTime() - 60_000));
    const activity = (await call('GET', `${W()}/dashboard`, h.person.anika)).json().activity;
    expect(activity.at(-1)).toMatchObject({ groupId: observers, groupName: 'Seller observers', partyKind: 'seller' });
    expect(activity.find((g: any) => g.groupName === 'Seller finance team')).toBeUndefined();
    expect(activity.find((g: any) => g.groupName === 'Bidder A')).toMatchObject({ partyKind: 'bidder', quietThisWeek: 0 });
    expect(activity.find((g: any) => g.groupName === 'Bidder B')).toMatchObject({ quietThisWeek: 1 });
  });

  it('names the creator on workspace.created', async () => {
    await h.pg.query(`update person set can_create_rooms = true where id = $1`, [h.person.anika]);
    const res = await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Osprey', timeZone: 'Africa/Johannesburg', start: 'standard' });
    expect(res.statusCode).toBe(201);
    const ev = (await call('GET', `/v1/workspaces/${res.json().id}/events?action=workspace.created&limit=1`, h.person.anika)).json().items[0];
    expect(ev.actorName).toBe('Anika Pillay');
    expect(ev.data).toMatchObject({ start: 'standard' });
  });
});

describe('new since last visit', () => {
  async function publish(at: Date[]) {
    for (const [i, when] of at.entries()) {
      await h.pg.query(`insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state, published_at)
        values ($1, $2, $3, 'document', $4, $5, 'published', $6)`,
        [h.t1, h.ws, h.node.aud, `Board pack ${i + 1}.pdf`, `3.2.${11 + i}`, when.toISOString()]);
    }
  }
  const ago = (min: number) => new Date(T.at.getTime() - min * 60_000);

  it('returns the first 5 per folder and a count', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] });
    await publish(Array.from({ length: 8 }, () => ago(120)));
    const d = (await call('GET', `${W()}/dashboard`, h.person.jan)).json();
    const fin = d.newSinceLastVisit.find((f: any) => f.folder === '3 Finance');
    expect(fin.folderId).toBe(h.node.fin);
    expect(fin.count).toBe(10);
    expect(fin.items).toHaveLength(5);
    expect(fin.items.map((i: any) => i.indexNumber)).toEqual(['3.2.1', '3.2.11', '3.2.12', '3.2.13', '3.2.14']);
  });

  it('counts from the last clear', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] });
    await publish([ago(120), ago(120), ago(120), ago(120), ago(120), ago(120), ago(5), ago(4)]);
    const d = (await call('GET', `${W()}/dashboard?after=${encodeURIComponent(ago(30).toISOString())}`, h.person.jan)).json();
    expect(d.newSinceLastVisit).toEqual([{ folder: '3 Finance', folderId: h.node.fin, count: 2,
      items: [expect.objectContaining({ indexNumber: '3.2.17' }), expect.objectContaining({ indexNumber: '3.2.18' })] }]);
    expect((await call('GET', `${W()}/dashboard?after=yesterday`, h.person.jan)).statusCode).toBe(400);
  });

  it('keeps first visits to large rooms small', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.a, level: 20 }] });
    await publish(Array.from({ length: 60 }, () => ago(120)));
    const d = (await call('GET', `${W()}/dashboard`, h.person.jan)).json();
    expect(d.newSinceLastVisit.reduce((n: number, f: any) => n + f.count, 0)).toBe(62);
    expect(d.newSinceLastVisit.flatMap((f: any) => f.items)).toHaveLength(5);
  });
});
