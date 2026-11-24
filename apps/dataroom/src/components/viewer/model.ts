// SPDX-License-Identifier: AGPL-3.0-only

export const LEVEL_LABEL: Record<number, string> = { 20: 'View', 30: 'Encrypted PDF', 40: 'Print', 50: 'Download PDF', 60: 'Original' };

export function levelClass(level: number): string {
  if (level >= 60) return 'l60';
  if (level >= 50) return 'l50';
  if (level >= 30) return 'l40';
  return 'l20';
}

export function levelLabel(level: number): string {
  if (level >= 60) return LEVEL_LABEL[60]!;
  if (level >= 50) return LEVEL_LABEL[50]!;
  if (level >= 40) return LEVEL_LABEL[40]!;
  if (level >= 30) return LEVEL_LABEL[30]!;
  return LEVEL_LABEL[20]!;
}

// never name a group: leaks other groups' settings. 30/40: viewer lacks the feature, not the right
export function rightsSentence(level: number, isAdmin: boolean, watermark: WatermarkNote = DEFAULT_WATERMARK): string {
  if (isAdmin) return 'Room admins can read, download the PDF and download the original file.';
  const stamp = watermarkSentence(watermark, 'you', 'Every page of the PDF');
  if (level >= 60) return `Your group can read this document, download it as a PDF and download the original file. ${stamp}`;
  if (level >= 50) return `Your group can read this document and download it as a PDF. ${stamp}`;
  if (level >= 40) return 'Your group can read this document online. Printing and the encrypted PDF download are not available in the viewer yet.';
  if (level >= 30) return 'Your group can read this document online. The encrypted PDF download is not available in the viewer yet.';
  return 'Your group can read this document online. Downloading and printing are not available for this document.';
}

export const canDownloadPdf = (level: number) => level >= 50;
export const canDownloadOriginal = (level: number) => level >= 60;

export function displayName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, '');
}

export function fileType(fileName: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(fileName);
  return m ? m[1]!.toUpperCase() : 'File';
}

export const pagesLabel = (n: number) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'page' : 'pages'}`;

// unread: never for admins
export interface Sibling { id: string; indexNumber: string | null; name: string; state?: 'draft' | 'withdrawn'; unread?: true }

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000).toLocaleString('en-GB')} KB`;
  return `${bytes.toLocaleString('en-GB')} bytes`;
}

// admins also list drafts and withdrawn
export function readableSiblings<T extends { id: string; kind: string; state: string }>(items: T[], currentId: string): T[] {
  return items.filter((x) => x.kind === 'document' && (x.state === 'published' || x.id === currentId));
}

export function nearWindow<T extends { id: string }>(docs: T[], id: string, size = 5): T[] {
  if (docs.length <= size) return docs;
  const i = Math.max(0, docs.findIndex((d) => d.id === id));
  const start = Math.max(0, Math.min(i - Math.floor(size / 2), docs.length - size));
  return docs.slice(start, start + size);
}

// null = switched off
export interface WatermarkNote { name: string | null; email: string | null; group: string | null; dateTime: boolean; ip: boolean }

export const DEFAULT_WATERMARK: WatermarkNote = { name: null, email: null, group: null, dateTime: true, ip: false };

export const watermarkOn = (w: WatermarkNote) => !!(w.name || w.email || w.group || w.dateTime || w.ip);

// stamp order
export function watermarkParts(w: WatermarkNote, voice: 'values' | 'you'): string[] {
  const parts = voice === 'values'
    ? [w.name, w.email, w.group]
    : [w.name && 'your name', w.email && 'your email address', w.group && 'your group'];
  if (w.dateTime) parts.push('today’s date and time');
  if (w.ip) parts.push('your IP address');
  return parts.filter((x): x is string => !!x);
}

export function listed(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function watermarkSentence(w: WatermarkNote, voice: 'values' | 'you', subject = 'Every page'): string {
  const parts = watermarkParts(w, voice);
  return parts.length ? `${subject} carries ${listed(parts)}.` : 'This room prints no watermark on its pages.';
}

export const docLabel = (d: { indexNumber: string | null; name: string }) =>
  (d.indexNumber ? `${d.indexNumber} ${displayName(d.name)}` : displayName(d.name));

export function neighbours<T extends { id: string }>(docs: T[], id: string): { prev: T | null; next: T | null } {
  const i = docs.findIndex((d) => d.id === id);
  if (i < 0) return { prev: null, next: null };
  return { prev: docs[i - 1] ?? null, next: docs[i + 1] ?? null };
}

export function startPage(search: string, hash: string): number {
  const q = new URLSearchParams(search).get('page');
  const h = /^#p(\d+)$/.exec(hash)?.[1];
  const n = Number(q ?? h ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export const clampPage = (n: number, count: number) => Math.max(1, Math.min(Math.max(count, 1), Math.floor(n) || 1));

export const ZOOM_MIN = 60;
export const ZOOM_MAX = 160;
export const ZOOM_STEP = 20;
export const zoomBy = (zoom: number, dir: 1 | -1) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + ZOOM_STEP * dir));

export interface CoverageRow { personId: string; pagesSeen: number; pageCount: number }
export interface PartyGroups {
  parties: { kind: string; groups: { id: string; name: string; parentGroupId: string | null; members: { personId: string }[] }[] }[];
}

// admin only: may name bidder groups
export function openedBySummary(coverage: { pageCount: number; people: CoverageRow[] }, people: PartyGroups): string {
  const groupOf = new Map<string, { id: string; name: string }>();
  for (const party of people.parties) {
    if (party.kind !== 'bidder') continue;
    const byId = new Map(party.groups.map((g) => [g.id, g]));
    for (const g of party.groups) {
      const top = (g.parentGroupId && byId.get(g.parentGroupId)) || g;
      for (const m of g.members) if (!groupOf.has(m.personId)) groupOf.set(m.personId, { id: top.id, name: top.name });
    }
  }
  const readers = coverage.people.filter((p) => groupOf.has(p.personId));
  if (readers.length === 0) return 'Not opened by any bidder yet.';
  const groups = new Map<string, { name: string; seen: number[] }>();
  for (const r of readers) {
    const g = groupOf.get(r.personId)!;
    const e = groups.get(g.id) ?? { name: g.name, seen: [] };
    e.seen.push(r.pagesSeen);
    groups.set(g.id, e);
  }
  const nGroups = groups.size;
  const head = `Opened by ${nGroups} bidder ${nGroups === 1 ? 'group' : 'groups'}, ${readers.length} ${readers.length === 1 ? 'person' : 'people'}.`;
  const avg = [...groups.values()].map((g) => ({ name: g.name, avg: Math.round(g.seen.reduce((a, b) => a + b, 0) / g.seen.length) }));
  avg.sort((a, b) => a.avg - b.avg);
  const low = avg[0]!;
  return `${head} ${low.name} read ${low.avg} of ${coverage.pageCount} pages on average.`;
}

export type NoPreview = 'file_type' | 'too_large' | 'failed';

export function noPreviewText(why: NoPreview, fileName: string, canDownload: boolean): { title: string; reason: string; next: string } {
  const ext = fileType(fileName);
  let reason = `${ext} files cannot be shown in the browser.`;
  if (why === 'too_large') reason = 'This file is too large to show in the browser.';
  else if (why === 'failed') reason = 'This file could not be prepared for viewing.';
  else if (ext === 'File') reason = 'Files of this type cannot be shown in the browser.';
  return {
    title: why === 'file_type' ? 'No preview for this file type' : 'No preview for this file',
    reason,
    next: canDownload ? 'Download the file to open it on your computer.' : 'You cannot download this file. Ask the room admin if you need it.',
  };
}
