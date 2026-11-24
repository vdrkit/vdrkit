// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from '@vdrkit/core';
import type { PipelineResult } from './pipeline.js';

export interface RecordOptions {
  keyVersion?: number | null;
}

export async function recordDerived(
  tx: SqlClient,
  versionId: string,
  result: Pick<PipelineResult, 'derived'> & Partial<Pick<PipelineResult, 'facts'>>,
  opts: RecordOptions = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const d of result.derived) {
    const { rows } = await tx.query<{ id: string }>(
      `insert into derived_file (tenant_id, version_id, kind, step, storage_key, sha256, key_version, metadata)
       values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
      [versionId, d.kind, d.step, d.storageKey, d.sha256, opts.keyVersion ?? null, JSON.stringify({ ...d.meta, size: d.size })],
    );
    if (rows[0]) ids.push(rows[0].id);
  }
  const pageCount = result.facts?.pageCount;
  if (typeof pageCount === 'number') {
    await tx.query(
      `update document_version set metadata = metadata || jsonb_build_object('pageCount', $2::int) where id = $1`,
      [versionId, pageCount],
    );
  }
  return ids;
}
