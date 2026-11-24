// SPDX-License-Identifier: AGPL-3.0-only
import { deflateRawSync } from 'node:zlib';
import type { Block } from '../../demo/documents.js';

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

const CRC_TABLE = crcTable();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = (7 << 11) | (30 << 5);
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 3;

export function zip(members: [string, string | Buffer][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of members) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const packed = deflateRawSync(data, { level: 6 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, packed);
    central.push(cd, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const cdBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBytes, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OOXML = 'application/vnd.openxmlformats-officedocument';

function contentTypes(overrides: [string, string][]): string {
  return `${XML}<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
}

function rels(list: [string, string, string][]): string {
  return `${XML}<Relationships xmlns="${PKG_REL}">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

function rootRels(main: string): string {
  return rels([
    ['rId1', `${REL}/officeDocument`, main],
    ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
  ]);
}

export interface FileInfo { title: string; author: string; created: Date }

function core(i: FileInfo): string {
  const at = i.created.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" `
    + 'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${esc(i.title)}</dc:title><dc:creator>${esc(i.author)}</dc:creator><cp:lastModifiedBy>${esc(i.author)}</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${at}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${at}</dcterms:modified></cp:coreProperties>`;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const run = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text: string, pPr = '', rPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${text ? run(text, rPr) : ''}</w:p>`;

export function docx(blocks: Block[], info: FileInfo, opts: { landscape?: boolean } = {}): Buffer {
  const [pw, ph] = opts.landscape ? [16838, 11906] : [11906, 16838];
  const textWidth = pw - 2 * 1134;
  const body: string[] = [];
  for (const b of blocks) {
    if (b.t === 'title') body.push(para(b.text, '<w:pStyle w:val="Title"/>'));
    else if (b.t === 'center') body.push(para(b.text, '<w:jc w:val="center"/>', b.bold ? '<w:b/>' : ''));
    else if (b.t === 'h') body.push(para(b.text, '<w:pStyle w:val="Heading1"/>'));
    else if (b.t === 'p') body.push(para(b.text));
    else if (b.t === 'li') body.push(para(`•\t${b.text}`, '<w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="360"/>'));
    else if (b.t === 'gap') body.push(para(''));
    else if (b.t === 'break') body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else if (b.t === 'table') {
      const widths = (b.widths ?? b.columns.map(() => 1 / b.columns.length)).map((w) => Math.round(w * textWidth));
      const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/>`;
      const cell = (text: string, i: number, bold: boolean) =>
        `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr>${para(text, '<w:spacing w:after="0"/>', `${bold ? '<w:b/>' : ''}<w:sz w:val="18"/>`)}</w:tc>`;
      body.push(`<w:tbl><w:tblPr><w:tblW w:w="${textWidth}" w:type="dxa"/><w:tblBorders>${['top', 'bottom', 'insideH'].map(border).join('')}</w:tblBorders>`
        + '<w:tblCellMar><w:left w:w="60" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr>'
        + `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
        + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${b.columns.map((c, i) => cell(c, i, true)).join('')}</w:tr>`
        + b.rows.map((r) => `<w:tr>${b.columns.map((_, i) => cell(r[i] ?? '', i, false)).join('')}</w:tr>`).join('')
        + '</w:tbl>');
      body.push(para(''));
    }
  }
  const sect = `<w:sectPr><w:pgSz w:w="${pw}" w:h="${ph}"${opts.landscape ? ' w:orient="landscape"' : ''}/>`
    + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
  const document = `${XML}<w:document xmlns:w="${W_NS}" xmlns:r="${REL}"><w:body>${body.join('')}${sect}</w:body></w:document>`;
  const styles = `${XML}<w:styles xmlns:w="${W_NS}">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="21"/><w:lang w:val="en-ZA"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>'
    + '</w:styles>';
  return zip([
    ['[Content_Types].xml', contentTypes([['/word/document.xml', `${OOXML}.wordprocessingml.document.main+xml`], ['/word/styles.xml', `${OOXML}.wordprocessingml.styles+xml`]])],
    ['_rels/.rels', rootRels('word/document.xml')],
    ['word/_rels/document.xml.rels', rels([['rId1', `${REL}/styles`, 'styles.xml']])],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['docProps/core.xml', core(info)],
  ]);
}

export type Cell = string | number | null | { v: number | string; f?: string; bold?: boolean; pct?: boolean };

export interface Sheet {
  name: string;
  title?: string;
  columns: string[];
  rows: Cell[][];
  widths?: number[];
}

const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XF = { plain: 0, header: 1, number: 2, title: 3, pct: 4, boldNumber: 5, boldText: 6, boldPct: 7, decimal: 8 };

export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellXml(ref: string, c: Cell, header = false): string {
  if (c === null || c === '') return '';
  const o = typeof c === 'object' ? c : { v: c };
  if (typeof o.v === 'string') {
    const s = header ? XF.header : o.bold ? XF.boldText : XF.plain;
    return `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
  }
  let s = Number.isInteger(o.v) ? XF.number : XF.decimal;
  if (o.pct) s = o.bold ? XF.boldPct : XF.pct;
  else if (o.bold) s = XF.boldNumber;
  const v = Number.isInteger(o.v) ? String(o.v) : String(Math.round(o.v * 10000) / 10000);
  return `<c r="${ref}" s="${s}">${o.f ? `<f>${esc(o.f)}</f>` : ''}<v>${v}</v></c>`;
}

export function xlsx(sheets: Sheet[], info: FileInfo): Buffer {
  const parts: [string, string][] = [];
  const files: [string, string][] = [];
  sheets.forEach((sh, n) => {
    const rows: string[] = [];
    let r = 1;
    if (sh.title) {
      rows.push(`<row r="1"><c r="A1" t="inlineStr" s="${XF.title}"><is><t xml:space="preserve">${esc(sh.title)}</t></is></c></row>`);
      r = 3;
    }
    rows.push(`<row r="${r}">${sh.columns.map((c, i) => cellXml(`${colName(i)}${r}`, c, true)).join('')}</row>`);
    for (const row of sh.rows) {
      r++;
      rows.push(`<row r="${r}">${row.map((c, i) => cellXml(`${colName(i)}${r}`, c)).join('')}</row>`);
    }
    const widths = sh.widths ?? sh.columns.map((c, i) => (i === 0 ? 36 : Math.max(12, c.length + 2)));
    const xml = `${XML}<worksheet xmlns="${S_NS}" xmlns:r="${REL}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`
      + `<dimension ref="A1:${colName(sh.columns.length - 1)}${r}"/><sheetViews><sheetView workbookViewId="0"${n === 0 ? ' tabSelected="1"' : ''}/></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      + `<sheetData>${rows.join('')}</sheetData>`
      + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
      + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
    files.push([`xl/worksheets/sheet${n + 1}.xml`, xml]);
    parts.push([`/xl/worksheets/sheet${n + 1}.xml`, `${OOXML}.spreadsheetml.worksheet+xml`]);
  });
  // Excel: max 31 chars, unique, none of []:*?/\ allowed
  const names = sheets.map((s, i) => s.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 28) || `Sheet${i + 1}`);
  const workbook = `${XML}<workbook xmlns="${S_NS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>`
    + names.map((nm, i) => `<sheet name="${esc(names.indexOf(nm) === i ? nm : `${nm} ${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>';
  const styles = `${XML}<styleSheet xmlns="${S_NS}">`
    + '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0;(#,##0);&quot;-&quot;"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts>'
    + '<fonts count="3"><font><sz val="10"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="13"/><color rgb="FF1E3A5F"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFE8ECF1"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA5B1"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="9">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>'
    + '<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>'
    + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return zip([
    ['[Content_Types].xml', contentTypes([['/xl/workbook.xml', `${OOXML}.spreadsheetml.sheet.main+xml`], ...parts, ['/xl/styles.xml', `${OOXML}.spreadsheetml.styles+xml`]])],
    ['_rels/.rels', rootRels('xl/workbook.xml')],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels([...sheets.map((_, i): [string, string, string] => [`rId${i + 1}`, `${REL}/worksheet`, `worksheets/sheet${i + 1}.xml`]),
      [`rId${sheets.length + 1}`, `${REL}/styles`, 'styles.xml']])],
    ...files,
    ['xl/styles.xml', styles],
    ['docProps/core.xml', core(info)],
  ]);
}

export interface Slide {
  title: string;
  subtitle?: string;
  bullets?: string[];
  table?: { columns: string[]; rows: string[][] };
}

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS3 = `xmlns:a="${A_NS}" xmlns:r="${REL}" xmlns:p="${P_NS}"`;
const EMU = 12700;   // per point
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const NAVY = '1E3A5F';
const INK = '1F2937';
const GREY = '6B7280';

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

function textBox(id: number, name: string, x: number, y: number, cx: number, cy: number, paras: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

const aRun = (text: string, size: number, color: string, bold = false) =>
  `<a:r><a:rPr lang="en-GB" sz="${size * 100}"${bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;

function slideXml(s: Slide, no: number, footer: string): string {
  const margin = 36 * EMU * 1.5;
  const width = SLIDE_W - 2 * margin;
  const shapes: string[] = [];
  shapes.push(textBox(2, 'Title', margin, 40 * EMU, width, 60 * EMU, `<a:p>${aRun(s.title, 28, NAVY, true)}</a:p>`));
  let y = 100 * EMU;
  if (s.subtitle) {
    shapes.push(textBox(3, 'Subtitle', margin, y, width, 30 * EMU, `<a:p>${aRun(s.subtitle, 16, GREY)}</a:p>`));
    y += 36 * EMU;
  }
  if (s.bullets?.length) {
    const h = Math.min(s.table ? 150 : 360, 30 + s.bullets.length * 34) * EMU;
    const paras = s.bullets.map((b) => `<a:p><a:pPr marL="285750" indent="-285750"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>${aRun(b, 18, INK)}</a:p>`).join('');
    shapes.push(textBox(4, 'Points', margin, y, width, h, paras));
    y += h + 10 * EMU;
  }
  if (s.table) {
    const cols = s.table.columns.length;
    const first = Math.round(width * (cols > 2 ? 0.34 : 0.5));
    const rest = Math.round((width - first) / Math.max(1, cols - 1));
    const colW = s.table.columns.map((_, i) => (i === 0 ? first : rest));
    const rowH = 26 * EMU;
    const line = '<a:lnB w="6350"><a:solidFill><a:srgbClr val="BFC5CC"/></a:solidFill></a:lnB>';
    const cell = (t: string, header: boolean, i: number) =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${i > 0 ? '<a:pPr algn="r"/>' : ''}${aRun(t, 13, header ? NAVY : INK, header)}</a:p></a:txBody>`
      + `<a:tcPr marL="45720" marR="45720" marT="22860" marB="22860">${line}${header ? '<a:solidFill><a:srgbClr val="E8ECF1"/></a:solidFill>' : '<a:noFill/>'}</a:tcPr></a:tc>`;
    const rows = [s.table.columns, ...s.table.rows];
    shapes.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
      + `<p:xfrm><a:off x="${margin}" y="${y}"/><a:ext cx="${width}" cy="${rowH * rows.length}"/></p:xfrm>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/>`
      + `<a:tblGrid>${colW.map((w) => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>`
      + rows.map((r, ri) => `<a:tr h="${rowH}">${s.table!.columns.map((_, i) => cell(r[i] ?? '', ri === 0, i)).join('')}</a:tr>`).join('')
      + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>');
  }
  shapes.push(textBox(6, 'Footer', margin, SLIDE_H - 34 * EMU, width, 20 * EMU,
    `<a:p>${aRun(`${footer}   ${no}`, 10, GREY)}</a:p>`));
  return `${XML}<p:sld ${NS3}><p:cSld><p:spTree>${GROUP}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const THEME = `${XML}<a:theme xmlns:a="${A_NS}" name="Heron"><a:themeElements><a:clrScheme name="Heron">`
  + `<a:dk1><a:srgbClr val="${INK}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="${NAVY}"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>`
  + ['2F5D8A', 'E07B39', '4B8F6E', '8E6BB0', 'C9A227', '5A7184'].map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('')
  + '<a:hlink><a:srgbClr val="2F5D8A"/></a:hlink><a:folHlink><a:srgbClr val="8E6BB0"/></a:folHlink></a:clrScheme>'
  + '<a:fontScheme name="Heron"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Heron">'
  + `<a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst>`
  + `<a:lnStyleLst>${'<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3)}</a:lnStyleLst>`
  + `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`
  + `<a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst>`
  + '</a:fmtScheme></a:themeElements></a:theme>';

export function pptx(slides: Slide[], info: FileInfo, footer: string): Buffer {
  const master = `${XML}<p:sldMaster ${NS3}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>`
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
  const layout = `${XML}<p:sldLayout ${NS3} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const presentation = `${XML}<p:presentation ${NS3}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const slideRels = rels([['rId1', `${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml']]);
  const P = `${OOXML}.presentationml`;
  return zip([
    ['[Content_Types].xml', contentTypes([
      ['/ppt/presentation.xml', `${P}.presentation.main+xml`],
      ['/ppt/slideMasters/slideMaster1.xml', `${P}.slideMaster+xml`],
      ['/ppt/slideLayouts/slideLayout1.xml', `${P}.slideLayout+xml`],
      ['/ppt/theme/theme1.xml', `${OOXML}.theme+xml`],
      ...slides.map((_, i): [string, string] => [`/ppt/slides/slide${i + 1}.xml`, `${P}.slide+xml`]),
    ])],
    ['_rels/.rels', rootRels('ppt/presentation.xml')],
    ['ppt/presentation.xml', presentation],
    ['ppt/_rels/presentation.xml.rels', rels([
      ['rId1', `${REL}/slideMaster`, 'slideMasters/slideMaster1.xml'],
      ['rId2', `${REL}/theme`, 'theme/theme1.xml'],
      ...slides.map((_, i): [string, string, string] => [`rId${i + 3}`, `${REL}/slide`, `slides/slide${i + 1}.xml`]),
    ])],
    ['ppt/slideMasters/slideMaster1.xml', master],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', `${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml'], ['rId2', `${REL}/theme`, '../theme/theme1.xml']])],
    ['ppt/slideLayouts/slideLayout1.xml', layout],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', `${REL}/slideMaster`, '../slideMasters/slideMaster1.xml']])],
    ['ppt/theme/theme1.xml', THEME],
    ...slides.flatMap((s, i): [string, string][] => [[`ppt/slides/slide${i + 1}.xml`, slideXml(s, i + 1, footer)], [`ppt/slides/_rels/slide${i + 1}.xml.rels`, slideRels]]),
    ['docProps/core.xml', core(info)],
  ]);
}
