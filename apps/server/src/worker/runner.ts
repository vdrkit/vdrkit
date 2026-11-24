// SPDX-License-Identifier: AGPL-3.0-only
import { appendEvent, withTenant } from '@vdrkit/core';
import {
  processVersion, publishWhenReady, purgeFailedSignIns, sendDeadlineReminders, sendDueNotifications, sendWaitingInvitations, sweepExpiredUploads, sweepStuckProcessing,
  type JobQueue, type WaitingInvitationsPayload, type WorkerContext,
} from './jobs.js';
import { ServiceUnavailable } from '../pipeline/pipeline.js';
import { assertPayload, PgBossQueue, PROCESS_VERSION_DEAD, type BossJob, type BossLike } from './pg-boss-queue.js';
import { runHealthAlerts, type AlertOptions, type HealthProbes } from '../site/health.js';

export interface VersionPayload { tenantId: string; versionId: string; waits?: number }
export interface NotifyPayload { tenantId?: string }

export interface RunnerOptions {
  listTenants?: () => Promise<string[]>;
  notifyCron?: string;
  listReminderTenants?: () => Promise<string[]>;
  reminderCron?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  healthProbes?: HealthProbes;
  healthCron?: string;
  purgeCron?: string;
  uploadSweepCron?: string;
  stuckSweepCron?: string;
  publicUrl?: string;
}

export const GAVE_UP = 'VDRkit could not process this file after several attempts. Ask your administrator to check the worker, then choose Process again.';

// converter or scanner down: retried every two minutes for an hour
export const OUTAGE_WAIT_MS = 2 * 60_000;
export const OUTAGE_TRIES = 30;

// throws -> pg-boss retries
export async function handleProcessVersion(ctx: WorkerContext, job: BossJob<VersionPayload>, queue?: JobQueue) {
  assertPayload('process-version', job.data as unknown as Record<string, unknown>);
  const { tenantId, versionId } = job.data;
  try {
    return await processVersion(ctx, tenantId, versionId);
  } catch (e) {
    const waits = Number(job.data.waits ?? 0);
    if (!(e instanceof ServiceUnavailable) || !queue || waits >= OUTAGE_TRIES) throw e;
    const at = ctx.now();
    const waiting = await withTenant(ctx.db, tenantId, async (tx) => {
      const { rows } = await tx.query(
        `update document_version set processing_status = 'pending', queued_at = $2, processing_started_at = null, processing_heartbeat_at = null
        where id = $1 and processing_status = 'processing' returning id`, [versionId, at.toISOString()]);
      return rows.length > 0;
    }, ctx.dbRole ? { role: ctx.dbRole } : {});
    if (!waiting) return { status: 'superseded' as const, pageCount: null };
    await queue.enqueue('process-version', { tenantId, versionId, waits: waits + 1 },
      { startAfter: new Date(Date.now() + OUTAGE_WAIT_MS), singletonKey: `version:${versionId}:wait:${waits + 1}` });
    return { status: 'waiting' as const, pageCount: null };
  }
}

export async function markVersionFailed(ctx: WorkerContext, tenantId: string, versionId: string, reason = GAVE_UP): Promise<boolean> {
  return withTenant(ctx.db, tenantId, async (tx) => {
    const row = (await tx.query<{ node_id: string; workspace_id: string }>(
      `update document_version dv set processing_status = 'failed', processing_error = $2, failed_step = 'worker'
         from node n where dv.id = $1 and n.id = dv.node_id and dv.processing_status <> 'ready'
       returning dv.node_id, n.workspace_id`, [versionId, reason])).rows[0];
    if (!row) return false;
    await appendEvent(tx, {
      action: 'document.processing_failed', workspaceId: row.workspace_id, resourceType: 'node', resourceId: row.node_id,
      occurredAt: ctx.now(), data: { version_id: versionId, failed_step: 'worker', error: reason },
    });
    await publishWhenReady(tx, versionId, ctx.now());
    return true;
  }, ctx.dbRole ? { role: ctx.dbRole } : {});
}

export async function handleSendDue(ctx: WorkerContext, queue: PgBossQueue, opts: Pick<RunnerOptions, 'listTenants'>, job: BossJob<NotifyPayload>) {
  assertPayload('send-due-notifications', job.data as Record<string, unknown>);
  if (!job.data.tenantId) {
    const tenants = opts.listTenants ? await opts.listTenants() : await tenantsWithDueNotifications(ctx);
    for (const tenantId of tenants) await queue.enqueue('send-due-notifications', { tenantId });
    return { fannedOut: tenants.length };
  }
  return sendDueNotifications(ctx, job.data.tenantId);
}

export async function handleReminders(ctx: WorkerContext, queue: PgBossQueue, opts: Pick<RunnerOptions, 'listReminderTenants'>, job: BossJob<NotifyPayload>) {
  assertPayload('send-deadline-reminders', job.data as Record<string, unknown>);
  if (!job.data.tenantId) {
    const tenants = opts.listReminderTenants ? await opts.listReminderTenants() : await tenantsWithDueReminders(ctx);
    for (const tenantId of tenants) await queue.enqueue('send-deadline-reminders', { tenantId });
    return { fannedOut: tenants.length };
  }
  return sendDeadlineReminders(ctx, job.data.tenantId);
}

// security definer: RLS hides everything before a tenant is set
function tenantIds(ctx: WorkerContext, sql: string): Promise<string[]> {
  return ctx.db.transaction(async (tx) => {
    if (ctx.dbRole) await tx.query(`set local role ${ctx.dbRole}`);
    const { rows } = await tx.query<{ id: string }>(sql, [ctx.now().toISOString()]);
    return rows.map((r) => r.id);
  });
}

export async function tenantsWithDueReminders(ctx: WorkerContext): Promise<string[]> {
  return tenantIds(ctx, `select t as id from tenants_with_due_reminders($1) t`);
}

export async function tenantsWithDueNotifications(ctx: WorkerContext): Promise<string[]> {
  return tenantIds(ctx, `select t as id from tenants_with_due_notifications($1) t`);
}

export async function registerWorker(boss: BossLike, ctx: WorkerContext, opts: RunnerOptions): Promise<PgBossQueue> {
  const log = opts.log ?? (() => {});
  const queue = new PgBossQueue(boss);
  await queue.setup();

  await boss.work<VersionPayload>('process-version', { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const r = await handleProcessVersion(ctx, job, queue);
    log('process-version', { versionId: job.data.versionId, status: r.status });
    return r;
  });
  await boss.work<VersionPayload>(PROCESS_VERSION_DEAD, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const marked = await markVersionFailed(ctx, job.data.tenantId, job.data.versionId);
    log('process-version gave up', { versionId: job.data.versionId, marked });
    return { marked };
  });
  await boss.work<NotifyPayload>('send-due-notifications', { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    return handleSendDue(ctx, queue, opts, job);
  });
  await boss.schedule('send-due-notifications', opts.notifyCron ?? '* * * * *', {}, { tz: 'UTC' });
  await boss.work<NotifyPayload>('send-deadline-reminders', { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    return handleReminders(ctx, queue, opts, job);
  });
  await boss.schedule('send-deadline-reminders', opts.reminderCron ?? '* * * * *', {}, { tz: 'UTC' });
  await boss.work('purge-failed-sign-ins', { batchSize: 1 }, async () => {
    const r = await purgeFailedSignIns(ctx);
    if (r.deleted) log('purge-failed-sign-ins', r);
    return r;
  });
  await boss.schedule('purge-failed-sign-ins', opts.purgeCron ?? '17 3 * * *', {}, { tz: 'UTC' });
  await boss.work('sweep-expired-uploads', { batchSize: 1 }, async () => {
    const r = await sweepExpiredUploads(ctx);
    if (r.swept || r.failed) log('sweep-expired-uploads', r);
    return r;
  });
  await boss.schedule('sweep-expired-uploads', opts.uploadSweepCron ?? '23 * * * *', {}, { tz: 'UTC' });
  await boss.work('sweep-stuck-processing', { batchSize: 1 }, async () => {
    const r = await sweepStuckProcessing(ctx, { queue });
    if (r.failed || r.restarted) log('sweep-stuck-processing', r);
    return r;
  });
  await boss.schedule('sweep-stuck-processing', opts.stuckSweepCron ?? '*/5 * * * *', {}, { tz: 'UTC' });
  await boss.work<WaitingInvitationsPayload>('send-waiting-invitations', { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    assertPayload('send-waiting-invitations', job.data as unknown as Record<string, unknown>);
    const r = await sendWaitingInvitations(ctx, job.data);
    log('send-waiting-invitations', { workspaceId: job.data.workspaceId, ...r });
    return r;
  });
  if (opts.healthProbes) {
    const probes = opts.healthProbes;
    await boss.work('site-health', { batchSize: 1 }, async () => {
      const alerts: AlertOptions = { db: ctx.db, probes };
      if (ctx.dbRole) alerts.dbRole = ctx.dbRole;
      if (ctx.mailer) alerts.mailer = ctx.mailer;
      if (ctx.storage) alerts.storage = ctx.storage;
      if (opts.publicUrl) alerts.publicUrl = opts.publicUrl;
      const r = await runHealthAlerts(alerts);
      if (r.alerted.length || r.recovered.length) log('site-health', { alerted: r.alerted, recovered: r.recovered });
      return { alerted: r.alerted, recovered: r.recovered };
    });
    await boss.schedule('site-health', opts.healthCron ?? '* * * * *', {}, { tz: 'UTC' });
  }
  return queue;
}
