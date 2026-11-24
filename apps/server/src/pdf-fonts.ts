// SPDX-License-Identifier: AGPL-3.0-only
// Noto Sans (OFL, fonts/OFL.txt): Latin, Greek, Cyrillic
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';

// src/ and dist/ sit at the same depth below apps/server
const FONTS = new URL('../fonts/', import.meta.url);

let files: Promise<{ regular: Uint8Array; bold: Uint8Array }> | undefined;

function load() {
  files ??= Promise.all([readFile(new URL('NotoSans-Regular.ttf', FONTS)), readFile(new URL('NotoSans-Bold.ttf', FONTS))])
    .then(([regular, bold]) => ({ regular, bold }))
    .catch((e) => { files = undefined; throw e; });
  return files;
}

export async function embedFonts(doc: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont }> {
  const f = await load();
  doc.registerFontkit(fontkit);
  return { regular: await doc.embedFont(f.regular, { subset: true }), bold: await doc.embedFont(f.bold, { subset: true }) };
}

// a character the font lacks (Chinese, Arabic) prints as '?' rather than as an empty box
export function printable(font: PDFFont, text: string): string {
  const known = new Set(font.getCharacterSet());
  return [...text].map((c) => (known.has(c.codePointAt(0)!) || /\s/.test(c) ? c : '?')).join('');
}
