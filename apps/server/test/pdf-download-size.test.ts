// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { encryptBuffer, LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { convertStep, GotenbergClient, MemoryStorage, runPipeline } from '../src/pipeline/pipeline.js';
import { rasteriseStep } from '../src/pipeline/rasterise.js';
import { recordDerived } from '../src/pipeline/record.js';
import { STAMP_MAX_BYTES } from '../src/routes/viewer.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
let storage: MemoryStorage;
let pdfKey: string;
let versionId: string;

beforeEach(async () => {
  h = await heron();
  storage = new MemoryStorage();
  const keyring = new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64')));
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, storage, keyring });

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Audited financial statements FY2025', { x: 50, y: 780, size: 14, font });
  const original = Buffer.from(await doc.save());
  const { key, version } = await h.app((tx) => keyring.dataKey(tx, h.ws));
  const storageKey = `ws/${h.ws}/originals/aud1-v1`;
  await storage.put(storageKey, await encryptBuffer(key, original, storageKey));
  versionId = await h.app(async (tx) => (await tx.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, key_version, processing_status)
     values (current_tenant_id(), $1, 1, $2, $3, $4, 'application/pdf', $5, 'ready') returning id`,
    [h.node.aud1, storageKey, createHash('sha256').update(original).digest('hex'), original.length, version])).rows[0]!.id);
  const result = await runPipeline(
    { versionId, workspaceId: h.ws, storageKey, filename: 'Audited financial statements FY2025.pdf', mime: 'application/pdf' },
    [convertStep(new GotenbergClient('http://127.0.0.1:9')), rasteriseStep], storage, key);
  await h.app((tx) => recordDerived(tx, versionId, result, { keyVersion: version }));
  pdfKey = result.derived.find((d) => d.kind === 'pdf')!.storageKey;
  await h.pg.query(`insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, recorded_at)
    values ($1, $2, $3, $4, 50, $5)`, [h.t1, h.ws, h.node.fin, h.group.a, T.grantsSet.toISOString()]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await h.pg.close();
});

const download = () => app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/nodes/${h.node.aud1}/download?format=pdf`,
  headers: { 'x-dev-person': h.person.jan, 'x-dev-tenant': h.t1, 'user-agent': 'vitest' } });
const recordSize = (size: number) =>
  h.pg.query(`update derived_file set metadata = metadata || jsonb_build_object('size', $2::bigint) where version_id = $1 and kind = 'pdf'`, [versionId, size]);

describe('watermarked PDF download size', () => {
  it('stamps a PDF at the limit', async () => {
    await recordSize(STAMP_MAX_BYTES);
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  it('refuses a PDF above the limit without reading it', async () => {
    await recordSize(STAMP_MAX_BYTES + 1);
    const get = vi.spyOn(storage, 'get');
    const res = await download();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      reason: 'pdf_too_large',
      detail: 'This PDF is too large for VDRkit to prepare a marked copy for download. You can still view it online.',
    });
    expect(get.mock.calls.map(([k]) => k)).not.toContain(pdfKey);
    expect((await h.pg.query(`select 1 from event where action = 'document.downloaded'`)).rows).toHaveLength(0);
  });

  it('falls back to the stored size when the record has none', async () => {
    await h.pg.query(`update derived_file set metadata = metadata - 'size' where version_id = $1 and kind = 'pdf'`, [versionId]);
    vi.spyOn(storage, 'size').mockResolvedValue(STAMP_MAX_BYTES + 1);
    expect((await download()).statusCode).toBe(409);
  });
});
