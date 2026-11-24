// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { nextWait, retrying, Transient, transientStatus, type RetryOptions } from '../src/lib/retry';
import { BulkUpload } from '../src/components/import/engine';

function clock() {
  const sleeps: number[] = [];
  const waits: (number | null)[] = [];
  const o: RetryOptions = { sleep: async (ms) => { sleeps.push(ms); }, online: () => true, onWait: (s) => { waits.push(s); } };
  return { o, sleeps, waits };
}

test('Bulk import redraws progress at most every 250 ms', async () => {
  let redraws = 0;
  const up = new BulkUpload('ws', [], () => { redraws++; });
  (up as unknown as { states: { status: string; sent: number }[] }).states.push({ status: 'sending', sent: 0 });
  const progress = (up as unknown as { progress: (i: number, sent: number) => void }).progress.bind(up);
  for (let n = 1; n <= 100; n++) progress(0, n * 1024);
  expect(redraws).toBe(0);
  await new Promise((done) => setTimeout(done, 400));
  expect(redraws).toBe(1);
  expect(up.states[0]!.sent).toBe(100 * 1024);
});

test.describe('lib/retry', () => {
  test('retries network errors and 5xx, not 4xx', () => {
    for (const s of [0, 408, 429, 500, 502, 503, 504]) expect(transientStatus(s), String(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 410, 413, 415, 422]) expect(transientStatus(s), String(s)).toBe(false);
  });

  test('pauses grow from 2 s to at most 30 s', () => {
    const seq = [2];
    while (seq.length < 7) seq.push(nextWait(seq[seq.length - 1]!));
    expect(seq).toEqual([2, 4, 8, 16, 30, 30, 30]);
  });

  test('recovers from a short hiccup', async () => {
    const c = clock();
    let calls = 0;
    const out = await retrying(async () => { if (++calls < 3) throw new Transient('Storage unavailable'); return 'ok'; }, { ...c.o, retries: 3 });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(c.waits).toEqual([2, 1, 4, 3, 2, 1, null]);
    expect(c.sleeps).toEqual(Array(6).fill(1000));
  });

  test('throws the last error after the final retry', async () => {
    const c = clock();
    let calls = 0;
    await expect(retrying(async () => { calls++; throw new Transient('The file could not be sent.'); }, { ...c.o, retries: 3 }))
      .rejects.toThrow('The file could not be sent.');
    expect(calls).toBe(4);
    expect(c.sleeps.length).toBe(2 + 4 + 8);
  });

  test('does not retry a final error', async () => {
    const c = clock();
    let calls = 0;
    await expect(retrying(async () => { calls++; throw new Error('Unsupported media type'); }, { ...c.o, retries: 3 })).rejects.toThrow('Unsupported media type');
    expect(calls).toBe(1);
    expect(c.waits).toEqual([]);
  });

  test('no wait when the first try succeeds', async () => {
    const c = clock();
    expect(await retrying(async () => 7, c.o)).toBe(7);
    expect(c.waits).toEqual([]);
  });

  test('offline wait does not use up a retry', async () => {
    const waits: (number | null)[] = [];
    let online = false;
    let calls = 0;
    const out = await retrying(async () => { if (++calls <= 2) throw new Transient('x'); return 'ok'; }, {
      retries: 1,
      sleep: async () => undefined,
      online: () => online,
      whenOnline: async () => { online = true; },
      onWait: (s) => { waits.push(s); },
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([0, 2, 1, null]);
  });

  test('cancel stops retrying', async () => {
    let cancelled = false;
    let calls = 0;
    const p = retrying(async () => { calls++; throw new Transient('x'); }, {
      sleep: async () => { cancelled = true; }, online: () => true, cancelled: () => cancelled,
    });
    await expect(p).rejects.toThrow('Cancelled');
    expect(calls).toBe(1);
  });
});

test.describe('bulk upload', () => {
  test('gives up on a file after a few tries', async () => {
    test.setTimeout(15_000);
    // no API: every try fails
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof setTimeout;
    try {
      const file = new File(['%PDF-1.7'], 'Lease.pdf', { type: 'application/pdf' });
      const waits: number[] = [];
      const up: BulkUpload = new BulkUpload('ws', [{ key: 'Lease.pdf', picked: { file, path: 'Lease.pdf' }, sha256: '0'.repeat(64), serverPath: 'Lease.pdf', targetFolderId: null, row: '' }],
        () => { if (up.retryIn !== null && up.retryIn !== waits.at(-1)) waits.push(up.retryIn); });
      await up.run();
      expect(up.states[0]!.status).toBe('failed');
      expect(up.states[0]!.error).toBe('The server did not take the file after several tries. Import it again later: files already in the room are skipped.');
      expect(up.retryIn).toBeNull();
      // three retries after the first try
      expect(waits).toEqual([2, 1, 4, 3, 2, 1, 8, 7, 6, 5, 4, 3, 2, 1]);
    } finally {
      globalThis.setTimeout = realTimeout;
    }
  });
});
