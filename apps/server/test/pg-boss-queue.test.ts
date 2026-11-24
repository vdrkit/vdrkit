// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';
import { appendEvent, verifyChain, withTenant } from '@vdrkit/core';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { GotenbergClient, MemoryStorage } from '../src/pipeline/pipeline.js';
import { purgeFailedSignIns, type WorkerContext } from '../src/worker/jobs.js';
import { PgBossQueue, PROCESS_VERSION_DEAD, QUEUES, queueRoleWarning, type BossJob, type BossLike, type QueueOptions, type SendOptions } from '../src/worker/pg-boss-queue.js';
import { GAVE_UP, registerWorker, tenantsWithDueNotifications, tenantsWithDueReminders } from '../src/worker/runner.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';
import { emptyOwnerDatabase, TEST_DATABASE_URL } from '../../../packages/core/test/real-postgres.js';

class FakeBoss implements BossLike {
  queues = new Map<string, QueueOptions>();
  created: string[] = [];
  jobs: { name: string; data: any; options: SendOptions }[] = [];
  handlers = new Map<string, (jobs: BossJob<any>[]) => Promise<unknown>>();
  schedules: { name: string; cron: string }[] = [];
  async start() { return this; }
  async stop() {}
  async createQueue(name: string, options?: QueueOptions) {
    if (options?.deadLetter && !this.queues.has(options.deadLetter)) throw new Error('dead letter queue missing');
    this.queues.set(name, options ?? {}); this.created.push(name);
  }
  async getQueue(name: string) { return this.queues.get(name) ?? null; }
  async send(name: string, data: object, options: SendOptions) {
    if (!this.queues.has(name)) throw new Error(`Queue ${name} does not exist`);
    if (this.queues.get(name)!.policy === 'stately' && this.jobs.some((j) => j.name === name && j.options.singletonKey === options.singletonKey)) return null;
    this.jobs.push({ name, data, options });
    return randomUUID();
  }
  async work<T>(name: string, _o: object, handler: (jobs: BossJob<T>[]) => Promise<unknown>) { this.handlers.set(name, handler); return name; }
  async schedule(name: string, cron: string) { this.schedules.push({ name, cron }); }
  on() { return this; }
  run(name: string, data: object) { return this.handlers.get(name)!([{ id: randomUUID(), name, data }]); }
}

const tenant = '00000000-0000-4000-8000-000000000001';
const version = '00000000-0000-4000-8000-0000000000aa';

describe('PgBossQueue', () => {
  it('creates the dead letter queue first', async () => {
    const boss = new FakeBoss();
    const q = new PgBossQueue(boss);
    await q.setup(); await q.setup();
    expect(boss.created).toEqual([PROCESS_VERSION_DEAD, 'process-version', 'send-due-notifications', 'send-deadline-reminders', 'site-health', 'purge-failed-sign-ins', 'sweep-expired-uploads', 'sweep-stuck-processing', 'send-waiting-invitations']);
    expect(boss.queues.get('process-version')).toMatchObject({ policy: 'stately', retryBackoff: true, deadLetter: PROCESS_VERSION_DEAD });
  });

  it('sends process-version with singleton key and retries', async () => {
    const boss = new FakeBoss();
    const q = new PgBossQueue(boss);
    await q.enqueue('process-version', { tenantId: tenant, versionId: version });
    await q.enqueue('process-version', { tenantId: tenant, versionId: version });   // duplicate
    expect(boss.jobs).toHaveLength(1);
    expect(boss.jobs[0]!.options).toMatchObject({
      singletonKey: `version:${version}`, retryLimit: QUEUES['process-version'].retryLimit, retryBackoff: true, deadLetter: PROCESS_VERSION_DEAD,
    });
  });

  it('passes startAfter and singletonKey', async () => {
    const boss = new FakeBoss();
    const later = new Date('2026-11-13T10:00:00Z');
    await new PgBossQueue(boss).enqueue('send-due-notifications', { tenantId: tenant }, { startAfter: later, singletonKey: 'k' });
    expect(boss.jobs[0]!.options).toMatchObject({ startAfter: later, singletonKey: 'k' });
  });

  it('requires a tenant id', async () => {
    const q = new PgBossQueue(new FakeBoss());
    await expect(q.enqueue('process-version', { versionId: version })).rejects.toThrow(/tenant id/);
    await expect(q.enqueue('send-due-notifications', { tenantId: 'not-a-uuid' })).rejects.toThrow(/tenant id/);
  });
});

describe('worker handlers', () => {
  let h: Heron;
  let boss: FakeBoss;
  let ctx: WorkerContext;
  beforeEach(async () => {
    h = await heron();
    boss = new FakeBoss();
    ctx = {
      db: h.db, storage: new MemoryStorage(), keyring: new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64'))),
      gotenberg: new GotenbergClient('http://127.0.0.1:9'), dbRole: 'vdrkit_app', now: () => T.at,
    };
  });
  afterEach(async () => { await h.pg.close(); });

  const addVersion = async (status = 'processing') => (await h.pg.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, processing_status)
     values ($1, $2, 1, 'k', $3, 1, 'application/pdf', $4) returning id`, [h.t1, h.node.aud1, '0'.repeat(64), status])).rows[0]!.id;

  it('registers handlers and schedules', async () => {
    await registerWorker(boss, ctx, { listTenants: async () => [] });
    expect([...boss.handlers.keys()].sort()).toEqual(['process-version', PROCESS_VERSION_DEAD, 'purge-failed-sign-ins', 'send-deadline-reminders', 'send-due-notifications', 'send-waiting-invitations', 'sweep-expired-uploads', 'sweep-stuck-processing']);
    expect(boss.schedules).toEqual([{ name: 'send-due-notifications', cron: '* * * * *' }, { name: 'send-deadline-reminders', cron: '* * * * *' },
      { name: 'purge-failed-sign-ins', cron: '17 3 * * *' }, { name: 'sweep-expired-uploads', cron: '23 * * * *' }, { name: 'sweep-stuck-processing', cron: '*/5 * * * *' }]);
  });

  it('fans reminder ticks out to due tenants', async () => {
    await registerWorker(boss, ctx, {});
    expect(await boss.run('send-deadline-reminders', {})).toEqual({ fannedOut: 0 });
    await h.pg.query(`insert into milestone (tenant_id, workspace_id, title, due_at) values ($1, $2, 'First-round bids', $3)`,
      [h.t1, h.ws, new Date(T.at.getTime() + 36 * 3_600_000).toISOString()]);
    expect(await boss.run('send-deadline-reminders', {})).toEqual({ fannedOut: 1 });
    expect(boss.jobs.at(-1)).toMatchObject({ name: 'send-deadline-reminders', data: { tenantId: h.t1 }, options: { singletonKey: `tenant:${h.t1}` } });
    expect(await tenantsWithDueReminders({ ...ctx, now: () => new Date(T.at.getTime() - 24 * 3_600_000) })).toEqual([]);
    const direct = await h.db.transaction(async (tx) => {
      await tx.query('set local role vdrkit_app');
      return (await tx.query(`select 1 from milestone`)).rows.length;
    });
    expect(direct).toBe(0);
  });

  it('schedules the health run', async () => {
    await h.pg.query(`update person set is_site_admin = true where id = $1`, [h.person.anika]);
    await h.pg.query(`insert into site_instance (tenant_id) values ($1)`, [h.t1]);
    const failing = { async run() { return [{ key: 'storage' as const, label: 'File storage', status: 'failing' as const, detail: 'down' }]; } };
    await registerWorker(boss, ctx, { listTenants: async () => [], healthProbes: failing });
    expect(boss.schedules).toEqual([{ name: 'send-due-notifications', cron: '* * * * *' }, { name: 'send-deadline-reminders', cron: '* * * * *' },
      { name: 'purge-failed-sign-ins', cron: '17 3 * * *' }, { name: 'sweep-expired-uploads', cron: '23 * * * *' }, { name: 'sweep-stuck-processing', cron: '*/5 * * * *' }, { name: 'site-health', cron: '* * * * *' }]);
    expect(await boss.run('site-health', {})).toEqual({ alerted: [], recovered: [] });
    expect((await h.pg.query<any>(`select check_key, status from site_health_state`)).rows).toEqual([{ check_key: 'storage', status: 'failing' }]);
  });

  it('purges failed sign-ins after 30 days', async () => {
    const day = 86_400_000;
    const failed = async (tenant: string, daysAgo: number, email: string) => {
      await h.pin(new Date(T.at.getTime() - daysAgo * day));
      await withTenant(h.db, tenant, (tx) => appendEvent(tx, { action: 'auth.sign_in_failed', resourceType: 'sign_in',
        data: { reason: 'wrong_code', method: 'email_code' }, context: { ip: '203.0.113.18', userAgent: 'Chrome', personal: { email } } }));
    };
    await failed(h.t1, 45, 'old@t1.example');
    await failed(h.t2, 31, 'old@t2.example');
    await failed(h.t1, 29, 'recent@t1.example');
    await h.pin(new Date(T.at.getTime() - 60 * day));
    await withTenant(h.db, h.t1, (tx) => appendEvent(tx, { action: 'auth.signed_in', resourceType: 'person', context: { ip: '203.0.113.18', userAgent: 'Chrome' } }));
    await h.pin(T.at);
    const contexts = async () => (await h.pg.query<{ email: string | null; action: string }>(
      `select ec.personal ->> 'email' as email, e.action from event_context ec join event e on e.id = ec.event_id order by e.seq`)).rows;

    await registerWorker(boss, ctx, { listTenants: async () => [] });
    expect(await boss.run('purge-failed-sign-ins', {})).toEqual({ deleted: 2 });
    expect(await contexts()).toEqual([{ email: 'recent@t1.example', action: 'auth.sign_in_failed' }, { email: null, action: 'auth.signed_in' }]);
    expect((await h.pg.query(`select 1 from event where action = 'auth.sign_in_failed'`)).rows).toHaveLength(3);
    expect(await h.app((tx) => verifyChain(tx, h.t1))).toMatchObject({ firstBroken: null });
    // idempotent
    expect(await boss.run('purge-failed-sign-ins', {})).toEqual({ deleted: 0 });
    expect(await purgeFailedSignIns({ ...ctx, now: () => new Date(T.at.getTime() + 0.5 * day) })).toEqual({ deleted: 0 });
    expect(await purgeFailedSignIns({ ...ctx, now: () => new Date(T.at.getTime() + 2 * day) })).toEqual({ deleted: 1 });
    const direct = await h.db.transaction(async (tx) => {
      await tx.query('set local role vdrkit_app');
      return (await tx.query(`select 1 from event_context`)).rows.length;
    });
    expect(direct).toBe(0);
  });

  it('fails the job for a missing version', async () => {
    await registerWorker(boss, ctx, { listTenants: async () => [] });
    await expect(boss.run('process-version', { tenantId: h.t1, versionId: randomUUID() })).rejects.toThrow(/not found/);
  });

  it('marks the version failed after retries', async () => {
    await registerWorker(boss, ctx, { listTenants: async () => [] });
    const stuck = await addVersion('processing');
    expect(await boss.run(PROCESS_VERSION_DEAD, { tenantId: h.t1, versionId: stuck })).toEqual({ marked: true });
    const row = (await h.pg.query<any>(`select processing_status, processing_error, failed_step from document_version where id = $1`, [stuck])).rows[0];
    expect(row).toEqual({ processing_status: 'failed', processing_error: GAVE_UP, failed_step: 'worker' });
    expect((await h.pg.query(`select 1 from event where action = 'document.processing_failed'`)).rows).toHaveLength(1);

    await h.pg.query(`update document_version set processing_status = 'ready' where id = $1`, [stuck]);
    expect(await boss.run(PROCESS_VERSION_DEAD, { tenantId: h.t1, versionId: stuck })).toEqual({ marked: false });
  });

  it('runs the dead letter handler in the tenant', async () => {
    await registerWorker(boss, ctx, { listTenants: async () => [] });
    const v = await addVersion('processing');
    expect(await boss.run(PROCESS_VERSION_DEAD, { tenantId: h.t2, versionId: v })).toEqual({ marked: false });
  });

  it('fans the tick out per tenant', async () => {
    await registerWorker(boss, ctx, { listTenants: async () => [h.t1, h.t2] });
    expect(await boss.run('send-due-notifications', {})).toEqual({ fannedOut: 2 });
    expect(boss.jobs.map((j) => j.options.singletonKey)).toEqual([`tenant:${h.t1}`, `tenant:${h.t2}`]);
    expect(await boss.run('send-due-notifications', { tenantId: h.t1 })).toEqual({ sent: 0, dropped: 0, failed: 0 });
  });

  it('fans out only to tenants with notifications due', async () => {
    await registerWorker(boss, ctx, {});
    expect(await boss.run('send-due-notifications', {})).toEqual({ fannedOut: 0 });
    const due = (tenant: string, at: Date) => h.pg.query(
      `insert into notification (tenant_id, workspace_id, person_id, category, mode, first_event_at, last_event_at, due_at)
       values ($1, $2, $3, 'documents', 'bundled', $4, $4, $4)`, [tenant, h.ws, h.person.jan, at.toISOString()]);
    await due(h.t1, new Date(T.at.getTime() - 60_000));
    expect(await boss.run('send-due-notifications', {})).toEqual({ fannedOut: 1 });
    expect(boss.jobs.at(-1)!.data).toEqual({ tenantId: h.t1 });
    expect(await tenantsWithDueNotifications({ ...ctx, now: () => new Date(T.at.getTime() - 120_000) })).toEqual([]);
    const direct = await h.db.transaction(async (tx) => {
      await tx.query('set local role vdrkit_app');
      return (await tx.query(`select 1 from notification`)).rows.length;
    });
    expect(direct).toBe(0);
  });
});

describe('queue role', () => {
  it('warns when pg-boss runs as the app role', () => {
    const app = 'postgres://vdrkit_app@db/vdrkit';
    expect(queueRoleWarning({ NODE_ENV: 'production', DATABASE_URL: app })).toMatch(/QUEUE_DATABASE_URL/);
    expect(queueRoleWarning({ NODE_ENV: 'production', DATABASE_URL: app, QUEUE_DATABASE_URL: app })).toMatch(/never grant CREATE/);
    expect(queueRoleWarning({ NODE_ENV: 'production', DATABASE_URL: app, QUEUE_DATABASE_URL: 'postgres://vdrkit_queue@db/vdrkit' })).toBeNull();
    expect(queueRoleWarning({ NODE_ENV: 'development', DATABASE_URL: app })).toBeNull();
  });
});

// own database
describe.skipIf(!TEST_DATABASE_URL)('pg-boss on Postgres', () => {
  it('keeps one queued job per version', async () => {
    const e = await emptyOwnerDatabase();
    const boss = new PgBoss({ connectionString: e.url.owner, schema: 'pgboss', supervise: false, schedule: false });
    try {
      await boss.start();
      const q = new PgBossQueue(boss as unknown as BossLike);
      await q.enqueue('process-version', { tenantId: tenant, versionId: version });
      await q.enqueue('process-version', { tenantId: tenant, versionId: version });
      expect(await boss.getQueueSize('process-version')).toBe(1);
      expect((await boss.getQueue('process-version'))?.deadLetter).toBe(PROCESS_VERSION_DEAD);
    } finally {
      await boss.stop({ graceful: false, wait: true });
      await e.drop();
    }
  });
});
