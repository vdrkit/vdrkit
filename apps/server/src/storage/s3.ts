// SPDX-License-Identifier: AGPL-3.0-only
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand,
  GetObjectCommand, HeadObjectCommand, ListPartsCommand, NoSuchKey, PutObjectCommand, S3Client, UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ByteRange, MultipartUploads, Storage } from '../pipeline/pipeline.js';

const STREAM_PART_BYTES = 16 * 1024 * 1024;
const STREAM_CONCURRENCY = 2;

const isNoSuchKey = (e: unknown) => e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey';

async function presignPart(client: S3Client, bucket: string, key: string, uploadId: string, partNumber: number, size: number, expiresIn: number) {
  return getSignedUrl(client,
    new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: size }),
    { expiresIn, signableHeaders: new Set(['content-length']) });
}

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

// quarantine/ holds plaintext uploads: the bucket needs a 1-day expiry rule for it,
// for noncurrent versions (delete() sends no VersionId) and for unfinished multipart uploads
export class S3Storage implements Storage {
  readonly client: S3Client;
  readonly bucket: string;
  readonly multipart: MultipartUploads;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    const config: S3ClientConfig = { region: cfg.region, forcePathStyle: cfg.forcePathStyle ?? false };
    if (cfg.endpoint) config.endpoint = cfg.endpoint;
    if (cfg.accessKeyId && cfg.secretAccessKey) {
      config.credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
    }
    this.client = new S3Client(config);
    const { client, bucket } = this;
    this.multipart = {
      async start(key, partSizes, expiresInSeconds) {
        const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
        const uploadId = created.UploadId;
        if (!uploadId) throw new Error('The storage service did not start the upload.');
        const urls: string[] = [];
        for (const [i, size] of partSizes.entries()) {
          urls.push(await presignPart(client, bucket, key, uploadId, i + 1, size, expiresInSeconds));
        }
        return { uploadId, urls };
      },
      async complete(key, uploadId, parts) {
        const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        await client.send(new CompleteMultipartUploadCommand({
          Bucket: bucket, Key: key, UploadId: uploadId,
          MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }));
      },
      async abort(key, uploadId) {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
      },
      async listParts(key, uploadId) {
        const out: { partNumber: number; etag: string; size: number }[] = [];
        let marker: string | undefined;
        for (;;) {
          const page = marker ? { PartNumberMarker: marker } : {};
          const res = await client.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, ...page }));
          for (const p of res.Parts ?? []) out.push({ partNumber: p.PartNumber ?? 0, etag: p.ETag ?? '', size: p.Size ?? 0 });
          if (!res.IsTruncated || !res.NextPartNumberMarker) break;
          marker = String(res.NextPartNumberMarker);
        }
        return out;
      },
      presignPart: (key, uploadId, partNumber, size, expiresInSeconds) =>
        presignPart(client, bucket, key, uploadId, partNumber, size, expiresInSeconds),
    };
  }

  async putStream(key: string, body: Readable): Promise<void> {
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let uploadId: string | null = null;
    let nextPart = 1;
    const parts: { PartNumber: number; ETag: string }[] = [];
    const inFlight = new Set<Promise<void>>();
    let failure: unknown = null;
    const sendPart = (data: Buffer) => {
      const partNumber = nextPart++;
      const command = new UploadPartCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId!, PartNumber: partNumber, Body: data, ContentLength: data.length,
      });
      const p: Promise<void> = this.client.send(command)
        .then((r) => { parts.push({ PartNumber: partNumber, ETag: r.ETag ?? '' }); })
        .catch((e: unknown) => { failure ??= e; })
        .finally(() => { inFlight.delete(p); });
      inFlight.add(p);
    };
    const take = (n: number) => {
      const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingLen);
      const rest = all.subarray(n);
      const part = Buffer.from(all.subarray(0, n));
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingLen = rest.length;
      return part;
    };
    try {
      for await (const chunk of body) {
        const c = chunk as Buffer;
        pending.push(c);
        pendingLen += c.length;
        while (pendingLen >= STREAM_PART_BYTES) {
          if (!uploadId) {
            const created = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }));
            if (!created.UploadId) throw new Error('The storage service did not start the upload.');
            uploadId = created.UploadId;
          }
          sendPart(take(STREAM_PART_BYTES));
          while (inFlight.size >= STREAM_CONCURRENCY) await Promise.race(inFlight);
          if (failure) throw failure;
        }
      }
      if (!uploadId) {
        const all = take(pendingLen);
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: all, ContentLength: all.length }));
        return;
      }
      if (pendingLen > 0) sendPart(take(pendingLen));
      while (inFlight.size) await Promise.race(inFlight);
      if (failure) throw failure;
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
      }));
    } catch (e) {
      await Promise.allSettled([...inFlight]);
      if (uploadId) {
        const abort = new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId });
        await this.client.send(abort).catch(() => undefined);
      }
      throw e;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    try {
      const bytes = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...bytes }));
      if (!res.Body) throw new Error(`No object at ${key}`);
      if (res.Body instanceof Readable) return res.Body;
      return Readable.fromWeb(res.Body.transformToWebStream() as never);
    } catch (e) {
      if (isNoSuchKey(e)) throw new Error(`No object at ${key}`);
      throw e;
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentLength: body.length }));
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new Error(`No object at ${key}`);
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (e) {
      if (isNoSuchKey(e)) throw new Error(`No object at ${key}`);
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async size(key: string): Promise<number | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.ContentLength ?? null;
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
}
