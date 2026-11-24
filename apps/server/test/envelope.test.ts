// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { decryptBuffer, decryptRangeStream, encryptBuffer, HEADER_BYTES, headerOf, LocalKeyProvider, newDataKey, sealedRange } from '../src/crypto/envelope.js';

const master = randomBytes(32).toString('base64');
const heron = 'f3a2c1d0-0000-4000-8000-000000000001';
const other = 'f3a2c1d0-0000-4000-8000-000000000002';
const CHUNK = 4096;
const H = HEADER_BYTES;
// storage key
const AT = 'ws/f3a2c1d0-0000-4000-8000-000000000001/v/9d2f6c1e-0000-4000-8000-000000000001/original';

describe('wrapped workspace keys', () => {
  it('wraps and unwraps a data key for its own workspace', async () => {
    const kp = new LocalKeyProvider(master);
    const key = newDataKey();
    const w = await kp.wrap(key, heron);
    expect(Buffer.from(w.blob, 'base64').includes(key)).toBe(false);
    expect((await kp.unwrap(w, heron)).equals(key)).toBe(true);
  });

  it('refuses to unwrap a key presented for another workspace', async () => {
    const kp = new LocalKeyProvider(master);
    const w = await kp.wrap(newDataKey(), heron);
    await expect(kp.unwrap(w, other)).rejects.toThrow();
  });

  it('refuses to unwrap with a different master key', async () => {
    const w = await new LocalKeyProvider(master).wrap(newDataKey(), heron);
    await expect(new LocalKeyProvider(randomBytes(32).toString('base64')).unwrap(w, heron)).rejects.toThrow();
  });

  it('explains how to make a valid master key', () => {
    expect(() => new LocalKeyProvider('too-short')).toThrow(/openssl rand -base64 32/);
  });
});

describe('file encryption', () => {
  const key = newDataKey();

  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 5 * CHUNK, 5 * CHUNK + 17])('round-trips a file of %i bytes', async (n) => {
    const plain = randomBytes(n);
    const sealed = await encryptBuffer(key, plain, AT, CHUNK);
    expect(sealed.subarray(0, 5).toString()).toBe('VDRK1');
    expect((await decryptBuffer(key, sealed, AT)).equals(plain)).toBe(true);
  });

  it('round-trips a 5 MB file with the default chunk size', async () => {
    const plain = randomBytes(5 * 1024 * 1024);
    expect((await decryptBuffer(key, await encryptBuffer(key, plain, AT), AT)).equals(plain)).toBe(true);
  });

  it('never produces the same ciphertext twice for the same file', async () => {
    const plain = Buffer.from('Audited financial statements FY2025');
    expect((await encryptBuffer(key, plain, AT)).equals(await encryptBuffer(key, plain, AT))).toBe(false);
  });

  it('detects a changed byte', async () => {
    const sealed = await encryptBuffer(key, randomBytes(3 * CHUNK), AT, CHUNK);
    sealed[H + CHUNK + 100] ^= 0x01;
    await expect(decryptBuffer(key, sealed, AT)).rejects.toThrow();
  });

  it('detects a file cut short at a chunk boundary', async () => {
    const sealed = await encryptBuffer(key, randomBytes(3 * CHUNK + 10), AT, CHUNK);
    const cut = sealed.subarray(0, H + 2 * (CHUNK + 16));
    await expect(decryptBuffer(key, cut, AT)).rejects.toThrow();
  });

  it('detects swapped chunks', async () => {
    const sealed = await encryptBuffer(key, randomBytes(3 * CHUNK + 10), AT, CHUNK);
    const s = CHUNK + 16;
    const a = sealed.subarray(H, H + s);
    const b = sealed.subarray(H + s, H + 2 * s);
    const swapped = Buffer.concat([sealed.subarray(0, H), b, a, sealed.subarray(H + 2 * s)]);
    await expect(decryptBuffer(key, swapped, AT)).rejects.toThrow();
  });

  it('fails with another workspace key', async () => {
    const sealed = await encryptBuffer(key, randomBytes(1000), AT);
    await expect(decryptBuffer(newDataKey(), sealed, AT)).rejects.toThrow();
  });

  it('gives every file its own salt', async () => {
    const plain = Buffer.from('Share purchase agreement, execution version');
    const a = await encryptBuffer(key, plain, AT);
    const b = await encryptBuffer(key, plain, AT);
    expect(a[5]).toBe(3);
    expect(a.subarray(10, H).equals(b.subarray(10, H))).toBe(false);
    expect(a.subarray(H).equals(b.subarray(H))).toBe(false);
  });

  it('detects a changed salt or version', async () => {
    const sealed = await encryptBuffer(key, randomBytes(1000), AT);
    const salt = Buffer.from(sealed);
    salt[20]! ^= 0x01;
    await expect(decryptBuffer(key, salt, AT)).rejects.toThrow();
    const version = Buffer.from(sealed);
    version[5] = 1;
    await expect(decryptBuffer(key, version, AT)).rejects.toThrow();
  });

  it('rejects files that are not VDRkit encrypted', async () => {
    await expect(decryptBuffer(key, Buffer.from('%PDF-1.7 plain file, never encrypted......'), AT)).rejects.toThrow(/Not a VDRkit encrypted file/);
  });
});

describe('files in the first format', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const plain = Buffer.from('Audited financial statements FY2025, signed 14 March 2026.');
  const sealed = Buffer.from('VkRSSzEBAAAAEFc76376jC4a8bWg5ZLkseHrkQn14GicISObNjT8egaiK2JmOFyVVhJgo+T523tn9rnfu9NaFVN99Vsj0w21/zJDySExrgUBnn3E/5FNSpVmVv1dDyVQy6pxpqb2bzL9GSMvGIBUZy2Ds7Olr3PVeQ9qpQOc8K09d1jet5B6gXo2', 'base64');
  const empty = Buffer.from('VkRSSzEBAAEAAE9GW7UZzEe2hoGYvHPmvKfdQUUPuPk=', 'base64');

  it('still decrypt', async () => {
    expect(sealed[5]).toBe(1);
    expect((await decryptBuffer(key, sealed, AT)).equals(plain)).toBe(true);
    expect((await decryptBuffer(key, empty, 'anywhere')).length).toBe(0);
  });

  it('still serve byte ranges', async () => {
    const header = headerOf(sealed.subarray(0, HEADER_BYTES));
    expect(header.length).toBe(16);
    const at = sealedRange(header, plain.length, 20, 41);
    const d = decryptRangeStream(key, header, AT, plain.length, at.firstChunk, at.skip, 22);
    const out: Buffer[] = [];
    for await (const c of Readable.from([sealed.subarray(at.sealedStart, at.sealedEnd + 1)]).pipe(d)) out.push(c as Buffer);
    expect(Buffer.concat(out).toString()).toBe(plain.subarray(20, 42).toString());
  });

  it('still detect a changed byte', async () => {
    const changed = Buffer.from(sealed);
    changed[30]! ^= 0x01;
    await expect(decryptBuffer(key, changed, AT)).rejects.toThrow();
  });
});

describe('files in the second format', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const plain = Buffer.from('Audited financial statements FY2025, signed 14 March 2026.');
  const sealed = Buffer.from('VkRSSzECAAAAENf+xLUVP7PRJeBHyzjivtFoZ8w/TrycEf62o+1tkAOOLDbWOOaoQt3VB70CD/R0nRm7tHmjtHxfA/6drAegrnVefNRw3UNRtqCx2xl7F82wpYQ1DsmbzrYhrGlc8hw5ttBeQBORclyPgHOyE1Ve4VcZfinJXgKEncPhSzUwDA30mm6GPPAFSDjoX1t6J1JJLw==', 'base64');
  const empty = Buffer.from('VkRSSzECAAEAACcF29Zg8sDZjyjI2csLsXDIb5iSCTAMe9pRrUESl5j9IavXlk6q', 'base64');

  it('still decrypt from any place', async () => {
    expect(sealed[5]).toBe(2);
    expect((await decryptBuffer(key, sealed, AT)).equals(plain)).toBe(true);
    expect((await decryptBuffer(key, sealed, 'somewhere/else')).equals(plain)).toBe(true);
    expect((await decryptBuffer(key, empty, AT)).length).toBe(0);
  });

  it('still serve byte ranges', async () => {
    const header = headerOf(sealed.subarray(0, HEADER_BYTES));
    expect(header.length).toBe(32);
    const at = sealedRange(header, plain.length, 20, 41);
    const d = decryptRangeStream(key, header, AT, plain.length, at.firstChunk, at.skip, 22);
    const out: Buffer[] = [];
    for await (const c of Readable.from([sealed.subarray(at.sealedStart, at.sealedEnd + 1)]).pipe(d)) out.push(c as Buffer);
    expect(Buffer.concat(out).toString()).toBe(plain.subarray(20, 42).toString());
  });
});

describe('a file and its place', () => {
  const key = newDataKey();
  const OTHER = 'ws/f3a2c1d0-0000-4000-8000-000000000001/v/9d2f6c1e-0000-4000-8000-000000000002/original';

  it('writes the third format', async () => {
    const sealed = await encryptBuffer(key, randomBytes(100), AT);
    expect(sealed[5]).toBe(3);
    expect(headerOf(sealed).length).toBe(32);
  });

  // swapped in the bucket
  it('does not open a file moved to the place of another', async () => {
    const plain = randomBytes(3 * CHUNK + 5);
    const sealed = await encryptBuffer(key, plain, AT, CHUNK);
    expect((await decryptBuffer(key, sealed, AT)).equals(plain)).toBe(true);
    await expect(decryptBuffer(key, sealed, OTHER)).rejects.toThrow();
    await expect(decryptBuffer(key, sealed, AT.replace('/original', '/rasterise/page_image-1.webp'))).rejects.toThrow();
  });

  it('does not serve a byte range of a moved file either', async () => {
    const plain = randomBytes(3 * CHUNK);
    const sealed = await encryptBuffer(key, plain, AT, CHUNK);
    const header = headerOf(sealed);
    const at = sealedRange(header, plain.length, CHUNK + 10, CHUNK + 20);
    const read = async (place: string) => {
      const out: Buffer[] = [];
      for await (const c of Readable.from([sealed.subarray(at.sealedStart, at.sealedEnd + 1)])
        .pipe(decryptRangeStream(key, header, place, plain.length, at.firstChunk, at.skip, 11))) out.push(c as Buffer);
      return Buffer.concat(out);
    };
    expect((await read(AT)).equals(plain.subarray(CHUNK + 10, CHUNK + 21))).toBe(true);
    await expect(read(OTHER)).rejects.toThrow();
  });

  it('cannot pass as the second format', async () => {
    const sealed = await encryptBuffer(key, randomBytes(1000), AT);
    const downgraded = Buffer.from(sealed);
    downgraded[5] = 2;
    await expect(decryptBuffer(key, downgraded, AT)).rejects.toThrow();
  });

  it('refuses to write a file without a place', async () => {
    expect(() => encryptBuffer(key, randomBytes(10), '')).toThrow('needs the place');
  });
});
