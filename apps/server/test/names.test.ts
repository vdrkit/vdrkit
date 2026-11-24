// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { MemoryQueue } from '../src/worker/jobs.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;

beforeEach(async () => {
  h = await heron();
  const keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at,
    storage: new MemoryStorage(), keyring, queue: new MemoryQueue() });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

const call = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': h.person.anika, 'x-dev-tenant': h.t1 }, payload });
const W = () => `/v1/workspaces/${h.ws}`;
const upload = (path: string) => call('POST', `${W()}/upload-sessions`, { targetFolderId: h.node.aud, path, size: 1, sha256: 'a'.repeat(64) });

const HIDDEN = ['\u0007', '\u007f', '\u200b', '\u200e', '\u202e', '\u2066', '\u2069', '\ufeff'];

describe('names in the index', () => {
  it('rejects control and invisible characters', async () => {
    for (const c of HIDDEN) {
      const name = `Invoice${c}fdp.exe`;
      const results = [
        await call('POST', `${W()}/folders`, { parentId: h.node.fin, name }),
        await call('PATCH', `${W()}/nodes/${h.node.aud1}`, { name }),
        await upload(name),
        await upload(`${name}/Letter.pdf`),
      ];
      for (const res of results) {
        expect([c.codePointAt(0)!.toString(16), res.statusCode]).toEqual([c.codePointAt(0)!.toString(16), 400]);
        expect(res.json().detail).toContain('Names may not contain control characters or invisible formatting characters.');
      }
    }
    const names = (await h.pg.query<{ name: string }>(`select name from node where workspace_id = $1`, [h.ws])).rows.map((r) => r.name);
    expect(names.filter((n) => n.startsWith('Invoice'))).toEqual([]);
  });

  it('accepts accents and other scripts', async () => {
    const long = `${'a'.repeat(251)}.pdf`;
    expect((await call('POST', `${W()}/folders`, { parentId: h.node.fin, name: long })).statusCode).toBe(201);
    expect((await call('PATCH', `${W()}/nodes/${h.node.aud1}`, { name: long })).statusCode).toBe(200);
    expect((await upload(long)).statusCode).toBe(201);
    for (const res of [await call('POST', `${W()}/folders`, { parentId: h.node.fin, name: `a${long}` }), await upload(`a${long}`)]) {
      expect(res.statusCode).toBe(400);
    }
    expect((await call('POST', `${W()}/folders`, { parentId: h.node.fin, name: 'Ångström — Überblick 決算' })).statusCode).toBe(201);
  });
});

describe('names of people', () => {
  it('rejects bidi and invisible characters in names and companies', async () => {
    for (const c of HIDDEN) {
      const bad = `Anika${c}reversed`;
      const results = [
        await call('PATCH', '/v1/me', { givenName: bad, familyName: 'Bos' }),
        await call('PATCH', '/v1/me', { givenName: 'Anika', familyName: bad }),
        await call('PATCH', '/v1/me', { company: bad }),
        await call('PATCH', '/v1/me', { jobTitle: bad }),
        await call('POST', `${W()}/invitations`, { groupId: h.group.a, people: [{ email: 'new@bidder-a.example', givenName: bad, familyName: 'Bos' }] }),
        await call('POST', `${W()}/invitations`, { groupId: h.group.a, people: [{ email: 'new@bidder-a.example', name: bad }] }),
      ];
      for (const res of results) {
        expect([c.codePointAt(0)!.toString(16), res.statusCode]).toEqual([c.codePointAt(0)!.toString(16), 400]);
        expect(res.json().detail).toContain('Names may not contain control characters or invisible formatting characters.');
      }
    }
    const people = (await h.pg.query<{ n: string }>(
      `select concat_ws(' ', given_name, family_name, company, job_title) as n from person`)).rows.map((r) => r.n);
    expect(people.filter((n) => n.includes('reversed'))).toEqual([]);
  });

  it('allows accents', async () => {
    const res = await call('PATCH', '/v1/me', { givenName: 'Łukasz', familyName: 'Ødegård 中文' });
    expect(res.statusCode).toBe(200);
  });
});
