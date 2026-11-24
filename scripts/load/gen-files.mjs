#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Bulk-import test files: ~2 GB in 400 files; --big adds a 1 GiB PDF. Deterministic.
//   node scripts/load/gen-files.mjs           the 400 files, in ten folders
//   node scripts/load/gen-files.mjs --big     also the 1 GiB PDF
//   node scripts/load/gen-files.mjs --clean   deletes exactly the files this script made (listed in .work/files.json)
// Scans are random noise (incompressible); each Office copy gets its own zip comment, so hashes differ.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ROOT, WORK } from './config.mjs';

const require = createRequire(`${ROOT}apps/server/package.json`);
const { PDFDocument, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');

const OUT = `${WORK}/files`;
const MANIFEST = `${WORK}/files.json`;
const args = process.argv.slice(2);
const MiB = 1024 * 1024;

if (args.includes('--clean')) {
  if (existsSync(MANIFEST)) {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    for (const f of m.files) rmSync(`${OUT}/${f.path}`, { force: true });
    for (const d of new Set(m.files.map((f) => f.path.split('/')[0]))) { try { rmdirSync(`${OUT}/${d}`); } catch { /* not empty or gone */ } }
    try { rmdirSync(OUT); } catch { /* not empty or gone */ }
    rmSync(MANIFEST);
  }
  rmSync(`${WORK}/big.pdf`, { force: true });
  console.log('Deleted the generated files.');
  process.exit(0);
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r = rng(2026);

async function noise(seed, w = 1240, h = 1754) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 240, g: 240, b: 235 }, noise: { type: 'gaussian', mean: 128 + (seed % 7), sigma: 40 } } })
    .jpeg({ quality: 70 }).toBuffer();
}

const LOREM = 'The parties agree that the Company shall deliver the goods described in the schedule on the dates set out there. '
  + 'Payment is due within thirty days of the invoice date. Either party may end this agreement on ninety days written notice. ';

async function pdf(target, title, scans) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const textPages = Math.max(1, Math.min(40, Math.round(target / 60_000)));
  for (let p = 0; p < textPages; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${title} - page ${p + 1}`, { x: 50, y: 790, size: 14, font });
    for (let l = 0; l < 40; l++) page.drawText(LOREM.slice((l * 7) % 60, ((l * 7) % 60) + 90), { x: 50, y: 760 - l * 17, size: 9, font });
  }
  let size = (await doc.save({ useObjectStreams: false })).length;
  let i = 0;
  while (size < target) {
    const img = await doc.embedJpg(scans[i % scans.length]);
    const page = doc.addPage([595, 842]);
    page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    size += scans[i % scans.length].length;
    i++;
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

function office(name, tag) {
  const b = readFileSync(`${ROOT}apps/server/test/fixtures/office/${name}`);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const comment = Buffer.from(`vdrkit load test ${tag}`);
  const head = Buffer.from(b.subarray(0, eocd + 22));
  head.writeUInt16LE(comment.length, eocd + 20);
  return Buffer.concat([head, comment]);
}

function binary(path, size, seed) {
  const fd = openSync(path, 'w');
  const g = rng(seed);
  const chunk = Buffer.alloc(4 * MiB);
  let left = size;
  while (left > 0) {
    for (let k = 0; k < chunk.length; k += 4) chunk.writeUInt32LE((g() * 4294967296) >>> 0, k);
    const n = Math.min(left, chunk.length);
    writeSync(fd, chunk, 0, n);
    left -= n;
  }
  closeSync(fd);
}

const FOLDERS = ['01 Corporate', '02 Legal', '03 Finance', '04 Commercial', '05 HR', '06 IT', '07 Property', '08 Insurance', '09 Environmental', '10 Tax'];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const scans = await Promise.all([1, 2, 3, 4, 5, 6].map((s) => noise(s)));
  const files = [];
  const t0 = Date.now();
  const plan = [
    ...Array.from({ length: 250 }, () => 'pdf'), ...Array.from({ length: 60 }, () => 'docx'), ...Array.from({ length: 40 }, () => 'xlsx'),
    ...Array.from({ length: 20 }, () => 'pptx'), ...Array.from({ length: 20 }, () => 'jpg'), ...Array.from({ length: 10 }, () => 'zip'),
  ].sort(() => r() - 0.5);
  for (const [i, kind] of plan.entries()) {
    const folder = FOLDERS[i % FOLDERS.length];
    mkdirSync(`${OUT}/${folder}`, { recursive: true });
    const name = `${String(Math.floor(i / FOLDERS.length) + 1).padStart(2, '0')} Load document ${i + 1}.${kind}`;
    const path = `${folder}/${name}`;
    const full = `${OUT}/${path}`;
    if (kind === 'pdf') {
      const target = r() < 0.125 ? (15 + r() * 45) * MiB : (0.05 + r() * r() * 6) * MiB;
      writeFileSync(full, await pdf(Math.round(target), name, scans));
    } else if (kind === 'jpg') {
      writeFileSync(full, await sharp({ create: { width: 3000 + Math.floor(r() * 1000), height: 2000 + Math.floor(r() * 1000), channels: 3, background: { r: 90, g: 120, b: 160 },
        noise: { type: 'gaussian', mean: 120, sigma: 35 } } }).jpeg({ quality: 85 }).toBuffer());
    } else if (kind === 'zip') {
      binary(full, Math.round((40 + r() * 120) * MiB), i);
    } else {
      writeFileSync(full, office(kind === 'docx' ? 'memo.docx' : kind === 'xlsx' ? 'accounts.xlsx' : 'memo.pptx', `${i}`));
    }
    files.push({ path, size: statSync(full).size, kind });
  }
  const total = files.reduce((a, f) => a + f.size, 0);
  writeFileSync(MANIFEST, JSON.stringify({ total, files }, null, 1));
  console.log(`${files.length} files, ${(total / 1024 ** 3).toFixed(2)} GiB in ${OUT} (${((Date.now() - t0) / 1000).toFixed(0)} s).`);

  if (args.includes('--big')) {
    const target = 1024 * MiB;
    const doc = await pdf(4 * MiB, 'One GiB scan', scans);
    const fd = openSync(`${WORK}/big.pdf`, 'w');
    writeSync(fd, doc);
    // pad in a comment, then repeat startxref so tail-scanning readers still find the real xref
    const xref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(doc.toString('latin1'))[1];
    const tail = Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`);
    binaryAppend(fd, target - doc.length - tail.length);
    writeSync(fd, tail);
    closeSync(fd);
    console.log(`big.pdf: ${statSync(`${WORK}/big.pdf`).size} bytes.`);
  }
}

function binaryAppend(fd, n) {
  const g = rng(99);
  const chunk = Buffer.alloc(4 * MiB);
  let left = n;
  writeSync(fd, Buffer.from('\n%'));
  left -= 2;
  while (left > 0) {
    for (let k = 0; k < chunk.length; k++) { const v = (g() * 256) | 0; chunk[k] = v === 10 || v === 13 ? 32 : v; }
    const m = Math.min(left, chunk.length);
    writeSync(fd, chunk, 0, m);
    left -= m;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
