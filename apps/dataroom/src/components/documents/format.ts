// SPDX-License-Identifier: AGPL-3.0-only

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

export function displayName(name: string): string {
  return name.replace(/\.[a-z0-9]{1,6}$/i, '');
}

const SHEETS = ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods'];
const SLIDES = ['ppt', 'pptx', 'odp'];
const IMAGES = ['jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'bmp'];
const WORD = ['doc', 'docx', 'dot', 'dotx', 'rtf', 'odt'];

export function typeTag(name: string): { label: string; cls: string } {
  const e = extensionOf(name);
  if (e === 'pdf') return { label: 'PDF', cls: 'pdf' };
  if (SHEETS.includes(e)) return { label: 'XLS', cls: 'xls' };
  if (WORD.includes(e) || e === 'txt') return { label: 'DOC', cls: 'doc' };
  if (SLIDES.includes(e)) return { label: 'PPT', cls: '' };
  if (IMAGES.includes(e)) return { label: 'IMG', cls: '' };
  return { label: (e || 'file').slice(0, 4).toUpperCase(), cls: '' };
}

export function kindWord(name: string): string {
  const e = extensionOf(name);
  if (e === 'pdf') return 'PDF';
  if (WORD.includes(e)) return 'Word';
  if (SHEETS.includes(e)) return 'Excel';
  if (SLIDES.includes(e)) return 'PowerPoint';
  if (IMAGES.includes(e)) return 'Image';
  return e ? e.toUpperCase() : 'File';
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const LEVELS: { value: number; label: string }[] = [
  { value: 20, label: 'View' },
  { value: 40, label: 'View and print' },
  { value: 50, label: 'Download PDF' },
  { value: 60, label: 'Original' },
];

export function levelLabel(level: number): string {
  if (level <= 0) return 'Blocked for this file';
  if (level < 20) return 'Name only';
  if (level === 30) return 'Download encrypted PDF';
  return [...LEVELS].reverse().find((l) => level >= l.value)?.label ?? 'View';
}

export function lastSeg(ix: string | null): number {
  const n = Number((ix ?? '').split('.').pop());
  return Number.isFinite(n) ? n : 0;
}

export function lastNumberIn(items: { indexNumber: string | null }[]): number {
  return Math.max(0, ...items.map((i) => lastSeg(i.indexNumber)));
}

// must match the API: first gap after the unbroken run
export function nextFolderNumber(items: { indexNumber: string | null }[]): number {
  const used = new Set(items.map((i) => lastSeg(i.indexNumber)).filter((n) => n > 0));
  if (!used.size) return 1;
  let n = Math.min(...used);
  while (used.has(n + 1)) n++;
  return n + 1;
}

export const join = (prefix: string | null, n: number) => (prefix ? `${prefix}.${n}` : String(n));

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

export function publishersLine(names: string[] | null): string {
  if (!names?.length) return 'A publisher or a room admin publishes';
  if (names.length === 1) return `${names[0]} publishes`;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]} publishes`;
}
