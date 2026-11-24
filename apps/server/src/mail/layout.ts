// SPDX-License-Identifier: AGPL-3.0-only
import type { InlineImage } from '@vdrkit/core';

// all escaping happens here

export interface MailBranding {
  orgName: string | null;
  logo: { png: Uint8Array; width: number; height: number } | null;
  privacyUrl: string | null;
}

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; muted?: boolean }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; code: string }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'facts'; rows: { label: string; value: string; mono?: boolean }[] }
  | { kind: 'alert'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'subheading'; text: string }
  | { kind: 'items'; rows: ItemRow[] }
  | { kind: 'link'; label: string; url: string };

export interface ItemRow {
  number?: string | null;
  title: string;
  url?: string | null;
  note?: string | null;
}

export type FooterPart = string | { label: string; url: string };
export type FooterLine = FooterPart[];

export interface EmailContent {
  header: { room?: string; label: string };
  blocks: Block[];
  footer: FooterLine[];
}

export interface RenderedEmail {
  html: string;
  text: string;
  inline: InlineImage[];
}

export const LOGO_CID = 'logo@vdrkit';

const C = {
  page: '#F4F7FA', card: '#FFFFFF', line: '#E3E9EF', lineStrong: '#CFD8E1', fg: '#1A2531', muted: '#626E7B', soft: '#4A5868',
  accent: '#13627A', accentText: '#0F5568', logoInk: '#2E2440',
  danger: '#B42318', dangerBg: '#FDECEA', ok: '#1F7A4D', okBg: '#E4F3EA',
};
const FONT = 'Arial, Helvetica, sans-serif';
const MONO = "'Courier New', Courier, monospace";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const multiline = (s: string) => escapeHtml(s.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');

export function safeUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('An email link must be an absolute web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('An email link must start with http or https.');
  return u.toString();
}

// letter-spacing, not a space: double-click must select all six. Outlook ignores span padding
export function codeHtml(code: string): string {
  const digits = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return escapeHtml(code);
  return `<span style="letter-spacing:6px;">${digits.slice(0, 2)}</span><span style="letter-spacing:22px;">${digits[2]}</span>`
    + `<span style="letter-spacing:6px;">${digits.slice(3)}</span>`;
}

function blockHtml(b: Block): string {
  const gap = 'margin:0 0 14px 0;';
  switch (b.kind) {
    case 'heading':
      return `<h2 style="${gap}font-family:${FONT};font-size:20px;line-height:28px;font-weight:700;color:${C.fg};">${escapeHtml(b.text)}</h2>`;
    case 'text':
      return b.muted
        ? `<p style="${gap}font-family:${FONT};font-size:14px;line-height:22px;color:${C.soft};">${multiline(b.text)}</p>`
        : `<p style="${gap}font-family:${FONT};font-size:15px;line-height:24px;color:${C.fg};">${multiline(b.text)}</p>`;
    case 'quote':
      return `<p style="${gap}font-family:${FONT};font-size:15px;line-height:24px;color:${C.soft};border-left:3px solid ${C.lineStrong};padding:0 0 0 12px;">${multiline(b.text)}</p>`;
    case 'code':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${gap}border-collapse:separate;"><tr>`
        + `<td style="font-family:${MONO};font-size:30px;line-height:36px;font-weight:700;letter-spacing:6px;color:${C.fg};background:${C.page};border:1px solid ${C.line};border-radius:8px;padding:12px 18px;">${codeHtml(b.code)}</td>`
        + '</tr></table>';
    case 'button':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${gap}border-collapse:separate;"><tr>`
        + `<td style="background:${C.accent};border-radius:8px;">`
        + `<a href="${escapeHtml(safeUrl(b.url))}" target="_blank" style="display:inline-block;padding:11px 20px;font-family:${FONT};font-size:15px;line-height:22px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escapeHtml(b.label)}</a>`
        + '</td></tr></table>';
    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="${gap}border-collapse:collapse;">`
        + b.rows.map((r) => '<tr>'
          + `<td valign="top" width="120" style="width:120px;padding:2px 12px 2px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${C.muted};">${escapeHtml(r.label)}</td>`
          + `<td valign="top" style="padding:2px 0;font-family:${r.mono ? MONO : FONT};font-size:${r.mono ? 13 : 14}px;line-height:20px;font-weight:700;color:${C.fg};word-break:break-word;">${multiline(r.value)}</td>`
          + '</tr>').join('')
        + '</table>';
    case 'alert':
    case 'ok': {
      const [fg, bg] = b.kind === 'alert' ? [C.danger, C.dangerBg] : [C.ok, C.okBg];
      return `<p style="${gap}font-family:${FONT};font-size:15px;line-height:24px;font-weight:700;color:${fg};background:${bg};border-radius:8px;padding:10px 14px;">${escapeHtml(b.text)}</p>`;
    }
    case 'subheading':
      return `<h3 style="margin:22px 0 8px 0;font-family:${FONT};font-size:13px;line-height:18px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${C.muted};">${escapeHtml(b.text)}</h3>`;
    case 'items':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="${gap}border-collapse:separate;border:1px solid ${C.line};border-radius:8px;">`
        + b.rows.map((r, i) => {
          const num = r.number ? `<span style="font-family:${MONO};color:${C.muted};">${escapeHtml(r.number)}</span>&nbsp; ` : '';
          const title = r.url
            ? `<a href="${escapeHtml(safeUrl(r.url))}" target="_blank" style="color:${C.accentText};font-weight:700;text-decoration:none;">${num}${escapeHtml(r.title)}</a>`
            : `<span style="color:${C.fg};font-weight:700;">${num}${escapeHtml(r.title)}</span>`;
          const note = r.note ? `<br><span style="font-size:12.5px;line-height:18px;color:${C.muted};">${escapeHtml(r.note)}</span>` : '';
          return `<tr><td style="padding:9px 14px;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:14px;line-height:20px;color:${C.fg};word-break:break-word;">${title}${note}</td></tr>`;
        }).join('')
        + '</table>';
    case 'link':
      return `<p style="${gap}font-family:${FONT};font-size:14px;line-height:22px;"><a href="${escapeHtml(safeUrl(b.url))}" target="_blank" style="color:${C.accentText};font-weight:700;">${escapeHtml(b.label)}</a></p>`;
  }
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'heading': case 'text': case 'alert': case 'ok': return b.text.replace(/\r\n?/g, '\n');
    case 'quote': return b.text.replace(/\r\n?/g, '\n').split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
    case 'code': return b.code;
    case 'button': return `${b.label}: ${safeUrl(b.url)}`;
    case 'facts': return b.rows.map((r) => `${r.label}: ${r.value.replace(/\s*\n\s*/g, ' ')}`).join('\n');
    case 'subheading': return b.text.toUpperCase();
    case 'items': return b.rows.map(itemText).join('\n');
    case 'link': return `${b.label}: ${safeUrl(b.url)}`;
  }
}

function itemText(r: ItemRow): string {
  let line = `- ${[r.number, r.title].filter(Boolean).join(' ')}`;
  if (r.url) line += ` (${safeUrl(r.url)})`;
  if (r.note) line += `\n  ${r.note}`;
  return line;
}

function footerHtml(line: FooterLine): string {
  return line.map((p) => (typeof p === 'string' ? escapeHtml(p)
    : `<a href="${escapeHtml(safeUrl(p.url))}" target="_blank" style="color:${C.accentText};">${escapeHtml(p.label)}</a>`)).join('');
}

function footerText(line: FooterLine): string {
  return line.map((p) => (typeof p === 'string' ? p : `${p.label} (${safeUrl(p.url)})`)).join('');
}

function logoHtml(b: MailBranding): string {
  const name = b.orgName?.trim() || 'VDRkit';
  if (b.logo) {
    return `<img src="cid:${LOGO_CID}" width="${b.logo.width}" height="${b.logo.height}" alt="${escapeHtml(name)}" `
      + `style="display:block;border:0;outline:none;width:${b.logo.width}px;height:${b.logo.height}px;">`;
  }
  return `<span style="font-family:Georgia, 'Times New Roman', serif;font-size:18px;line-height:24px;font-weight:700;letter-spacing:1px;color:${C.logoInk};">${escapeHtml(name)}</span>`;
}

function emailLogoSize(l: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, 32 / l.height, 180 / l.width);
  return { width: Math.max(1, Math.round(l.width * scale)), height: Math.max(1, Math.round(l.height * scale)) };
}

export function renderEmail(subject: string, brand: MailBranding, c: EmailContent): RenderedEmail {
  if (c.blocks.filter((b) => b.kind === 'button').length > 1) throw new Error('An email has at most one button.');
  const footer: FooterLine[] = [...c.footer];
  if (brand.privacyUrl) footer.push([{ label: 'Privacy notice', url: brand.privacyUrl }]);
  const logo = brand.logo ? { ...brand.logo, ...emailLogoSize(brand.logo) } : null;
  const b = { ...brand, logo };

  const header = c.header.room
    ? `<b style="color:${C.fg};">${escapeHtml(c.header.room)}</b><br>${escapeHtml(c.header.label)}`
    : escapeHtml(c.header.label);
  const html = '<!doctype html>\n'
    + '<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">'
    + `<title>${escapeHtml(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:${C.page};color-scheme:light;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};"><tr><td align="center" style="padding:24px 12px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:${C.card};border:1px solid ${C.line};border-radius:8px;border-collapse:separate;">`
    + `<tr><td style="padding:20px 28px;border-bottom:1px solid ${C.line};">`
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + `<td align="left" valign="middle">${logoHtml(b)}</td>`
    + `<td align="right" valign="middle" style="font-family:${FONT};font-size:12px;line-height:16px;color:${C.muted};text-align:right;">${header}</td>`
    + '</tr></table></td></tr>'
    + `<tr><td style="padding:24px 28px 8px 28px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.fg};">`
    + c.blocks.map(blockHtml).join('')
    + '</td></tr>'
    + `<tr><td style="padding:16px 28px 22px 28px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">`
    + footer.map(footerHtml).join('<br>')
    + '</td></tr>'
    + '</table></td></tr></table></body></html>\n';

  const text = [
    ...c.blocks.map(blockText),
    '',
    footer.map(footerText).join('\n'),
  ].join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const inline: InlineImage[] = brand.logo ? [{ cid: LOGO_CID, filename: 'logo.png', contentType: 'image/png', content: brand.logo.png }] : [];
  return { html, text, inline };
}
