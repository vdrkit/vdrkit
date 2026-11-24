// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export interface WrappedKey {
  provider: string;
  keyVersion: number;
  blob: string;
}

export interface KeyProvider {
  readonly name: string;
  // context (workspace id) goes into the AAD
  wrap(dataKey: Buffer, context: string): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, context: string): Promise<Buffer>;
}

export class LocalKeyProvider implements KeyProvider {
  readonly name = 'local';
  private readonly key: Buffer;

  constructor(masterKeyBase64: string, private readonly keyVersion = 1) {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) throw new Error('VDRKIT_MASTER_KEY must be 32 bytes, base64 encoded. Generate it with: openssl rand -base64 32');
    this.key = key;
  }

  async wrap(dataKey: Buffer, context: string): Promise<WrappedKey> {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, nonce);
    c.setAAD(Buffer.from(`vdrkit:wrap:v1:${context}`));
    const ct = Buffer.concat([c.update(dataKey), c.final()]);
    const blob = Buffer.concat([nonce, c.getAuthTag(), ct]).toString('base64');
    return { provider: this.name, keyVersion: this.keyVersion, blob };
  }

  async unwrap(w: WrappedKey, context: string): Promise<Buffer> {
    if (w.provider !== this.name) throw new Error(`Key was wrapped by ${w.provider}, not ${this.name}`);
    const raw = Buffer.from(w.blob, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(`vdrkit:wrap:v1:${context}`));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  }
}

export function newDataKey(): Buffer {
  return randomBytes(32);
}

// v1 header: "VDRK1" | 1 | chunk size u32be (4) | nonce prefix (6). Key: the room key. Nonce: prefix | chunk index
// v2 header: "VDRK1" | 2 | chunk size u32be (4) | salt (22). Key: HKDF(room key, salt). Nonce: chunk index
// v2: per-file key, so nonces never repeat within a room
// chunk: ciphertext | tag (16). AAD = header + chunk index + last flag (catches reorder/truncation)
const MAGIC = Buffer.from('VDRK1');
const V1_HEADER = 16;
const V2_HEADER = 32;
// same layout as version 2; the key also depends on where the file is stored
const V3_HEADER = 32;
const TAG_LEN = 16;
export const DEFAULT_CHUNK = 64 * 1024;

// enough leading bytes for either header; no encrypted file is shorter
export const HEADER_BYTES = V3_HEADER;

const notOurs = () => new Error('Not a VDRkit encrypted file');

// null: too few bytes to tell yet
function headerLength(start: Buffer): number | null {
  if (start.length < 6) return null;
  if (!timingSafeEqual(start.subarray(0, 5), MAGIC)) throw notOurs();
  if (start[5] === 1) return V1_HEADER;
  if (start[5] === 2) return V2_HEADER;
  if (start[5] === 3) return V3_HEADER;
  throw notOurs();
}

export function headerOf(start: Buffer): Buffer {
  const len = headerLength(start);
  if (len === null || start.length < len) throw notOurs();
  return start.subarray(0, len);
}

interface FileCipher { key: Buffer; prefix: Buffer }

// place: the storage key. v3 binds it into the file key, so a file swapped into another's place won't open
function fileCipher(dataKey: Buffer, header: Buffer, place: string): FileCipher {
  if (header[5] === 1) return { key: dataKey, prefix: header.subarray(10, 16) };
  const info = header[5] === 2 ? 'vdrkit:file:v2' : Buffer.concat([Buffer.from('vdrkit:file:v3\0'), Buffer.from(place, 'utf8')]);
  return { key: Buffer.from(hkdfSync('sha256', dataKey, header.subarray(10), info, 32)), prefix: Buffer.alloc(6) };
}

function nonceFor(prefix: Buffer, index: number): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUIntBE(index, 6, 6);
  return n;
}

function aadFor(header: Buffer, index: number, last: boolean): Buffer {
  const a = Buffer.alloc(header.length + 7);
  header.copy(a, 0);
  a.writeUIntBE(index, header.length, 6);
  a[header.length + 6] = last ? 1 : 0;
  return a;
}

function sealChunk(f: FileCipher, header: Buffer, index: number, plain: Buffer, last: boolean): Buffer {
  const c = createCipheriv('aes-256-gcm', f.key, nonceFor(f.prefix, index));
  c.setAAD(aadFor(header, index, last));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function openChunk(f: FileCipher, header: Buffer, index: number, sealed: Buffer, last: boolean): Buffer {
  const d = createDecipheriv('aes-256-gcm', f.key, nonceFor(f.prefix, index));
  d.setAAD(aadFor(header, index, last));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final()]);
}

export function encryptStream(dataKey: Buffer, place: string, chunkSize = DEFAULT_CHUNK): Transform {
  if (dataKey.length !== 32) throw new Error('Data key must be 32 bytes');
  if (!place) throw new Error('An encrypted file needs the place it is stored at');
  const header = Buffer.alloc(V3_HEADER);
  MAGIC.copy(header, 0);
  header[5] = 3;
  header.writeUInt32BE(chunkSize, 6);
  randomBytes(V3_HEADER - 10).copy(header, 10);
  const f = fileCipher(dataKey, header, place);
  let buf = Buffer.alloc(0);
  let index = 0;
  let started = false;
  return new Transform({
    transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      if (!started) {
        this.push(header);
        started = true;
      }
      buf = Buffer.concat([buf, data]);
      while (buf.length > chunkSize) {
        this.push(sealChunk(f, header, index++, buf.subarray(0, chunkSize), false));
        buf = buf.subarray(chunkSize);
      }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!started) this.push(header);
      this.push(sealChunk(f, header, index, buf, true));
      cb();
    },
  });
}

export function decryptStream(dataKey: Buffer, place: string): Transform {
  let header: Buffer | null = null;
  let f: FileCipher | null = null;
  let sealedLen = 0;
  let buf = Buffer.alloc(0);
  let index = 0;
  return new Transform({
    transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        buf = Buffer.concat([buf, data]);
        if (!header || !f) {
          const len = headerLength(buf);
          if (len === null || buf.length < len) return cb();
          header = buf.subarray(0, len);
          f = fileCipher(dataKey, header, place);
          sealedLen = header.readUInt32BE(6) + TAG_LEN;
          buf = buf.subarray(len);
        }
        while (buf.length > sealedLen) {
          this.push(openChunk(f, header, index++, buf.subarray(0, sealedLen), false));
          buf = buf.subarray(sealedLen);
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!header || !f || buf.length < TAG_LEN) throw new Error('Encrypted file is incomplete');
        this.push(openChunk(f, header, index, buf, true));
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

async function run(t: Transform, input: Buffer, pieceSize = 50_000): Promise<Buffer> {
  const out: Buffer[] = [];
  return new Promise((resolve, reject) => {
    t.on('data', (d: Buffer) => out.push(d));
    t.on('end', () => resolve(Buffer.concat(out)));
    t.on('error', reject);
    for (let i = 0; i < input.length; i += pieceSize) t.write(input.subarray(i, i + pieceSize));
    t.end();
  });
}

export const encryptBuffer = (key: Buffer, plain: Buffer, place: string, chunkSize = DEFAULT_CHUNK) => run(encryptStream(key, place, chunkSize), plain);
export const decryptBuffer = (key: Buffer, sealed: Buffer, place: string) => run(decryptStream(key, place), sealed);

export const chunkSizeOf = (header: Buffer) => headerOf(header).readUInt32BE(6);

export const chunkCount = (plainSize: number, chunkSize: number) => Math.max(1, Math.ceil(plainSize / chunkSize));

const sealedSize = (headerLen: number, plainSize: number, chunkSize: number) => headerLen + plainSize + chunkCount(plainSize, chunkSize) * TAG_LEN;

// of a file written now
export const sealedSizeOf = (plainSize: number, chunkSize = DEFAULT_CHUNK) => sealedSize(V3_HEADER, plainSize, chunkSize);

export function sealedRange(lead: Buffer, plainSize: number, start: number, end: number) {
  const header = headerOf(lead);
  const chunkSize = header.readUInt32BE(6);
  const first = Math.floor(start / chunkSize);
  const last = Math.floor(end / chunkSize);
  const sealedChunk = chunkSize + TAG_LEN;
  const lastSealedByte = header.length + (last + 1) * sealedChunk;
  const sealedEnd = Math.min(lastSealedByte, sealedSize(header.length, plainSize, chunkSize)) - 1;
  return {
    sealedStart: header.length + first * sealedChunk,
    sealedEnd,
    firstChunk: first,
    skip: start - first * chunkSize,
  };
}

export function decryptRangeStream(dataKey: Buffer, lead: Buffer, place: string, plainSize: number, firstChunk: number, skip: number,
  length: number): Transform {
  const header = headerOf(lead);
  const chunkSize = header.readUInt32BE(6);
  const f = fileCipher(dataKey, header, place);
  const sealedLen = chunkSize + TAG_LEN;
  const total = chunkCount(plainSize, chunkSize);
  let index = firstChunk;
  let buf = Buffer.alloc(0);
  let toSkip = skip;
  let left = length;
  const emit = (t: Transform, plain: Buffer) => {
    let p = plain;
    if (toSkip > 0) {
      const n = Math.min(toSkip, p.length);
      p = p.subarray(n);
      toSkip -= n;
    }
    if (left <= 0 || p.length === 0) return;
    if (p.length > left) p = p.subarray(0, left);
    left -= p.length;
    t.push(p);
  };
  return new Transform({
    transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, data]) : data;
        // last chunk: may be short, opened in flush
        while (buf.length >= sealedLen && index < total - 1) {
          emit(this, openChunk(f, header, index, buf.subarray(0, sealedLen), false));
          index++;
          buf = buf.subarray(sealedLen);
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (buf.length > 0) {
          if (index !== total - 1 || buf.length < TAG_LEN) throw new Error('Encrypted file is incomplete');
          emit(this, openChunk(f, header, index, buf, true));
        }
        if (left > 0) throw new Error('Encrypted file is incomplete');
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}
