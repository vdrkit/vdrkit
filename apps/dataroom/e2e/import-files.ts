// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function pdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, ' ');
  const stream = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function writeTree(dir: string, root: string, files: Record<string, Buffer | string>): string {
  const base = join(dir, root);
  rmSync(base, { recursive: true, force: true });
  for (const [p, body] of Object.entries(files)) {
    const full = join(base, ...p.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return base;
}
