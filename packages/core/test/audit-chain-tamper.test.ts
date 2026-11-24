// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heron, T, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { await h.pg.close(); });

interface Also { actorId?: string; onBehalfOfId?: string; resourceType?: string; resourceId?: string; requestId?: string }

async function append(action: string, data: Record<string, unknown> = {}, also: Also = {}): Promise<{ id: string; chain_pos: number }> {
  return h.app(async (tx) => {
    const { rows } = await tx.query<{ id: string; chain_pos: string }>(
      `select id, chain_pos from append_event($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [action, h.ws, also.actorId ?? null, also.onBehalfOfId ?? null, also.resourceType ?? null, also.resourceId ?? null,
        JSON.stringify(data), also.requestId ?? null, null]);
    return { id: rows[0]!.id, chain_pos: Number(rows[0]!.chain_pos) };
  });
}

async function verify(): Promise<{ checked: number; firstBroken: number | null }> {
  const { rows } = await h.pg.query<{ checked: string; first_broken: string | null }>(
    `select checked, first_broken from verify_chain($1)`, [h.ws]);
  const r = rows[0]!;
  return { checked: Number(r.checked), firstBroken: r.first_broken == null ? null : Number(r.first_broken) };
}

// as a superuser could
async function withoutAppendOnlyTrigger(fn: () => Promise<void>): Promise<void> {
  await h.pg.exec(`alter table event disable trigger user`);
  try { await fn(); } finally { await h.pg.exec(`alter table event enable trigger user`); }
}

describe('audit hash chain', () => {
  it('detects an edited or deleted event', async () => {
    const e1 = await append('document.opened', { page_count: 3 });
    const e2 = await append('document.downloaded', { format: 'pdf' });
    const e3 = await append('grant.changed', { level: 20 });
    const e4 = await append('document.printed', { pages: 3 });
    expect([e1.chain_pos, e2.chain_pos, e3.chain_pos, e4.chain_pos]).toEqual([1, 2, 3, 4]);

    expect(await verify()).toEqual({ checked: 4, firstBroken: null });

    const original = (await h.pg.query<{ action: string }>(`select action from event where id = $1`, [e2.id])).rows[0]!.action;
    await withoutAppendOnlyTrigger(async () => {
      await h.pg.query(`update event set action = 'grant.changed' where id = $1`, [e2.id]);
    });
    expect((await verify()).firstBroken).toBe(2);

    // putting it back repairs the chain
    await withoutAppendOnlyTrigger(async () => {
      await h.pg.query(`update event set action = $2 where id = $1`, [e2.id, original]);
    });
    expect(await verify()).toEqual({ checked: 4, firstBroken: null });

    await withoutAppendOnlyTrigger(async () => {
      await h.pg.query(`delete from event where id = $1`, [e3.id]);
    });
    expect((await verify()).firstBroken).toBe(3);
  });

  it('detects edits to every column and swapped events', async () => {
    const also: Also = { actorId: randomUUID(), onBehalfOfId: randomUUID(), resourceType: 'node', resourceId: h.node.aud1, requestId: 'req-1' };
    const events = [];
    for (const action of ['document.opened', 'document.downloaded', 'grant.changed', 'document.printed']) {
      events.push(await append(action, { level: 20 }, also));
    }
    const e2 = events[1]!;
    const e3 = events[2]!;
    expect(await verify()).toEqual({ checked: 4, firstBroken: null });

    // a new column fails here until someone decides whether the hash covers it
    const EDITS: Record<string, string> = {
      id: `gen_random_uuid()`,
      tenant_id: `'${h.t2}'`,
      seq: `seq + 100`,
      // moves the event out of this chain, which reads as a gap
      chain_key: `'${h.t1}'`,
      chain_pos: `chain_pos + 100`,
      occurred_at: `occurred_at + interval '1 microsecond'`,
      workspace_id: `gen_random_uuid()`,
      actor_id: `gen_random_uuid()`,
      on_behalf_of_id: `null`,
      action: `'document.printed'`,
      resource_type: `'workspace'`,
      resource_id: `gen_random_uuid()`,
      data: `data || '{"level": 60}'`,
      request_id: `'req-2'`,
      prev_hash: `repeat('f', 64)`,
      hash: `repeat('f', 64)`,
    };
    const columns = (await h.pg.query<{ c: string }>(
      `select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'event' order by ordinal_position`)).rows.map((r) => r.c);
    expect(Object.keys(EDITS).sort()).toEqual(columns.sort());

    const original = (await h.pg.query<{ row: Record<string, unknown> }>(`select to_jsonb(e) as row from event e where id = $1`, [e2.id])).rows[0]!.row;
    const broken: Record<string, number | null> = {};
    for (const [column, value] of Object.entries(EDITS)) {
      await withoutAppendOnlyTrigger(async () => {
        await h.pg.query(`update event set ${column} = ${value} where id = $1`, [e2.id]);
      });
      broken[column] = (await verify()).firstBroken;
      await withoutAppendOnlyTrigger(async () => {
        await h.pg.query(`update event set ${column} = (jsonb_populate_record(null::event, $2::jsonb)).${column} where ${column === 'id' ? 'hash' : 'id'} = $1`,
          [column === 'id' ? original.hash : e2.id, JSON.stringify(original)]);
      });
      expect([column, await verify()]).toEqual([column, { checked: 4, firstBroken: null }]);
    }
    expect(broken).toEqual(Object.fromEntries(Object.keys(EDITS).map((c) => [c, 2])));

    // the second and third events trade places
    await withoutAppendOnlyTrigger(async () => {
      await h.pg.query(`update event set chain_pos = case id when $1 then $3::bigint else $4::bigint end where id in ($1, $2)`,
        [e2.id, e3.id, e3.chain_pos, e2.chain_pos]);
    });
    expect((await verify()).firstBroken).toBe(2);
  });

  it('shows rewritten watermarks and pages seen', async () => {
    // one event per page, plus a digest of the watermark lines
    const lines = ['Jan de Vries · jan@bidder-a.example', 'Bidder A · Thu 12 Nov, 08:00 GMT'];
    const digest = (l: string[]) => createHash('sha256').update(l.join('\n')).digest('hex');
    const versionId = (await h.pg.query<{ id: string }>(
      `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
       values ($1, $2, 1, 'k', repeat('a', 64), 1, 'application/pdf') returning id`, [h.t1, h.node.aud1])).rows[0]!.id;
    const sessionId = (await h.pg.query<{ id: string }>(
      `insert into view_session (tenant_id, workspace_id, node_id, version_id, person_id, opened_at, last_seen_at, page_count, pages_seen)
       values ($1, $2, $3, $4, $5, $6, $6, 3, '{1,2,3}') returning id`,
      [h.t1, h.ws, h.node.aud1, versionId, h.person.jan, T.at.toISOString()])).rows[0]!.id;
    for (const page of [1, 2, 3]) {
      await append('document.page_viewed',
        { version_id: versionId, page, person_id: h.person.jan, session_id: sessionId, watermark_sha256: digest(lines) });
    }
    const download = await append('document.downloaded',
      { format: 'pdf', version_id: versionId, person_id: h.person.jan, watermark_sha256: digest(lines) });
    await h.app((tx) => tx.query(
      `insert into event_context (event_id, occurred_at, tenant_id, ip, user_agent, personal, subject_person_id)
       select id, occurred_at, tenant_id, '1.2.3.4', 'ua', $2::jsonb, $3 from event where id = $1`,
      [download.id, JSON.stringify({ watermark: lines }), h.person.jan]));
    expect(await verify()).toEqual({ checked: 4, firstBroken: null });

    const chained = async () => ({
      pages: (await h.pg.query<{ page: number }>(
        `select (data ->> 'page')::int as page from event
          where action = 'document.page_viewed' and data ->> 'session_id' = $1 order by chain_pos`, [sessionId])).rows.map((r) => r.page),
      watermark: (await h.pg.query<{ d: string }>(`select data ->> 'watermark_sha256' as d from event where id = $1`, [download.id])).rows[0]!.d,
    });
    const readable = async () => ({
      pages: (await h.pg.query<{ pages_seen: number[] }>(`select pages_seen from view_session where id = $1`, [sessionId])).rows[0]!.pages_seen,
      watermark: (await h.pg.query<{ personal: { watermark: string[] } | null }>(
        `select personal from event_context where event_id = $1`, [download.id])).rows[0]!.personal?.watermark ?? null,
    });
    expect(await chained()).toEqual({ pages: [1, 2, 3], watermark: digest((await readable()).watermark!) });

    // the app role can rewrite both and the chain still verifies
    await h.app((tx) => tx.query(
      `update event_context set personal = $2::jsonb where event_id = $1`,
      [download.id, JSON.stringify({ watermark: ['Someone Else · innocent@example.com'] })]));
    await h.app((tx) => tx.query(`update view_session set pages_seen = '{1}' where id = $1`, [sessionId]));
    expect(await verify()).toEqual({ checked: 4, firstBroken: null });

    // ...but neither rewrite matches the chained record any more
    const now = await readable();
    expect(now.pages).toEqual([1]);
    expect((await chained()).pages).toEqual([1, 2, 3]);
    expect(digest(now.watermark!)).not.toBe((await chained()).watermark);
    expect((await chained()).watermark).toBe(digest(lines));

    // and the chained digest itself cannot be changed without breaking the chain
    await withoutAppendOnlyTrigger(async () => {
      await h.pg.query(`update event set data = jsonb_set(data, '{watermark_sha256}', to_jsonb($2::text)) where id = $1`,
        [download.id, digest(['Someone Else · innocent@example.com'])]);
    });
    expect((await verify()).firstBroken).toBe(download.chain_pos);
  });

  it('lets the app role erase a person without breaking the chain', async () => {
    const e = await append('document.downloaded', { format: 'pdf', watermark_sha256: 'a'.repeat(64) });
    await h.app((tx) => tx.query(
      `insert into event_context (event_id, occurred_at, tenant_id, personal, subject_person_id)
       select id, occurred_at, tenant_id, $2::jsonb, $3 from event where id = $1`,
      [e.id, JSON.stringify({ watermark: ['Jan de Vries · jan@bidder-a.example'] }), h.person.jan]));

    await h.app((tx) => tx.query(`update person set erased_at = $2 where id = $1`, [h.person.jan, T.at.toISOString()]));

    const personal = (await h.pg.query<{ personal: unknown }>(`select personal from event_context where event_id = $1`, [e.id])).rows[0]!.personal;
    expect(personal).toBeNull();
    expect((await h.pg.query<{ d: string }>(`select data ->> 'watermark_sha256' as d from event where id = $1`, [e.id])).rows[0]!.d).toBe('a'.repeat(64));
    expect(await verify()).toEqual({ checked: 1, firstBroken: null });
  });
});
