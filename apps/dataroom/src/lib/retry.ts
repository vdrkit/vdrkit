// SPDX-License-Identifier: AGPL-3.0-only
// Waiting to come back online doesn't count as a try.

export class Transient extends Error {}

// 0 = no response
export const transientStatus = (s: number) => s === 0 || s === 408 || s === 429 || s >= 500;

export const FIRST_WAIT = 2;
export const MAX_WAIT = 30;
export const nextWait = (w: number) => Math.min(MAX_WAIT, w * 2);

export interface RetryOptions {
  retries?: number;
  // seconds left; 0 while offline; null after a successful retry
  onWait?: (secondsLeft: number | null) => void;
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  online?: () => boolean;
  whenOnline?: () => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const defaultWhenOnline = () => new Promise<void>((r) => window.addEventListener('online', () => r(), { once: true }));

export async function retrying<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? Infinity;
  const sleep = o.sleep ?? defaultSleep;
  const online = o.online ?? defaultOnline;
  const whenOnline = o.whenOnline ?? defaultWhenOnline;
  const cancelled = o.cancelled ?? (() => false);
  let wait = FIRST_WAIT;
  let tried = 0;
  let waited = false;
  for (;;) {
    if (cancelled()) throw new Error('Cancelled');
    try {
      const out = await fn();
      if (waited) o.onWait?.(null);
      return out;
    } catch (e) {
      if (!(e instanceof Transient) || cancelled()) throw e;
      if (!online()) {
        waited = true;
        o.onWait?.(0);
        await whenOnline();
        continue;
      }
      if (tried >= retries) throw e;
      tried++;
      waited = true;
      for (let s = wait; s > 0 && !cancelled(); s--) {
        o.onWait?.(s);
        await sleep(1000);
      }
      wait = nextWait(wait);
    }
  }
}
