// SPDX-License-Identifier: AGPL-3.0-only
import type { Picked } from '@/components/documents/upload';

export type FileStatus = 'new' | 'duplicate_skipped' | 'duplicate_kept' | 'system_skipped';

export interface PlannedFile {
  sourcePath: string;
  name: string;
  indexNumber: string | null;
  size: number;
  status: FileStatus;
  noPreview: boolean;
  duplicateOf?: string;
}

export interface PlannedFolder {
  sourcePath: string;
  sourceName: string;
  name: string;
  indexNumber: string;
  existingId: string | null;
  files: PlannedFile[];
  children: PlannedFolder[];
}

export type PlanWarning =
  | { kind: 'number_taken'; sourcePath: string; wanted: string; given: string; takenBy: string | null }
  | { kind: 'number_repeated'; sourcePath: string; wanted: string; given: string };

export interface UploadPlan {
  folders: PlannedFolder[];
  files: PlannedFile[];
  warnings: PlanWarning[];
  summary: {
    droppedFiles: number; uploadFiles: number; uploadBytes: number; newFolders: number; existingFoldersReceiving: number;
    duplicates: number; systemFilesSkipped: number; noPreview: number;
  };
}

// must match parseLeadingNumber() on the server
const LEADING_NUMBER = /^(\d+(?:[.\-_]\d+)*)[.)]?[\s_\-]+(.+)$/;
const YEAR = /^(19|20)\d\d$/;
const MAX_INDEX_NUMBER = 999_999_999;
export function parseLeadingNumber(name: string): { number: number | null; name: string } {
  const m = LEADING_NUMBER.exec(name.trim());
  // "2023 Accounts" is named after the year
  if (!m || !m[1] || !m[2] || YEAR.test(m[1])) return { number: null, name: name.trim() };
  const parts = m[1].split(/[.\-_]/);
  const last = Number(parts[parts.length - 1]);
  return { number: last > 0 && last <= MAX_INDEX_NUMBER ? last : null, name: m[2].trim() };
}

// wrapper folder skipped unless its name starts with a number
export function stripCollectingRoot(files: Picked[]): { set: string | null; files: Picked[] } {
  const firsts = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : null)));
  const [root] = [...firsts];
  if (firsts.size !== 1 || !root) return { set: null, files };
  if (parseLeadingNumber(root).number != null || !files.some((f) => f.path.split('/').length > 2)) return { set: null, files };
  return { set: root, files: files.map((f) => ({ file: f.file, path: f.path.slice(root.length + 1) })) };
}

export function rewritePath(path: string, typed: Map<string, number>): string {
  const segs = path.split('/');
  const file = segs.pop()!;
  const out: string[] = [];
  let at = '';
  for (const s of segs) {
    at = at ? `${at}/${s}` : s;
    const n = typed.get(at);
    out.push(n != null ? `${n} ${parseLeadingNumber(s).name}` : s);
  }
  return [...out, file].join('/');
}

// the server merges by name, so spell out every planned folder
export function placedPaths(plan: UploadPlan): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (f: PlannedFolder, prefix: string[]) => {
    const own = Number(f.indexNumber.split('.').at(-1));
    const seg = [...prefix, `${own} ${f.name}`];
    for (const x of f.files) out.set(x.sourcePath, [...seg, x.name].join('/'));
    f.children.forEach((c) => walk(c, seg));
  };
  plan.folders.forEach((f) => walk(f, []));
  for (const x of plan.files) out.set(x.sourcePath, x.name);
  return out;
}

export function* walkFolders(folders: PlannedFolder[], depth = 0): Generator<{ folder: PlannedFolder; depth: number; parent: PlannedFolder | null }> {
  for (const f of folders) {
    yield { folder: f, depth, parent: null };
    for (const x of walkFolders(f.children, depth + 1)) yield { ...x, parent: x.parent ?? f };
  }
}

export function filesUnder(f: PlannedFolder): PlannedFile[] {
  return [...f.files, ...f.children.flatMap(filesUnder)];
}

// subfolders first, or the server's numbers drift from the plan
export function uploadOrder(plan: UploadPlan): PlannedFile[] {
  const out: PlannedFile[] = [];
  const walk = (f: PlannedFolder) => { f.children.forEach(walk); out.push(...f.files); };
  plan.folders.forEach(walk);
  out.push(...plan.files);
  return out.filter((x) => x.status === 'new' || x.status === 'duplicate_kept');
}

const ixParts = (ix: string | null) => (ix ?? '').split('.').map((x) => Number(x) || 0);
export function compareIndex(a: string | null, b: string | null): number {
  const pa = ixParts(a);
  const pb = ixParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

export function size(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function andList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
