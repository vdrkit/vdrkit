// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidLogo, logoToPng } from '../src/logo-png.js';


const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = (s: string) => Buffer.from(s);

async function pixel(png: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [...data.subarray(i, i + 4)];
}
async function anythingDrawn(png: Buffer): Promise<boolean> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  return false;
}

let server: Server;
let requests: string[];
let base: string;
let dir: string;
let redFile: string;
let textFile: string;

beforeAll(async () => {
  requests = [];
  server = createServer((req, res) => { requests.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'image/png' }); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'vdrkit-logo-'));
  redFile = join(dir, 'red.png');
  writeFileSync(redFile, await sharp({ create: { width: 20, height: 10, channels: 4, background: '#ff0000' } }).png().toBuffer());
  textFile = join(dir, 'secret.txt');
  writeFileSync(textFile, 'SECRET SECRET SECRET');
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('logo to PNG', () => {
  it('renders SVG with a style block', async () => {
    const out = await logoToPng(svg(`<svg ${NS} width="90" height="20"><style>.a{fill:#00ff00}.b{fill:#ff6600}</style>`
      + `<rect class="a" width="45" height="10"/><rect class="b" x="45" width="45" height="10"/></svg>`), 'svg');
    expect([out.width, out.height]).toEqual([720, 160]);
    expect((await sharp(out.png).metadata()).format).toBe('png');
    expect(await pixel(out.png, 100, 20)).toEqual([0, 255, 0, 255]);
    expect(await pixel(out.png, 600, 20)).toEqual([255, 102, 0, 255]);
    expect((await pixel(out.png, 100, 140))[3]).toBe(0);
  });

  it('refuses a raster that declares more pixels than a logo needs', async () => {
    const huge = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(huge.length).toBeLessThan(256 * 1024);
    await expect(logoToPng(huge, 'png')).rejects.toThrow(new InvalidLogo('too large'));
  });

  it('keeps the aspect ratio within 720 x 160', async () => {
    const tall = await logoToPng(svg(`<svg ${NS} viewBox="0 0 10 20"><rect width="10" height="20"/></svg>`), 'svg');
    expect([tall.width, tall.height]).toEqual([80, 160]);
    const wide = await logoToPng(svg(`<svg ${NS} width="3000" height="100"><rect width="3000" height="100"/></svg>`), 'svg');
    expect([wide.width, wide.height]).toEqual([720, 24]);
  });

  it('neutralises scripts in SVG', async () => {
    const out = await logoToPng(svg(`<svg ${NS} width="90" height="20" onload="fetch('${base}/onload')">`
      + `<script>fetch('${base}/script')</script><rect width="90" height="20" fill="#003366" onclick="alert(1)"/>`
      + `<a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>`), 'svg');
    expect((await sharp(out.png).metadata()).format).toBe('png');
    expect(out.png.includes('script')).toBe(false);
    expect(out.png.includes('alert')).toBe(false);
    expect(await pixel(out.png, 300, 80)).toEqual([0, 0x33, 0x66, 255]);
    expect(requests).toEqual([]);
  });

  it('does not fetch external images', async () => {
    const files = [pathToFileURL(redFile).href, redFile.replace(/\\/g, '/'), 'red.png'];
    const references = [
      `<image href="${base}/image.png" width="90" height="20"/>`,
      `<image xlink:href="${base}/xlink.png" width="90" height="20"/>`,
      `<use href="${base}/use.svg#a"/>`,
      `<style>@import url(${base}/import.css); rect { fill: url(${base}/fill.svg#p) }</style><rect width="1" height="1"/>`,
      `<rect width="90" height="20" style="fill:url(${base}/style.svg#p)"/>`,
      `<rect width="90" height="20" filter="url(${base}/filter.svg#f)"/>`,
      ...files.map((f) => `<image href="${f}" width="90" height="20" preserveAspectRatio="none"/>`),
      ...files.map((f) => `<image xlink:href="${f}" width="90" height="20" preserveAspectRatio="none"/>`),
    ];
    for (const r of references) {
      const out = await logoToPng(svg(`<svg ${NS} width="90" height="20">${r}</svg>`), 'svg').catch((e: unknown) => e);
      if (out instanceof InvalidLogo) continue;
      const png = (out as { png: Buffer }).png;
      expect([r, (await pixel(png, 300, 80)).join(',')]).not.toEqual([r, '255,0,0,255']);
    }
    expect(requests).toEqual([]);
    // control: embedded image is drawn
    const embedded = `data:image/png;base64,${(await sharp(redFile).toBuffer()).toString('base64')}`;
    const control = await logoToPng(svg(`<svg ${NS} width="90" height="20"><image href="${embedded}" width="90" height="20" preserveAspectRatio="none"/></svg>`), 'svg');
    expect(await pixel(control.png, 300, 80)).toEqual([255, 0, 0, 255]);
  });

  it('ignores XInclude and external entities', async () => {
    const control = await logoToPng(svg(`<svg ${NS} width="90" height="20"><text x="2" y="15" font-size="12">SECRET</text></svg>`), 'svg');
    expect(await anythingDrawn(control.png)).toBe(true);
    const xi = await logoToPng(svg(`<svg ${NS} xmlns:xi="http://www.w3.org/2001/XInclude" width="90" height="20"><text x="2" y="15" font-size="12">`
      + `<xi:include href="${pathToFileURL(textFile).href}" parse="text"/></text></svg>`), 'svg');
    expect(await anythingDrawn(xi.png)).toBe(false);
    await expect(logoToPng(svg(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "${pathToFileURL(textFile).href}">]>`
      + `<svg ${NS} width="90" height="20"><text x="2" y="15">&x;</text></svg>`), 'svg')).rejects.toBeInstanceOf(InvalidLogo);
  });

  it('re-encodes PNG and JPEG without metadata', async () => {
    const big = await sharp({ create: { width: 1440, height: 160, channels: 3, background: '#123456' } })
      .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'Drosvelt Capital secret' } } }).toBuffer();
    expect(big.includes('Drosvelt Capital secret')).toBe(true);
    const fromJpeg = await logoToPng(big, 'jpeg');
    expect([fromJpeg.width, fromJpeg.height]).toEqual([720, 80]);
    expect((await sharp(fromJpeg.png).metadata()).format).toBe('png');
    expect(fromJpeg.png.includes('Drosvelt Capital secret')).toBe(false);
    const small = await sharp({ create: { width: 120, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const fromPng = await logoToPng(small, 'png');
    expect([fromPng.width, fromPng.height]).toEqual([120, 30]);
    expect((await pixel(fromPng.png, 5, 5))[3]).toBe(0);
  });

  it('rejects unreadable images', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer();
    await expect(logoToPng(png, 'jpeg')).rejects.toBeInstanceOf(InvalidLogo);
    await expect(logoToPng(svg('not an svg'), 'svg')).rejects.toBeInstanceOf(InvalidLogo);
    await expect(logoToPng(svg(`<svg ${NS}><rect`), 'svg')).rejects.toBeInstanceOf(InvalidLogo);
    await expect(logoToPng(Buffer.from('<html><body>hi</body></html>'), 'svg')).rejects.toBeInstanceOf(InvalidLogo);
  });
});
