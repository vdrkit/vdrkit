// SPDX-License-Identifier: AGPL-3.0-only
import sharp, { type Metadata, type Sharp } from 'sharp';

// always re-encoded to PNG; librsvg without a base file fetches no external URLs

export const LOGO_PNG_BOX = { width: 720, height: 160 } as const;
export type LogoSource = 'png' | 'jpeg' | 'webp' | 'svg';

export class InvalidLogo extends Error {}

const RENDER_TIMEOUT_SECONDS = 10;
const MAX_DENSITY = 72 * 400;
// a small file can declare a huge image; each decoded pixel costs four bytes
const LOGO_MAX_PIXELS = 4096 * 4096;

export interface LogoPng { png: Buffer; width: number; height: number }

export async function logoToPng(bytes: Buffer, kind: LogoSource): Promise<LogoPng> {
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { failOn: 'error' }).metadata();
  } catch {
    throw new InvalidLogo('unreadable');
  }
  if (meta.format !== kind || !meta.width || !meta.height) throw new InvalidLogo('wrong format');
  if (kind !== 'svg' && meta.width * meta.height > LOGO_MAX_PIXELS) throw new InvalidLogo('too large');

  let img: Sharp;
  if (kind === 'svg') {
    const scale = Math.min(LOGO_PNG_BOX.width / meta.width, LOGO_PNG_BOX.height / meta.height);
    const density = Math.min(MAX_DENSITY, Math.max(1, 72 * scale));
    img = sharp(bytes, { density, failOn: 'error', limitInputPixels: LOGO_MAX_PIXELS })
      .resize(LOGO_PNG_BOX.width, LOGO_PNG_BOX.height, { fit: 'inside' });
  } else {
    img = sharp(bytes, { failOn: 'error', limitInputPixels: LOGO_MAX_PIXELS })
      .rotate() // EXIF orientation, before metadata is dropped
      .resize(LOGO_PNG_BOX.width, LOGO_PNG_BOX.height, { fit: 'inside', withoutEnlargement: true });
  }
  try {
    // no withMetadata(): EXIF, XMP and ICC must be dropped
    const { data, info } = await img.ensureAlpha().png({ compressionLevel: 9 }).timeout({ seconds: RENDER_TIMEOUT_SECONDS })
      .toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  } catch {
    throw new InvalidLogo('render failed');
  }
}
