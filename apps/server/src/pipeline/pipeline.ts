// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { decryptBuffer, decryptStream, encryptBuffer } from '../crypto/envelope.js';
import { claimedTypeProblem } from './file-type.js';

export interface Storage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete?(key: string): Promise<void>;
  size?(key: string): Promise<number | null>;
  multipart?: MultipartUploads;
  // atomic
  putStream?(key: string, body: Readable): Promise<void>;
  getStream?(key: string, range?: ByteRange): Promise<Readable>;
}

export interface ByteRange { start: number; end: number }

export async function putStream(storage: Storage, key: string, body: Readable): Promise<void> {
  if (storage.putStream) return storage.putStream(key, body);
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  await storage.put(key, Buffer.concat(chunks));
}

export async function getStream(storage: Storage, key: string, range?: ByteRange): Promise<Readable> {
  if (storage.getStream) return storage.getStream(key, range);
  const all = await storage.get(key);
  return Readable.from([range ? all.subarray(range.start, range.end + 1) : all]);
}

export interface MultipartUploads {
  // part sizes are signed into the URLs
  start(key: string, partSizes: number[], expiresInSeconds: number): Promise<{ uploadId: string; urls: string[] }>;
  complete(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  listParts?(key: string, uploadId: string): Promise<{ partNumber: number; etag: string; size: number }[]>;
  presignPart?(key: string, uploadId: string, partNumber: number, size: number, expiresInSeconds: number): Promise<string>;
}

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) { this.objects.set(key, Buffer.from(body)); }
  async get(key: string) {
    const b = this.objects.get(key);
    if (!b) throw new Error(`No object at ${key}`);
    return Buffer.from(b);
  }
  async delete(key: string) { this.objects.delete(key); }
  async size(key: string) { return this.objects.get(key)?.length ?? null; }
}

export interface Original {
  versionId: string;
  workspaceId: string;
  storageKey: string;
  filename: string;
  mime: string;
}

export interface Derived {
  kind: 'pdf' | 'page_image' | 'thumbnail' | 'text';
  step: string;
  storageKey: string;
  sha256: string;
  size: number;
  meta?: Record<string, unknown>;
}

export interface StepContext {
  original: Original;
  readOriginal(): Promise<Buffer>;
  openOriginal(): Promise<Readable>;
  storedSize(): Promise<number | null>;
  readDerived(kind: Derived['kind']): Promise<Buffer | null>;
  store(kind: Derived['kind'], step: string, body: Buffer, meta?: Record<string, unknown>): Promise<Derived>;
  facts: Record<string, unknown>;
  // throws when the run must end; long steps call it between units of work
  checkpoint(): void;
}

export interface Step {
  name: string;
  appliesTo(o: Original): boolean;
  run(ctx: StepContext): Promise<void>;
}

// not the file's fault; let pg-boss retry
export class ServiceUnavailable extends Error {}

export interface PipelineResult {
  ok: boolean;
  derived: Derived[];
  facts: Record<string, unknown>;
  completedSteps: string[];
  failedStep?: string;
  error?: string;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const STORED_EXTENSION: Record<string, string> = { 'image/webp': '.webp' };
export const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

// stop: a reason to end the run early (it passed its time limit, or another run owns the version), else null
export async function runPipeline(original: Original, steps: Step[], storage: Storage, dataKey: Buffer,
  opts: { stop?: () => string | null } = {}): Promise<PipelineResult> {
  const derived: Derived[] = [];
  const facts: Record<string, unknown> = {};
  const completed: string[] = [];
  let plain: Buffer | null = null;

  const checkpoint = () => {
    const why = opts.stop?.();
    if (why) throw new Error(why);
  };
  const ctx: StepContext = {
    original,
    facts,
    checkpoint,
    async readOriginal() {
      if (!plain) plain = await decryptBuffer(dataKey, await storage.get(original.storageKey), original.storageKey);
      return plain;
    },
    async openOriginal() {
      if (plain) return Readable.from([plain]);
      const sealed = await getStream(storage, original.storageKey);
      const d = decryptStream(dataKey, original.storageKey);
      sealed.on('error', (e) => d.destroy(e));
      d.on('close', () => {
        if (!sealed.readableEnded) sealed.destroy();
      });
      return sealed.pipe(d);
    },
    async storedSize() {
      return storage.size ? storage.size(original.storageKey) : null;
    },
    async readDerived(kind) {
      const d = [...derived].reverse().find((x) => x.kind === kind);
      return d ? decryptBuffer(dataKey, await storage.get(d.storageKey), d.storageKey) : null;
    },
    async store(kind, step, body, meta) {
      const ext = typeof meta?.contentType === 'string' ? (STORED_EXTENSION[meta.contentType] ?? '') : '';
      const n = derived.filter((x) => x.kind === kind).length + 1;
      const key = `ws/${original.workspaceId}/v/${original.versionId}/${step}/${kind}-${n}${ext}`;
      await storage.put(key, await encryptBuffer(dataKey, body, key));
      const d: Derived = { kind, step, storageKey: key, sha256: sha256(body), size: body.length };
      if (meta) d.meta = meta;
      derived.push(d);
      return d;
    },
  };

  for (const step of steps) {
    if (!step.appliesTo(original)) continue;
    try {
      checkpoint();
      await step.run(ctx);
      completed.push(step.name);
    } catch (e) {
      if (e instanceof ServiceUnavailable) throw e;
      return { ok: false, derived, facts, completedSteps: completed, failedStep: step.name, error: (e as Error).message };
    }
  }
  return { ok: true, derived, facts, completedSteps: completed };
}

export const hashStep: Step = {
  name: 'hash',
  appliesTo: () => true,
  async run(ctx) {
    const h = createHash('sha256');
    let size = 0;
    for await (const c of await ctx.openOriginal()) {
      h.update(c as Buffer);
      size += (c as Buffer).length;
    }
    ctx.facts.sha256 = h.digest('hex');
    ctx.facts.size = size;
  },
};

function previewLimit(): number {
  const v = Number(process.env.PREVIEW_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 512 * 1024 * 1024;
}

export const PREVIEW_MAX_BYTES = previewLimit();

export async function tooLargeToPreview(ctx: StepContext, limit = PREVIEW_MAX_BYTES): Promise<boolean> {
  if (ctx.facts.previewSkipped === 'too_large') return true;
  const size = typeof ctx.facts.size === 'number' ? ctx.facts.size : await ctx.storedSize();
  if (size != null && size > limit) {
    ctx.facts.previewSkipped = 'too_large';
    return true;
  }
  return false;
}

export type PreviewSkipped = 'too_large' | 'file_type';

export const SEARCH_SKIPPED_REASON = 'VDRkit could not read the text in this PDF. The file can still be viewed, but its content will not appear in search.';

export const previewStep: Step = {
  name: 'preview',
  appliesTo: () => true,
  async run(ctx) {
    if (typeof ctx.facts.pageCount === 'number' && ctx.facts.pageCount > 0) return;
    ctx.facts.previewSkipped ??= 'file_type';
  },
};

export const OFFICE = new Set(['doc', 'docx', 'dot', 'dotx', 'rtf', 'odt', 'txt', 'xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods', 'ppt', 'pptx', 'odp', 'html', 'htm']);
export const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'bmp']);

export class GotenbergClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 120_000) {}

  async officeToPdf(filename: string, body: Buffer): Promise<Buffer> {
    const problem = claimedTypeProblem(extensionOf(filename), body);
    if (problem) throw new Error(problem);
    const form = new FormData();
    form.append('files', new Blob([body]), filename);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/forms/libreoffice/convert`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
      throw new ServiceUnavailable(`Document conversion is not reachable (${cause}). The file is converted when it is back.`);
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ServiceUnavailable(`Document conversion is busy or down (${res.status}). The file is converted when it is back.`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      // damaged files mention passwords too
      if (/password may be required|password protected/i.test(text)) {
        throw new Error('The file is password protected, so VDRkit cannot convert it for viewing.');
      }
      if (res.status === 400 && /LibreOffice failed to process/i.test(text)) {
        throw new Error('The file could not be read: it may be damaged. Open it on your computer, save it again and upload the new copy.');
      }
      // may name paths inside the container: log only
      console.error(`Document conversion failed (${res.status}) for ${JSON.stringify(filename)}: ${text}`);
      throw new Error(`Conversion to PDF failed (${res.status}). The file may be damaged or of a kind the converter cannot read. Save it again on your computer, or upload it as a PDF.`);
    }
    const pdf = Buffer.from(await res.arrayBuffer());
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('The converter did not return a PDF.');
    return pdf;
  }
}

export function convertStep(gotenberg: GotenbergClient): Step {
  return {
    name: 'convert',
    appliesTo: (o) => {
      const ext = extensionOf(o.filename);
      return ext === 'pdf' || OFFICE.has(ext) || IMAGE.has(ext);
    },
    async run(ctx) {
      const ext = extensionOf(ctx.original.filename);
      if (await tooLargeToPreview(ctx)) return;
      const original = await ctx.readOriginal();
      if (ext === 'pdf') {
        const problem = claimedTypeProblem('pdf', original);
        if (problem) throw new Error(problem);
        await ctx.store('pdf', 'convert', original, { passthrough: true });
        return;
      }
      if (IMAGE.has(ext)) {
        ctx.facts.viewer = 'image';
        return;
      }
      await ctx.store('pdf', 'convert', await gotenberg.officeToPdf(ctx.original.filename, original));
    },
  };
}
