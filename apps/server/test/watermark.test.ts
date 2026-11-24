// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { applyWatermark, DEFAULT_FIELDS, watermarkLines, watermarkOverlay, watermarkSvg, type Viewer } from '../src/pipeline/watermark.js';

const jan: Viewer = { name: 'Jan de Vries', email: 'jan@bidder-a.example', groupName: 'Bidder A', ip: '198.51.100.10', timeZone: 'Europe/London' };
const at = new Date('2026-11-12T08:00:00Z');

async function blankPage(w = 850, h = 1100) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } }).png().toBuffer();
}
async function meanBrightness(buf: Buffer) {
  const s = await sharp(buf).stats();
  return s.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
}

describe('watermarkLines', () => {
  it("uses the viewer's time zone by default", () => {
    expect(watermarkLines(DEFAULT_FIELDS, jan, at)).toEqual(['Jan de Vries · jan@bidder-a.example', 'Bidder A · Thu 12 Nov, 08:00 GMT']);
  });

  it('adds the IP when switched on', () => {
    expect(watermarkLines({ ...DEFAULT_FIELDS, ip: true }, jan, at)[1]).toBe('Bidder A · Thu 12 Nov, 08:00 GMT · 198.51.100.10');
  });

  it('drops empty lines', () => {
    expect(watermarkLines({ name: true, email: false, group: false, dateTime: false, ip: false }, jan, at)).toEqual(['Jan de Vries']);
    expect(watermarkLines({ name: false, email: false, group: false, dateTime: false, ip: false }, jan, at)).toEqual([]);
  });
});

describe('watermarkSvg', () => {
  it('escapes names', () => {
    const svg = watermarkSvg(400, 400, ['O\'Brien <script> & "Partners"']);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt; &amp; &quot;Partners&quot;');
  });

  it('escapes the style', () => {
    const opacity = '0.2" onload="x' as unknown as number;
    const svg = watermarkSvg(400, 400, ['Jan de Vries'], { opacity, angleDeg: -30, color: '#1A2531', sizeRatio: 0.022 });
    expect(svg).toContain('fill-opacity="0.2&quot; onload=&quot;x"');
    expect(svg).not.toContain('onload="');
  });

  it('tiles the text', () => {
    const svg = watermarkSvg(850, 1100, ['Jan de Vries']);
    expect((svg.match(/<text /g) ?? []).length).toBeGreaterThan(20);
  });
});

describe('applyWatermark', () => {
  it('keeps the page size', async () => {
    const out = await applyWatermark(await blankPage(), watermarkLines(DEFAULT_FIELDS, jan, at));
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 850, 1100]);
    const mean = await meanBrightness(out);
    expect(mean).toBeLessThan(254);
    expect(mean).toBeGreaterThan(225);
  });

  it('skips an empty stamp', async () => {
    const out = await applyWatermark(await blankPage(), []);
    expect(await meanBrightness(out)).toBeGreaterThan(254.5);
  });
});

describe('watermark overlay cache', () => {
  function everyRepeat(width: number, height: number, lines: string[]): string {
    const size = Math.max(12, Math.round(width * 0.022));
    const lineGap = Math.round(size * 1.35);
    const stepY = lines.length * lineGap + size * 4;
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const stepX = Math.round(longest * size * 0.62 + size * 3);
    const diag = Math.ceil(Math.hypot(width, height));
    const rows: string[] = [];
    let r = 0;
    for (let y = -diag; y < diag; y += stepY, r++) {
      for (let x = -diag + (r % 2) * (stepX / 2); x < diag; x += stepX) {
        rows.push(`<text x="${Math.round(x)}" y="${Math.round(y)}">${lines.map((l, i) => `<tspan x="${Math.round(x)}" dy="${i === 0 ? 0 : lineGap}">${l}</tspan>`).join('')}</text>`);
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<g transform="translate(${width / 2} ${height / 2}) rotate(-30)" fill="#1A2531" fill-opacity="0.16" ` +
      `font-family="Schibsted Grotesk, Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="600">${rows.join('')}</g></svg>`;
  }

  it.each([
    [1600, 2263, ['Jan de Vries · jan.de.vries@bidder-a.example.com', 'Bidder A · Thu 20 Nov, 21:58 CET · 198.51.100.10']],
    [1600, 1131, ['WWWWWWWWWWWWWWWWWWWW @@@@@@@@@@', 'Bidder A']],
    [320, 452, ['Jan']],
  ])('leaves out only repeats that miss the page: %i x %i draws the same pixels', async (w, h, lines) => {
    const svg = watermarkSvg(w, h, lines);
    const all = everyRepeat(w, h, lines);
    expect((svg.match(/<text /g) ?? []).length).toBeLessThan((all.match(/<text /g) ?? []).length / 2);
    const [a, b] = await Promise.all([sharp(Buffer.from(svg)).raw().toBuffer(), sharp(Buffer.from(all)).raw().toBuffer()]);
    expect(a.equals(b)).toBe(true);
  });

  it('should match the uncached result', async () => {
    const page = await sharp({ create: { width: 640, height: 900, channels: 3, background: '#f4f1ea' } }).webp({ lossless: true }).toBuffer();
    const lines = watermarkLines(DEFAULT_FIELDS, jan, at);
    const direct = await sharp(page).composite([{ input: Buffer.from(watermarkSvg(640, 900, lines)), top: 0, left: 0 }]).webp({ quality: 82, effort: 0 }).toBuffer();
    const first = await applyWatermark(page, lines);
    const second = await applyWatermark(page, lines);
    expect(first.equals(direct)).toBe(true);
    expect(second.equals(direct)).toBe(true);
  });

  it("never shares one person's overlay with another", async () => {
    const lines = watermarkLines(DEFAULT_FIELDS, jan, at);
    const other = watermarkLines(DEFAULT_FIELDS, { ...jan, name: 'Eva Smit', email: 'eva@bidder-b.example' }, at);
    const later = watermarkLines(DEFAULT_FIELDS, jan, new Date(at.getTime() + 60_000));
    const [a1, a2] = await Promise.all([watermarkOverlay(320, 452, lines), watermarkOverlay(320, 452, lines)]);
    expect(a1).toBe(a2);
    expect(await watermarkOverlay(320, 452, lines)).toBe(a1);
    const b = await watermarkOverlay(320, 452, other);
    const c = await watermarkOverlay(320, 452, later);
    const d = await watermarkOverlay(320, 460, lines);
    for (const x of [b, c, d]) expect(x.equals(a1)).toBe(false);
  });
});
