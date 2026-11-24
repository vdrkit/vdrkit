// SPDX-License-Identifier: AGPL-3.0-only
import { inflateRawSync } from 'node:zlib';

// LibreOffice will happily convert garbage; check content against the extension first

type Kind = { what: string; check: (b: Buffer) => boolean };

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const isOle = (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(OLE);
const isZip = (b: Buffer) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;
const hasStream = (b: Buffer, name: string) => b.includes(Buffer.from(name, 'utf16le'));

function start(b: Buffer, n = 64): string {
  let s = b.subarray(0, 512).toString('latin1');
  if (s.startsWith('\xef\xbb\xbf')) s = s.slice(3);
  return s.trimStart().slice(0, n);
}
const isUtf16 = (b: Buffer) => b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
const isText = (b: Buffer) => isUtf16(b) || !b.subarray(0, 64 * 1024).includes(0);
const isMarkup = (b: Buffer) => start(b).startsWith('<');
const isRtf = (b: Buffer) => start(b).startsWith('{\\rtf');

export function zipEntry(b: Buffer, name: string, max = 1024 * 1024): Buffer | null | undefined {
  try {
    const from = Math.max(0, b.length - 65_557);
    let eocd = -1;
    for (let i = b.length - 22; i >= from; i--) {
      if (b.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return undefined;
    let count = b.readUInt16LE(eocd + 10);
    let offset = b.readUInt32LE(eocd + 16);
    if ((count === 0xffff || offset === 0xffffffff) && eocd >= 20 && b.readUInt32LE(eocd - 20) === 0x07064b50) {
      const z64 = Number(b.readBigUInt64LE(eocd - 12));
      if (b.readUInt32LE(z64) !== 0x06064b50) return undefined;
      count = Number(b.readBigUInt64LE(z64 + 32));
      offset = Number(b.readBigUInt64LE(z64 + 48));
    }
    let p = offset;
    for (let n = 0; n < count && p + 46 <= b.length; n++) {
      if (b.readUInt32LE(p) !== 0x02014b50) return undefined;
      const method = b.readUInt16LE(p + 10);
      let compressed = b.readUInt32LE(p + 20);
      const nameLen = b.readUInt16LE(p + 28);
      const extraLen = b.readUInt16LE(p + 30);
      const commentLen = b.readUInt16LE(p + 32);
      let local = b.readUInt32LE(p + 42);
      const entryName = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      if (entryName === name) {
        if (compressed === 0xffffffff || local === 0xffffffff) {
          const extra = b.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
          for (let e = 0; e + 4 <= extra.length;) {
            const id = extra.readUInt16LE(e);
            const len = extra.readUInt16LE(e + 2);
            if (id === 1) {
              let q = e + 4;
              if (b.readUInt32LE(p + 24) === 0xffffffff) q += 8;
              if (compressed === 0xffffffff) {
                compressed = Number(extra.readBigUInt64LE(q));
                q += 8;
              }
              if (local === 0xffffffff) local = Number(extra.readBigUInt64LE(q));
            }
            e += 4 + len;
          }
        }
        if (b.readUInt32LE(local) !== 0x04034b50) return undefined;
        const data = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
        const raw = b.subarray(data, data + compressed);
        if (method === 0) return raw.subarray(0, max);
        if (method === 8) return inflateRawSync(raw, { maxOutputLength: max });
        return undefined;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return undefined;
  }
}

// truncated zip passes; the converter reports it as damaged
const ooxml = (main: RegExp) => (b: Buffer) => {
  if (!isZip(b)) return false;
  const types = zipEntry(b, '[Content_Types].xml');
  if (types === undefined) return true;
  return !!types && main.test(types.toString('utf8'));
};
const WORD_MAIN = /wordprocessingml\.(document|template)\.main|ms-word\.(document|template)\.macroEnabled/i;
const EXCEL_MAIN = /spreadsheetml\.(sheet|template)\.main|ms-excel\.(sheet|template)\.(binary\.)?macroEnabled/i;
const POWERPOINT_MAIN = /presentationml\.(presentation|slideshow|template)\.main|ms-powerpoint\.(presentation|slideshow|template)\.macroEnabled/i;

const word = ooxml(WORD_MAIN);
const excel = ooxml(EXCEL_MAIN);
const powerpoint = ooxml(POWERPOINT_MAIN);
const encrypted = (b: Buffer) => isOle(b) && hasStream(b, 'EncryptedPackage');
const odf = (type: string) => (b: Buffer) => isZip(b) && b.subarray(0, 200).includes(`application/vnd.oasis.opendocument.${type}`);

const wordx = (b: Buffer) => word(b) || encrypted(b);
const excelx = (b: Buffer) => excel(b) || encrypted(b);
const legacyWord = (b: Buffer) => (isOle(b) && hasStream(b, 'WordDocument')) || word(b) || isRtf(b) || isMarkup(b);

const WORD_DOC = 'Word document';
const EXCEL = 'Excel workbook';
const POWERPOINT = 'PowerPoint presentation';

const KINDS: Record<string, Kind> = {
  docx: { what: WORD_DOC, check: wordx },
  dotx: { what: WORD_DOC, check: wordx },
  xlsx: { what: EXCEL, check: excelx },
  xlsm: { what: EXCEL, check: excelx },
  xlsb: { what: EXCEL, check: excelx },
  pptx: { what: POWERPOINT, check: (b) => powerpoint(b) || encrypted(b) },
  doc: { what: WORD_DOC, check: legacyWord },
  dot: { what: WORD_DOC, check: legacyWord },
  xls: { what: EXCEL, check: (b) => (isOle(b) && (hasStream(b, 'Workbook') || hasStream(b, 'Book'))) || excel(b) || isMarkup(b) },
  ppt: { what: POWERPOINT, check: (b) => (isOle(b) && hasStream(b, 'PowerPoint Document')) || powerpoint(b) || isMarkup(b) },
  odt: { what: 'OpenDocument text', check: odf('text') },
  ods: { what: 'OpenDocument spreadsheet', check: odf('spreadsheet') },
  odp: { what: 'OpenDocument presentation', check: odf('presentation') },
  rtf: { what: 'RTF document', check: isRtf },
  txt: { what: 'text file', check: isText },
  csv: { what: 'CSV file', check: isText },
  html: { what: 'web page', check: isText },
  htm: { what: 'web page', check: isText },
  pdf: { what: 'PDF', check: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
};

export function claimedTypeProblem(ext: string, body: Buffer): string | null {
  const kind = KINDS[ext.toLowerCase()];
  if (!kind || kind.check(body)) return null;
  return `This file is not a real ${kind.what}. Open it on your computer, save it again and upload the new copy.`;
}
