// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { degrees, PDFDocument, rgb } from 'pdf-lib';
import { embedFonts, printable } from '../pdf-fonts.js';
import { appendEvent, canSeeVersion, effectiveAccess, Level, versionAccess, type SqlClient, present } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import type { Readable } from 'node:stream';
import { decryptBuffer, decryptRangeStream, HEADER_BYTES, headerOf, sealedRange } from '../crypto/envelope.js';
import type { Keyring } from '../crypto/keyring.js';
import { extensionOf, getStream, type ByteRange, type Storage } from '../pipeline/pipeline.js';
import { noPreviewOf } from './preview.js';
import { applyWatermark, DEFAULT_FIELDS, watermarkDigest, watermarkLines, type Viewer, type WatermarkFields } from '../pipeline/watermark.js';
import { forbidden, HttpProblem, notFound } from '../problems.js';
import { blockedLink, capAccess, personOf, requireWorkspaceAdmin } from './util.js';

const serverProblem = (detail: string) =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/server-error', title: 'Server not set up for files', status: 500, detail });

export const VIEW_SESSION_MS = 8 * 60 * 60_000;

const sessionEnded = () =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/session-ended', title: 'Viewing session ended', status: 410,
    detail: 'This viewing session ended after 8 hours. Open the document again to continue.' });

const notReady = (detail: string) =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/not-ready', title: 'Not ready yet', status: 409, detail });

// stamping holds the whole PDF in memory, inside the request
export const STAMP_MAX_BYTES = 200 * 1024 * 1024;

const tooLargeToStamp = () =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/pdf-too-large', title: 'Too large to download as a PDF', status: 409, reason: 'pdf_too_large',
    detail: 'This PDF is too large for VDRkit to prepare a marked copy for download. You can still view it online.' });

function noPages(v: Version, filename: string): HttpProblem | null {
  const why = v.processing_status === 'failed' ? 'failed' as const : noPreviewOf(v.processing_status, v.page_count, v.preview_skipped);
  if (!why) return null;
  let detail = 'This file could not be prepared for viewing. Download the file to open it on your computer.';
  if (why === 'file_type') {
    const ext = extensionOf(filename).toUpperCase();
    detail = `${ext ? `${ext} files` : 'Files of this type'} cannot be shown in the browser. Download the file to open it on your computer.`;
  } else if (why === 'too_large') {
    detail = 'This file is too large to show in the browser. Download the file to open it on your computer.';
  }
  return new HttpProblem({ type: 'https://vdrkit.com/problems/no-preview', title: 'No preview', status: 409, detail, reason: 'no_preview', noPreview: why });
}

function fileDeps(app: FastifyInstance): { storage: Storage; keyring: Keyring } {
  const { storage, keyring } = app.deps;
  if (!storage) throw serverProblem('File storage is not configured on this server, so documents cannot be shown or downloaded.');
  if (!keyring) throw serverProblem('Encryption keys are not configured on this server, so documents cannot be shown or downloaded.');
  return { storage, keyring };
}

interface DocNode { id: string; name: string }

// 404 if the name isn't visible (no probing), 403 otherwise
async function gate(
  app: FastifyInstance, tx: SqlClient, caller: Caller, ws: string, nodeId: string, need: number, refusal: string, route: string,
): Promise<{ node: DocNode; level: number; versionId: string | null }> {
  const at = present(app.now());
  const access = capAccess(caller, await effectiveAccess(tx, personOf(caller), nodeId, at));
  if (access.level < Level.Fence && !access.canUpload && !access.canManage && !access.canPublish) throw blockedLink({ workspaceId: ws, nodeId, route });
  const { rows } = await tx.query<DocNode>(
    `select id, name from node where id = $1 and workspace_id = $2 and kind = 'document' and deleted_at is null`,
    [nodeId, ws],
  );
  const node = rows[0];
  if (!node) throw notFound();
  const version = await versionAccess(tx, caller.principal, nodeId, at);
  if (version.hidden) throw blockedLink({ workspaceId: ws, nodeId, route, versionHidden: true });
  if (access.level < need) throw forbidden(refusal, `needs_level_${need}`);
  return { node, level: access.level, versionId: version.versionId };
}

const ACTIVE_GROUPS = `
  select g.id, g.name from membership m join groups g on g.id = m.group_id
   where m.person_id = $1 and g.workspace_id = $2 and m.status = 'active'
     and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= $3 and $3 < m.superseded_at
     and g.valid_from <= $3 and $3 < g.valid_to`;

interface Version {
  id: string; storage_key: string; mime: string; sha256: string; key_version: number | null; size_bytes: string | number; failed_step: string | null;
  processing_status: string; virus_scan: string | null; page_count: number | null; preview_skipped: string | null;
}

async function chosenVersion(tx: SqlClient, versionId: string | null): Promise<Version> {
  if (!versionId) throw notReady('This document has no file yet.');
  const { rows } = await tx.query<Version>(
    `select id, storage_key, mime, sha256, key_version, size_bytes, failed_step, processing_status, metadata ->> 'virusScan' as virus_scan,
            coalesce(page_count, (metadata ->> 'pageCount')::int) as page_count, metadata ->> 'previewSkipped' as preview_skipped
       from document_version where id = $1`, [versionId]);
  const v = rows[0];
  if (!v) throw notReady('This document has no file yet.');
  // locked for everyone, room admins included
  if (v.failed_step === 'virus') {
    throw new HttpProblem({ type: 'https://vdrkit.com/problems/virus-found', title: 'Virus found', status: 409, reason: 'virus_found',
      detail: 'The virus scanner found a virus in this file, so nobody can open or download it. Remove it and upload a clean copy.' });
  }
  return v;
}

// no scanner, or too large for it, counts as scanned
function needScanned(v: Version): void {
  if (v.virus_scan || v.processing_status === 'ready') return;
  if (v.processing_status === 'failed') {
    throw new HttpProblem({ type: 'https://vdrkit.com/problems/virus-check-missing', title: 'Not checked for viruses', status: 409,
      reason: 'virus_check_missing', detail: 'This file could not be checked for viruses, so nobody can download it. Upload a new copy.' });
  }
  throw new HttpProblem({ type: 'https://vdrkit.com/problems/virus-check-pending', title: 'Virus check not finished', status: 409,
    reason: 'virus_check_pending', detail: 'This file is still being checked for viruses. Try again in a few minutes.' });
}

async function pageCountOf(tx: SqlClient, versionId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `select count(*)::int as n from derived_file where version_id = $1 and kind = 'page_image'`, [versionId]);
  return Number(rows[0]?.n ?? 0);
}

const FieldsIn = z.object({
  name: z.boolean(), email: z.boolean(), group: z.boolean(), dateTime: z.boolean(), ip: z.boolean(),
}).partial();

export function roomWatermarkFields(stored: unknown): WatermarkFields {
  const parsed = FieldsIn.safeParse(stored ?? {});
  if (!parsed.success) return { ...DEFAULT_FIELDS };
  return { ...DEFAULT_FIELDS, ...parsed.data };
}

async function viewerStamp(tx: SqlClient, caller: Caller, ws: string, at: Date): Promise<{ fields: WatermarkFields; viewer: Omit<Viewer, 'ip'> }> {
  const personId = personOf(caller);
  const { rows } = await tx.query<{ name: string; email: string; time_zone: string; group_name: string | null; wm: unknown }>(
    `select p.name, p.email, p.time_zone,
            (select string_agg(distinct x.name, ', ' order by x.name) from (${ACTIVE_GROUPS}) x) as group_name,
            (select w.metadata -> 'watermark' from workspace w where w.id = $2) as wm
       from person p where p.id = $4`,
    [personId, ws, at.toISOString(), caller.seeAs?.adminPersonId ?? personId],
  );
  const p = rows[0];
  if (!p) throw notFound();
  return { fields: roomWatermarkFields(p.wm), viewer: { name: p.name, email: p.email, groupName: p.group_name ?? '', timeZone: p.time_zone } };
}

async function viewerLines(tx: SqlClient, req: FastifyRequest, caller: Caller, ws: string, at: Date): Promise<string[]> {
  const { fields, viewer } = await viewerStamp(tx, caller, ws, at);
  const lines = watermarkLines(fields, { ...viewer, ip: req.ip }, at);
  // never hand out a clean page, whatever a room's stored settings say
  return lines.length ? lines : [viewer.email];
}

export interface WatermarkNote { name: string | null; email: string | null; group: string | null; dateTime: boolean; ip: boolean }

export async function watermarkNote(tx: SqlClient, caller: Caller, ws: string, at: Date): Promise<WatermarkNote> {
  const { fields, viewer } = await viewerStamp(tx, caller, ws, at);
  const note = {
    name: fields.name ? viewer.name : null,
    email: fields.email ? viewer.email : null,
    group: fields.group && viewer.groupName ? viewer.groupName : null,
    dateTime: fields.dateTime,
    ip: fields.ip,
  };
  // same fallback as viewerLines
  if (!note.name && !note.email && !note.group && !note.dateTime && !note.ip) note.email = viewer.email;
  return note;
}

async function fileKey(tx: SqlClient, deps: { keyring: Keyring }, ws: string, storageKey: string, keyVersion: number | null) {
  return { storageKey, key: await deps.keyring.keyFor(tx, ws, keyVersion) };
}

async function readWithKey(deps: { storage: Storage }, f: { storageKey: string; key: Buffer }): Promise<Buffer> {
  return decryptBuffer(f.key, await deps.storage.get(f.storageKey), f.storageKey);
}

export function requestedRange(header: string | undefined, size: number, ifRange?: string, etag?: string): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  if (ifRange !== undefined && ifRange !== etag) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    // suffix range, "bytes=-500"
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  return { start, end };
}

async function originalStream(storage: Storage, key: Buffer, storageKey: string, plainSize: number, range: ByteRange | null): Promise<Readable> {
  const headerStream = await getStream(storage, storageKey, { start: 0, end: HEADER_BYTES - 1 });
  const parts: Buffer[] = [];
  for await (const c of headerStream) parts.push(c as Buffer);
  const header = headerOf(Buffer.concat(parts));
  let sealed: Readable;
  let d: ReturnType<typeof decryptRangeStream>;
  if (plainSize === 0) {
    sealed = await getStream(storage, storageKey, { start: header.length, end: header.length + 15 });
    d = decryptRangeStream(key, header, storageKey, 0, 0, 0, 0);
  } else {
    const r = range ?? { start: 0, end: plainSize - 1 };
    const at = sealedRange(header, plainSize, r.start, r.end);
    sealed = await getStream(storage, storageKey, { start: at.sealedStart, end: at.sealedEnd });
    d = decryptRangeStream(key, header, storageKey, plainSize, at.firstChunk, at.skip, r.end - r.start + 1);
  }
  sealed.on('error', (e) => d.destroy(e));
  // client abort releases the storage connection
  d.on('close', () => { if (!sealed.readableEnded) sealed.destroy(); });
  return sealed.pipe(d);
}

export async function stampPdf(pdf: Buffer, lines: string[]): Promise<Buffer> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf);
  } catch {
    throw notReady('This PDF is protected or damaged, so VDRkit cannot prepare a marked copy.');
  }
  if (lines.length > 0) {
    const font = (await embedFonts(doc)).bold;
    const safe = lines.map((l) => printable(font, l));
    const angle = 30;
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const size = Math.max(9, Math.round(width * 0.022));
      const lineGap = size * 1.35;
      const textWidth = Math.max(...safe.map((l) => font.widthOfTextAtSize(l, size)));
      const stepU = textWidth + size * 3;
      const stepV = safe.length * lineGap + size * 4;
      const reach = Math.ceil(Math.hypot(width, height));
      for (let v = -reach; v <= reach; v += stepV) {
        const offset = (Math.round(v / stepV) % 2) * (stepU / 2);
        for (let u = -reach + offset; u <= reach; u += stepU) {
          safe.forEach((text, i) => {
            const vv = v - i * lineGap;
            const x = width / 2 + u * cos - vv * sin;
            const y = height / 2 + u * sin + vv * cos;
            if (x < -textWidth || x > width + textWidth || y < -textWidth || y > height + textWidth) return;
            page.drawText(text, { x, y, size, font, rotate: degrees(angle), color: rgb(0.1, 0.145, 0.19), opacity: 0.18 });
          });
        }
      }
    }
  }
  return Buffer.from(await doc.save());
}

export function attachment(filename: string): string {
  const clean = filename.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim() || 'document';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["%;]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const asPdfName = (name: string) => (/\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, '.pdf') : `${name}.pdf`);
const iso = (d: unknown) => new Date(d as string).toISOString();

const Params = z.object({ ws: z.string().uuid(), id: z.string().uuid() });
const CANNOT_OPEN = 'You can see this document in the index, but your access does not include opening it.';

export const viewerRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/v1/workspaces/:ws/nodes/:id/open', {
    schema: {
      summary: 'Open a document in the viewer',
      params: Params,
      response: { 200: z.object({ sessionId: z.string().uuid(), versionId: z.string().uuid(), pageCount: z.number(), expiresAt: z.string() }) },
    },
  }, async (req) => {
    fileDeps(app);
    return app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      const { ws, id } = req.params;
      const person = personOf(caller);
      const g = await gate(app, tx, caller, ws, id, Level.View, CANNOT_OPEN, 'viewer.open');
      const version = await chosenVersion(tx, g.versionId);
      const pageCount = await pageCountOf(tx, version.id);
      if (pageCount === 0) throw noPages(version, g.node.name) ?? notReady('This document is still being prepared for viewing. Try again in a minute.');
      const expiresAt = new Date(now.getTime() + VIEW_SESSION_MS).toISOString();
      if (caller.seeAs) return { sessionId: randomUUID(), versionId: version.id, pageCount, expiresAt };
      const { rows } = await tx.query<{ id: string }>(
        `insert into view_session (tenant_id, workspace_id, node_id, version_id, person_id, opened_at, last_seen_at, page_count)
         values (current_tenant_id(), $1, $2, $3, $4, $5, $5, $6) returning id`,
        [ws, id, version.id, person, now.toISOString(), pageCount],
      );
      await appendEvent(tx, {
        action: 'document.opened', workspaceId: ws, actorId: caller.actorId,
        onBehalfOfId: caller.principal.kind === 'person' ? null : person,
        resourceType: 'node', resourceId: id,
        data: { version_id: version.id, page_count: pageCount, person_id: person, session_id: rows[0]!.id },
        requestId: req.id, occurredAt: now,
        context: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
      });
      return { sessionId: rows[0]!.id, versionId: version.id, pageCount, expiresAt };
    });
  });

  r.get('/v1/workspaces/:ws/nodes/:id/pages/:page', {
    schema: {
      summary: 'Get one watermarked page as WebP',
      params: Params.extend({ page: z.coerce.number().int().min(1) }),
      querystring: z.object({ session: z.string().uuid(), size: z.enum(['full', 'thumb']).default('full') }),
    },
  }, async (req, reply) => {
    const deps = fileDeps(app);
    // render after the transaction; don't hold a pool connection
    const ready = await app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      const { ws, id, page } = req.params;
      const person = personOf(caller);
      const g = await gate(app, tx, caller, ws, id, Level.View, CANNOT_OPEN, 'viewer.page');
      let session: { version_id: string; page_count: number; opened_at: string } | undefined;
      if (caller.seeAs) {
        const v = await chosenVersion(tx, g.versionId);
        session = { version_id: v.id, page_count: await pageCountOf(tx, v.id), opened_at: now.toISOString() };
      } else {
        const { rows } = await tx.query<{ version_id: string; page_count: number; opened_at: string }>(
          `select version_id, page_count, opened_at from view_session where id = $1 and node_id = $2 and workspace_id = $3 and person_id = $4`,
          [req.query.session, id, ws, person],
        );
        session = rows[0];
      }
      if (!session) throw notFound();
      if (now.getTime() >= new Date(session.opened_at).getTime() + VIEW_SESSION_MS) throw sessionEnded();
      // recheck per page, the version may have been restricted since opening
      if (!(await canSeeVersion(tx, caller.principal, session.version_id, present(now)))) {
        throw blockedLink({ workspaceId: ws, nodeId: id, route: 'viewer.page', versionHidden: true });
      }
      const kind = req.query.size === 'thumb' ? 'thumbnail' : 'page_image';
      const { rows: files } = await tx.query<{ storage_key: string; key_version: number | null }>(
        `select storage_key, key_version from derived_file
          where version_id = $1 and kind = $2 and (metadata ->> 'page')::int = $3
          order by created_at desc limit 1`,
        [session.version_id, kind, page],
      );
      const file = files[0];
      if (!file) throw notFound();
      return { file: await fileKey(tx, deps, ws, file.storage_key, file.key_version), lines: await viewerLines(tx, req, caller, ws, now),
        versionId: session.version_id, seeAs: !!caller.seeAs, kind, now };
    });
    const clean = await readWithKey(deps, ready.file);
    const image = await applyWatermark(clean, ready.lines);
    if (!ready.seeAs) {
      await app.inTenant(req, async (tx, caller) => {
        const n = ready.kind === 'page_image' ? req.params.page : 0;
        const before = await tx.query<{ seen: boolean }>(
          `select $2 = any(pages_seen) as seen from view_session where id = $1 for update`, [req.query.session, n]);
        await tx.query(
          `update view_session
              set pages_seen = case when $2 = 0 or $2 = any(pages_seen) then pages_seen else array_append(pages_seen, $2) end,
                  last_seen_at = greatest(last_seen_at, $3)
            where id = $1`,
          [req.query.session, n, ready.now.toISOString()],
        );
        // pages_seen is only a read model; the first view of each page per session goes in the chain
        if (n !== 0 && before.rows[0]?.seen === false) {
          const person = personOf(caller);
          await appendEvent(tx, {
            action: 'document.page_viewed', workspaceId: req.params.ws, actorId: caller.actorId,
            onBehalfOfId: caller.principal.kind === 'person' ? null : person,
            resourceType: 'node', resourceId: req.params.id,
            data: { version_id: ready.versionId, page: n, person_id: person, session_id: req.query.session,
              watermark_sha256: watermarkDigest(ready.lines) },
            requestId: req.id, occurredAt: ready.now,
          });
        }
      });
    }
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type('image/webp').send(image);
  });

  r.get('/v1/workspaces/:ws/nodes/:id/download', {
    schema: {
      summary: 'Download a watermarked PDF or the original file. Supports Range requests',
      params: Params,
      querystring: z.object({ format: z.enum(['pdf', 'original']).default('pdf') }),
    },
  }, async (req, reply) => {
    const deps = fileDeps(app);
    type Pdf = { pdf: { file: { storageKey: string; key: Buffer }; lines: string[]; versionId: string; person: string; onBehalfOfId: string | null;
      actorId: string | null; now: Date }; mime: string; filename: string };
    const out = await app.inTenant<Pdf | { stream: () => Promise<Readable>; mime: string; filename: string;
      size: number; range: ByteRange | null; etag: string }>(req, async (tx, caller) => {
      const now = app.now();
      const { ws, id } = req.params;
      const format = req.query.format;
      const person = personOf(caller);
      const g = format === 'pdf'
        ? await gate(app, tx, caller, ws, id, Level.Pdf, 'Your access to this document does not include downloading it as a PDF.', 'viewer.download')
        : await gate(app, tx, caller, ws, id, Level.Original, 'Your access to this document does not include downloading the original file.', 'viewer.download');
      const version = await chosenVersion(tx, g.versionId);
      if (format === 'pdf') {
        const { rows } = await tx.query<{ storage_key: string; key_version: number | null; size: string | null }>(
          `select storage_key, key_version, metadata ->> 'size' as size from derived_file where version_id = $1 and kind = 'pdf' order by created_at desc limit 1`,
          [version.id]);
        if (!rows[0]) {
          if (noPages(version, g.node.name)) {
            throw new HttpProblem({ type: 'https://vdrkit.com/problems/no-preview', title: 'No preview', status: 409, reason: 'no_preview',
              detail: 'This file has no PDF copy, because it cannot be shown in the browser. Only people allowed to download original files can download it.' });
          }
          throw notReady('This document is still being prepared. Try again in a minute.');
        }
        const size = rows[0].size != null ? Number(rows[0].size) : await deps.storage.size?.(rows[0].storage_key);
        if (size != null && size > STAMP_MAX_BYTES) throw tooLargeToStamp();
        return { pdf: { file: await fileKey(tx, deps, ws, rows[0].storage_key, rows[0].key_version), lines: await viewerLines(tx, req, caller, ws, now),
          versionId: version.id, person, onBehalfOfId: caller.principal.kind === 'person' ? null : person, actorId: caller.actorId, now },
        mime: 'application/pdf', filename: asPdfName(g.node.name) };
      } else {
        needScanned(version);
        // log every request, ranges too
        const size = Number(version.size_bytes);
        const etag = `"${version.sha256}"`;
        const ifRange = typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined;
        const range = requestedRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size, ifRange, etag);
        if (range === 'unsatisfiable') {
          throw new HttpProblem({ type: 'https://vdrkit.com/problems/range-not-satisfiable', title: 'Range not satisfiable', status: 416,
            detail: `The file is ${size} bytes long.` });
        }
        const key = await deps.keyring.keyFor(tx, ws, version.key_version);
        await appendEvent(tx, {
          action: 'document.downloaded', workspaceId: ws, actorId: caller.actorId,
          onBehalfOfId: caller.principal.kind === 'person' ? null : person,
          resourceType: 'node', resourceId: id,
          data: { format, version_id: version.id, sha256: version.sha256, person_id: person,
            ...(range ? { range: `bytes ${range.start}-${range.end}/${size}` } : {}) },
          requestId: req.id, occurredAt: now,
          context: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, subjectPersonId: person },
        });
        return { stream: () => originalStream(deps.storage, key, version.storage_key, size, range), mime: version.mime || 'application/octet-stream',
          filename: g.node.name, size, range, etag };
      }
    });
    let body: Buffer | null = null;
    if ('pdf' in out) {
      const p = out.pdf;
      body = await stampPdf(await readWithKey(deps, p.file), p.lines);
      const sha256 = createHash('sha256').update(body).digest('hex');
      // commit the record before the file is sent
      await app.inTenant(req, (tx) => appendEvent(tx, {
        action: 'document.downloaded', workspaceId: req.params.ws, actorId: p.actorId, onBehalfOfId: p.onBehalfOfId,
        resourceType: 'node', resourceId: req.params.id,
        data: { format: 'pdf', version_id: p.versionId, sha256, person_id: p.person, watermark_sha256: watermarkDigest(p.lines) },
        requestId: req.id, occurredAt: p.now,
        // personal data: erasable context, not the hash chain; only its digest is hashed
        context: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, personal: { watermark: p.lines }, subjectPersonId: p.person },
      }));
    }
    reply
      .header('content-disposition', attachment(out.filename))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .type(out.mime);
    if ('pdf' in out) return reply.send(body);
    reply.header('accept-ranges', 'bytes').header('etag', out.etag);
    if (out.range) {
      reply.code(206).header('content-range', `bytes ${out.range.start}-${out.range.end}/${out.size}`)
        .header('content-length', out.range.end - out.range.start + 1);
    } else {
      reply.header('content-length', out.size);
    }
    return reply.send(await out.stream());
  });

  r.get('/v1/workspaces/:ws/nodes/:id/coverage', {
    schema: {
      summary: 'Who opened a document and how many pages each saw. Room admins only',
      params: Params,
      response: {
        200: z.object({
          versionId: z.string().uuid(),
          pageCount: z.number(),
          people: z.array(z.object({
            personId: z.string().uuid(), name: z.string(), email: z.string(),
            pagesSeen: z.number(), pageCount: z.number(), firstOpenedAt: z.string(), lastSeenAt: z.string(),
          })),
        }),
      },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, id } = req.params;
    await requireWorkspaceAdmin(tx, caller, ws, app.now());
    const { rows: nodes } = await tx.query<{ id: string }>(
      `select id from node where id = $1 and workspace_id = $2 and kind = 'document' and deleted_at is null`, [id, ws]);
    if (!nodes[0]) throw notFound();
    const { rows: versions } = await tx.query<{ id: string }>(
      `select id from document_version where node_id = $1 order by version_no desc limit 1`, [id]);
    const version = versions[0];
    if (!version) throw notReady('This document has no file yet.');
    const pageCount = await pageCountOf(tx, version.id);
    const { rows } = await tx.query<{ person_id: string; name: string; email: string; seen: number; first_opened: string; last_seen: string }>(
      `select s.person_id, case when p.erased_at is not null then 'Erased user' else p.name end as name,
              case when p.erased_at is not null then '' else p.email end as email,
              (select count(distinct x)::int from view_session s2, unnest(s2.pages_seen) x
                where s2.version_id = $1 and s2.person_id = s.person_id) as seen,
              min(s.opened_at) as first_opened, max(s.last_seen_at) as last_seen
         from view_session s join person p on p.id = s.person_id
        where s.version_id = $1
        group by s.person_id, p.name, p.email, p.erased_at
        order by max(s.last_seen_at) desc`,
      [version.id],
    );
    return {
      versionId: version.id,
      pageCount,
      people: rows.map((x) => ({
        personId: x.person_id, name: x.name, email: x.email, pagesSeen: Number(x.seen), pageCount,
        firstOpenedAt: iso(x.first_opened), lastSeenAt: iso(x.last_seen),
      })),
    };
  }));
};
