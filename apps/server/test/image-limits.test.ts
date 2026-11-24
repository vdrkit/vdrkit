// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { readPicture, TOO_MANY_PIXELS } from '../src/pipeline/image.js';

// BMP goes through the fallback renderer; 2835 ppm is 72 dpi
function bmp(w: number, hgt: number, ppm = 2835): Buffer {
  const row = Math.ceil((w * 3) / 4) * 4;
  const b = Buffer.alloc(54 + row * hgt);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(hgt, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * hgt, 34);
  b.writeInt32LE(ppm, 38);
  b.writeInt32LE(ppm, 42);
  return b;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('image pixel limit', () => {
  it('keeps the limit when the fallback renderer reads the image', async () => {
    const decode = vi.spyOn(mupdf.Image.prototype, 'toPixmap');
    vi.spyOn(mupdf.Image.prototype, 'getWidth').mockReturnValue(20_000);
    vi.spyOn(mupdf.Image.prototype, 'getHeight').mockReturnValue(14_000);
    await expect(readPicture(bmp(6, 4), 'bmp')).rejects.toThrow(TOO_MANY_PIXELS);
    expect(decode).not.toHaveBeenCalled();
  });

  it('counts pixels, whatever resolution the file states', async () => {
    const decode = vi.spyOn(mupdf.Image.prototype, 'toPixmap');
    vi.spyOn(mupdf.Image.prototype, 'getWidth').mockReturnValue(20_000);
    vi.spyOn(mupdf.Image.prototype, 'getHeight').mockReturnValue(14_000);
    await expect(readPicture(bmp(6, 4, 23_622), 'bmp')).rejects.toThrow(TOO_MANY_PIXELS);
    expect(decode).not.toHaveBeenCalled();
  });

  it('keeps every pixel of an image that states 96 or 600 dpi', async () => {
    expect(await readPicture(bmp(600, 400, 3780), 'bmp')).toMatchObject({ kind: 'png', width: 600, height: 400 });
    expect(await readPicture(bmp(600, 400, 23_622), 'bmp')).toMatchObject({ kind: 'png', width: 600, height: 400 });
  });

  it('renders an image at the limit', async () => {
    expect(await readPicture(bmp(6, 4), 'bmp')).toMatchObject({ kind: 'png', width: 6, height: 4 });
  });
});
