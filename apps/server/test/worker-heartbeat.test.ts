// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { touchHeartbeat } from '../src/worker-main.js';


let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vdrkit-heartbeat-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('worker heartbeat', () => {
  it('touches the file when the queue and the database answer', async () => {
    const file = join(dir, 'beat');
    expect(await touchHeartbeat(file, async () => undefined)).toBe(true);
    expect(new Date(await readFile(file, 'utf8')).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('leaves the file alone when the queue fails', async () => {
    const file = join(dir, 'beat');
    expect(await touchHeartbeat(file, async () => { throw new Error('connection refused'); })).toBe(false);
    await expect(stat(file)).rejects.toThrow();
  });

  it('leaves the file alone when the queue does not answer in time', async () => {
    const file = join(dir, 'beat');
    expect(await touchHeartbeat(file, () => new Promise(() => undefined), 50)).toBe(false);
    await expect(stat(file)).rejects.toThrow();
  });
});
