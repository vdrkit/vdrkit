// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appendEvent } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { activityExportRoutes, csvCell } from '../src/routes/activity-export.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
const principal: Record<string, string> = {};

beforeEach(async () => {
  h = await heron();
  for (const [key, id] of Object.entries(h.person)) {
    principal[key] = (await h.pg.query<{ id: string }>(
      `insert into principal (tenant_id, kind, person_id, name) select tenant_id, 'person', id, name from person where id = $1 returning id`, [id],
    )).rows[0]!.id;
  }
  const at = async (iso: string, e: Parameters<typeof appendEvent>[1]) => {
    await h.pin(new Date(iso));
    await h.app((tx) => appendEvent(tx, e));
  };
  // 10:30 in Johannesburg
  await at('2026-11-10T08:30:00Z', {
    action: 'document.opened', workspaceId: h.ws, actorId: principal.jan, resourceType: 'node', resourceId: h.node.aud1,
    data: { page_count: 12 },
  });
  await at('2026-11-11T07:00:00Z', {
    action: 'grants.bulk_changed', workspaceId: h.ws, actorId: principal.anika, resourceType: 'workspace', resourceId: h.ws,
    data: { cells: [{ node_id: h.node.fin, group_id: h.group.a, level: 20 }, { node_id: h.node.tax, group_id: h.group.b, level: 10 }] },
  });
  await at('2026-11-11T09:15:00Z', {
    action: 'document.opened', workspaceId: h.ws, actorId: principal.mei, resourceType: 'node', resourceId: h.node.tax1, data: {},
  });
  await at('2026-11-11T21:59:00Z', {
    action: 'qna.question_asked', workspaceId: h.ws, actorId: principal.jan, data: { note: 'Why, "exactly"?' },
  });
  await h.pg.query(`update person set time_zone = 'Africa/Johannesburg' where id = $1`, [h.person.anika]);
  await h.pin(T.at);
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const exportCsv = (person: string, query = '', headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: `/v1/workspaces/${h.ws}/events/export.csv${query}`,
    headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1, ...headers },
  });

function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  return rows;
}

describe('activity log export', () => {
  it('is for room admins only', async () => {
    expect((await exportCsv(h.person.jan)).statusCode).toBe(403);
    expect((await exportCsv(h.person.maria)).statusCode).toBe(403);
    expect((await exportCsv(h.person.anika, '', { 'x-dev-agent-max-level': '60' })).statusCode).toBe(403);
  });

  it('writes Excel columns in the reader time zone', async () => {
    const res = await exportCsv(h.person.anika);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('attachment; filename="Project Heron activity 2026-11-12.csv"');
    expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.body.endsWith('\r\n')).toBe(true);

    const rows = parseCsv(res.body);
    expect(rows).toEqual([
      ['Time', 'Person', 'Group', 'Action', 'Document', 'Details', 'Proof'],
      ['2026-11-11 23:59 SAST', 'Jan de Vries', 'Bidder A', 'Recorded', '', 'qna.question_asked; note: Why, "exactly"?', ''],
      ['2026-11-11 11:15 SAST', 'Mei Tanaka', 'Bidder B', 'Viewed', '3.4.6 Tax clearance certificate 2026.pdf', 'Opened document',
        'Opened at: Wed 11 Nov 2026, 11:15:00 SAST'],
      ['2026-11-11 09:00 SAST', 'Anika Pillay', 'Room admin', 'Changed access', '', '2 permission changes; Bidder A: No access → View; Bidder B: No access → Name only',
        'Bidder A, 3 Finance: No access → View | Bidder B, 3.4 Tax: No access → Name only'],
      ['2026-11-10 10:30 SAST', 'Jan de Vries', 'Bidder A', 'Viewed', '3.2.1 Audited financial statements FY2025.pdf', 'Opened document',
        'Pages viewed: None of 12 yet | Opened at: Tue 10 Nov 2026, 10:30:00 SAST'],
    ]);
    expect(res.body).toContain('"qna.question_asked; note: Why, ""exactly""?"');
  });

  it('filters by date, action and person', async () => {
    const day = parseCsv((await exportCsv(h.person.anika, '?from=2026-11-11&to=2026-11-11')).body);
    expect(day.slice(1).map((r) => r[0])).toEqual(['2026-11-11 23:59 SAST', '2026-11-11 11:15 SAST', '2026-11-11 09:00 SAST']);
    const opened = parseCsv((await exportCsv(h.person.anika, '?action=document.opened')).body);
    expect(opened.length).toBe(3);
    const jan = parseCsv((await exportCsv(h.person.anika, `?person=${h.person.jan}`)).body);
    expect(jan.slice(1).map((r) => r[1])).toEqual(['Jan de Vries', 'Jan de Vries']);
    expect((await exportCsv(h.person.anika, '?from=yesterday')).statusCode).toBe(400);
  });

  it('neutralises spreadsheet formulas', async () => {
    await h.pg.query(`update person set name = '=HYPERLINK("http://evil.example","Click")' where id = $1`, [h.person.mei]);
    const rows = parseCsv((await exportCsv(h.person.anika, '?action=document.opened')).body);
    expect(rows[1]![1]).toBe(`'=HYPERLINK("http://evil.example","Click")`);
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(bad).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvCell('safe')).toBe('safe');
  });

  it('shows erased people as "Erased user"', async () => {
    await h.pg.query(`update person set erased_at = $2 where id = $1`, [h.person.jan, T.at.toISOString()]);
    const res = await exportCsv(h.person.anika);
    expect(res.body).not.toContain('Jan de Vries');
    const rows = parseCsv(res.body);
    expect(rows[1]!.slice(1, 4)).toEqual(['Erased user', 'Bidder A', 'Recorded']);
  });

  it('audits the export', async () => {
    await exportCsv(h.person.anika, '?action=document.opened');
    const { rows } = await h.pg.query<{ action: string; data: any; occurred_at: Date }>(
      `select action, data, occurred_at from event where workspace_id = $1 and action = 'activity.exported'`, [h.ws]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toEqual({ filters: { from: null, to: null, action: 'document.opened', person_id: null }, rows: 2 });
    expect(new Date(rows[0]!.occurred_at).toISOString()).toBe(T.at.toISOString());

    const next = parseCsv((await exportCsv(h.person.anika)).body);
    expect(next[1]!.slice(3)).toEqual(['Exported', '', 'Exported activity log; rows: 2, action: document.opened', '']);

    await exportCsv(h.person.jan);
    const count = await h.pg.query<{ n: number }>(`select count(*)::int as n from event where action = 'activity.exported'`);
    expect(count.rows[0]!.n).toBe(2);
  });
});
