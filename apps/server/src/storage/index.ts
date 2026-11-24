// SPDX-License-Identifier: AGPL-3.0-only
import type { Storage } from '../pipeline/pipeline.js';
import { LocalDiskStorage } from './local-disk.js';
import { S3Storage } from './s3.js';

export { LocalDiskStorage } from './local-disk.js';
export { S3Storage, type S3Config } from './s3.js';

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage | undefined {
  const driver = env.STORAGE_DRIVER || (env.S3_BUCKET ? 's3' : '');
  if (!driver) return undefined;
  if (driver === 'local') return new LocalDiskStorage(env.STORAGE_LOCAL_DIR || './data/storage');
  if (driver === 's3') {
    if (!env.S3_BUCKET) throw new Error('STORAGE_DRIVER is s3 but S3_BUCKET is not set.');
    return new S3Storage({
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || 'us-east-1',
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: ['1', 'true', 'yes'].includes((env.S3_FORCE_PATH_STYLE ?? '').toLowerCase()),
    });
  }
  throw new Error(`Unknown STORAGE_DRIVER "${driver}". Use s3 or local.`);
}
