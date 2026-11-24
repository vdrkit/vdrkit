// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ByteRange, Storage } from '../pipeline/pipeline.js';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export class LocalDiskStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  // path traversal
  private pathOf(key: string): string {
    if (!KEY.test(key) || key.split('/').some((s) => s === '.' || s === '..')) throw new Error(`Invalid storage key: ${key}`);
    const p = resolve(this.root, ...key.split('/'));
    if (!p.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return p;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const p = this.pathOf(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, p);
  }

  async putStream(key: string, body: Readable): Promise<void> {
    const p = this.pathOf(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await pipeline(body, createWriteStream(tmp, { flags: 'wx' }));
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    const p = this.pathOf(key);
    if ((await this.size(key)) === null) throw new Error(`No object at ${key}`);
    return createReadStream(p, range ? { start: range.start, end: range.end } : {});
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathOf(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No object at ${key}`);
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathOf(key))).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}
