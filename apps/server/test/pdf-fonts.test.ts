// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { PDFDocument } from 'pdf-lib';
import { ndaPdf } from '../src/routes/nda-pdf.js';
import { stampPdf } from '../src/routes/viewer.js';

function textOf(bytes: Uint8Array): string {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  let out = '';
  for (let i = 0; i < doc.countPages(); i++) out += doc.loadPage(i).toStructuredText().asText();
  return out;
}

const names = 'Łukasz Wiśniewski, Dvořák s.r.o., Ελληνική Τράπεζα, ООО «Москва», Søren Ødegård';

describe('names outside Western European', () => {
  it('print as written in the NDA PDF', async () => {
    const { bytes } = await ndaPdf({
      title: 'Non-disclosure agreement – Project Heron',
      subtitle: `Accepted by ${names}`,
      body: `# Parties\n\nThis agreement binds ${names} and the seller.\n\n## Signed in 北京\n\n“Quoted” text — with dashes…`,
    });
    const text = textOf(bytes).replace(/\s+/g, ' ');
    for (const n of names.split(', ')) expect(text).toContain(n);
    expect(text).toContain('Non-disclosure agreement – Project Heron');
    expect(text).toContain('“Quoted” text — with dashes…');
    // no Chinese in the font: a question mark, not an empty box
    expect(text).toContain('Signed in ??');
  });

  it('embed only the letters used', async () => {
    const { bytes } = await ndaPdf({ title: 'NDA', subtitle: 'Accepted', body: 'Short.' });
    expect(bytes.length).toBeLessThan(60_000);
  });

  it('print as written in the watermark of a downloaded PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const stamped = await stampPdf(Buffer.from(await doc.save()), ['Łukasz Wiśniewski', 'Ελληνική Τράπεζα']);
    const text = textOf(stamped);
    expect(text).toContain('Łukasz Wiśniewski');
    expect(text).toContain('Ελληνική Τράπεζα');
    expect(text).not.toContain('?');
  });
});
