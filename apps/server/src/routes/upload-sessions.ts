// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { finished, Readable, Transform, type TransformCallback } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, effectiveAccess, parseLeadingNumber, type SqlClient, present } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { encryptStream } from '../crypto/envelope.js';
import { extensionOf, getStream, putStream, type Storage } from '../pipeline/pipeline.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../problems.js';
import { grantAdminsOnTopFolder } from './rooms.js';
import { hasHiddenCharacters, HIDDEN_CHARACTERS_MESSAGE, lockIndex, NAME_MAX, personOf, requireMember, requireWorkspaceAdmin, roomArchived,
  roomFrozenForUploading } from './util.js';

const configuredMax = Number(process.env.UPLOAD_MAX_BYTES);
export const MAX_UPLOAD_BYTES = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 5 * 1024 ** 3;

export function sizeLimitText(bytes = MAX_UPLOAD_BYTES): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Number(gb.toFixed(1))} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
const SESSION_TTL_SECONDS = 24 * 60 * 60;
// S3: parts >= 5 MiB except the last, max 10,000
const MIN_PART_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;

const WsParams = z.object({ ws: z.string().uuid() });
const SessionParams = WsParams.extend({ id: z.string().uuid() });

const Segment = z.string().min(1).max(NAME_MAX)
  .refine((s) => s !== '.' && s !== '..', 'Paths may not contain . or ..')
  .refine((s) => !s.includes('\\'), 'Paths may not contain backslashes')
  .refine((s) => !hasHiddenCharacters(s), HIDDEN_CHARACTERS_MESSAGE);
const RelativePath = z.string().min(1).max(1024).superRefine((p, ctx) => {
  for (const s of p.split('/')) {
    const checked = Segment.safeParse(s);
    if (!checked.success) {
      ctx.addIssue({ code: 'custom', message: checked.error.issues[0]?.message ?? 'Invalid path' });
      return;
    }
  }
});

const StartBody = z.object({
  targetFolderId: z.string().uuid().nullable().default(null),
  replacesNodeId: z.string().uuid().optional(),
  path: RelativePath,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(200).default('application/octet-stream'),
  numbering: z.enum(['from_names', 'alphabetical']).default('from_names'),
  plannedNumber: z.number().int().min(1).max(99999).optional(),
});

const StartOut = z.object({
  id: z.string().uuid(),
  expiresAt: z.string(),
  method: z.enum(['presigned', 'direct']),
  uploadUrl: z.string().optional(),
  partSize: z.number().optional(),
  parts: z.array(z.object({ partNumber: z.number(), url: z.string() })).optional(),
});

const CompleteOut = z.object({
  nodeId: z.string().uuid(),
  versionId: z.string().uuid(),
  versionNo: z.number(),
  indexNumber: z.string().nullable(),
  createdFolders: z.array(z.object({ id: z.string().uuid(), indexNumber: z.string(), name: z.string() })),
  awaitingRelease: z.boolean(),
});
type CompleteOut = z.infer<typeof CompleteOut>;
type Completed = CompleteOut & { fresh: boolean; tenantId: string; quarantineKey: string };

interface Session {
  id: string; workspace_id: string; person_id: string; principal_id: string; target_folder_id: string | null;
  replaces_node_id: string | null; relative_path: string; numbering: 'from_names' | 'alphabetical'; planned_number: number | null;
  declared_size: string; declared_sha256: string; mime: string; quarantine_key: string; multipart_upload_id: string | null;
  part_count: number | null; status: string; node_id: string | null; version_id: string | null; expires_at: Date | string;
}

class Tally extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;
  constructor(private readonly max = Infinity) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.max) return cb(new TooLong(this.max));
    this.hash.update(chunk);
    cb(null, chunk);
  }
}
class TooLong extends Error { constructor(readonly max: number) { super(`More than ${max} bytes`); } }

function through<T extends Transform>(src: Readable, t: T): T {
  src.on('error', (e) => t.destroy(e));
  // don't destroy a fully read request (keep-alive)
  t.on('close', () => { if (!src.readableEnded) src.destroy(); });
  return src.pipe(t);
}

const canSeeAny = (a: { level: number; canUpload: boolean; canManage: boolean; canPublish: boolean }) =>
  a.level > 0 || a.canUpload || a.canManage || a.canPublish;
const norm = (s: string) => s.trim().toLocaleLowerCase('en');

const quietly = (work: Promise<unknown> | undefined) => work?.catch(() => undefined);
const discard = (storage: Storage, key: string) => quietly(storage.delete?.(key));

function needDeps(app: FastifyInstance) {
  const { storage, keyring, queue } = app.deps;
  if (!storage || !keyring || !queue) {
    throw new HttpProblem({ type: 'https://vdrkit.com/problems/not-configured', title: 'Uploads are not set up', status: 503,
      detail: 'This server has no file storage, master key or job queue configured.' });
  }
  return { storage, keyring, queue };
}

async function principalFor(tx: SqlClient, caller: Caller): Promise<string> {
  const person = personOf(caller);
  if (caller.actorId) {
    const own = await tx.query(`select 1 from principal where id = $1 and kind = 'person' and person_id = $2 and revoked_at is null`, [caller.actorId, person]);
    if (own.rows.length) return caller.actorId;
  }
  const found = (await tx.query<{ id: string }>(
    `select id from principal where kind = 'person' and person_id = $1 and revoked_at is null order by created_at limit 1`, [person])).rows[0];
  if (found) return found.id;
  return (await tx.query<{ id: string }>(
    `insert into principal (tenant_id, kind, person_id, name) select current_tenant_id(), 'person', id, name from person where id = $1 returning id`,
    [person])).rows[0]!.id;
}

// runs at start and again at completion
async function checkTarget(tx: SqlClient, caller: Caller, ws: string, t: { targetFolderId: string | null; replacesNodeId: string | null; path: string }, now: Date) {
  if (caller.principal.kind === 'agent') throw forbidden('Agents cannot upload. Ask the person to approve it.', 'agent_needs_approval');
  await requireMember(tx, caller, ws, now);
  // for share: a freeze must wait for a completing upload
  const room = (await tx.query<{ state: string }>(`select state from workspace where id = $1 for share`, [ws])).rows[0]!;
  if (room.state === 'frozen') throw roomFrozenForUploading();
  if (room.state === 'archived') throw roomArchived();
  if (room.state === 'closed') throw badRequest('This room is closed. Open it again before uploading.');
  const nodeId = t.replacesNodeId ?? t.targetFolderId;
  if (!nodeId) {
    await requireWorkspaceAdmin(tx, caller, ws, now);
    return null;
  }
  const n = (await tx.query<{ id: string; kind: string; name: string; state: string; index_number: string | null }>(
    `select id, kind, name, state, index_number from node where id = $1 and workspace_id = $2 and deleted_at is null`, [nodeId, ws])).rows[0];
  const a = await effectiveAccess(tx, personOf(caller), nodeId, present(now));
  if (!n || !canSeeAny(a)) throw notFound();
  if (!a.canUpload) throw forbidden('You cannot upload here.', 'no_upload_right');
  if (t.replacesNodeId) {
    if (n.kind !== 'document') throw badRequest('A new version can only replace a document.');
    if (t.path.includes('/')) throw badRequest('A new version is a single file, without folders.');
    if (extensionOf(t.path) !== extensionOf(n.name)) {
      throw badRequest(`A new version must be the same type of file as the document (.${extensionOf(n.name) || 'no extension'}). Upload it as a new document instead.`);
    }
  } else if (n.kind !== 'folder') {
    throw badRequest('Files can only be uploaded into folders.');
  }
  return n;
}

async function siblingNumbers(tx: SqlClient, ws: string, parentId: string | null, prefix: string) {
  const { rows } = await tx.query<{ n: number | null }>(
    // Deleted drafts keep their numbers. Their path isn't renumbered on a move: use the last segment
    `select nullif(case when deleted_at is null then split_part(index_number, '.', $3)
                        else substring(index_number from '([0-9]+)$') end, '')::int as n from node
      where workspace_id = $1 and parent_id is not distinct from $2 and index_number ~ '^[0-9]+([.][0-9]+)*$'`,
    [ws, parentId, prefix ? prefix.split('.').length + 1 : 1]);
  const used = new Set(rows.map((r) => Number(r.n)).filter((n) => Number.isFinite(n)));
  const sort = (await tx.query<{ s: number }>(
    `select coalesce(max(sort_key), 0) + 1 as s from node where workspace_id = $1 and parent_id is not distinct from $2 and deleted_at is null`,
    [ws, parentId])).rows[0]!.s;
  return { used, next: Math.max(0, ...used) + 1, sortKey: Number(sort) };
}

async function placeDocument(tx: SqlClient, caller: Caller, ws: string, target: { id: string; index_number: string | null } | null,
  path: string, numbering: 'from_names' | 'alphabetical', plannedNumber: number | null, now: Date, requestId: string) {
  const segments = path.split('/');
  const fileName = segments.pop()!;
  let parentId = target?.id ?? null;
  let prefix = target?.index_number ?? '';
  const createdFolders: CompleteOut['createdFolders'] = [];
  const join = (n: number) => (prefix ? `${prefix}.${n}` : String(n));
  const created = new Set<string>();
  const seesEverySibling = async (parent: string | null) => {
    const others = (await tx.query<{ id: string }>(
      `select id from node where workspace_id = $1 and parent_id is not distinct from $2 and deleted_at is null`, [ws, parent]))
      .rows.map((r) => r.id).filter((id) => !created.has(id));
    if (!others.length) return true;
    const seen = new Set((await tx.query<{ node_id: string }>(
      `select node_id from accessible_nodes_among($1, $2, $4::uuid[], $3, record_clock()) where level >= 10 or can_upload or can_manage or can_publish`,
      [personOf(caller), ws, now.toISOString(), others])).rows.map((r) => r.node_id));
    return others.every((id) => seen.has(id));
  };

  for (const seg of segments) {
    const parsed = parseLeadingNumber(seg);
    const kids = (await tx.query<{ id: string; name: string; index_number: string | null }>(
      `select id, name, index_number from node where workspace_id = $1 and parent_id is not distinct from $2 and kind = 'folder' and deleted_at is null`,
      [ws, parentId])).rows;
    let match: { id: string; name: string; index_number: string | null } | null = null;
    for (const k of kids) {
      if (norm(k.name) !== norm(parsed.name)) continue;
      const a = await effectiveAccess(tx, personOf(caller), k.id, present(now));
      // never merge into a hidden folder: the upload would reveal it
      if (!canSeeAny(a)) continue;
      // a subfolder can switch the upload right off
      if (!a.canUpload) {
        const folder = k.index_number ? `${k.index_number} ${k.name}` : k.name;
        throw forbidden(`You cannot upload into ${folder}. Rename the folder in your upload, or ask for the upload right there.`,
          'no_upload_right', [{ id: k.id, indexNumber: k.index_number }]);
      }
      match = k;
      break;
    }
    if (match) {
      parentId = match.id;
      prefix = match.index_number ?? prefix;
      continue;
    }
    const { used, next, sortKey } = await siblingNumbers(tx, ws, parentId, prefix);
    const seesAll = await seesEverySibling(parentId);
    // hidden siblings: take the next number silently, or we confirm they exist
    let number = next;
    if (numbering === 'from_names' && seesAll && parsed.number != null && !used.has(parsed.number)) number = parsed.number;
    const indexNumber = join(number);
    const id = (await tx.query<{ id: string }>(
      `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state)
       values (current_tenant_id(), $1, $2, 'folder', $3, $4, $5, 'draft') returning id`,
      [ws, parentId, parsed.name, indexNumber, sortKey])).rows[0]!.id;
    if (!parentId) await grantAdminsOnTopFolder(tx, ws, id, now);
    await appendEvent(tx, { action: 'folder.created', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: id,
      data: { index_number: indexNumber, parent_id: parentId, via: 'upload' }, occurredAt: now, requestId });
    createdFolders.push({ id, indexNumber, name: parsed.name });
    created.add(id);
    parentId = id;
    prefix = indexNumber;
  }

  const { used, next, sortKey } = await siblingNumbers(tx, ws, parentId, prefix);
  const keep = plannedNumber != null && !used.has(plannedNumber) && await seesEverySibling(parentId);
  const indexNumber = join(keep ? plannedNumber : next);
  const nodeId = (await tx.query<{ id: string }>(
    `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state)
     values (current_tenant_id(), $1, $2, 'document', $3, $4, $5, 'draft') returning id`,
    [ws, parentId, fileName, indexNumber, sortKey])).rows[0]!.id;
  return { nodeId, indexNumber, createdFolders };
}

const wrongSize = (received: number, declared: number) =>
  badRequest(`The file is ${received} bytes, but ${declared} were declared when the upload started.`);

function countBytes(body: NodeJS.ReadableStream, declared: number): Transform {
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      if (received > declared) done(wrongSize(received, declared));
      else done(null, chunk);
    },
    flush(done) {
      done(received === declared ? null : wrongSize(received, declared));
    },
  });
  // fail the counter so storage drops the partial file; don't destroy req or the 400 is lost
  finished(body, (err) => { if (err) counter.destroy(err); });
  counter.once('error', () => body.unpipe(counter));
  body.pipe(counter);
  return counter;
}

class Rejected extends Error {
  constructor(readonly reason: 'size_mismatch' | 'hash_mismatch', readonly detail: string, readonly quarantineKey: string) { super(detail); }
}

export const uploadSessionRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  r.post('/v1/workspaces/:ws/upload-sessions', {
    schema: {
      summary: 'Start a file upload',
      params: WsParams,
      body: StartBody,
      response: { 201: StartOut },
    },
  }, async (req, reply) => {
    const { storage } = needDeps(app);
    const out = await app.inTenant(req, async (tx, caller) => {
      const { ws } = req.params;
      const b = req.body;
      const now = app.now();
      const replacesNodeId = b.replacesNodeId ?? null;
      if (replacesNodeId && b.targetFolderId) throw badRequest('Give either a target folder or a document to replace, not both.');
      await checkTarget(tx, caller, ws, { targetFolderId: b.targetFolderId, replacesNodeId, path: b.path }, now);
      if (b.size > MAX_UPLOAD_BYTES) throw badRequest(`Files larger than ${sizeLimitText()} cannot be uploaded. Split the file or compress it.`);

      const id = randomUUID();
      const quarantineKey = `quarantine/${ws}/${id}`;
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
      let multipart: { uploadId: string; urls: string[]; partSize: number } | null = null;
      if (storage.multipart) {
        const partSize = Math.max(MIN_PART_BYTES, Math.ceil(b.size / MAX_PARTS));
        const partCount = Math.max(1, Math.ceil(b.size / partSize));
        const sizes = Array.from({ length: partCount }, (_, i) => (i < partCount - 1 ? partSize : b.size - partSize * (partCount - 1)));
        const started = await storage.multipart.start(quarantineKey, sizes, SESSION_TTL_SECONDS);
        multipart = { ...started, partSize };
      }
      await tx.query(
        `insert into upload_session (id, tenant_id, workspace_id, person_id, principal_id, target_folder_id, replaces_node_id, relative_path,
           numbering, declared_size, declared_sha256, mime, quarantine_key, multipart_upload_id, part_size, part_count, created_at, expires_at,
           planned_number)
         values ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [id, ws, personOf(caller), await principalFor(tx, caller), replacesNodeId ? null : b.targetFolderId, replacesNodeId, b.path,
          b.numbering, b.size, b.sha256, b.mime, quarantineKey, multipart?.uploadId ?? null, multipart?.partSize ?? null,
          multipart?.urls.length ?? null, now.toISOString(), expiresAt.toISOString(), replacesNodeId ? null : b.plannedNumber ?? null]);
      await appendEvent(tx, { action: 'upload.started', workspaceId: ws, actorId: caller.actorId, resourceType: 'upload_session', resourceId: id,
        data: { path: b.path, size: b.size, sha256: b.sha256, target_folder_id: b.targetFolderId, replaces_node_id: replacesNodeId },
        occurredAt: now, requestId: req.id });
      return multipart
        ? { id, expiresAt: expiresAt.toISOString(), method: 'presigned' as const, partSize: multipart.partSize,
            parts: multipart.urls.map((url, i) => ({ partNumber: i + 1, url })) }
        : { id, expiresAt: expiresAt.toISOString(), method: 'direct' as const, uploadUrl: `/v1/workspaces/${ws}/upload-sessions/${id}/content` };
    });
    return reply.code(201).send(out);
  });

  async function ownSession(tx: SqlClient, caller: Caller, ws: string, id: string, lock = false): Promise<Session> {
    if (caller.principal.kind === 'agent') throw forbidden('Agents cannot upload. Ask the person to approve it.', 'agent_needs_approval');
    const s = (await tx.query<Session>(
      `select * from upload_session where id = $1 and workspace_id = $2 ${lock ? 'for update' : ''}`, [id, ws])).rows[0];
    if (!s || s.person_id !== personOf(caller)) throw notFound();
    return s;
  }

  const expired = () => new HttpProblem({ type: 'https://vdrkit.com/problems/upload-expired', title: 'Upload expired', status: 410,
    detail: 'This upload has expired. Start it again.' });
  const notOpen = (s: Session) => {
    if (s.status === 'expired') return expired();
    const detail = s.status === 'rejected' ? 'This upload was rejected. Start it again.' : 'This upload is no longer open.';
    return new HttpProblem({ type: 'https://vdrkit.com/problems/upload-not-open', title: 'Upload is closed', status: 409, detail });
  };

  r.put('/v1/workspaces/:ws/upload-sessions/:id/content', {
    bodyLimit: MAX_UPLOAD_BYTES,
    // JSON/text parsers would buffer the whole body
    onRequest: async (req) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/octet-stream') {
        throw new HttpProblem({ type: 'https://vdrkit.com/problems/unsupported-media-type', title: 'Unsupported media type', status: 415,
          detail: 'Send the file as application/octet-stream.' });
      }
    },
    schema: {
      summary: 'Send file bytes (servers without presigned uploads)',
      params: SessionParams,
      response: { 204: z.null() },
    },
  }, async (req, reply) => {
    const { storage } = needDeps(app);
    const body = req.body as Readable | Buffer | undefined;
    try {
      const s = await app.inTenant(req, async (tx, caller) => {
        const s = await ownSession(tx, caller, req.params.ws, req.params.id);
        if (s.status !== 'open') throw notOpen(s);
        if (new Date(s.expires_at) <= app.now()) throw expired();
        if (s.multipart_upload_id) throw badRequest('Send this file to the presigned part URLs instead.');
        return s;
      });
      if (!body || (!Buffer.isBuffer(body) && typeof (body as Readable).pipe !== 'function')) throw badRequest('Send the file as application/octet-stream.');
      const size = Number(s.declared_size);
      const announced = req.headers['content-length'];
      if (announced !== undefined && Number(announced) !== size) throw wrongSize(Number(announced), size);
      const counted = countBytes(Buffer.isBuffer(body) ? Readable.from([body]) : body as Readable, size);
      try {
        await putStream(storage, s.quarantine_key, counted);
      } catch (e) {
        await discard(storage, s.quarantine_key);
        throw e;
      }
      // cancelled or completed meanwhile; the sweep only sees open uploads, so discard here
      const after = await app.inTenant(req, (tx, caller) => ownSession(tx, caller, req.params.ws, req.params.id));
      if (after.status !== 'open') {
        await discard(storage, s.quarantine_key);
        throw notOpen(after);
      }
    } catch (e) {
      if (!req.raw.complete) reply.header('connection', 'close');
      throw e;
    }
    return reply.code(204).send(null);
  });

  r.post('/v1/workspaces/:ws/upload-sessions/:id/complete', {
    schema: {
      summary: 'Complete an upload',
      params: SessionParams,
      body: z.object({
        parts: z.array(z.object({ partNumber: z.number().int().min(1).max(MAX_PARTS), etag: z.string().min(1).max(200) })).max(MAX_PARTS).optional(),
        useFileName: z.boolean().optional(),
      }).default({}),
      response: { 200: CompleteOut },
    },
  }, async (req) => {
    const { storage, keyring, queue } = needDeps(app);
    const { ws, id } = req.params;

    const first = await app.inTenant<Completed | Rejected | { s: Session; key: Buffer; keyVersion: number }>(req, async (tx, caller) => {
      const now = app.now();
      const s = await ownSession(tx, caller, ws, id, true);
      if (s.status === 'completed') return completedResult(tx, s, caller.tenantId);
      if (s.status !== 'open') throw notOpen(s);
      if (new Date(s.expires_at) <= now) throw expired();
      await checkTarget(tx, caller, ws, { targetFolderId: s.target_folder_id, replacesNodeId: s.replaces_node_id, path: s.relative_path }, now);
      const size = Number(s.declared_size);
      if (s.multipart_upload_id) {
        const parts = req.body.parts ?? [];
        if (parts.length !== s.part_count) throw badRequest(`Expected ${s.part_count} parts with their ETags, got ${parts.length}.`);
        try {
          await storage.multipart!.complete(s.quarantine_key, s.multipart_upload_id, parts);
        } catch (e) {
          const there = storage.size ? await storage.size(s.quarantine_key).catch(() => null) : null;
          if (there !== size) {
            // the store's own text names buckets and keys
            req.log.warn({ err: e, uploadSession: s.id }, 'storage could not join the upload parts');
            throw badRequest('The storage service could not join the parts of the file. Send the missing parts again, or start the upload again.');
          }
        }
      }
      const stored = storage.size ? await storage.size(s.quarantine_key) : undefined;
      if (stored === null) throw badRequest('The file has not arrived yet. Send it, then complete the upload.');
      if (stored !== undefined && stored !== size) {
        return reject(tx, caller, s, new Rejected('size_mismatch', `The file that arrived is ${stored} bytes, but ${size} were declared.`, s.quarantine_key),
          { received_size: stored }, now, req.id);
      }
      const { key, version } = await keyring.dataKey(tx, ws);
      return { s, key, keyVersion: version };
    });
    if (first instanceof Rejected) return refuse(storage, first);
    if ('fresh' in first) return answer(first);

    const { s, key, keyVersion } = first;
    const size = Number(s.declared_size);
    const versionId = randomUUID();
    const storageKey = `ws/${ws}/v/${versionId}/original`;
    let source: Readable;
    try {
      source = await getStream(storage, s.quarantine_key);
    } catch {
      throw badRequest('The file has not arrived yet. Send it, then complete the upload.');
    }
    const tally = new Tally();
    try {
      await putStream(storage, storageKey, through(through(source, tally), encryptStream(key, storageKey)));
    } catch (e) {
      await discard(storage, storageKey);
      throw e;
    }
    const actualSha = tally.hash.digest('hex');

    // recheck, another completion may have won
    let outcome: Completed | Rejected;
    try {
      outcome = await app.inTenant<Completed | Rejected>(req, async (tx, caller) => {
        const now = app.now();
        const s = await ownSession(tx, caller, ws, id, true);
        if (s.status === 'completed') return completedResult(tx, s, caller.tenantId);
        if (s.status !== 'open') throw notOpen(s);
        const received = { received_size: tally.bytes, received_sha256: actualSha };
        if (tally.bytes !== size) {
          const bad = new Rejected('size_mismatch', `The file that arrived is ${tally.bytes} bytes, but ${size} were declared.`, s.quarantine_key);
          return reject(tx, caller, s, bad, received, now, req.id);
        }
        if (actualSha !== s.declared_sha256) {
          const bad = new Rejected('hash_mismatch', 'The file that arrived is not the file that was declared: its SHA-256 differs. Upload it again.', s.quarantine_key);
          return reject(tx, caller, s, bad, received, now, req.id);
        }
        const checked = await checkTarget(tx, caller, ws, { targetFolderId: s.target_folder_id, replacesNodeId: s.replaces_node_id, path: s.relative_path }, now);

        await lockIndex(tx, ws);
        // read again under the locks: a publish or a renumber may have committed while this waited
        const target = checked ? (await tx.query<{ id: string; kind: string; name: string; state: string; index_number: string | null }>(
          `select id, kind, name, state, index_number from node where id = $1 and deleted_at is null for share`, [checked.id])).rows[0] ?? null : null;
        if (checked && !target) throw notFound();
        let nodeId: string;
        let indexNumber: string | null;
        let createdFolders: CompleteOut['createdFolders'] = [];
        let versionNo = 1;
        let awaitingRelease = false;
        let visibleTo: string[] = [];
        if (s.replaces_node_id) {
          nodeId = s.replaces_node_id;
          indexNumber = target!.index_number;
          versionNo = Number((await tx.query<{ n: number }>(
            `select coalesce(max(version_no), 0) + 1 as n from document_version where node_id = $1`, [nodeId])).rows[0]!.n);
          const fileName = s.relative_path.split('/').pop()!;
          if (req.body.useFileName && fileName && fileName !== target!.name) {
            await tx.query(`update node set name = $2, updated_at = $3 where id = $1`, [nodeId, fileName, now.toISOString()]);
            await appendEvent(tx, { action: 'node.renamed', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: nodeId,
              data: { index_number: target!.index_number, upload_session_id: id }, occurredAt: now, requestId: req.id });
          }
          if (target!.state === 'published') {
            awaitingRelease = true;
            visibleTo = (await tx.query<{ id: string }>(
              `select g.id from groups g join party pa on pa.id = g.party_id
                where g.workspace_id = $1 and pa.kind = 'seller' and g.valid_from <= $2 and $2 < g.valid_to`, [ws, now.toISOString()])).rows.map((g) => g.id);
          }
        } else {
          const planned = s.planned_number == null ? null : Number(s.planned_number);
          ({ nodeId, indexNumber, createdFolders } = await placeDocument(tx, caller, ws, target, s.relative_path, s.numbering, planned, now, req.id));
        }

        await tx.query(
          `insert into document_version (id, tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, key_version,
             visible_to_group_ids, awaiting_release, metadata, created_at, queued_at)
           values ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11, $12, $13, $13)`,
          [versionId, nodeId, versionNo, storageKey, actualSha, size, s.mime, s.principal_id, keyVersion, visibleTo, awaitingRelease,
            JSON.stringify({ filename: s.relative_path.split('/').pop(), upload_session_id: id }), now.toISOString()]);
        await tx.query(`update upload_session set status = 'completed', node_id = $2, version_id = $3, completed_at = $4 where id = $1`,
          [id, nodeId, versionId, now.toISOString()]);
        await appendEvent(tx, { action: versionNo === 1 ? 'document.uploaded' : 'document.version_uploaded', workspaceId: ws, actorId: caller.actorId,
          resourceType: 'node', resourceId: nodeId,
          data: { index_number: indexNumber, version_id: versionId, version_no: versionNo, size, sha256: actualSha, person_id: personOf(caller), upload_session_id: id },
          occurredAt: now, requestId: req.id });
        return { nodeId, versionId, versionNo, indexNumber, createdFolders, awaitingRelease, fresh: true, tenantId: caller.tenantId, quarantineKey: s.quarantine_key };
      });
    } catch (e) {
      await discard(storage, storageKey);
      throw e;
    }
    if (outcome instanceof Rejected || !outcome.fresh) await discard(storage, storageKey);
    if (outcome instanceof Rejected) return refuse(storage, outcome);
    if (outcome.fresh) {
      // after commit: the worker must find the version
      await queue.enqueue('process-version', { tenantId: outcome.tenantId, versionId: outcome.versionId });
      await discard(storage, outcome.quarantineKey);
    }
    return answer(outcome);
  });

  async function completedResult(tx: SqlClient, s: Session, tenantId: string): Promise<Completed> {
    const v = (await tx.query<{ version_no: number; index_number: string | null; awaiting_release: boolean }>(
      `select dv.version_no, n.index_number, dv.awaiting_release from document_version dv join node n on n.id = dv.node_id where dv.id = $1`,
      [s.version_id])).rows[0]!;
    return { nodeId: s.node_id!, versionId: s.version_id!, versionNo: Number(v.version_no), indexNumber: v.index_number, createdFolders: [],
      awaitingRelease: v.awaiting_release, fresh: false, tenantId, quarantineKey: s.quarantine_key };
  }

  // returned not thrown, so the event commits
  async function reject(tx: SqlClient, caller: Caller, s: Session, wrong: Rejected, received: Record<string, unknown>, now: Date, requestId: string) {
    await tx.query(`update upload_session set status = 'rejected', rejection = $2, completed_at = $3 where id = $1`, [s.id, wrong.reason, now.toISOString()]);
    await appendEvent(tx, { action: 'upload.rejected', workspaceId: s.workspace_id, actorId: caller.actorId, resourceType: 'upload_session', resourceId: s.id,
      data: { reason: wrong.reason, declared_size: Number(s.declared_size), declared_sha256: s.declared_sha256, ...received }, occurredAt: now, requestId });
    return wrong;
  }

  async function refuse(storage: Storage, wrong: Rejected): Promise<never> {
    await discard(storage, wrong.quarantineKey);
    throw new HttpProblem({ type: 'https://vdrkit.com/problems/upload-rejected', title: 'Upload rejected', status: 422, detail: wrong.detail, reason: wrong.reason });
  }

  const answer = ({ fresh: _f, tenantId: _t, quarantineKey: _q, ...out }: Completed): CompleteOut => out;

  r.get('/v1/workspaces/:ws/upload-sessions/:id', {
    schema: {
      summary: 'Resume an upload',
      params: SessionParams,
      response: {
        200: z.object({
          id: z.string().uuid(),
          status: z.enum(['open', 'completed', 'rejected', 'aborted', 'expired']),
          expiresAt: z.string(),
          method: z.enum(['presigned', 'direct']),
          size: z.number(),
          partSize: z.number().optional(),
          received: z.array(z.object({ partNumber: z.number(), etag: z.string(), size: z.number() })).optional(),
          parts: z.array(z.object({ partNumber: z.number(), url: z.string() })).optional(),
          uploadUrl: z.string().optional(),
        }),
      },
    },
  }, async (req) => {
    const { storage } = needDeps(app);
    const s = await app.inTenant(req, (tx, caller) => ownSession(tx, caller, req.params.ws, req.params.id));
    const expiresAt = new Date(s.expires_at);
    const open = s.status === 'open' && expiresAt > app.now();
    const status = (s.status === 'open' && !open ? 'expired' : s.status) as 'open' | 'completed' | 'rejected' | 'aborted' | 'expired';
    const size = Number(s.declared_size);
    const base = { id: s.id, status, expiresAt: expiresAt.toISOString(), size };
    if (!s.multipart_upload_id) {
      if (!open) return { ...base, method: 'direct' as const };
      return { ...base, method: 'direct' as const, uploadUrl: `/v1/workspaces/${req.params.ws}/upload-sessions/${s.id}/content` };
    }
    const partSize = Number((s as Session & { part_size: string | number }).part_size);
    if (!open || !storage.multipart?.listParts || !storage.multipart.presignPart) return { ...base, method: 'presigned' as const, partSize };
    const count = Number(s.part_count);
    const sizeOf = (n: number) => (n < count ? partSize : size - partSize * (count - 1));
    const received = (await storage.multipart.listParts(s.quarantine_key, s.multipart_upload_id)).filter((p) => p.size === sizeOf(p.partNumber));
    const have = new Set(received.map((p) => p.partNumber));
    const seconds = Math.max(60, Math.floor((expiresAt.getTime() - app.now().getTime()) / 1000));
    const parts: { partNumber: number; url: string }[] = [];
    for (let n = 1; n <= count; n++) {
      if (!have.has(n)) parts.push({ partNumber: n, url: await storage.multipart.presignPart(s.quarantine_key, s.multipart_upload_id, n, sizeOf(n), seconds) });
    }
    return { ...base, method: 'presigned' as const, partSize, received, parts };
  });

  r.delete('/v1/workspaces/:ws/upload-sessions/:id', {
    schema: {
      summary: 'Cancel an upload',
      params: SessionParams,
      response: { 204: z.null() },
    },
  }, async (req, reply) => {
    const { storage } = needDeps(app);
    const s = await app.inTenant(req, async (tx, caller) => {
      const s = await ownSession(tx, caller, req.params.ws, req.params.id, true);
      if (s.status !== 'open') throw notOpen(s);
      await tx.query(`update upload_session set status = 'aborted', completed_at = $2 where id = $1`, [s.id, app.now().toISOString()]);
      await appendEvent(tx, { action: 'upload.cancelled', workspaceId: req.params.ws, actorId: caller.actorId, resourceType: 'upload_session',
        resourceId: s.id, data: { path: s.relative_path }, occurredAt: app.now(), requestId: req.id });
      return s;
    });
    if (s.multipart_upload_id) await quietly(storage.multipart?.abort(s.quarantine_key, s.multipart_upload_id));
    await discard(storage, s.quarantine_key);
    return reply.code(204).send(null);
  });
};
