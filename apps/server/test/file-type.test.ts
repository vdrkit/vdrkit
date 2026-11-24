// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { claimedTypeProblem, zipEntry } from '../src/pipeline/file-type.js';
import { convertStep, GotenbergClient, MemoryStorage, runPipeline } from '../src/pipeline/pipeline.js';
import { encryptBuffer, newDataKey } from '../src/crypto/envelope.js';

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures/office', name));

function zip(members: [string, string, 'store'?][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text, how] of members) {
    const raw = Buffer.from(text);
    const data = how === 'store' ? raw : deflateRawSync(raw);
    const n = Buffer.from(name);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(how === 'store' ? 0 : 8, 8);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(how === 'store' ? 0 : 8, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, data);
    centrals.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const types = (main: string) => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/x.xml" ContentType="application/vnd.${main}+xml"/></Types>`;
const docx = zip([['[Content_Types].xml', types('openxmlformats-officedocument.wordprocessingml.document.main')], ['word/document.xml', '<w:document/>']]);
const xlsm = zip([['[Content_Types].xml', types('ms-excel.sheet.macroEnabled.main')]]);
const pptx = zip([['[Content_Types].xml', types('openxmlformats-officedocument.presentationml.presentation.main')]]);
const ole = (stream: string) => Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(504), Buffer.from(stream, 'utf16le'), Buffer.alloc(64)]);

const word = 'This file is not a real Word document. Open it on your computer, save it again and upload the new copy.';
const excel = 'This file is not a real Excel workbook. Open it on your computer, save it again and upload the new copy.';
const powerpoint = 'This file is not a real PowerPoint presentation. Open it on your computer, save it again and upload the new copy.';

describe('claimedTypeProblem', () => {
  it('accepts real Office files, including protected ones', () => {
    expect(claimedTypeProblem('docx', fixture('memo.docx'))).toBeNull();
    expect(claimedTypeProblem('xlsx', fixture('accounts.xlsx'))).toBeNull();
    expect(claimedTypeProblem('pptx', fixture('memo.pptx'))).toBeNull();
    expect(claimedTypeProblem('docx', fixture('protected.docx'))).toBeNull();
    expect(claimedTypeProblem('xlsx', fixture('protected.xlsx'))).toBeNull();
    expect(claimedTypeProblem('pdf', fixture('protected.pdf'))).toBeNull();
    expect(claimedTypeProblem('XLSM', xlsm)).toBeNull();
    expect(claimedTypeProblem('dotx', docx)).toBeNull();
  });

  it('rejects random bytes named as Office or PDF', () => {
    const junk = randomBytes(4096);
    expect(claimedTypeProblem('xlsx', junk)).toBe(excel);
    expect(claimedTypeProblem('docx', junk)).toBe(word);
    expect(claimedTypeProblem('pptx', junk)).toBe(powerpoint);
    expect(claimedTypeProblem('doc', junk)).toBe(word);
    expect(claimedTypeProblem('xls', junk)).toBe(excel);
    expect(claimedTypeProblem('ppt', junk)).toBe(powerpoint);
    expect(claimedTypeProblem('odt', junk)).toBe('This file is not a real OpenDocument text. Open it on your computer, save it again and upload the new copy.');
    expect(claimedTypeProblem('rtf', junk)).toBe('This file is not a real RTF document. Open it on your computer, save it again and upload the new copy.');
    expect(claimedTypeProblem('csv', Buffer.concat([Buffer.from('a,b\n'), junk]))).toBe('This file is not a real CSV file. Open it on your computer, save it again and upload the new copy.');
    expect(claimedTypeProblem('pdf', junk)).toBe('This file is not a real PDF. Open it on your computer, save it again and upload the new copy.');
  });

  it('checks the program of ZIP and OLE files', () => {
    expect(claimedTypeProblem('xlsx', fixture('memo.docx'))).toBe(excel);
    expect(claimedTypeProblem('docx', pptx)).toBe(word);
    expect(claimedTypeProblem('pptx', zip([['readme.txt', 'just a zip']]))).toBe(powerpoint);
    expect(claimedTypeProblem('docx', ole('WordDocument'))).toBe(word);     // old .doc
    expect(claimedTypeProblem('doc', ole('WordDocument'))).toBeNull();
    expect(claimedTypeProblem('xls', ole('Workbook'))).toBeNull();
    expect(claimedTypeProblem('xls', ole('Book'))).toBeNull();               // Excel 5 and 95
    expect(claimedTypeProblem('ppt', ole('PowerPoint Document'))).toBeNull();
    expect(claimedTypeProblem('doc', ole('Workbook'))).toBe(word);
    expect(claimedTypeProblem('docx', ole('EncryptedPackage'))).toBeNull();
  });

  it('accepts HTML, XML and RTF under old Office names', () => {
    expect(claimedTypeProblem('xls', Buffer.from('\uFEFF  <html><table><tr><td>1</td></tr></table></html>'))).toBeNull();
    expect(claimedTypeProblem('xls', Buffer.from('<?xml version="1.0"?><Workbook/>'))).toBeNull();
    expect(claimedTypeProblem('doc', Buffer.from('{\\rtf1\\ansi Hello}'))).toBeNull();
    expect(claimedTypeProblem('doc', docx)).toBeNull();
    expect(claimedTypeProblem('xls', fixture('accounts.xlsx'))).toBeNull();
  });

  it('checks OpenDocument mimetype and text files', () => {
    const odt = zip([['mimetype', 'application/vnd.oasis.opendocument.text', 'store'], ['content.xml', '<office:document-content/>']]);
    expect(claimedTypeProblem('odt', odt)).toBeNull();
    expect(claimedTypeProblem('ods', odt)).toBe('This file is not a real OpenDocument spreadsheet. Open it on your computer, save it again and upload the new copy.');
    expect(claimedTypeProblem('csv', Buffer.from('Name;Amount\r\nHeron;12,5\r\n', 'latin1'))).toBeNull();
    expect(claimedTypeProblem('txt', Buffer.from('\uFEFFNotes', 'utf16le'))).toBeNull();   // UTF-16 BOM
    expect(claimedTypeProblem('html', Buffer.from('<p>Hello</p>'))).toBeNull();
  });

  it('ignores unchecked types', () => {
    expect(claimedTypeProblem('zip', randomBytes(64))).toBeNull();
    expect(claimedTypeProblem('png', randomBytes(64))).toBeNull();
    expect(claimedTypeProblem('', randomBytes(64))).toBeNull();
  });

  it('reads ZIP members and tolerates broken archives', () => {
    expect(zipEntry(docx, 'word/document.xml')?.toString()).toBe('<w:document/>');
    expect(zipEntry(docx, 'missing.xml')).toBeNull();
    expect(zipEntry(docx.subarray(0, 40), '[Content_Types].xml')).toBeUndefined();
    expect(zipEntry(randomBytes(100), '[Content_Types].xml')).toBeUndefined();
  });

  it('lets truncated Office files through', () => {
    expect(claimedTypeProblem('docx', fixture('memo.docx').subarray(0, 3000))).toBeNull();
  });

  it('fails before calling the converter', async () => {
    const storage = new MemoryStorage();
    const key = newDataKey();
    const storageKey = 'ws/heron/originals/Cash flow.xlsx';
    await storage.put(storageKey, await encryptBuffer(key, randomBytes(20_000), storageKey));
    let called = false;
    const gotenberg = new GotenbergClient('http://127.0.0.1:9');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { called = true; throw new Error('not expected'); }) as typeof fetch;
    try {
      const res = await runPipeline({ versionId: 'v1', workspaceId: 'heron', storageKey, filename: 'Cash flow.xlsx', mime: 'application/octet-stream' },
        [convertStep(gotenberg)], storage, key);
      expect(res).toMatchObject({ ok: false, failedStep: 'convert', error: excel });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
