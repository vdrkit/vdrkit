// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './db.js';

export interface NewEvent {
  action: string;
  workspaceId?: string | null;
  actorId?: string | null;
  onBehalfOfId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  // hashed, can't be erased: no personal data, use context
  data?: Record<string, unknown>;
  requestId?: string | null;
  /** ignored */
  occurredAt?: Date;
  context?: {
    ip?: string | null;
    userAgent?: string | null;
    personal?: Record<string, unknown> | null;
    subjectPersonId?: string | null;
  };
}

export interface StoredEvent {
  id: string;
  seq: number;
  chainKey: string;
  chainPos: number;
  occurredAt: Date;
  action: string;
  hash: string;
  prevHash: string;
}

export async function appendEvent(tx: SqlClient, e: NewEvent): Promise<StoredEvent> {
  const { rows } = await tx.query<{
    id: string; seq: string; chain_key: string; chain_pos: string; occurred_at: string | Date; action: string; hash: string; prev_hash: string;
  }>(
    `select id, seq, chain_key, chain_pos, occurred_at, action, hash, prev_hash
       from append_event($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      e.action,
      e.workspaceId ?? null,
      e.actorId ?? null,
      e.onBehalfOfId ?? null,
      e.resourceType ?? null,
      e.resourceId ?? null,
      JSON.stringify(e.data ?? {}),
      e.requestId ?? null,
      null,
    ],
  );
  const r = rows[0];
  if (!r) throw new Error('append_event returned nothing');
  if (e.context && (e.context.ip || e.context.userAgent || e.context.personal)) {
    await tx.query(
      `insert into event_context (event_id, occurred_at, tenant_id, ip, user_agent, personal, subject_person_id)
       values ($1, $2, current_tenant_id(), $3, $4, $5::jsonb, $6)`,
      [r.id, new Date(r.occurred_at).toISOString(), e.context.ip ?? null, e.context.userAgent ?? null,
        e.context.personal ? JSON.stringify(e.context.personal) : null, e.context.subjectPersonId ?? null],
    );
  }
  return {
    id: r.id,
    seq: Number(r.seq),
    chainKey: r.chain_key,
    chainPos: Number(r.chain_pos),
    occurredAt: new Date(r.occurred_at),
    action: r.action,
    hash: r.hash,
    prevHash: r.prev_hash,
  };
}

export interface ChainCheck {
  checked: number;
  firstBroken: number | null;
}

export async function verifyChain(tx: SqlClient, chainKey: string): Promise<ChainCheck> {
  const { rows } = await tx.query<{ checked: string; first_broken: string | null }>(
    'select checked, first_broken from verify_chain($1)',
    [chainKey],
  );
  const r = rows[0];
  return { checked: Number(r?.checked ?? 0), firstBroken: r?.first_broken == null ? null : Number(r.first_broken) };
}
