// SPDX-License-Identifier: AGPL-3.0-only
import {
  appendEvent, closeStaleClaims, dueNotificationBatches, enqueuePublishDropped, prepareNotifications, recordSent, sendDueReminders, withTenant,
  type Channel, type Database, type OutgoingMessage,
} from '@vdrkit/core';
import { brandingFrom, brandingRow, type BrandingRow } from '../mail/branding.js';
import { notificationMessage, reminderMessage } from '../mail/notification-emails.js';
import { decryptBuffer } from '../crypto/envelope.js';
import type { Keyring } from '../crypto/keyring.js';
import { convertStep, GotenbergClient, hashStep, previewStep, runPipeline, SEARCH_SKIPPED_REASON, type Step, type Storage } from '../pipeline/pipeline.js';
import { imageStep } from '../pipeline/image.js';
import { rasteriseStep } from '../pipeline/rasterise.js';
import { virusScanStep, type ClamAvClient } from '../pipeline/virus-scan.js';
import { extractTextStep, indexText, parseExtractedText } from '../pipeline/extract-text.js';
import { recordDerived } from '../pipeline/record.js';
import { FAILED_SIGN_IN_DAYS } from '../site/common.js';
import { HttpProblem } from '../problems.js';
import { publishItems, type PublishRequest } from '../routes/publish.js';
import { releaseWaitingInvitations } from '../routes/people.js';
import type { SqlClient } from '@vdrkit/core';

export interface WorkerContext {
  db: Database;
  storage: Storage;
  keyring: Keyring;
  gotenberg: GotenbergClient;
  clamav?: ClamAvClient | null;
  mailer?: Channel;
  dbRole?: 'vdrkit_app';
  now: () => Date;
  publicUrl?: string;
  heartbeatMs?: number;
}

export type JobName = 'process-version' | 'send-due-notifications' | 'send-deadline-reminders' | 'site-health' | 'purge-failed-sign-ins'
  | 'sweep-expired-uploads' | 'sweep-stuck-processing' | 'send-waiting-invitations';
export interface JobQueue {
  enqueue(name: JobName, payload: Record<string, unknown>, opts?: { startAfter?: Date; singletonKey?: string }): Promise<void>;
}

export class MemoryQueue implements JobQueue {
  readonly jobs: { name: JobName; payload: Record<string, unknown> }[] = [];
  async enqueue(name: JobName, payload: Record<string, unknown>) {
    this.jobs.push({ name, payload });
  }
}

type RoleContext = Pick<WorkerContext, 'db' | 'dbRole'>;

function asWorker<T>(ctx: RoleContext, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    if (ctx.dbRole) await tx.query(`set local role ${ctx.dbRole}`);
    return fn(tx);
  });
}

const tenantTx = <T>(ctx: RoleContext, tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(ctx.db, tenantId, fn, ctx.dbRole ? { role: ctx.dbRole } : {});

export async function purgeFailedSignIns(ctx: Pick<WorkerContext, 'db' | 'dbRole' | 'now'>): Promise<{ deleted: number }> {
  const before = new Date(ctx.now().getTime() - FAILED_SIGN_IN_DAYS * 86_400_000);
  return asWorker(ctx, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(`select purge_failed_sign_ins($1) as n`, [before.toISOString()]);
    return { deleted: Number(rows[0]?.n ?? 0) };
  });
}

export const UPLOAD_SWEEP_GRACE_MS = 60 * 60_000;

interface ExpiredUpload { id: string; quarantine_key: string; multipart_upload_id: string | null; expires_at: string }

// bytes first, then the row
export async function sweepExpiredUploads(ctx: Pick<WorkerContext, 'db' | 'dbRole' | 'now' | 'storage'>, limit = 500): Promise<{ swept: number; failed?: number }> {
  const before = new Date(ctx.now().getTime() - UPLOAD_SWEEP_GRACE_MS).toISOString();
  const tenants = await asWorker(ctx, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(`select t as id from tenants_with_expired_uploads($1) t`, [before]);
    return rows.map((r) => r.id);
  });
  let swept = 0;
  let failed = 0;
  for (const tenantId of tenants) {
    // a session whose bytes cannot be deleted stays open; page past it
    let after: { expiresAt: string; id: string } | null = null;
    for (;;) {
      const from: { expiresAt: string; id: string } | null = after;
      const open: ExpiredUpload[] = await tenantTx(ctx, tenantId, async (tx) => {
        const { rows } = await tx.query<ExpiredUpload>(
          `select id, quarantine_key, multipart_upload_id, expires_at::text as expires_at from upload_session
            where status = 'open' and expires_at < $1 and ($3::timestamptz is null or (expires_at, id) > ($3::timestamptz, $4::uuid))
            order by expires_at, id limit $2`,
          [before, limit, from?.expiresAt ?? null, from?.id ?? null]);
        return rows;
      });
      if (!open.length) break;
      const last = open.at(-1)!;
      after = { expiresAt: last.expires_at, id: last.id };
      for (const s of open) {
        if (s.multipart_upload_id) await ctx.storage.multipart?.abort(s.quarantine_key, s.multipart_upload_id).catch(() => undefined);
        try {
          await ctx.storage.delete?.(s.quarantine_key);
        } catch {
          // not encrypted yet: next sweep retries
          failed++;
          continue;
        }
        const marked = await tenantTx(ctx, tenantId, async (tx) => {
          const row = (await tx.query<{ workspace_id: string; relative_path: string; person_id: string }>(
            `update upload_session set status = 'expired', completed_at = $2 where id = $1 and status = 'open' and expires_at < $3
             returning workspace_id, relative_path, person_id`, [s.id, ctx.now().toISOString(), before])).rows[0];
          if (!row) return false;
          await appendEvent(tx, { action: 'upload.expired', workspaceId: row.workspace_id, resourceType: 'upload_session', resourceId: s.id,
            data: { path: row.relative_path, person_id: row.person_id }, occurredAt: ctx.now() });
          return true;
        });
        if (marked) swept++;
      }
      if (open.length < limit) break;
    }
  }
  return failed ? { swept, failed } : { swept };
}

// workers report every 30 s; silent this long means gone
export const STUCK_AFTER_MS = 5 * 60_000;
export const HEARTBEAT_MS = 30_000;
// the longest one version may take; the queue's own expiry sits just above it
export const PROCESS_MAX_MS = 2 * 60 * 60_000;
// stopped twice on one file: no third start
export const MAX_RESTARTS = 2;

export const STUCK_REASON = 'VDRkit stopped processing this file because the worker stopped more than once while working on it. Ask your administrator to check the worker, then choose Process again.';

export const TOO_LONG_REASON = 'VDRkit stopped processing this file because it took longer than 2 hours. Split it into smaller documents and upload those.';

export const PENDING_STUCK_AFTER_MS = 2 * 60 * 60_000;

export const PENDING_REASON = 'VDRkit did not start processing this file within 2 hours. Ask your administrator to check the worker, then choose Process again.';

export interface StuckSweepOptions { queue?: JobQueue; silentMs?: number; maxMs?: number; pendingMs?: number }

// silent worker: restart, twice at most. Past the time limit: fail (the run notices on its next report).
// never picked up: fail.
export async function sweepStuckProcessing(ctx: Pick<WorkerContext, 'db' | 'dbRole' | 'now'>, o: StuckSweepOptions = {}): Promise<{ failed: number; restarted?: number }> {
  const at = ctx.now();
  const silentBefore = new Date(at.getTime() - (o.silentMs ?? STUCK_AFTER_MS)).toISOString();
  const startedBefore = new Date(at.getTime() - (o.maxMs ?? PROCESS_MAX_MS)).toISOString();
  const pendingBefore = new Date(at.getTime() - (o.pendingMs ?? PENDING_STUCK_AFTER_MS)).toISOString();
  const tenants = await asWorker(ctx, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(`select t as id from tenants_with_stuck_versions($1, $2, $3) t`,
      [silentBefore, startedBefore, pendingBefore]);
    return rows.map((r) => r.id);
  });
  let failed = 0;
  const again: { tenantId: string; versionId: string }[] = [];
  for (const tenantId of tenants) {
    failed += await tenantTx(ctx, tenantId, async (tx) => {
      const stuck = (await tx.query<{ id: string; node_id: string; workspace_id: string; why: 'never_started' | 'too_long' | 'silent'; restarts: number;
        publish_when_ready: PublishRequest | null }>(
        `select v.id, v.node_id, n.workspace_id, v.publish_when_ready, coalesce((v.metadata ->> 'processing_restarts')::int, 0) as restarts,
                case when v.processing_status = 'pending' then 'never_started'
                     when coalesce(v.processing_started_at, v.created_at) < $2 then 'too_long' else 'silent' end as why
           from document_version v join node n on n.id = v.node_id
          where (v.processing_status = 'processing'
                 and (coalesce(v.processing_heartbeat_at, v.processing_started_at, v.created_at) < $1
                      or coalesce(v.processing_started_at, v.created_at) < $2))
             or (v.processing_status = 'pending' and coalesce(v.queued_at, v.created_at) < $3
                 and not exists (select 1 from document_version busy
                                  where coalesce(busy.processing_heartbeat_at, busy.processing_started_at) >= $1))
            for update of v`, [silentBefore, startedBefore, pendingBefore])).rows;
      let n = 0;
      for (const r of stuck) {
        if (r.why === 'silent' && o.queue && r.restarts < MAX_RESTARTS) {
          await tx.query(
            `update document_version set processing_status = 'pending', queued_at = $2, processing_started_at = null, processing_heartbeat_at = null,
                    metadata = metadata || jsonb_build_object('processing_restarts', $3::int) where id = $1`, [r.id, at.toISOString(), r.restarts + 1]);
          await appendEvent(tx, { action: 'document.processing_restarted', workspaceId: r.workspace_id, resourceType: 'node', resourceId: r.node_id,
            occurredAt: at, data: { version_id: r.id, reason: 'worker_stopped', restarts: r.restarts + 1 } });
          again.push({ tenantId, versionId: r.id });
          continue;
        }
        const error = r.why === 'never_started' ? PENDING_REASON : r.why === 'too_long' ? TOO_LONG_REASON : STUCK_REASON;
        await tx.query(
          `update document_version set processing_status = 'failed', failed_step = 'worker', processing_error = $2, publish_when_ready = null where id = $1`,
          [r.id, error]);
        await appendEvent(tx, {
          action: 'document.processing_failed', workspaceId: r.workspace_id, resourceType: 'node', resourceId: r.node_id,
          occurredAt: at, data: { version_id: r.id, failed_step: 'worker', error, stuck: true,
            ...(r.why === 'never_started' ? { never_started: true } : {}), ...(r.why === 'too_long' ? { too_long: true } : {}) },
        });
        if (r.publish_when_ready) await dropPublishRequest(tx, r.workspace_id, r.node_id, r.id, r.publish_when_ready, 'failed', at);
        n++;
      }
      return n;
    });
  }
  // after commit: the worker must find the version pending
  for (const v of again) await o.queue!.enqueue('process-version', v, { singletonKey: `version:${v.versionId}:restart:${at.getTime()}` });
  return again.length ? { failed, restarted: again.length } : { failed };
}

async function dropPublishRequest(tx: SqlClient, ws: string, nodeId: string, versionId: string, req: PublishRequest,
  why: 'failed' | 'refused', now: Date, problem?: HttpProblem['problem']): Promise<void> {
  await tx.query(`update document_version set publish_when_ready = null where id = $1`, [versionId]);
  const code = why === 'failed' ? null : refusalCode(problem);
  const ev = await appendEvent(tx, { action: 'document.publish_request_dropped', workspaceId: ws, actorId: req.actor_id, resourceType: 'node', resourceId: nodeId,
    occurredAt: now, data: { version_id: versionId, person_id: req.person_id, reason: why, ...(code ? { code } : {}), ...(problem?.detail ? { detail: problem.detail } : {}) } });
  await enqueuePublishDropped(tx, { eventId: ev.id, workspaceId: ws, personId: req.person_id, nodeId, versionId, occurredAt: now });
}

function refusalCode(p: HttpProblem['problem'] | undefined): string | null {
  if (!p) return null;
  if (p.reason) return p.reason;
  if (p.status === 404) return 'not_found';
  if (/is (closed|archived)/.test(p.detail ?? '')) return 'room_closed';
  return null;
}

export async function publishWhenReady(tx: SqlClient, versionId: string, now: Date): Promise<'published' | 'dropped' | null> {
  const v = (await tx.query<{ node_id: string; workspace_id: string; state: string; awaiting_release: boolean; processing_status: string;
    withdrawn_at: string | null; deleted_at: string | null; request: PublishRequest | null; newest: boolean }>(
    `select dv.node_id, n.workspace_id, n.state, dv.awaiting_release, dv.processing_status, dv.withdrawn_at, n.deleted_at, dv.publish_when_ready as request,
            not exists (select 1 from document_version o where o.node_id = dv.node_id and o.version_no > dv.version_no and o.withdrawn_at is null) as newest
       from document_version dv join node n on n.id = dv.node_id where dv.id = $1`, [versionId])).rows[0];
  if (!v?.request) return null;
  if (v.processing_status === 'failed') {
    await dropPublishRequest(tx, v.workspace_id, v.node_id, versionId, v.request, 'failed', now);
    return 'dropped';
  }
  if (v.processing_status !== 'ready') return null;
  const draftDoc = v.state === 'draft' && v.newest;
  const waiting = v.state === 'published' && v.awaiting_release;
  if (v.withdrawn_at || v.deleted_at || (!draftDoc && !waiting)) {
    await tx.query(`update document_version set publish_when_ready = null where id = $1`, [versionId]);
    return null;
  }
  await tx.query('savepoint publish_when_ready');
  try {
    await publishItems(tx, {
      ws: v.workspace_id, person: v.request.person_id, actorId: v.request.actor_id, nodeIds: draftDoc ? [v.node_id] : [],
      versionIds: waiting ? [versionId] : [], quiet: v.request.quiet, downloadOnly: false, now,
    });
    await tx.query('release savepoint publish_when_ready');
    return 'published';
  } catch (e) {
    await tx.query('rollback to savepoint publish_when_ready');
    if (!(e instanceof HttpProblem)) throw e;
    await dropPublishRequest(tx, v.workspace_id, v.node_id, versionId, v.request, 'refused', now, e.problem);
    return 'dropped';
  }
}

export const PIPELINE_STEPS = (ctx: Pick<WorkerContext, 'clamav' | 'gotenberg'>): Step[] =>
  [hashStep, virusScanStep(ctx.clamav), convertStep(ctx.gotenberg), imageStep, rasteriseStep, extractTextStep, previewStep];

export interface ProcessResult { status: 'ready' | 'failed' | 'removed' | 'superseded' | 'waiting'; pageCount: number | null; error?: string; failedStep?: string }

// processing_started_at marks the run that owns the version; an expired job's retry can run beside the first
export async function processVersion(ctx: WorkerContext, tenantId: string, versionId: string): Promise<ProcessResult> {
  const startedAt = ctx.now().toISOString();
  const v = await tenantTx(ctx, tenantId, async (tx) => {
    const row = (await tx.query<any>(
      `update document_version dv set processing_status = 'processing', processing_error = null, failed_step = null, processing_started_at = $2,
              processing_heartbeat_at = $2
         from node n where dv.id = $1 and n.id = dv.node_id and not coalesce((dv.metadata ->> 'removed_draft')::boolean, false)
       returning dv.id, dv.node_id, dv.storage_key, dv.sha256, dv.mime, dv.key_version, n.workspace_id, n.name`, [versionId, startedAt])).rows[0];
    if (!row) {
      const removed = (await tx.query(`select 1 from document_version where id = $1`, [versionId])).rows.length > 0;
      if (removed) return null;
      throw new Error(`Version ${versionId} not found`);
    }
    const key = await ctx.keyring.keyFor(tx, row.workspace_id, row.key_version);
    return { ...row, key };
  });
  if (!v) return { status: 'removed', pageCount: null };

  // heartbeat; a report that finds another owner ends the work
  let lost = false;
  const began = ctx.now().getTime();
  const beat = setInterval(() => {
    void tenantTx(ctx, tenantId, async (tx) => {
      const { rows } = await tx.query(
        `update document_version set processing_heartbeat_at = $3
          where id = $1 and processing_status = 'processing' and processing_started_at = $2::timestamptz returning id`,
        [versionId, startedAt, ctx.now().toISOString()]);
      if (!rows.length) lost = true;
    }).catch(() => undefined);
  }, ctx.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref?.();
  const stop = () => {
    if (lost) return 'Another run has taken over this file.';
    return ctx.now().getTime() - began > PROCESS_MAX_MS ? TOO_LONG_REASON : null;
  };

  let result: Awaited<ReturnType<typeof runPipeline>>;
  try {
    result = await runPipeline(
      { versionId, workspaceId: v.workspace_id, storageKey: v.storage_key, filename: v.name, mime: v.mime },
      PIPELINE_STEPS(ctx),
      ctx.storage,
      v.key,
      { stop },
    );
  } finally {
    clearInterval(beat);
  }

  let error = result.error;
  let failedStep = result.failedStep;
  if (result.ok && result.facts.sha256 !== v.sha256) {
    error = 'The stored file does not match the file that was uploaded. Upload it again.';
    failedStep = 'hash';
  }
  const ok = result.ok && !error;
  const pageCount = typeof result.facts.pageCount === 'number' ? result.facts.pageCount : null;

  let texts: string[] = [];
  const textFile = result.derived.find((d) => d.kind === 'text');
  if (ok && textFile) texts = parseExtractedText(await decryptBuffer(v.key, await ctx.storage.get(textFile.storageKey), textFile.storageKey));

  const kept = await tenantTx(ctx, tenantId, async (tx) => {
    const now = (await tx.query<{ gone: boolean; owned: boolean }>(
      `select coalesce((metadata ->> 'removed_draft')::boolean, false) as gone,
              processing_status = 'processing' and processing_started_at = $2::timestamptz as owned
         from document_version where id = $1 for update`, [versionId, startedAt])).rows[0];
    if (!now || now.gone) return 'removed';
    // a later run, the stuck sweep or the give-up handler has the last word
    if (!now.owned) return 'superseded';
    const keyVersion = v.key_version ?? (await ctx.keyring.dataKey(tx, v.workspace_id)).version;
    await tx.query(`select forget_derived_files($1)`, [versionId]);
    await recordDerived(tx, versionId, result, { keyVersion });
    if (ok) await indexText(tx, { workspaceId: v.workspace_id, nodeId: v.node_id, versionId, pages: texts });
    await tx.query(
      `update document_version set processing_status = $2, processing_error = $3, failed_step = $4, page_count = $5 where id = $1`,
      [versionId, ok ? 'ready' : 'failed', ok ? null : error ?? 'Processing failed', ok ? null : failedStep ?? null, pageCount]);
    const scan = {
      virusScan: result.facts.virusScan ?? null,
      virusSignature: result.facts.virusSignature ?? null,
      previewSkipped: result.facts.previewSkipped ?? null,
      searchSkipped: ok ? result.facts.searchSkipped ?? null : null,
    };
    await tx.query(`update document_version set metadata = (metadata - 'previewSkipped' - 'searchSkipped') || jsonb_strip_nulls($2::jsonb) where id = $1`,
      [versionId, JSON.stringify(scan)]);
    await appendEvent(tx, {
      action: ok ? 'document.processed' : 'document.processing_failed', workspaceId: v.workspace_id,
      resourceType: 'node', resourceId: v.node_id, occurredAt: ctx.now(),
      data: { version_id: versionId, page_count: pageCount, steps: result.completedSteps, virus_scan: result.facts.virusScan ?? null,
        ...(ok ? {} : { failed_step: failedStep, error }),
        ...(scan.searchSkipped ? { search_skipped: scan.searchSkipped, note: SEARCH_SKIPPED_REASON } : {}) },
    });
    await publishWhenReady(tx, versionId, ctx.now());
    return 'kept';
  });
  // same storage keys as the owner's run, so its objects stay
  if (kept === 'superseded') return { status: 'superseded', pageCount: null };
  if (kept === 'removed') {
    for (const d of result.derived) await ctx.storage.delete?.(d.storageKey).catch(() => undefined);
    return { status: 'removed', pageCount: null };
  }
  return ok ? { status: 'ready', pageCount } : { status: 'failed', pageCount, error: error!, failedStep: failedStep! };
}

const noMailer: Channel = { name: 'email', send: async () => ({ status: 'failed', error: 'No mail server is configured' }) };

export interface WaitingInvitationsPayload { tenantId: string; workspaceId: string; actorId?: string | null; publicUrl?: string }

export async function sendWaitingInvitations(ctx: WorkerContext, p: WaitingInvitationsPayload): Promise<{ sent: number; notSent: number }> {
  const deps = { mailer: ctx.mailer ?? noMailer, storage: ctx.storage, publicUrl: p.publicUrl || ctx.publicUrl || '', now: ctx.now };
  return releaseWaitingInvitations(deps, (fn) => tenantTx(ctx, p.tenantId, fn), p.workspaceId, { actorId: p.actorId ?? null });
}

// not inside a transaction (fetches the logo)
async function brandingFor(ctx: WorkerContext, row: BrandingRow | null) {
  return brandingFrom(row, ctx.storage, ctx.publicUrl ?? '');
}

async function deliver(channel: Channel, msg: OutgoingMessage) {
  try {
    return await channel.send(msg);
  } catch (e) {
    return { status: 'failed' as const, error: e instanceof Error ? e.message.slice(0, 200) : 'failed' };
  }
}

// claim, send, record: separate transactions. The claim commits first: never sent twice
export async function sendDueNotifications(ctx: WorkerContext, tenantId: string, limit = 200): Promise<{ sent: number; dropped: number; failed: number }> {
  const now = ctx.now();
  const channel = ctx.mailer ?? noMailer;
  await tenantTx(ctx, tenantId, (tx) => closeStaleClaims(tx, now));
  const batches = await tenantTx(ctx, tenantId, (tx) => dueNotificationBatches(tx, now, limit));
  const out = { sent: 0, dropped: 0, failed: 0 };
  for (const ids of batches) {
    const { p, row } = await tenantTx(ctx, tenantId, async (tx) => {
      const p = await prepareNotifications(tx, ids, now, { claim: true });
      return { p, row: p.status === 'ready' ? await brandingRow(tx) : null };
    });
    if (p.status === 'skipped') continue;
    if (p.status === 'dropped') {
      out.dropped++;
      continue;
    }
    let result: Awaited<ReturnType<Channel['send']>>;
    let sent: { to: string; subject: string } | undefined;
    try {
      const msg = notificationMessage(p.email.content, await brandingFor(ctx, row), ctx.publicUrl ?? '');
      sent = msg;
      result = await deliver(channel, msg);
    } catch (e) {
      result = { status: 'failed', error: e instanceof Error ? e.message.slice(0, 200) : 'The email could not be built' };
    }
    const r = await tenantTx(ctx, tenantId, (tx) => recordSent(tx, p.email, channel.name, result, now, sent));
    out[r.status]++;
  }
  return out;
}

export async function sendDeadlineReminders(ctx: WorkerContext, tenantId: string): Promise<{ sent: number; failed: number }> {
  const now = ctx.now();
  await tenantTx(ctx, tenantId, (tx) => closeStaleClaims(tx, now));
  const row = await tenantTx(ctx, tenantId, (tx) => brandingRow(tx));
  const brand = await brandingFor(ctx, row);
  return sendDueReminders((fn) => tenantTx(ctx, tenantId, fn), ctx.mailer ?? noMailer, now,
    (c) => reminderMessage(c, brand, ctx.publicUrl ?? ''));
}
