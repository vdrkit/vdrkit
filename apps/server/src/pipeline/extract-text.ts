// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from '@vdrkit/core';
import type { Step } from './pipeline.js';

export interface ExtractedText {
  pages: { page: number; text: string }[];
}

// no NUL in pg text; ts_headline uses control chars as markers
function clean(s: string): string {
  const visible = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return visible.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export async function extractPdfText(pdf: Buffer): Promise<string[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  try {
    const out: string[] = [];
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      try {
        const st = page.toStructuredText('preserve-whitespace');
        try {
          out.push(clean(st.asText()));
        } finally {
          st.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return out;
  } finally {
    doc.destroy();
  }
}

export function parseExtractedText(body: Buffer): string[] {
  const parsed = JSON.parse(body.toString('utf8')) as ExtractedText;
  return [...parsed.pages].sort((a, b) => a.page - b.page).map((p) => p.text);
}

export const extractTextStep: Step = {
  name: 'extract',
  appliesTo: () => true,
  async run(ctx) {
    const pdf = await ctx.readDerived('pdf');
    if (!pdf) return;
    let pages: string[];
    try {
      pages = await extractPdfText(pdf);
    } catch {
      // the page images are enough to view it
      ctx.facts.searchSkipped = 'unreadable';
      return;
    }
    const body: ExtractedText = { pages: pages.map((text, i) => ({ page: i + 1, text })) };
    await ctx.store('text', 'extract', Buffer.from(JSON.stringify(body), 'utf8'), { pages: pages.length });
    ctx.facts.pages = pages.length;
  },
};

export interface IndexTextInput {
  workspaceId: string;
  nodeId: string;
  versionId: string;
  pages: string[];
}

// caller's tenant tx
export async function indexText(tx: SqlClient, input: IndexTextInput): Promise<number> {
  await tx.query('delete from document_text where version_id = $1', [input.versionId]);
  const numbers: number[] = [];
  const bodies: string[] = [];
  input.pages.forEach((text, i) => {
    const body = clean(text);
    if (body.length === 0) return;
    numbers.push(i + 1);
    bodies.push(body);
  });
  if (numbers.length === 0) return 0;
  await tx.query(
    `insert into document_text (tenant_id, workspace_id, node_id, version_id, page, body)
     select current_tenant_id(), $1, $2, $3, p.page, p.body
       from unnest($4::int[], $5::text[]) as p(page, body)`,
    [input.workspaceId, input.nodeId, input.versionId, numbers, bodies],
  );
  return numbers.length;
}
