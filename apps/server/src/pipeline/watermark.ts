// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { formatWhen } from '@vdrkit/core';

export interface WatermarkFields {
  name: boolean;
  email: boolean;
  group: boolean;
  dateTime: boolean;
  ip: boolean;
}

export const DEFAULT_FIELDS: WatermarkFields = { name: true, email: true, group: true, dateTime: true, ip: false };

export interface Viewer {
  name: string;
  email: string;
  groupName: string;
  ip?: string | null;
  timeZone: string;
}

export function watermarkLines(fields: WatermarkFields, v: Viewer, at: Date): string[] {
  const first: string[] = [];
  if (fields.name && v.name) first.push(v.name);
  if (fields.email && v.email) first.push(v.email);
  const second: string[] = [];
  if (fields.group && v.groupName) second.push(v.groupName);
  if (fields.dateTime) {
    const when = formatWhen(at, v.timeZone, at);
    if (when) second.push(when);
  }
  if (fields.ip && v.ip) second.push(v.ip);
  return [first.join(' · '), second.join(' · ')].filter((l) => l.length > 0);
}

// the stamped text is erasable PII; the chain keeps only this digest
export function watermarkDigest(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface WatermarkStyle {
  opacity: number;
  angleDeg: number;
  color: string;
  sizeRatio: number;
}

export const DEFAULT_STYLE: WatermarkStyle = { opacity: 0.16, angleDeg: -30, color: '#1A2531', sizeRatio: 0.022 };

export function watermarkSvg(width: number, height: number, lines: string[], style: WatermarkStyle = DEFAULT_STYLE): string {
  const size = Math.max(12, Math.round(width * style.sizeRatio));
  const lineGap = Math.round(size * 1.35);
  const block = lines.length * lineGap;
  const stepY = block + size * 4;
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const stepX = Math.round(longest * size * 0.62 + size * 3);
  const diag = Math.ceil(Math.hypot(width, height));
  const angle = (style.angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const left = -size;
  const right = longest * size + size;
  const top = -size * 1.5;
  const bottom = (lines.length - 1) * lineGap + size;
  const onPage = (x: number, y: number) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [gx, gy] of [[x + left, y + top], [x + right, y + top], [x + left, y + bottom], [x + right, y + bottom]] as const) {
      const sx = width / 2 + gx * cos - gy * sin;
      const sy = height / 2 + gx * sin + gy * cos;
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
    return maxX >= 0 && minX <= width && maxY >= 0 && minY <= height;
  };
  const rows: string[] = [];
  let r = 0;
  for (let y = -diag; y < diag; y += stepY, r++) {
    const offset = (r % 2) * (stepX / 2);
    for (let x = -diag + offset; x < diag; x += stepX) {
      const ax = Math.round(x);
      const ay = Math.round(y);
      if (!onPage(ax, ay)) continue;
      const spans = lines.map((l, i) => `<tspan x="${ax}" dy="${i === 0 ? 0 : lineGap}">${xml(l)}</tspan>`);
      rows.push(`<text x="${ax}" y="${ay}">${spans.join('')}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<g transform="translate(${width / 2} ${height / 2}) rotate(${style.angleDeg})" fill="${xml(style.color)}" fill-opacity="${xml(String(style.opacity))}" ` +
    `font-family="Schibsted Grotesk, Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="600">${rows.join('')}</g></svg>`;
}

export async function applyWatermark(page: Buffer, lines: string[], style: WatermarkStyle = DEFAULT_STYLE): Promise<Buffer> {
  const img = sharp(page);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('Page image has no size');
  if (lines.length === 0) return img.webp(WEBP).toBuffer();
  const overlay = await watermarkOverlay(meta.width, meta.height, lines, style);
  return img.composite([{ input: overlay, top: 0, left: 0 }]).webp(WEBP).toBuffer();
}

// key includes the viewer's text: never share across viewers
const OVERLAY_CACHE_BYTES = 48 * 1024 * 1024;
const overlays = new Map<string, { png: Promise<Buffer>; bytes: number }>();
let overlayBytes = 0;

export async function watermarkOverlay(width: number, height: number, lines: string[], style: WatermarkStyle = DEFAULT_STYLE): Promise<Buffer> {
  const key = JSON.stringify([width, height, lines, style]);
  const hit = overlays.get(key);
  if (hit) {
    overlays.delete(key);
    overlays.set(key, hit);
    return hit.png;
  }
  const svg = Buffer.from(watermarkSvg(width, height, lines, style));
  const entry = { png: sharp(svg).png({ compressionLevel: 2 }).toBuffer(), bytes: 0 };
  overlays.set(key, entry);
  try {
    const png = await entry.png;
    if (overlays.get(key) === entry) {
      entry.bytes = png.length;
      overlayBytes += png.length;
      for (const [k, e] of overlays) {
        if (overlayBytes <= OVERLAY_CACHE_BYTES) break;
        overlays.delete(k);
        overlayBytes -= e.bytes;
      }
    }
    return png;
  } catch (e) {
    if (overlays.get(key) === entry) overlays.delete(key);
    throw e;
  }
}

const WEBP = { quality: 82, effort: 0 } as const;
