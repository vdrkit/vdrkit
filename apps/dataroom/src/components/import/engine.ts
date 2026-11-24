// SPDX-License-Identifier: AGPL-3.0-only
'use client';

// Three in flight, completed in index order: the server numbers on completion.
// The planned number rides along, so a failure doesn't renumber the rest.
import { apiUrl, browserApi, toSignIn } from '@/api/browser';
import type { Problem } from '@/api/client';
import { UPLOAD_RETRIES, type Picked } from '@/components/documents/upload';
import { retrying, Transient, transientStatus } from '@/lib/retry';

export interface Job {
  key: string;
  picked: Picked;
  sha256: string;
  serverPath: string;
  targetFolderId: string | null;
  plannedNumber?: number;
  plannedIndex?: string | null;
  row: string;
}

export type JobStatus = 'waiting' | 'sending' | 'retrying' | 'completing' | 'done' | 'failed' | 'cancelled';

export interface JobState {
  status: JobStatus;
  sent: number;
  error?: string;
  versionId?: string;
  nodeId?: string;
  indexNumber?: string | null;
  createdFolders?: { id: string; indexNumber: string; name: string }[];
}

const PROGRESS_MS = 250;

class Final extends Error {}
class Restart extends Error {}

interface Session {
  id: string;
  method: 'direct' | 'presigned';
  uploadUrl?: string;
  partSize?: number;
  parts?: { partNumber: number; url: string }[];
  etags: Map<number, string>;
  stale?: boolean;
  // resumed URLs: a 403 means the session is gone
  resumed?: boolean;
}

async function reach<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch {
    throw new Transient();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const problemText = (p: unknown, fallback: string) => {
  const pr = p as Partial<Problem> | undefined;
  return pr?.detail ?? pr?.title ?? fallback;
};

// XHR: fetch has no upload progress
function put(url: string, body: Blob, onProgress: (n: number) => void, signal: AbortSignal, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; etag: string | null; text: string }>((resolve) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => resolve({ status: x.status, etag: x.getResponseHeader('etag'), text: x.responseText });
    x.onerror = () => resolve({ status: 0, etag: null, text: '' });
    x.onabort = () => resolve({ status: -1, etag: null, text: '' });
    signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(body);
  });
}

export class BulkUpload {
  readonly states: JobState[];
  private paused = false;
  private cancelled = false;
  private waiting: (() => void)[] = [];
  private readonly abort = new AbortController();
  private readonly sessions = new Map<number, Session>();
  retryIn: number | null = null;
  private startedAt = 0;
  private sentAtStart = 0;

  constructor(private readonly ws: string, readonly jobs: Job[], private readonly onChange: () => void) {
    this.states = jobs.map(() => ({ status: 'waiting', sent: 0 }));
  }

  get isPaused() { return this.paused; }
  get isCancelled() { return this.cancelled; }
  get totalBytes() { return this.jobs.reduce((a, j) => a + j.picked.file.size, 0); }
  get sentBytes() {
    let total = 0;
    this.states.forEach((s, i) => {
      const size = this.jobs[i]!.picked.file.size;
      total += s.status === 'done' ? size : Math.min(s.sent, size);
    });
    return total;
  }
  get rate() {
    const secs = (Date.now() - this.startedAt) / 1000;
    return secs > 1 ? Math.max(0, this.sentBytes - this.sentAtStart) / secs : 0;
  }

  pause() {
    this.paused = true;
    this.onChange();
  }
  continue() {
    this.paused = false;
    this.startedAt = Date.now();
    this.sentAtStart = this.sentBytes;
    this.wake();
    this.onChange();
  }

  private wake() {
    const waiting = this.waiting;
    this.waiting = [];
    waiting.forEach((r) => r());
  }

  async cancelRest() {
    this.cancelled = true;
    this.abort.abort();
    this.wake();
    this.states.forEach((s) => { if (s.status !== 'done' && s.status !== 'failed') s.status = 'cancelled'; });
    this.onChange();
    const api = browserApi();
    const open = [...this.sessions.entries()].filter(([i]) => this.states[i]!.status !== 'done');
    await Promise.all(open.map(([, s]) =>
      api.DELETE('/v1/workspaces/{ws}/upload-sessions/{id}', { params: { path: { ws: this.ws, id: s.id } } }).catch(() => null)));
  }

  private async gate() {
    while (this.paused && !this.cancelled) await new Promise<void>((r) => { this.waiting.push(r); });
  }

  private set(i: number, patch: Partial<JobState>) {
    Object.assign(this.states[i]!, patch);
    this.onChange();
  }

  // throttled to one redraw per PROGRESS_MS; status changes redraw at once
  private redraw: ReturnType<typeof setTimeout> | null = null;
  private progress(i: number, sent: number) {
    this.states[i]!.sent = sent;
    if (this.redraw) return;
    this.redraw = setTimeout(() => {
      this.redraw = null;
      this.onChange();
    }, PROGRESS_MS);
  }

  private async retrying<T>(i: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await retrying(fn, {
        retries: UPLOAD_RETRIES,
        cancelled: () => this.cancelled,
        onWait: (s) => {
          if (s === null) return;
          this.states[i]!.status = 'retrying';
          this.retryIn = s;
          this.onChange();
        },
      });
    } catch (e) {
      if (e instanceof Transient) throw new Final('The server did not take the file after several tries. Import it again later: files already in the room are skipped.');
      throw e;
    } finally {
      if (this.retryIn !== null) { this.retryIn = null; this.onChange(); }
    }
  }

  private async startSession(i: number) {
    const j = this.jobs[i]!;
    const body: { targetFolderId: string | null; path: string; size: number; sha256: string; mime: string; plannedNumber?: number } = {
      targetFolderId: j.targetFolderId,
      path: j.serverPath,
      size: j.picked.file.size,
      sha256: j.sha256,
      mime: j.picked.file.type || 'application/octet-stream',
    };
    if (j.plannedNumber) body.plannedNumber = j.plannedNumber;
    const r = await reach(browserApi().POST('/v1/workspaces/{ws}/upload-sessions', { params: { path: { ws: this.ws } }, body }));
    if (!r.data) {
      if (transientStatus(r.response.status)) throw new Transient();
      throw new Final(problemText(r.error, 'The upload could not start.'));
    }
    this.sessions.set(i, { ...r.data, etags: new Map() });
  }

  private async resume(i: number) {
    const s = this.sessions.get(i)!;
    const r = await reach(browserApi().GET('/v1/workspaces/{ws}/upload-sessions/{id}', { params: { path: { ws: this.ws, id: s.id } } }));
    if (!r.data) {
      if (transientStatus(r.response.status)) throw new Transient();
      throw new Restart();
    }
    if (r.data.status !== 'open') throw new Restart();
    if (r.data.method === 'presigned' && r.data.parts && r.data.received && s.parts) {
      s.etags = new Map(r.data.received.map((p) => [p.partNumber, p.etag]));
      const fresh = new Map(r.data.parts.map((p) => [p.partNumber, p.url]));
      s.parts = s.parts.map((p) => ({ partNumber: p.partNumber, url: fresh.get(p.partNumber) ?? p.url }));
      s.resumed = true;
    }
    s.stale = false;
  }

  private async sendBytes(i: number) {
    const j = this.jobs[i]!;
    const s = this.sessions.get(i)!;
    if (s.method === 'presigned' && s.stale) await this.resume(i);
    if (s.method === 'direct' && s.uploadUrl) {
      const url = apiUrl(s.uploadUrl);
      const res = await put(url, j.picked.file, (n) => this.progress(i, n), this.abort.signal, { 'content-type': 'application/octet-stream' });
      if (res.status === -1) throw new Final('Cancelled');
      toSignIn(url, res.status, parseJson(res.text));
      if (res.status >= 200 && res.status < 300) return;
      if (res.status === 409 || res.status === 410) throw new Restart();
      if (transientStatus(res.status)) throw new Transient();
      throw new Final(problemText(parseJson(res.text), 'The file could not be sent.'));
    }
    if (s.method === 'presigned' && s.parts && s.partSize) {
      for (const part of s.parts) {
        if (s.etags.has(part.partNumber)) continue;
        const from = (part.partNumber - 1) * s.partSize;
        const done = s.etags.size * s.partSize;
        const res = await put(part.url, j.picked.file.slice(from, from + s.partSize), (n) => this.progress(i, done + n), this.abort.signal);
        if (res.status === -1) throw new Final('Cancelled');
        // 403: expired or refused URL. Fresh URLs once, then a new session
        if (res.status === 403) {
          if (s.resumed) throw new Restart();
          s.stale = true;
          throw new Transient();
        }
        if (res.status < 200 || res.status >= 300) {
          if (transientStatus(res.status)) { s.stale = true; throw new Transient(); }
          throw new Final('The file could not be sent to storage.');
        }
        s.etags.set(part.partNumber, res.etag ?? '');
        s.resumed = false;
      }
    }
  }

  private async transfer(i: number): Promise<boolean> {
    await this.gate();
    if (this.cancelled) return false;
    this.set(i, { status: 'sending' });
    let restarted = false;
    for (;;) {
      try {
        if (!this.sessions.has(i)) await this.retrying(i, () => this.startSession(i));
        await this.retrying(i, () => this.sendBytes(i));
        this.set(i, { status: 'sending', sent: this.jobs[i]!.picked.file.size });
        return true;
      } catch (e) {
        if (e instanceof Restart && !restarted) { restarted = true; this.sessions.delete(i); continue; }
        if (this.cancelled) return false;
        this.set(i, { status: 'failed', error: e instanceof Restart ? 'The upload expired. Start it again.' : (e as Error).message });
        return false;
      }
    }
  }

  private async complete(i: number): Promise<void> {
    await this.gate();
    if (this.cancelled) return;
    this.set(i, { status: 'completing' });
    let restarted = false;
    for (;;) {
      try {
        const out = await this.retrying(i, async () => {
          const s = this.sessions.get(i)!;
          let body = {};
          if (s.method === 'presigned') {
            const sorted = [...s.etags.entries()].sort((a, b) => a[0] - b[0]);
            body = { parts: sorted.map(([partNumber, etag]) => ({ partNumber, etag })) };
          }
          const r = await reach(browserApi().POST('/v1/workspaces/{ws}/upload-sessions/{id}/complete', {
            params: { path: { ws: this.ws, id: s.id } },
            body,
          }));
          if (r.data) return r.data;
          const st = r.response.status;
          if (st === 409 || st === 410 || st === 422) throw new Restart(problemText(r.error, 'The upload was rejected.'));
          if (transientStatus(st)) throw new Transient();
          throw new Final(problemText(r.error, 'The upload could not be finished.'));
        });
        this.set(i, { status: 'done', sent: this.jobs[i]!.picked.file.size, versionId: out.versionId, nodeId: out.nodeId, indexNumber: out.indexNumber, createdFolders: out.createdFolders });
        return;
      } catch (e) {
        if (e instanceof Restart && !restarted) {
          restarted = true;
          this.sessions.delete(i);
          if (await this.transfer(i)) { this.set(i, { status: 'completing' }); continue; }
          return;
        }
        if (this.cancelled) return;
        this.set(i, { status: 'failed', error: (e as Error).message });
        return;
      }
    }
  }

  async run(): Promise<void> {
    this.startedAt = Date.now();
    const n = this.jobs.length;
    const ahead = 3;
    const transfers: Promise<boolean>[] = [];
    let next = 0;
    for (; next < Math.min(ahead, n); next++) transfers[next] = this.transfer(next);
    for (let i = 0; i < n; i++) {
      const ok = await transfers[i]!;
      if (ok && !this.cancelled) await this.complete(i);
      if (next < n) { transfers[next] = this.transfer(next); next++; }
    }
    this.onChange();
  }
}
