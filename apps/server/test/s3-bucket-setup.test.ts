// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/s3-bucket-setup.sh');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

const STUB = `#!/bin/sh
# Records each call, with the JSON of any file:// argument, and answers like $STUB_MODE (aws, minio or
# nover: a store that refuses noncurrent-version rules). $STUB_VERSIONING is the bucket's versioning status.
log="$STUB_DIR/calls.log"
op="$2"; [ "$1" = "--endpoint-url" ] && op="$4"
echo "CALL $*" >> "$log"
for a in "$@"; do case "$a" in file://*) cat "\${a#file://}" >> "$log"; echo >> "$log";; esac; done
case "$op" in
  head-bucket) exit 255 ;;
  create-bucket) echo '{"Location":"/b"}' ;;
  put-bucket-cors)
    [ "$STUB_MODE" = minio ] && { echo "An error occurred (NotImplemented) when calling the PutBucketCors operation" >&2; exit 254; }
    for a in "$@"; do case "$a" in file://*) cp "\${a#file://}" "$STUB_DIR/cors.now";; esac; done; exit 0 ;;
  put-bucket-lifecycle-configuration)
    for a in "$@"; do case "$a" in file://*) f="\${a#file://}";; esac; done
    [ "$STUB_MODE" = nover ] && grep -q Noncurrent "$f" && { echo "An error occurred (MalformedXML) when calling the PutBucketLifecycleConfiguration operation" >&2; exit 254; }
    if [ "$STUB_MODE" = minio ]; then grep -v AbortIncomplete "$f" > "$STUB_DIR/lifecycle.now" || true; else cp "$f" "$STUB_DIR/lifecycle.now"; fi; exit 0 ;;
  get-bucket-lifecycle-configuration) cat "$STUB_DIR/lifecycle.now" ;;
  get-bucket-versioning) [ -n "$STUB_VERSIONING" ] && echo "{\"Status\": \"$STUB_VERSIONING\"}"; exit 0 ;;
  get-bucket-cors) [ "$STUB_MODE" = minio ] && exit 254; echo '{"CORSRules":[]}' ;;
esac
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vdrkit-s3setup-'));
  writeFileSync(join(dir, 'aws'), STUB.replace(/\r\n/g, '\n'));
  chmodSync(join(dir, 'aws'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(mode: 'aws' | 'minio' | 'nover', env: Record<string, string> = {}) {
  const r = spawnSync('sh', [SCRIPT], {
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, STUB_DIR: dir.replace(/\\/g, '/'), STUB_MODE: mode, STUB_VERSIONING: '', TMPDIR: dir.replace(/\\/g, '/'),
      S3_BUCKET: 'vdrkit', PUBLIC_URL: 'https://dataroom.example.com/', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', ...env },
    encoding: 'utf8',
  });
  let calls = '';
  try { calls = readFileSync(join(dir, 'calls.log'), 'utf8'); } catch { /* no call made */ }
  return { ...r, calls };
}

describe.skipIf(!hasSh)('s3-bucket-setup.sh', () => {
  it('sets CORS and lifecycle rules', () => {
    const r = run('aws', { CREATE_BUCKET: '1', S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Created bucket vdrkit.');
    expect(r.stdout).toContain('CORS: PUT from https://dataroom.example.com, ETag readable.');
    expect(r.stdout).toContain('Lifecycle: quarantine/ cleared after 1 day, unfinished uploads aborted after 1 day.');
    expect(r.stdout).toContain('Old versions under quarantine/ are removed after 1 day.');
    expect(r.calls).toContain('--endpoint-url https://acct.r2.cloudflarestorage.com s3api put-bucket-cors --bucket vdrkit');
    const cors = JSON.parse(r.calls.split('\n').find((l) => l.startsWith('{"CORSRules"'))! + r.calls.split('{"CORSRules"')[1]!.split('\n').slice(1).join('').split('CALL')[0]);
    expect(cors.CORSRules).toEqual([{ ID: 'vdrkit-browser-uploads', AllowedOrigins: ['https://dataroom.example.com'], AllowedMethods: ['PUT'],
      AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }]);
    const lc = JSON.parse(readFileSync(join(dir, 'lifecycle.now'), 'utf8'));
    expect(lc.Rules).toEqual([
      { ID: 'vdrkit-quarantine', Status: 'Enabled', Filter: { Prefix: 'quarantine/' }, Expiration: { Days: 1 },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 } },
      { ID: 'vdrkit-abort-unfinished-uploads', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
    ]);
    expect(JSON.stringify(lc)).not.toContain('ws/');
  });

  it('falls back to a quarantine rule on MinIO', () => {
    const r = run('minio', { QUARANTINE_DAYS: '3' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Set MINIO_API_CORS_ALLOW_ORIGIN=https://dataroom.example.com on the MinIO server.');
    expect(r.stdout).toContain('Lifecycle: quarantine/ cleared after 3 days.');
    expect(r.stdout).toContain('MINIO_API_STALE_UPLOADS_EXPIRY');
    expect(JSON.parse(readFileSync(join(dir, 'lifecycle.now'), 'utf8')).Rules).toEqual([
      { ID: 'vdrkit-quarantine', Status: 'Enabled', Filter: { Prefix: 'quarantine/' }, Expiration: { Days: 3 },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 } },
    ]);
  });

  it('skips the old-versions rule when unversioned', () => {
    const r = run('nover');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('This store does not take the rule for old versions. Leave versioning off on this bucket.');
    expect(JSON.parse(readFileSync(join(dir, 'lifecycle.now'), 'utf8')).Rules[0]).toEqual(
      { ID: 'vdrkit-quarantine', Status: 'Enabled', Filter: { Prefix: 'quarantine/' }, Expiration: { Days: 1 } });

    for (const status of ['Enabled', 'Suspended']) {
      rmSync(join(dir, 'lifecycle.now'), { force: true });
      const versioned = run('nover', { STUB_VERSIONING: status });
      expect(versioned.status).toBe(1);
      expect(versioned.stderr).toContain('MalformedXML');
      expect(() => readFileSync(join(dir, 'lifecycle.now'))).toThrow();
    }
  });

  it('rejects bad arguments', () => {
    expect(run('aws', { S3_BUCKET: '' }).status).not.toBe(0);
    expect(run('aws', { PUBLIC_URL: '' }).status).not.toBe(0);
    const bad = run('aws', { QUARANTINE_DAYS: 'seven' });
    expect([bad.status, bad.stderr.trim()]).toEqual([2, 'QUARANTINE_DAYS must be a whole number of days.']);
  });
});
