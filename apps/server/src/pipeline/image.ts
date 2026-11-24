// SPDX-License-Identifier: AGPL-3.0-only
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { extensionOf, IMAGE, tooLargeToPreview, type Step } from './pipeline.js';

const PT_PER_PX = 72 / 96;
const MAX_PAGE_PT = 14_400;
const TALL_RATIO = 3;
const SLICE_RATIO = 1.5;
const MAX_PIXELS = 268_402_689;

const load = (input: Buffer) => sharp(input, { limitInputPixels: MAX_PIXELS });

export const notAnImage = (ext: string) =>
  `This file is not a real ${ext.toUpperCase()} image, or it is damaged. Open it on your computer, save it again and upload the new copy.`;

export const TOO_MANY_PIXELS = 'This image has more than 268 million pixels, too many for VDRkit to show in the viewer. Make it smaller on your computer and upload the new copy.';

class TooManyPixels extends Error {}

interface Picture { kind: 'jpg' | 'png'; bytes: Buffer; width: number; height: number }

async function readWithMupdf(body: Buffer): Promise<Picture> {
  const mupdf = await import('mupdf');
  // limit the image's own pixels: in points, a huge 600 dpi image looks small
  const image = new mupdf.Image(body);
  try {
    if (image.getWidth() * image.getHeight() > MAX_PIXELS) throw new TooManyPixels(TOO_MANY_PIXELS);
    const pix = image.toPixmap();
    try {
      // may come back in another colour space, with alpha
      const { data, info } = await load(Buffer.from(pix.asPNG())).flatten({ background: '#ffffff' }).toColourspace('srgb').png()
        .toBuffer({ resolveWithObject: true });
      return { kind: 'png', bytes: data, width: info.width, height: info.height };
    } finally {
      pix.destroy();
    }
  } finally {
    image.destroy();
  }
}

export async function readPicture(body: Buffer, ext: string): Promise<Picture> {
  try {
    const meta = await load(body).metadata();
    if (!meta.width || !meta.height) throw new Error('no size');
    const upright = !meta.orientation || meta.orientation === 1;
    if (meta.format === 'jpeg' && upright) return { kind: 'jpg', bytes: body, width: meta.width, height: meta.height };
    const { data, info } = await load(body).rotate().png().toBuffer({ resolveWithObject: true });
    return { kind: 'png', bytes: data, width: info.width, height: info.height };
  } catch {
    try {
      return await readWithMupdf(body);
    } catch (e) {
      if (e instanceof TooManyPixels) throw e;
      throw new Error(notAnImage(ext));
    }
  }
}

export async function picturePdf(p: Picture): Promise<{ pdf: Buffer; pages: number }> {
  const doc = await PDFDocument.create();
  const slices: Picture[] = [];
  if (p.height > p.width * TALL_RATIO) {
    const step = Math.max(1, Math.round(p.width * SLICE_RATIO));
    for (let top = 0; top < p.height; top += step) {
      const height = Math.min(step, p.height - top);
      const bytes = await load(p.bytes).extract({ left: 0, top, width: p.width, height }).png().toBuffer();
      slices.push({ bytes, kind: 'png', width: p.width, height });
    }
  } else {
    slices.push(p);
  }
  for (const s of slices) {
    // copy: pdf-lib ignores byteOffset ("SOI not found in JPEG")
    const own = new Uint8Array(s.bytes);
    let image;
    try {
      image = s.kind === 'jpg' ? await doc.embedJpg(own) : await doc.embedPng(own);
    } catch {
      const png = await load(s.bytes).png().toBuffer();
      image = await doc.embedPng(new Uint8Array(png));
    }
    let scale = PT_PER_PX;
    const longest = Math.max(s.width, s.height) * scale;
    if (longest > MAX_PAGE_PT) scale *= MAX_PAGE_PT / longest;
    const w = s.width * scale;
    const h = s.height * scale;
    const page = doc.addPage([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  }
  return { pdf: Buffer.from(await doc.save()), pages: slices.length };
}

export const imageStep: Step = {
  name: 'image',
  appliesTo: (o) => IMAGE.has(extensionOf(o.filename)),
  async run(ctx) {
    if (await tooLargeToPreview(ctx)) return;
    const ext = extensionOf(ctx.original.filename);
    ctx.facts.viewer = 'image';
    const picture = await readPicture(await ctx.readOriginal(), ext);
    const { pdf, pages } = await picturePdf(picture);
    await ctx.store('pdf', 'image', pdf, { fromImage: true, width: picture.width, height: picture.height, pages });
  },
};
