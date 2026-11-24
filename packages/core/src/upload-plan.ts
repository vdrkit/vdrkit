// SPDX-License-Identifier: AGPL-3.0-only

export interface ExistingFolder {
  id: string;
  number: number;
  name: string;
  children: ExistingFolder[];
  lastDocumentNumber: number;
  /** keeps its number; never merge into or name it */
  hidden?: boolean;
  hiddenDocuments?: boolean;
}

export interface DroppedFile {
  path: string;
  size: number;
  sha256?: string;
}

export interface PlanOptions {
  numbering: 'from_names' | 'alphabetical';
  duplicates: 'skip' | 'keep';
}

export type FileStatus = 'new' | 'duplicate_skipped' | 'duplicate_kept' | 'system_skipped';

export interface PlannedFile {
  sourcePath: string;
  name: string;
  indexNumber: string | null;
  size: number;
  status: FileStatus;
  noPreview: boolean;
  duplicateOf?: string;
  duplicateName?: string;
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
    droppedFiles: number;
    uploadFiles: number;
    uploadBytes: number;
    newFolders: number;
    existingFoldersReceiving: number;
    duplicates: number;
    systemFilesSkipped: number;
    noPreview: number;
  };
}

const SYSTEM_FILE = /^(thumbs\.db|\.ds_store|desktop\.ini|\._.*|~\$.*|\.~lock\..*)$/i;
const PREVIEWABLE = new Set([
  'pdf', 'doc', 'docx', 'dot', 'dotx', 'rtf', 'odt', 'txt', 'xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods',
  'ppt', 'pptx', 'odp', 'msg', 'eml', 'jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'bmp', 'html', 'htm',
]);
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

function extension(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const norm = (s: string) => s.trim().toLocaleLowerCase('en');

interface DropNode {
  sourceName: string;
  sourcePath: string;
  folders: Map<string, DropNode>;
  files: DroppedFile[];
}

function buildDropTree(files: DroppedFile[]): DropNode {
  const root: DropNode = { sourceName: '', sourcePath: '', folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.get(part);
      if (!next) {
        next = { sourceName: part, sourcePath: at.sourcePath ? `${at.sourcePath}/${part}` : part, folders: new Map(), files: [] };
        at.folders.set(part, next);
      }
      at = next;
    }
    at.files.push(f);
  }
  return root;
}

export function planUpload(
  target: { children: ExistingFolder[]; lastDocumentNumber: number; hiddenDocuments?: boolean },
  files: DroppedFile[],
  options: PlanOptions,
  existingHashes: Map<string, string> = new Map(),
  prefix = '',
  existingNames: Map<string, string> = new Map(),
): UploadPlan {
  const warnings: PlanWarning[] = [];
  const summary: UploadPlan['summary'] = {
    droppedFiles: files.length,
    uploadFiles: 0,
    uploadBytes: 0,
    newFolders: 0,
    existingFoldersReceiving: 0,
    duplicates: 0,
    systemFilesSkipped: 0,
    noPreview: 0,
  };
  const receiving = new Set<string>();
  const seenHashes = new Map(existingHashes);
  const seenNames = new Map(existingNames);

  const join = (p: string, n: number) => (p ? `${p}.${n}` : String(n));

  function planFiles(list: DroppedFile[], folderNumber: string, lastNumber: number, existingId: string | null): PlannedFile[] {
    let next = lastNumber;
    const sorted = [...list].sort((a, b) => collator.compare(baseName(a.path), baseName(b.path)));
    return sorted.map((f): PlannedFile => {
      const name = baseName(f.path);
      const noPreview = !PREVIEWABLE.has(extension(name));
      if (SYSTEM_FILE.test(name)) {
        summary.systemFilesSkipped++;
        return { sourcePath: f.path, name, indexNumber: null, size: f.size, status: 'system_skipped', noPreview };
      }
      const hash = f.sha256?.toLowerCase();
      const dupOf = hash ? seenHashes.get(hash) : undefined;
      const dupName = hash && dupOf ? seenNames.get(hash) : undefined;
      if (dupOf) {
        summary.duplicates++;
        if (options.duplicates === 'skip') {
          const skipped: PlannedFile = {
            sourcePath: f.path, name, indexNumber: null, size: f.size, status: 'duplicate_skipped', noPreview, duplicateOf: dupOf,
          };
          if (dupName) skipped.duplicateName = dupName;
          return skipped;
        }
      }
      next += 1;
      const indexNumber = join(folderNumber, next);
      if (hash && !dupOf) {
        seenHashes.set(hash, indexNumber);
        seenNames.set(hash, name);
      }
      summary.uploadFiles++;
      summary.uploadBytes += f.size;
      if (noPreview) summary.noPreview++;
      if (existingId) receiving.add(existingId);
      const planned: PlannedFile = {
        sourcePath: f.path, name, indexNumber, size: f.size, status: dupOf ? 'duplicate_kept' : 'new', noPreview,
      };
      if (dupOf) {
        planned.duplicateOf = dupOf;
        if (dupName) planned.duplicateName = dupName;
      }
      return planned;
    });
  }

  function planLevel(drops: DropNode[], existing: ExistingFolder[], parentNumber: string, parentExistingId: string | null,
    parent: { lastDocumentNumber: number; hiddenDocuments?: boolean }): PlannedFolder[] {
    const byName = new Map(existing.filter((e) => !e.hidden).map((e) => [norm(e.name), e]));
    const used = new Map<number, string | null>(existing.map((e) => [e.number, e.hidden ? null : e.name]));
    // documents share the numbering; only the highest is known
    for (let i = 1; i <= parent.lastDocumentNumber; i++) if (!used.has(i)) used.set(i, null);
    const parsed = drops.map((d) => ({ d, ...parseLeadingNumber(d.sourceName) }));

    const assigned = new Map<DropNode, { number: number; existing: ExistingFolder | null }>();
    for (const p of parsed) {
      const match = byName.get(norm(p.name));
      if (match) assigned.set(p.d, { number: match.number, existing: match });
    }
    const fresh = parsed.filter((p) => !assigned.has(p.d));
    let nextFree = Math.max(0, parent.lastDocumentNumber, ...existing.map((e) => e.number));
    const takeNext = () => {
      do nextFree += 1;
      while (used.has(nextFree));
      return nextFree;
    };
    type Fresh = (typeof fresh)[number];
    const byNumber = (a: Fresh, b: Fresh) => (a.number ?? Infinity) - (b.number ?? Infinity) || collator.compare(a.name, b.name);
    const alphabetical = (a: Fresh, b: Fresh) => collator.compare(a.name, b.name);

    // anything hidden: number silently, a collision warning would leak it
    const anyHidden = existing.some((e) => e.hidden) || !!parent.hiddenDocuments;
    if (options.numbering === 'from_names' && !anyHidden) {
      for (const p of [...fresh].sort(byNumber)) {
        let n: number;
        if (p.number != null && !used.has(p.number)) {
          n = p.number;
        } else {
          n = takeNext();
          if (p.number != null) {
            const sourcePath = p.d.sourcePath;
            const wanted = join(parentNumber, p.number);
            const given = join(parentNumber, n);
            const isRepeat = parsed.some((q) => q !== p && q.number === p.number && !existing.some((e) => e.number === p.number));
            if (isRepeat) {
              warnings.push({ kind: 'number_repeated', sourcePath, wanted, given });
            } else {
              warnings.push({ kind: 'number_taken', sourcePath, wanted, given, takenBy: used.get(p.number) ?? null });
            }
          }
        }
        used.set(n, p.name);
        nextFree = Math.max(nextFree, n);
        assigned.set(p.d, { number: n, existing: null });
      }
    } else {
      const order = options.numbering === 'from_names' ? byNumber : alphabetical;
      for (const p of [...fresh].sort(order)) {
        const n = takeNext();
        used.set(n, p.name);
        assigned.set(p.d, { number: n, existing: null });
      }
    }

    return parsed
      .map((p) => {
        const a = assigned.get(p.d)!;
        const match = a.existing;
        const existingId = match?.id ?? null;
        const indexNumber = join(parentNumber, a.number);
        if (!match) {
          summary.newFolders++;
          if (parentExistingId) receiving.add(parentExistingId);
        }
        const children = planLevel([...p.d.folders.values()], match?.children ?? [], indexNumber, existingId,
          match ?? { lastDocumentNumber: 0 });
        const lastNumber = lastChildNumber(match ?? { children: [], lastDocumentNumber: 0 }, children);
        const folder: PlannedFolder = {
          sourcePath: p.d.sourcePath,
          sourceName: p.d.sourceName,
          name: match ? match.name : p.name,
          indexNumber,
          existingId,
          files: planFiles(p.d.files, indexNumber, lastNumber, existingId),
          children,
        };
        return { folder, number: a.number };
      })
      .sort((x, y) => x.number - y.number)
      .map((x) => x.folder);
  }

  const tree = buildDropTree(files);
  const folders = planLevel([...tree.folders.values()], target.children, prefix, null, target);
  const rootFiles = planFiles(tree.files, prefix, lastChildNumber(target, folders), null);
  summary.existingFoldersReceiving = receiving.size;
  return { folders, files: rootFiles, warnings, summary };
}

// documents come after every subfolder
function lastChildNumber(existing: { children: ExistingFolder[]; lastDocumentNumber: number }, planned: PlannedFolder[]): number {
  const plannedNumbers = planned.map((f) => Number(f.indexNumber.split('.').at(-1)));
  return Math.max(existing.lastDocumentNumber, 0, ...existing.children.map((c) => c.number), ...plannedNumbers);
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function* walkPlan(folders: PlannedFolder[], depth = 0): Generator<{ folder: PlannedFolder; depth: number }> {
  for (const f of folders) {
    yield { folder: f, depth };
    yield* walkPlan(f.children, depth + 1);
  }
}
