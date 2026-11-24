// SPDX-License-Identifier: AGPL-3.0-only
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Database {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<unknown>;
  // pinned connection for session advisory locks; PGlite doesn't need it
  session?<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}

export interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>): Promise<T>;
}

export function fromPGlite(db: PGliteLike): Database {
  return {
    transaction: (fn) => db.transaction((tx) => fn(tx as SqlClient)),
    exec: (sql) => db.exec(sql),
  };
}

export interface PgPoolLike {
  connect(): Promise<{
    query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    release(): void;
  }>;
}

type PgClientLike = Awaited<ReturnType<PgPoolLike['connect']>>;

function onClient(client: PgClientLike) {
  return {
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      await client.query('begin');
      try {
        const result = await fn(client as SqlClient);
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    },
    async exec(sql: string): Promise<unknown> {
      try {
        return await client.query(sql);
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      }
    },
  };
}

export function fromPgPool(pool: PgPoolLike): Database {
  const withClient = async <T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  };
  return {
    transaction: (fn) => withClient((c) => onClient(c).transaction(fn)),
    exec: (sql) => withClient((c) => onClient(c).exec(sql)),
    session: (fn) => withClient((c) => fn(onClient(c))),
  };
}

export interface TenantOptions {
  role?: 'vdrkit_app';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RLS does the tenant filtering here, not the queries
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: SqlClient) => Promise<T>,
  opts: TenantOptions = {},
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error(`Invalid tenant id: ${tenantId}`);
  return db.transaction(async (tx) => {
    if (opts.role) await tx.query(`set local role ${opts.role}`);
    await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn(tx);
  });
}
