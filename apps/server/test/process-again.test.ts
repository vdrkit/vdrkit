// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { MemoryQueue } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
let queue: MemoryQueue;
let clock: Date;
let version: string;

beforeEach(async () => {
  h = await heron();
  queue = new MemoryQueue();
  clock = T.at;
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, queue });
  version = (await h.pg.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, processing_status, processing_error, failed_step, metadata)
     values ($1, $2, 1, 'k', $3, 10, 'application/pdf', 'failed', 'Document conversion is not reachable.', 'worker', '{"processing_restarts": 2}')
     returning id`, [h.t1, h.node.audDraft, 'ab'.repeat(32)])).rows[0]!.id;
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const again = (person: string, id = version) =>
  app.inject({ method: 'POST', url: `/v1/workspaces/${h.ws}/versions/${id}/process-again`, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, payload: {} });
const row = async () => (await h.pg.query<{ processing_status: string; processing_error: string | null; failed_step: string | null; restarts: string | null }>(
  `select processing_status, processing_error, failed_step, metadata ->> 'processing_restarts' as restarts from document_version where id = $1`, [version])).rows[0]!;

describe('process again', () => {
  it('puts a failed version back in the queue and logs who asked', async () => {
    const res = await again(h.person.anika);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'pending' });
    expect(await row()).toEqual({ processing_status: 'pending', processing_error: null, failed_step: null, restarts: null });
    expect(queue.jobs).toEqual([{ name: 'process-version', payload: { tenantId: h.t1, versionId: version } }]);
    const ev = (await h.pg.query<{ data: any }>(`select data from event where action = 'document.processing_restarted'`)).rows.map((r) => r.data);
    expect(ev).toEqual([{ version_id: version, reason: 'asked', person_id: h.person.anika }]);
  });

  it('answers 409 for a version that has not failed', async () => {
    expect((await again(h.person.anika)).statusCode).toBe(200);
    const second = await again(h.person.anika);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ reason: 'not_failed', detail: 'Only a file whose processing failed can be processed again.' });
    expect(queue.jobs).toHaveLength(1);
  });

  it('should be limited to admins, uploaders and publishers', async () => {
    expect((await again(h.person.maria)).statusCode).toBe(200);
    await h.pg.query(`update document_version set processing_status = 'failed' where id = $1`, [version]);
    // a bidder cannot see a draft at all
    const bidder = await again(h.person.jan);
    expect(bidder.statusCode).toBe(404);
    expect((await again(h.person.anika, '00000000-0000-4000-8000-000000000000')).body).toBe(bidder.body);
    expect((await row()).processing_status).toBe('failed');
    expect(queue.jobs).toHaveLength(1);
  });

  it('is refused in an archived room', async () => {
    await h.pg.query(`update workspace set state = 'archived' where id = $1`, [h.ws]);
    const res = await again(h.person.anika);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('room_archived');
    expect((await row()).processing_status).toBe('failed');
    expect(queue.jobs).toEqual([]);
  });
});
