// SPDX-License-Identifier: AGPL-3.0-only
import * as mupdf from 'mupdf';
import sharp from 'sharp';
import type { Step } from './pipeline.js';

export const PAGE_WIDTH = 1600;
export const THUMB_WIDTH = 320;
// WebP holds 16,383 pixels a side at most
export const MAX_PAGE_HEIGHT = 16_000;

export type PageImageType = 'image/webp' | 'image/png';
export const PAGE_IMAGE_TYPE: PageImageType = 'image/webp';

export function pageImageType(storageKey: string, contentType?: string | null): PageImageType {
  if (contentType === 'image/webp' || storageKey.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

interface Raw { pixels: Buffer; width: number; height: number }

function renderPage(doc: mupdf.Document, index: number, width: number): Raw {
  const page = doc.loadPage(index);
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    const pageWidth = x1 - x0;
    if (!(pageWidth > 0)) throw new Error(`Page ${index + 1} has no width.`);
    // very tall pages are scaled down to fit
    const scale = Math.min(width / pageWidth, MAX_PAGE_HEIGHT / Math.max(1, y1 - y0));
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const w = pix.getWidth();
      const h = pix.getHeight();
      if (pix.getNumberOfComponents() !== 3 || pix.getStride() !== w * 3) throw new Error(`Page ${index + 1} could not be rendered.`);
      return { pixels: Buffer.from(pix.getPixels()), width: w, height: h };
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}

const rawInput = (r: Raw) => sharp(r.pixels, { raw: { width: r.width, height: r.height, channels: 3 } });

const LOSSLESS = { lossless: true, effort: 2 } as const;
const LOSSY = { quality: 90, effort: 2 } as const;
const FLAT_ENTROPY = 2;
const LOSSLESS_KEEP_BYTES = 200 * 1024;

async function encodePage(r: Raw, flat: boolean): Promise<Buffer> {
  if (!flat) return rawInput(r).webp(LOSSY).toBuffer();
  const lossless = await rawInput(r).webp(LOSSLESS).toBuffer();
  if (lossless.length <= LOSSLESS_KEEP_BYTES) return lossless;
  const lossy = await rawInput(r).webp(LOSSY).toBuffer();
  return lossless.length <= lossy.length ? lossless : lossy;
}

// white on both sides, up to the width the viewer expects
async function centred(r: Raw, width: number): Promise<Raw> {
  const left = Math.floor((width - r.width) / 2);
  const { data, info } = await rawInput(r).extend({ left, right: width - r.width - left, background: { r: 255, g: 255, b: 255 } })
    .raw().toBuffer({ resolveWithObject: true });
  return { pixels: data, width: info.width, height: info.height };
}

async function resized(r: Raw, width: number): Promise<Raw> {
  const { data, info } = await rawInput(r).resize({ width }).raw().toBuffer({ resolveWithObject: true });
  return { pixels: data, width: info.width, height: info.height };
}

export const rasteriseStep: Step = {
  name: 'rasterise',
  appliesTo: () => true,
  async run(ctx) {
    const pdf = await ctx.readDerived('pdf');
    if (!pdf) return;
    let doc: mupdf.Document;
    try {
      doc = mupdf.Document.openDocument(pdf, 'application/pdf');
    } catch {
      throw new Error('The PDF could not be opened for viewing. It may be damaged.');
    }
    try {
      if (doc.needsPassword()) throw new Error('The PDF is password protected, so VDRkit cannot show it in the viewer.');
      const pageCount = doc.countPages();
      for (let i = 0; i < pageCount; i++) {
        ctx.checkpoint();
        let raw = renderPage(doc, i, PAGE_WIDTH);
        // renderer can be a pixel off; the viewer needs the exact width
        if (raw.width < PAGE_WIDTH - 2) raw = await centred(raw, PAGE_WIDTH);
        else if (raw.width !== PAGE_WIDTH) raw = await resized(raw, PAGE_WIDTH);
        const flat = (await rawInput(raw).stats()).entropy < FLAT_ENTROPY;
        const meta = { page: i + 1, contentType: PAGE_IMAGE_TYPE };
        const page = await encodePage(raw, flat);
        await ctx.store('page_image', 'rasterise', page, { ...meta, width: PAGE_WIDTH });
        const thumb = await encodePage(await resized(raw, THUMB_WIDTH), flat);
        await ctx.store('thumbnail', 'rasterise', thumb, { ...meta, width: THUMB_WIDTH });
      }
      ctx.facts.pageCount = pageCount;
    } finally {
      doc.destroy();
    }
  },
};
