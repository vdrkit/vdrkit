// SPDX-License-Identifier: AGPL-3.0-only
import type { JobName, JobQueue } from './jobs.js';

// dev only. Timed-out jobs keep running

export type JobFailure = { kind: 'timeout'; ms: number } | { kind: 'error'; error: unknown };

export interface InlineQueueOptions {
  run: (name: JobName, payload: Record<string, unknown>) => Promise<unknown>;
  onFailure?: (name: JobName, payload: Record<string, unknown>, failure: JobFailure) => Promise<unknown>;
  timeoutMs?: number;
}

const envTimeout = Number(process.env.DEV_JOB_TIMEOUT_MS);
export const DEV_JOB_TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5 * 60_000;

const noop = () => {};

export class InlineQueue implements JobQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: InlineQueueOptions) {}

  async enqueue(name: JobName, payload: Record<string, unknown>): Promise<void> {
    this.chain = this.chain.then(() => this.runOne(name, payload));
  }

  idle(): Promise<void> {
    return this.chain;
  }

  private async runOne(name: JobName, payload: Record<string, unknown>): Promise<void> {
    const ms = this.opts.timeoutMs ?? DEV_JOB_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, ms);
    });
    let failure: JobFailure | null = null;
    try {
      const job = this.opts.run(name, payload);
      job.catch(noop);
      await Promise.race([job, timeout]);
      if (timedOut) failure = { kind: 'timeout', ms };
    } catch (error) {
      failure = { kind: 'error', error };
    } finally {
      clearTimeout(timer);
    }
    if (failure && this.opts.onFailure) {
      try {
        await this.opts.onFailure(name, payload, failure);
      } catch (err) {
        console.error(`inline-queue: failed to record failure for ${name}`, err);
      }
    }
  }
}
