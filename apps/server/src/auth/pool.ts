// SPDX-License-Identifier: AGPL-3.0-only
export interface AuthPool {
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number; command: string }>;
    release(): void;
  }>;
  end(): Promise<void>;
}

// PGlite reports rowCount/command differently
export function poolFromPGlite(pg: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }> }): AuthPool {
  const client = {
    async query(text: string, params?: unknown[]) {
      const r = await pg.query(text, params);
      const command = (/^\s*(\w+)/.exec(text)?.[1] ?? '').toUpperCase();
      return { rows: r.rows ?? [], rowCount: r.affectedRows ?? r.rows?.length ?? 0, command };
    },
    release() {},
  };
  return { connect: async () => client, end: async () => {} };
}
