// SPDX-License-Identifier: AGPL-3.0-only
// rendition stands in for Gotenberg when none is configured
import { layoutPdf, spaceThousands, type Block } from '../../demo/documents.js';
import { MIME } from '../../demo/seed-demo.js';
import type { RoomDoc } from './catalogue.js';
import { contentOf } from './content.js';
import { docx, pptx, xlsx, type Cell, type Sheet, type Slide } from './ooxml.js';

export { MIME };

export interface Rendered {
  filename: string;
  mime: string;
  original: Buffer;
  rendition: Buffer | null;
}

const fmt = (x: number) => spaceThousands(x.toFixed(Number.isInteger(x) ? 0 : 2));
const cellText = (c: Cell): string => {
  if (c === null) return '';
  if (typeof c === 'number') return fmt(c);
  if (typeof c === 'string') return c;
  if (typeof c.v === 'string') return c.v;
  return c.pct ? `${(c.v * 100).toFixed(1)}%` : fmt(c.v);
};

function* sheetBlocks(sheets: Sheet[]): Generator<Block> {
  for (const [i, s] of sheets.entries()) {
    if (i > 0) yield { t: 'break' };
    yield { t: 'h', text: s.title ?? s.name };
    const w = s.widths ?? s.columns.map((_, k) => (k === 0 ? 36 : 14));
    const sum = w.reduce((a, b) => a + b, 0);
    const widths = w.map((x) => x / sum);
    for (let k = 0; k < s.rows.length || k === 0; k += 24) {
      const rows = s.rows.slice(k, k + 24).map((r) => s.columns.map((_, j) => cellText(r[j] ?? null)));
      yield { t: 'table', columns: s.columns, rows, widths };
    }
  }
}

function* slideBlocks(slides: Slide[]): Generator<Block> {
  for (const [i, s] of slides.entries()) {
    if (i > 0) yield { t: 'break' };
    yield { t: 'title', text: s.title };
    if (s.subtitle) yield { t: 'center', text: s.subtitle };
    yield { t: 'gap' };
    for (const b of s.bullets ?? []) yield { t: 'li', text: b };
    if (s.table) yield { t: 'table', columns: s.table.columns, rows: s.table.rows };
  }
}

export async function renderDocument(d: RoomDoc, version = 1): Promise<Rendered> {
  const content = contentOf(d, version);
  const title = `${d.ix} ${d.name}`;
  const info = { title: d.name, author: d.uploader === 'maria' ? 'Maria Botha' : 'Drosvelt Holdings', created: new Date(Date.UTC(2026, 9, 28, 8, 0)) };
  const base = { filename: `${d.name}.${d.ext}`, mime: MIME[d.ext] };
  if ('blocks' in content) {
    const laid = await layoutPdf(content.blocks, { title, pages: d.pages + (version - 1), landscape: content.landscape });
    if (d.ext === 'pdf') return { ...base, original: laid.pdf, rendition: null };
    if (d.ext === 'docx') return { ...base, original: docx(laid.used, info, { landscape: content.landscape }), rendition: laid.pdf };
    throw new Error(`${d.ix}: text content cannot be a .${d.ext} file`);
  }
  if ('sheets' in content) {
    if (d.ext !== 'xlsx') throw new Error(`${d.ix}: a workbook must be an .xlsx file`);
    const laid = await layoutPdf(sheetBlocks(content.sheets), { title, pages: 15, landscape: true });
    return { ...base, original: xlsx(content.sheets, info), rendition: laid.pdf };
  }
  if (d.ext !== 'pptx') throw new Error(`${d.ix}: a deck must be a .pptx file`);
  const laid = await layoutPdf(slideBlocks(content.slides), { title, pages: content.slides.length, landscape: true });
  return { ...base, original: pptx(content.slides, info, 'Drosvelt Holdings · Confidential'), rendition: laid.pdf };
}
