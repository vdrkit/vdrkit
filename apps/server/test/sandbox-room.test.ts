// SPDX-License-Identifier: AGPL-3.0-only
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { claimedTypeProblem, zipEntry } from '../src/pipeline/file-type.js';
import { extractPdfText } from '../src/pipeline/extract-text.js';
import { allSandboxDocuments, neighbourDocuments, SANDBOX_TREE, sandboxDocuments, versionsOf } from '../src/sandbox/room/catalogue.js';
import { fingerprint } from '../src/sandbox/room/cache.js';
import { renderDocument } from '../src/sandbox/room/render.js';


const docs = sandboxDocuments();

describe('the sandbox room', () => {
  it('has about 300 published documents, drafts and second versions', () => {
    const published = docs.filter((d) => d.status !== 'draft');
    expect(published.length).toBeGreaterThanOrEqual(280);
    expect(published.length).toBeLessThanOrEqual(320);
    const drafts = docs.length - published.length;
    expect(drafts).toBeGreaterThanOrEqual(20);
    expect(drafts).toBeLessThanOrEqual(40);
    expect(SANDBOX_TREE.map((f) => f.name)).toEqual(['Corporate', 'Legal', 'Finance', 'Commercial', 'HR', 'IT', 'Property', 'Insurance', 'Environmental',
      'Intellectual property', 'Data protection']);
    for (const f of SANDBOX_TREE) expect(docs.some((d) => d.ix.split('.')[0] === f.ix), f.name).toBe(true);
    expect(docs.filter((d) => d.status === 'upd')).toHaveLength(3);
    expect(docs.filter((d) => d.status === 'rev')).toHaveLength(3);
    expect(new Set(docs.map((d) => d.ix)).size).toBe(docs.length);
    const ext = (e: string) => docs.filter((d) => d.ext === e).length;
    expect(ext('pdf')).toBeGreaterThan(docs.length / 2);
    for (const e of ['docx', 'xlsx', 'pptx']) expect(ext(e), e).toBeGreaterThanOrEqual(10);
  });

  it('is the same room every time', () => {
    expect(fingerprint({})).toBe(fingerprint({}));
    expect(sandboxDocuments().map((d) => d.name)).toEqual(docs.map((d) => d.name));
  });

  it('gives every document real content', async () => {
    expect(neighbourDocuments().map((d) => d.room)).toEqual([...Array(12).fill('osprey'), 'falcon', ...Array(7).fill('weaver')]);
    const seen = new Set<string>();
    for (const d of allSandboxDocuments()) {
      for (const v of versionsOf(d)) {
        const r = await renderDocument(d, v);
        const what = `${d.room ?? 'heron'} ${d.ix} v${v} ${r.filename}`;
        expect(claimedTypeProblem(d.ext, r.original), what).toBeNull();
        const pdf = r.rendition ?? r.original;
        expect(r.rendition === null, what).toBe(d.ext === 'pdf');
        const pages = (await PDFDocument.load(pdf)).getPageCount();
        expect(pages, what).toBeGreaterThanOrEqual(1);
        expect(pages, what).toBeLessThanOrEqual(15);
        const text = (await extractPdfText(pdf)).join('\n');
        expect(text.length, what).toBeGreaterThan(300);
        for (const m of text.matchAll(/\b[\w.-]+@([\w-]+\.)+[\w-]+\b/g)) expect(m[0], what).toMatch(/\.example$/);
        for (const y of text.match(/\b20[0-9]{2}\b/g) ?? []) seen.add(y);
        if (d.ext !== 'pdf') {
          const part = { docx: 'word/document.xml', xlsx: 'xl/worksheets/sheet1.xml', pptx: 'ppt/slides/slide1.xml' }[d.ext]!;
          expect(zipEntry(r.original, part)?.length, what).toBeGreaterThan(200);
        }
      }
    }
    for (const y of ['2024', '2025', '2026']) expect(seen.has(y), y).toBe(true);
  }, 120_000);

  it('renders the same bytes for the same document', async () => {
    for (const d of docs.filter((_, i) => i % 40 === 0)) {
      const [a, b] = [await renderDocument(d), await renderDocument(d)];
      expect(a.original.equals(b.original), d.ix).toBe(true);
    }
  });
});
