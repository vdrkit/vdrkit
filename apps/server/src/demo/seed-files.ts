// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { withTenant, type Database } from '@vdrkit/core';
import { encryptBuffer } from '../crypto/envelope.js';
import type { Keyring } from '../crypto/keyring.js';
import type { Storage } from '../pipeline/pipeline.js';
import { processVersion, type WorkerContext } from '../worker/jobs.js';
import { stableId } from './seed-demo.js';
import { DEV_DOCUMENTS, pagesFor, renderPdf } from './documents.js';

export interface SeedFilesOptions {
  db: Database;
  storage: Storage;
  keyring: Keyring;
  worker: WorkerContext;
  tenantId: string;
  fullPages?: boolean;
  log?: (msg: string) => void;
}

const DB_ROLE = { role: 'vdrkit_app' as const };

interface SeedVersion { id: string; version_no: number; processing_status: string; placeholder: boolean }

export async function seedDevFiles(o: SeedFilesOptions): Promise<{ versions: number; pages: number; documents: string[] }> {
  const ws = stableId(o.tenantId, 'workspace');
  const out = { versions: 0, pages: 0, documents: [] as string[] };
  for (const d of DEV_DOCUMENTS) {
    const nodeId = stableId(o.tenantId, `node:${d.ix}`);
    const versions = await withTenant(o.db, o.tenantId, (tx) => tx.query<SeedVersion>(
      `select id, version_no, processing_status, metadata ? 'placeholder' as placeholder from document_version where node_id = $1 order by version_no`, [nodeId]), DB_ROLE);
    let did = false;
    for (const v of versions.rows) {
      if (!v.placeholder || v.processing_status === 'pending') continue;
      const pdf = await renderPdf(d, pagesFor(d, !!o.fullPages, v.version_no), v.version_no);
      const sha = createHash('sha256').update(pdf).digest('hex');
      const key = `ws/${ws}/v/${v.id}/original`;
      await withTenant(o.db, o.tenantId, async (tx) => {
        const dk = await o.keyring.dataKey(tx, ws);
        await o.storage.put(key, await encryptBuffer(dk.key, pdf, key));
        await tx.query(
          `update document_version set storage_key = $2, sha256 = $3, size_bytes = $4, key_version = $5,
                  metadata = (metadata - 'placeholder') || '{"devFile": true}'::jsonb
            where id = $1`, [v.id, key, sha, pdf.length, dk.version]);
      }, DB_ROLE);
      const r = await processVersion(o.worker, o.tenantId, v.id);
      if (r.status !== 'ready') throw new Error(`Processing ${d.ix} version ${v.version_no} failed at ${r.failedStep}: ${r.error}`);
      out.versions++;
      out.pages += r.pageCount ?? 0;
      did = true;
      o.log?.(`  ${d.ix} version ${v.version_no}: ${r.pageCount} pages`);
    }
    if (did) out.documents.push(d.ix);
  }
  return out;
}
