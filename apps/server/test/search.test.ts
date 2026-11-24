// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { encryptBuffer, decryptBuffer, newDataKey } from '../src/crypto/envelope.js';
import { convertStep, GotenbergClient, hashStep, MemoryStorage, runPipeline } from '../src/pipeline/pipeline.js';
import { extractTextStep, indexText, parseExtractedText } from '../src/pipeline/extract-text.js';
import { searchRoutes, splitQuery } from '../src/routes/search.js';
import { pageExtract, queryTerms, sentences } from '../src/routes/search-extract.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';

let h: Heron;
let app: FastifyInstance;
let itDoc: string;

async function makePdf(pages: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) pdf.addPage([595, 842]).drawText(text, { x: 50, y: 760, size: 12, font });
  return Buffer.from(await pdf.save());
}

async function ingest(storage: MemoryStorage, key: Buffer, nodeId: string, filename: string, pages: string[]) {
  const body = await makePdf(pages);
  const storageKey = `ws/${h.ws}/originals/${nodeId}`;
  await storage.put(storageKey, await encryptBuffer(key, body, storageKey));
  const { rows } = await h.pg.query<{ id: string }>(
    `insert into document_version (tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime)
     values ($1, $2, 1, $3, $4, $5, 'application/pdf') returning id`,
    [h.t1, nodeId, storageKey, 'a'.repeat(64), body.length],
  );
  const versionId = rows[0]!.id;
  const res = await runPipeline(
    { versionId, workspaceId: h.ws, storageKey, filename, mime: 'application/pdf' },
    [hashStep, convertStep(new GotenbergClient('http://127.0.0.1:9')), extractTextStep], storage, key,
  );
  expect(res).toMatchObject({ ok: true, completedSteps: ['hash', 'convert', 'extract'] });
  expect(res.facts.pages).toBe(pages.length);
  const text = res.derived.find((d) => d.kind === 'text')!;
  expect(storage.objects.get(text.storageKey)!.subarray(0, 5).toString()).toBe('VDRK1');   // encrypted at rest
  const extracted = parseExtractedText(await decryptBuffer(key, storage.objects.get(text.storageKey)!, text.storageKey));
  await h.app((tx) => indexText(tx, { workspaceId: h.ws, nodeId, versionId, pages: extracted }));
  return extracted;
}

async function grant(group: string, node: string, level: number) {
  await h.pg.query(
    `insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, recorded_at) values ($1, $2, $3, $4, $5, $6)`,
    [h.t1, h.ws, node, group, level, T.grantsSet.toISOString()],
  );
}

beforeEach(async () => {
  h = await heron();
  itDoc = (await h.pg.query<{ id: string }>(
    `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
     values ($1, $2, $3, 'document', 'Network diagram.pdf', '6.1', 'published') returning id`, [h.t1, h.ws, h.node.it])).rows[0]!.id;
  const storage = new MemoryStorage();
  const key = newDataKey();
  const pages = await ingest(storage, key, h.node.aud1, 'Audited financial statements FY2025.pdf', [
    'Statement of financial position at 30 June 2025',
    'Note 14: IFRS 16 lease liabilities amounted to R 42 million',
  ]);
  expect(pages[1]).toContain('IFRS 16 lease liabilities');
  await ingest(storage, key, h.node.tax1, 'Tax clearance certificate 2026.pdf', ['Germiston water use licence reference WUL-0042']);
  await ingest(storage, key, h.node.audDraft, "Auditor's management letter FY2025.pdf", ['Tarnley finding on IFRS 16 lease liabilities']);
  await ingest(storage, key, itDoc, 'Network diagram.pdf', ['Germiston data centre rack layout']);
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at });
});
afterEach(async () => {
  await app.close();
  await h.pg.close();
});

const search = (person: string, q: string, extra = '', headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: `/v1/workspaces/${h.ws}/search?q=${encodeURIComponent(q)}${extra}`,
    headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1, ...headers },
  });
const ids = (res: { json(): any }) => res.json().items.map((i: any) => i.nodeId);

describe('full-text search', () => {
  it('only searches documents the bidder can view', async () => {
    await grant(h.group.a, h.node.fin, 20);
    const res = await search(h.person.jan, 'lease liabilities');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(ids(res)).toEqual([h.node.aud1]);
    const hit = body.items[0];
    expect(hit).toMatchObject({ indexNumber: '3.2.1', kind: 'document', matchedIn: 'content', page: 2 });
    expect(hit.snippet).toContain('IFRS 16 lease liabilities');
    expect(hit.highlights.map(([s, e]: [number, number]) => hit.snippet.slice(s, e))).toEqual(['lease liabilities']);
    expect(hit).toMatchObject({ pagesMatched: 1, state: 'published', isNew: false });
    expect(hit.pages).toEqual([{ page: 2, snippet: hit.snippet, highlights: hit.highlights }]);

    expect(ids(await search(h.person.jan, 'Germiston'))).toEqual([h.node.tax1]);
    expect(ids(await search(h.person.anika, 'Germiston')).sort()).toEqual([h.node.tax1, itDoc].sort());
  });

  it('should match names only at Fence level', async () => {
    await grant(h.group.b, h.node.fin, 10);
    expect((await search(h.person.mei, 'Germiston')).json().items).toEqual([]);
    const res = (await search(h.person.mei, 'audited')).json();
    expect(res.items.map((i: any) => `${i.indexNumber} ${i.matchedIn}`).sort()).toEqual(['3.2 name', '3.2.1 name']);
    for (const i of res.items) expect([i.snippet, i.page, i.highlights]).toEqual([null, null, []]);
  });

  it('should hide drafts from bidders', async () => {
    await grant(h.group.a, h.node.fin, 20);
    expect((await search(h.person.jan, 'Tarnley')).json().items).toEqual([]);
    expect((await search(h.person.jan, 'management letter')).json().items).toEqual([]);
    expect(ids(await search(h.person.anika, 'Tarnley'))).toEqual([h.node.audDraft]);
    expect(ids(await search(h.person.anika, 'management letter'))).toEqual([h.node.audDraft]);
  });

  it('leaves hidden folders out of the path', async () => {
    await grant(h.group.a, h.node.aud, 20);
    const jan = (await search(h.person.jan, 'lease')).json().items[0];
    expect(jan.path.map((p: any) => `${p.indexNumber} ${p.name}`)).toEqual(['3.2 Audited financials']);
    const anika = (await search(h.person.anika, 'lease')).json().items.find((i: any) => i.nodeId === h.node.aud1);
    expect(anika.path.map((p: any) => p.indexNumber)).toEqual(['3', '3.2']);
  });

  it('caps an agent at its own level', async () => {
    await grant(h.group.a, h.node.fin, 20);
    const res = (await search(h.person.jan, 'audited lease', '', { 'x-dev-agent-max-level': '10' })).json();
    expect(res.items).toEqual([]);
    const names = (await search(h.person.jan, 'audited', '', { 'x-dev-agent-max-level': '10' })).json();
    expect(names.items.length).toBe(2);
    expect(names.items.every((i: any) => i.snippet === null && i.matchedIn === 'name')).toBe(true);
    expect((await search(h.person.jan, 'Germiston', '', { 'x-dev-agent-max-level': '10' })).json().items).toEqual([]);
    expect((await search(h.person.jan, 'Germiston', '', { 'x-dev-agent-max-level': '0' })).json().items).toEqual([]);
  });

  it('supports prefixes and phrases', async () => {
    await grant(h.group.a, h.node.fin, 20);
    expect(ids(await search(h.person.jan, 'germ'))).toEqual([h.node.tax1]);
    expect(ids(await search(h.person.jan, 'IFRS 16 lea'))).toEqual([h.node.aud1]);
    expect(ids(await search(h.person.jan, '"lease liabilities"'))).toEqual([h.node.aud1]);
    expect(ids(await search(h.person.jan, '"liabilities lease"'))).toEqual([]);
    expect(ids(await search(h.person.jan, 'lease -IFRS'))).toEqual([]);
    expect(splitQuery('"water use" lic')).toEqual({ rest: '"water use"', prefix: 'lic' });
    expect(splitQuery('"water use')).toEqual({ rest: '"water use', prefix: '' });
  });

  it('ranks name matches first', async () => {
    await grant(h.group.a, h.node.fin, 20);
    const res = (await search(h.person.jan, 'statement')).json();
    expect(res.items[0]).toMatchObject({ nodeId: h.node.aud1, matchedIn: 'name', page: 1 });
  });

  it('breaks ties by pages and index number', async () => {
    await grant(h.group.a, h.node.fin, 20);
    const storage = new MemoryStorage();
    const key = newDataKey();
    const add = async (name: string, ix: string, pages: string[]) => {
      const id = (await h.pg.query<{ id: string }>(
        `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
         values ($1, $2, $3, 'document', $4, $5, 'published') returning id`, [h.t1, h.ws, h.node.tax, name, ix])).rows[0]!.id;
      await ingest(storage, key, id, name, pages);
      return id;
    };
    const ten = await add('Plant register.pdf', '3.4.10', ['Kingfisher plant.']);
    const nine = await add('Site notes.pdf', '3.4.9', ['Kingfisher site.']);
    const two = await add('Water notes.pdf', '3.4.20', ['Kingfisher one.', 'Kingfisher two.']);
    const named = await add('Kingfisher.pdf', '3.4.30', ['Nothing here.']);
    expect(ids(await search(h.person.jan, 'kingfisher'))).toEqual([named, two, nine, ten]);
    expect(ids(await search(h.person.jan, 'kingfisher', '&match=names'))).toEqual([named]);
  });

  it('filters by folder', async () => {
    await grant(h.group.a, h.node.fin, 20);
    expect(ids(await search(h.person.jan, '2025', `&folder=${h.node.tax}`))).toEqual([]);
    expect(ids(await search(h.person.jan, '2025', `&folder=${h.node.aud}`))).toEqual([h.node.aud1]);
    expect((await search(h.person.jan, 'Germiston', `&folder=${h.node.it}`)).statusCode).toBe(404);
  });

  it('refuses an empty query', async () => {
    const res = await search(h.person.jan, '  ');
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('Type what you are looking for.');
    await grant(h.group.a, h.node.fin, 20);
    expect(ids(await search(h.person.jan, 'g'))).toEqual([h.node.tax1]);
  });

  it('returns up to two page extracts', async () => {
    await grant(h.group.a, h.node.fin, 20);
    const storage = new MemoryStorage();
    const key = newDataKey();
    const licence = (await h.pg.query<{ id: string }>(
      `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
       values ($1, $2, $3, 'document', 'Site register.pdf', '3.4.7', 'published') returning id`, [h.t1, h.ws, h.node.tax])).rows[0]!.id;
    await ingest(storage, key, licence, 'Site register.pdf', [
      'Confidential\nPage 1 of 3\nThe licence was renewed for the Germiston plant in 2024, and the renewal fee\nwas paid in full.',
      'Germiston site plan.',
      'Confidential\nPage 3 of 3\nSchedule of fees. Germiston water use licence reference WUL-0042 remains valid.',
    ]);
    const hit = (await search(h.person.jan, 'germiston licence')).json().items.find((i: any) => i.nodeId === licence);
    expect(hit).toMatchObject({ nodeId: licence, pagesMatched: 2 });
    expect(hit.pages.map((p: any) => p.page).sort()).toEqual([1, 3]);
    const p1 = hit.pages.find((p: any) => p.page === 1);
    expect(p1.snippet).toBe('The licence was renewed for the Germiston plant in 2024, and the renewal fee was paid in full.');
    expect(p1.highlights.map(([a, b]: [number, number]) => p1.snippet.slice(a, b))).toEqual(['licence', 'Germiston']);
    const p3 = hit.pages.find((p: any) => p.page === 3);
    expect(p3.snippet).toBe('Germiston water use licence reference WUL-0042 remains valid.');
    expect((await search(h.person.jan, 'germiston')).json().items.find((i: any) => i.nodeId === licence).pagesMatched).toBe(3);
  });

  it('marks drafts and new documents', async () => {
    await grant(h.group.a, h.node.fin, 20);
    const draft = (await search(h.person.anika, 'management letter')).json().items[0];
    expect(draft).toMatchObject({ nodeId: h.node.audDraft, state: 'draft', isNew: false });
    expect((await search(h.person.jan, 'lease')).json().items[0].isNew).toBe(false);   // no previous visit yet
    await h.pg.query(`update node set published_at = $1 where id = $2`, ['2026-11-10T09:00:00Z', h.node.aud1]);
    await h.pg.query(`update node set published_at = $1 where id = $2`, ['2026-11-05T09:00:00Z', h.node.tax1]);
    await h.pg.query(
      `insert into workspace_visit (tenant_id, workspace_id, person_id, previous_visit_at, last_visit_at) values ($1, $2, $3, $4, $5)`,
      [h.t1, h.ws, h.person.jan, '2026-11-08T09:00:00Z', '2026-11-11T09:00:00Z']);
    expect((await search(h.person.jan, 'lease')).json().items[0]).toMatchObject({ nodeId: h.node.aud1, isNew: true });
    expect((await search(h.person.jan, 'germiston')).json().items[0]).toMatchObject({ nodeId: h.node.tax1, isNew: false });
    expect((await search(h.person.mei, 'lease')).json().items).toEqual([]);
  });

  it('paginates', async () => {
    const all = (await search(h.person.anika, 'pdf')).json();
    expect(all.total).toBe(4);
    const second = (await search(h.person.anika, 'pdf', '&limit=2&offset=2')).json();
    expect(second.items.map((i: any) => i.nodeId)).toEqual(all.items.slice(2).map((i: any) => i.nodeId));
  });
});

describe('page extracts', () => {
  it('parses the query', () => {
    expect(queryTerms('change "supply agreement" -Germiston or lea')).toEqual({ terms: ['change', 'supply agreement', 'lea'], lastIsPrefix: true });
    expect(queryTerms('lease "change of control"')).toEqual({ terms: ['lease', 'change of control'], lastIsPrefix: false });
  });

  it('joins wrapped lines into sentences', () => {
    expect(sentences('Confidential\nPage 1 of 3\n6. CHANGE OF CONTROL\n6.1 Each Party shall notify the other in writing of any change of\ncontrol. 6.2 Should Drosvelt undergo a change of control, it tells Tarnley.\n6.3 Tarnley may end it.'))
      .toEqual(['Confidential', 'Page 1 of 3', '6. CHANGE OF CONTROL', '6.1 Each Party shall notify the other in writing of any change of control.',
        '6.2 Should Drosvelt undergo a change of control, it tells Tarnley.', '6.3 Tarnley may end it.']);
  });

  it('highlights the best sentence', () => {
    const body = 'CHANGE OF CONTROL\nThe control operated as designed.\nA change of control of the Supplier entitles Kwelanet to terminate this agreement on notice.';
    const x = pageExtract(body, 'change of control')!;
    expect(x.snippet).toBe('A change of control of the Supplier entitles Kwelanet to terminate this agreement on notice.');
    expect(x.highlights.map(([a, b]) => x.snippet.slice(a, b))).toEqual(['change of control']);
    const y = pageExtract('Consent of the lender is needed for any change in control.', 'change of control')!;
    expect(y.highlights.map(([a, b]) => y.snippet.slice(a, b))).toEqual(['change', 'control']);
    const z = pageExtract('Germiston warehouse lease.', 'germ')!;
    expect(z.highlights.map(([a, b]) => z.snippet.slice(a, b))).toEqual(['Germ']);
    const long = pageExtract(`${'Word '.repeat(80)}Germiston ${'tail '.repeat(80)}end.`, 'germiston')!;
    expect(long.snippet.length).toBeLessThan(230);
    expect(long.snippet.startsWith('… ') && long.snippet.endsWith(' …')).toBe(true);
    expect(pageExtract('Nothing here.', 'germiston')).toBeNull();
  });

  const NL = String.fromCharCode(10);
  it('skips a title in capitals', () => {
    const body = 'PACKAGING SUPPLY AGREEMENT' + NL + 'between' + NL + 'The Parties entered into a supply agreement on 14 February 2024 for packaging.';
    expect(pageExtract(body, '"supply agreement"')!.snippet).toBe('The Parties entered into a supply agreement on 14 February 2024 for packaging.');
    expect(pageExtract('CHANGE OF CONTROL CONSENTS TRACKER', 'change of control')!.snippet).toBe('CHANGE OF CONTROL CONSENTS TRACKER');
  });
});
