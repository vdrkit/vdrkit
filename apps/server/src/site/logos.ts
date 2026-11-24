// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import type { Storage } from '../pipeline/pipeline.js';
import { badRequest, HttpProblem } from '../problems.js';
import { InvalidLogo, logoToPng, type LogoSource } from '../logo-png.js';

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_BOX = { width: 180, height: 40 };
export type LogoVariant = 'light' | 'dark';

export interface StoredLogo {
  key: string;
  filename: string;
  mime: 'image/png' | 'image/svg+xml';
  size: number;
  width: number | null;
  height: number | null;
  sha256: string;
}

const KIND: Record<string, LogoSource> = { 'image/png': 'png', 'image/svg+xml': 'svg' };

export async function inspectLogo(body: Buffer, contentType: string, filename: string | undefined): Promise<{ png: Buffer; meta: Omit<StoredLogo, 'key'> }> {
  if (body.length === 0) throw badRequest('The file is empty.');
  if (body.length > LOGO_MAX_BYTES) throw badRequest('A logo can be at most 512 KB.');
  const kind = KIND[contentType];
  if (!kind) {
    throw new HttpProblem({ type: 'https://vdrkit.com/problems/unsupported-media-type', title: 'Unsupported file type', status: 415,
      detail: 'Upload a PNG or SVG file.' });
  }
  let out;
  try {
    out = await logoToPng(body, kind);
  } catch (err) {
    if (err instanceof InvalidLogo) throw badRequest(kind === 'png' ? 'This file is not a PNG image. Upload a PNG or SVG file.' : 'This file is not an SVG image. Upload a PNG or SVG file.');
    throw err;
  }
  const name = (filename ?? '').replace(/[^\w .()-]/g, '').trim().slice(0, 120);
  const sha256 = createHash('sha256').update(out.png).digest('hex');
  const meta: Omit<StoredLogo, 'key'> = {
    filename: name || `logo.${kind}`, mime: 'image/png', size: out.png.length, width: out.width, height: out.height, sha256,
  };
  return { png: out.png, meta };
}

export function displaySize(l: Pick<StoredLogo, 'width' | 'height'>): { width: number; height: number } {
  if (!l.width || !l.height) return { ...LOGO_BOX };
  const scale = Math.min(1, LOGO_BOX.width / l.width, LOGO_BOX.height / l.height);
  return { width: Math.max(1, Math.round(l.width * scale)), height: Math.max(1, Math.round(l.height * scale)) };
}

export async function storeLogo(storage: Storage, prefix: string, variant: LogoVariant, png: Buffer, meta: Omit<StoredLogo, 'key'>): Promise<StoredLogo> {
  const key = `${prefix}/branding/logo-${variant}-${randomUUID()}.png`;
  await storage.put(key, png);
  return { key, ...meta };
}

// legacy SVG rows: convert, never serve raw
export async function logoBytes(storage: Storage, l: StoredLogo): Promise<Buffer | null> {
  const bytes = Buffer.from(await storage.get(l.key));
  if (l.mime === 'image/png') return bytes;
  try {
    const { png } = await logoToPng(bytes, 'svg');
    return png;
  } catch {
    return null;
  }
}

export async function removeLogo(storage: Storage, logo: StoredLogo | null | undefined): Promise<void> {
  if (logo?.key) await storage.delete?.(logo.key).catch(() => undefined);
}

export function logoView(l: StoredLogo | null | undefined, url: string) {
  if (!l) return null;
  return { filename: l.filename, mime: 'image/png', size: l.size, width: l.width, height: l.height, displaySize: displaySize(l), url: `${url}?v=${l.sha256.slice(0, 12)}` };
}
