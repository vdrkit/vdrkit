// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from '@vdrkit/core';
import { newDataKey, type KeyProvider } from './envelope.js';

export interface Keyring {
  dataKey(tx: SqlClient, workspaceId: string): Promise<{ key: Buffer; version: number }>;
  keyFor(tx: SqlClient, workspaceId: string, version: number | null): Promise<Buffer>;
}

// keep TTL short: a destroyed key must stop working
// don't cache a new key before commit
export class DbKeyring implements Keyring {
  private cache = new Map<string, { key: Buffer; version: number; until: number }>();
  private versions = new Map<string, { key: Buffer; until: number }>();
  private static readonly TTL_MS = 5 * 60_000;

  constructor(private readonly provider: KeyProvider) {}

  async keyFor(tx: SqlClient, workspaceId: string, version: number | null): Promise<Buffer> {
    const current = await this.dataKey(tx, workspaceId);
    if (version == null || version === current.version) return current.key;
    const id = `${workspaceId}:${version}`;
    const hit = this.versions.get(id);
    if (hit && hit.until > Date.now()) return hit.key;
    const row = (await tx.query<{ wrapped: string | null; provider: string; provider_key_version: number }>(
      `select wrapped, provider, provider_key_version from workspace_key where workspace_id = $1 and version = $2`, [workspaceId, version])).rows[0];
    if (!row) throw new Error(`Key version ${version} of this room does not exist.`);
    if (!row.wrapped) throw new Error('The key that encrypted this file has been destroyed. The file can no longer be read.');
    const key = await this.provider.unwrap({ provider: row.provider, keyVersion: row.provider_key_version, blob: row.wrapped }, workspaceId);
    this.versions.set(id, { key, until: Date.now() + DbKeyring.TTL_MS });
    return key;
  }

  async dataKey(tx: SqlClient, workspaceId: string) {
    const hit = this.cache.get(workspaceId);
    if (hit && hit.until > Date.now()) return { key: hit.key, version: hit.version };
    await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`workspace_key:${workspaceId}`]);
    const { rows } = await tx.query<{ version: number; wrapped: string | null; provider: string; provider_key_version: number }>(
      `select version, wrapped, provider, provider_key_version from workspace_key
        where workspace_id = $1 order by version desc limit 1`, [workspaceId]);
    const row = rows[0];
    let out: { key: Buffer; version: number };
    if (row) {
      if (!row.wrapped) throw new Error('The key of this room has been destroyed. Its files can no longer be read.');
      const key = await this.provider.unwrap({ provider: row.provider, keyVersion: row.provider_key_version, blob: row.wrapped }, workspaceId);
      out = { key, version: Number(row.version) };
      this.cache.set(workspaceId, { ...out, until: Date.now() + DbKeyring.TTL_MS });
    } else {
      const key = newDataKey();
      const w = await this.provider.wrap(key, workspaceId);
      await tx.query(
        `insert into workspace_key (tenant_id, workspace_id, version, provider, provider_key_version, wrapped)
         values (current_tenant_id(), $1, 1, $2, $3, $4)`, [workspaceId, w.provider, w.keyVersion, w.blob]);
      out = { key, version: 1 };
    }
    return out;
  }
}
