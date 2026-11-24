// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { apiUrl, browserApi, followSignOut } from '@/api/browser';
import type { Problem } from '@/api/client';
import { retrying, Transient, transientStatus } from '@/lib/retry';

export interface Picked {
  file: File;
  path: string;
}

export class UploadError extends Error {}

const problemText = (p: unknown, fallback: string) => {
  const pr = p as Partial<Problem> | undefined;
  return pr?.detail ?? pr?.title ?? fallback;
};

const HASH_CHUNK = 8 * 1024 * 1024;

export const UNREADABLE = 'could not be read. It may have been moved or changed since you chose it';

// not Web Crypto: no incremental digest, 2 GB+ buffers fail, absent on plain http
export async function sha256Hex(file: Blob): Promise<string> {
  const h = sha256.create();
  for (let at = 0; at < file.size; at += HASH_CHUNK) h.update(new Uint8Array(await file.slice(at, at + HASH_CHUNK).arrayBuffer()));
  return bytesToHex(h.digest());
}

export interface Uploaded { nodeId: string; versionId: string; versionNo: number; indexNumber: string | null; awaitingRelease: boolean }

export const UPLOAD_RETRIES = 3;

export interface UploadOptions {
  // 0 while offline, null once through
  onRetry?: (secondsLeft: number | null) => void;
  // checked before each try: a closed dialog sends nothing more
  cancelled?: () => boolean;
}

function refused(status: number, problem: unknown, fallback: string) {
  const text = problemText(problem, fallback);
  return transientStatus(status) ? new Transient(text) : new UploadError(text);
}

async function send<T>(request: () => Promise<T>, failed: string): Promise<T> {
  try {
    return await request();
  } catch {
    throw new Transient(failed);
  }
}

type Target = { targetFolderId: string | null } | { replacesNodeId: string; useFileName?: boolean };

// completing twice is safe
export async function uploadFile(ws: string, p: Picked, sha256: string, to: Target, opts: UploadOptions = {}): Promise<Uploaded> {
  const api = browserApi();
  const retry = <T>(fn: () => Promise<T>) => retrying(fn, { retries: UPLOAD_RETRIES, onWait: opts.onRetry, cancelled: opts.cancelled });
  const target = 'replacesNodeId' in to ? { replacesNodeId: to.replacesNodeId } : to;
  const s = await retry(async () => {
    const failed = 'The upload could not start.';
    const r = await send(() => api.POST('/v1/workspaces/{ws}/upload-sessions', {
      params: { path: { ws } },
      body: { ...target, path: p.path, size: p.file.size, sha256, mime: p.file.type || 'application/octet-stream' },
    }), failed);
    if (!r.data) throw refused(r.response.status, r.error, failed);
    return r.data;
  });
  let parts: { partNumber: number; etag: string }[] | undefined;
  if (s.method === 'direct' && s.uploadUrl) {
    const url = apiUrl(s.uploadUrl);
    await retry(async () => {
      const failed = 'The file could not be sent.';
      const res = await send(() => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: p.file }), failed);
      await followSignOut(url, res);
      if (!res.ok) throw refused(res.status, await res.json().catch(() => undefined), failed);
    });
  } else if (s.method === 'presigned' && s.parts && s.partSize) {
    parts = [];
    for (const part of s.parts) {
      const from = (part.partNumber - 1) * s.partSize;
      const size = s.partSize;
      const etag = await retry(async () => {
        const failed = 'The file could not be sent to storage.';
        const res = await send(() => fetch(part.url, { method: 'PUT', body: p.file.slice(from, from + size) }), failed);
        if (!res.ok) throw refused(res.status, undefined, failed);
        return res.headers.get('etag') ?? '';
      });
      parts.push({ partNumber: part.partNumber, etag });
    }
  }
  const complete: { parts?: typeof parts; useFileName?: boolean } = {};
  if (parts) complete.parts = parts;
  if ('useFileName' in to && to.useFileName) complete.useFileName = true;
  const done = await retry(async () => {
    const failed = 'The upload could not be finished.';
    const r = await send(() => api.POST('/v1/workspaces/{ws}/upload-sessions/{id}/complete', {
      params: { path: { ws, id: s.id } },
      body: complete,
    }), failed);
    if (!r.data) throw refused(r.response.status, r.error, failed);
    return r.data;
  });
  return { nodeId: done.nodeId, versionId: done.versionId, versionNo: done.versionNo, indexNumber: done.indexNumber, awaitingRelease: !!done.awaitingRelease };
}

export async function pickedFromDrop(dt: DataTransfer): Promise<Picked[]> {
  // read before any await: Safari/Firefox clear DataTransfer
  // Safari may give no entry; fall back to the File
  const dropped = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => ({ entry: i.webkitGetAsEntry?.() ?? null, file: i.getAsFile() }));
  if (dropped.some((d) => d.entry?.isDirectory)) {
    const out: Picked[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        out.push({ file, path: prefix + file.name });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
        }
      }
    };
    for (const d of dropped) {
      if (d.entry) await walk(d.entry, '');
      else if (d.file) out.push({ file: d.file, path: d.file.name });
    }
    return out;
  }
  return [...dt.files].map((file) => ({ file, path: file.name }));
}

export function pickedFromInput(files: FileList | null): Picked[] {
  if (!files) return [];
  return [...files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

export const hasFiles = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
