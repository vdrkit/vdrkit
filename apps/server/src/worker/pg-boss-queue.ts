// SPDX-License-Identifier: AGPL-3.0-only
import type { JobName, JobQueue } from './jobs.js';

export interface BossLike {
  start(): Promise<unknown>;
  stop(opts?: { graceful?: boolean; timeout?: number }): Promise<void>;
  createQueue(name: string, options?: QueueOptions): Promise<void>;
  getQueue(name: string): Promise<unknown | null>;
  send(name: string, data: object, options: SendOptions): Promise<string | null>;
  work<T>(name: string, options: { batchSize?: number; pollingIntervalSeconds?: number }, handler: (jobs: BossJob<T>[]) => Promise<unknown>): Promise<string>;
  schedule(name: string, cron: string, data?: object, options?: SendOptions & { tz?: string }): Promise<void>;
  on(event: 'error', handler: (err: Error) => void): unknown;
}

export interface BossJob<T> { id: string; name: string; data: T }

export interface QueueOptions {
  name?: string;
  policy?: 'standard' | 'short' | 'singleton' | 'stately';
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
  retentionDays?: number;
  deadLetter?: string;
}

export interface SendOptions {
  singletonKey?: string;
  startAfter?: Date;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
  deadLetter?: string;
}

// pg-boss owns its schema; as vdrkit_app it could plant functions
export function queueRoleWarning(env: Record<string, string | undefined>): string | null {
  if (['test', 'development'].includes(env.NODE_ENV ?? '')) return null;
  if (env.QUEUE_DATABASE_URL && env.QUEUE_DATABASE_URL !== env.DATABASE_URL) return null;
  return 'WARNING: pg-boss shares the vdrkit_app role (QUEUE_DATABASE_URL unset or same as DATABASE_URL). '
    + 'Give it its own role via QUEUE_DATABASE_URL; never grant CREATE to vdrkit_app.';
}

export const PROCESS_VERSION_DEAD = 'process-version-dead';

export const QUEUES: Record<JobName | typeof PROCESS_VERSION_DEAD, QueueOptions> = {
  'process-version': {
    // just above PROCESS_MAX_MS, so the queue never starts a second run beside a live one
    policy: 'stately', retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 2 * 60 * 60 + 10 * 60, retentionDays: 7,
    deadLetter: PROCESS_VERSION_DEAD,
  },
  'process-version-dead': { policy: 'standard', retryLimit: 10, retryDelay: 60, retryBackoff: true, retentionDays: 30 },
  'send-due-notifications': { policy: 'stately', retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 5 * 60, retentionDays: 1 },
  'send-deadline-reminders': { policy: 'stately', retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 5 * 60, retentionDays: 1 },
  'site-health': { policy: 'singleton', retryLimit: 0, expireInSeconds: 2 * 60, retentionDays: 1 },
  'purge-failed-sign-ins': { policy: 'singleton', retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * 60, retentionDays: 7 },
  'sweep-expired-uploads': { policy: 'singleton', retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 30 * 60, retentionDays: 7 },
  'sweep-stuck-processing': { policy: 'singleton', retryLimit: 0, expireInSeconds: 5 * 60, retentionDays: 1 },
  'send-waiting-invitations': { policy: 'standard', retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 10 * 60, retentionDays: 7 },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const isNotifyJob = (name: JobName) => name === 'send-due-notifications' || name === 'send-deadline-reminders';

// DLQ first
const QUEUE_ORDER = [
  PROCESS_VERSION_DEAD, 'process-version', 'send-due-notifications', 'send-deadline-reminders', 'site-health',
  'purge-failed-sign-ins', 'sweep-expired-uploads', 'sweep-stuck-processing', 'send-waiting-invitations',
] as const;

export function singletonKeyFor(name: JobName, payload: Record<string, unknown>): string | undefined {
  if (name === 'process-version') return `version:${String(payload.versionId)}`;
  if (isNotifyJob(name) && payload.tenantId) return `tenant:${String(payload.tenantId)}`;
  return undefined;
}

export function assertPayload(name: JobName, payload: Record<string, unknown>): void {
  const t = payload.tenantId;
  if (name === 'process-version') {
    if (!isUuid(t)) throw new Error('process-version: bad tenant id');
    if (!isUuid(payload.versionId)) throw new Error('process-version: bad version id');
    if (payload.waits !== undefined && !Number.isInteger(payload.waits)) throw new Error('process-version: bad wait count');
  }
  if (isNotifyJob(name) && t !== undefined && !isUuid(t)) throw new Error(`${name}: bad tenant id`);
  if (name === 'send-waiting-invitations') {
    if (!isUuid(t)) throw new Error('send-waiting-invitations: bad tenant id');
    if (!isUuid(payload.workspaceId)) throw new Error('send-waiting-invitations: bad room id');
  }
}

export class PgBossQueue implements JobQueue {
  private ready: Promise<void> | null = null;

  constructor(private readonly boss: BossLike) {}

  // pg-boss 10: queues must exist before send
  setup(): Promise<void> {
    this.ready ??= this.createQueues();
    return this.ready;
  }

  private async createQueues(): Promise<void> {
    for (const name of QUEUE_ORDER) {
      if (!(await this.boss.getQueue(name))) await this.boss.createQueue(name, { name, ...QUEUES[name] });
    }
  }

  async enqueue(name: JobName, payload: Record<string, unknown>, opts: { startAfter?: Date; singletonKey?: string } = {}): Promise<void> {
    assertPayload(name, payload);
    await this.setup();
    const q = QUEUES[name];
    const options: SendOptions = {
      retryLimit: q.retryLimit, retryDelay: q.retryDelay, retryBackoff: q.retryBackoff, expireInSeconds: q.expireInSeconds,
    };
    if (q.deadLetter) options.deadLetter = q.deadLetter;
    const key = opts.singletonKey ?? singletonKeyFor(name, payload);
    if (key) options.singletonKey = key;
    if (opts.startAfter) options.startAfter = opts.startAfter;
    await this.boss.send(name, payload, options);
  }
}
