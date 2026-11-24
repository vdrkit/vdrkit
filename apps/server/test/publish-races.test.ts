// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { MemoryQueue } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';
import { CAN_RACE, together } from './race.js';

let h: Heron;
let app: FastifyInstance;

beforeEach(async () => {
  h = await heron();
  const keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at,
    storage: new MemoryStorage(), keyring, queue: new MemoryQueue() });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const call = (method: 'POST' | 'PUT', url: string, person: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1, ...headers }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const count = async (action: string, node: string) => (await h.pg.query(`select 1 from event where action = $1 and resource_id = $2`, [action, node])).rows.length;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function draftVersion(node: string): Promise<string> {
  const by = (await h.pg.query<{ id: string }>(`insert into principal (tenant_id, kind, person_id, name) values ($1, 'person', $2, 'Maria') returning id`,
    [h.t1, h.person.maria])).rows[0]!.id;
  return (await h.pg.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, processing_status)
     values ($1, $2, 1, $3, $4, 1, 'application/pdf', $5, 'ready') returning id`,
    [h.t1, node, `k/${node}/1`, '1'.repeat(64), by])).rows[0]!.id;
}

describe.skipIf(!CAN_RACE)('concurrent publish', () => {
  it('holds back late versions', async () => {
    const bytes = Buffer.from('%PDF-1.4 the signed letter');
    const started = await call('POST', `${W()}/upload-sessions`, h.person.maria, { replacesNodeId: h.node.audDraft, path: 'Letter.pdf',
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'application/pdf' });
    expect(started.statusCode, started.body).toBe(201);
    const { id, uploadUrl } = started.json();
    expect((await call('PUT', uploadUrl, h.person.maria, bytes, { 'content-type': 'application/octet-stream' })).statusCode).toBe(204);

    const [published, completed] = await together(h, () => [
      call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft], quiet: true }),
      // publish is waiting to commit by now
      pause(150).then(() => call('POST', `${W()}/upload-sessions/${id}/complete`, h.person.maria, {})),
    ]);
    expect(published!.statusCode, published!.body).toBe(200);
    expect(completed!.statusCode, completed!.body).toBe(200);
    expect(completed!.json().awaitingRelease).toBe(true);
    const v = (await h.pg.query<{ awaiting_release: boolean }>(`select awaiting_release from document_version where id = $1`,
      [completed!.json().versionId])).rows[0]!;
    expect(v.awaiting_release).toBe(true);
  });

  it('should not publish a removed draft', async () => {
    const version = await draftVersion(h.node.audDraft);
    const [published, removed] = await together(h, () => [
      call('POST', `${W()}/publish`, h.person.anika, { nodeIds: [h.node.audDraft], quiet: true }),
      call('POST', `${W()}/versions/${version}/remove-draft`, h.person.anika, {}),
    ]);
    expect(published!.statusCode, published!.body).toBe(200);
    const node = (await h.pg.query<{ state: string; deleted: boolean }>(
      `select state, deleted_at is not null as deleted from node where id = $1`, [h.node.audDraft])).rows[0]!;
    if (removed!.statusCode === 200) {
      expect(node.deleted).toBe(true);
      expect(await count('document.published', h.node.audDraft)).toBe(0);
    } else {
      expect(removed!.statusCode, removed!.body).toBe(400);
      expect(node).toEqual({ state: 'published', deleted: false });
      expect(await count('document.draft_removed', h.node.audDraft)).toBe(0);
    }
  });

  it('handles a double remove', async () => {
    const version = await draftVersion(h.node.audDraft);
    const done = await together(h, () => [
      call('POST', `${W()}/versions/${version}/remove-draft`, h.person.anika, {}),
      call('POST', `${W()}/versions/${version}/remove-draft`, h.person.anika, {}),
    ]);
    expect(done.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await count('document.draft_removed', h.node.audDraft)).toBe(1);
  });
});
