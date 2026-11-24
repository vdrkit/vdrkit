// SPDX-License-Identifier: AGPL-3.0-only
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import { embedFonts, printable } from '../pdf-fonts.js';

export interface NdaPdfInput { title: string; subtitle: string; body: string }

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 64;
const SIZE = 10.5;
const LEAD = 15.5;

function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

export async function ndaPdf(input: NdaPdfInput): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = await PDFDocument.create();
  doc.setTitle(input.title);
  doc.setProducer('VDRkit');
  doc.setCreator('VDRkit');
  const { regular, bold } = await embedFonts(doc);
  const width = A4[0] - 2 * MARGIN;
  const ink = rgb(0.1, 0.145, 0.19);
  const muted = rgb(0.43, 0.48, 0.54);

  let page = doc.addPage(A4);
  let y = A4[1] - MARGIN;
  const need = (h: number) => {
    if (y - h < MARGIN) { page = doc.addPage(A4); y = A4[1] - MARGIN; }
  };
  const block = (text: string, font: PDFFont, size: number, lead: number, color = ink, after = 6) => {
    for (const l of wrap(font, size, printable(font, text), width)) {
      need(lead);
      page.drawText(l, { x: MARGIN, y: y - size, size, font, color });
      y -= lead;
    }
    y -= after;
  };

  block(input.title, bold, 16, 22, ink, 2);
  block(input.subtitle, regular, 9.5, 14, muted, 14);
  const isHeading = (l: string) => /^#{1,3}\s/.test(l);
  const paragraphs = input.body.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  for (const raw of paragraphs) {
    const parts: string[] = [];
    for (const l of raw.split('\n')) {
      if (isHeading(l) || parts.length === 0 || isHeading(parts[parts.length - 1]!)) parts.push(l);
      else parts[parts.length - 1] += ` ${l}`;
    }
    for (const part of parts) {
      const t = part.trim();
      if (!t) continue;
      if (t.startsWith('# ')) block(t.slice(2), bold, 13, 19, ink, 6);
      else if (/^#{2,3}\s/.test(t)) { y -= 4; block(t.replace(/^#{2,3}\s/, ''), bold, SIZE, LEAD, ink, 2); }
      else block(t, regular, SIZE, LEAD, ink, 8);
    }
  }
  const pages = doc.getPageCount();
  doc.getPages().forEach((p, i) => {
    p.drawText(`Page ${i + 1} of ${pages}`, { x: MARGIN, y: MARGIN / 2, size: 8.5, font: regular, color: muted });
  });
  return { bytes: await doc.save(), pages };
}
