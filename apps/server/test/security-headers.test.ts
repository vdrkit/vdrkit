// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentSecurityPolicy, FIXED_HEADERS, THEME_BOOT_SCRIPT_HASH, uploadOrigins } from '../../dataroom/src/lib/security-headers.js';
import { THEME_BOOT_SCRIPT } from '../../dataroom/src/lib/theme.js';


describe('the front end Content-Security-Policy', () => {
  it('is strict in production', () => {
    expect(contentSecurityPolicy({ nonce: 'abc123==', dev: false })).toBe([
      "default-src 'self'",
      `script-src 'self' 'nonce-abc123==' '${THEME_BOOT_SCRIPT_HASH}'`,
      "style-src 'self' 'nonce-abc123=='",
      "style-src-attr 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "manifest-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '));
  });

  it('is looser under next dev', () => {
    const dev = contentSecurityPolicy({ nonce: 'n', dev: true });
    expect(dev).toContain(`script-src 'self' 'nonce-n' '${THEME_BOOT_SCRIPT_HASH}' 'unsafe-eval'`);
    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    expect(dev).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy({ nonce: 'n', dev: false })).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  });

  it('allows the theme boot script by hash', () => {
    expect(`sha256-${createHash('sha256').update(THEME_BOOT_SCRIPT).digest('base64')}`).toBe(THEME_BOOT_SCRIPT_HASH);
  });

  it('adds the S3 upload origin to connect-src', async () => {
    const cases = [
      { env: { STORAGE_DRIVER: 's3', S3_BUCKET: 'vdrkit', S3_REGION: 'eu-west-1' }, cfg: { region: 'eu-west-1' } },
      { env: { S3_BUCKET: 'vdrkit' }, cfg: { region: 'us-east-1' } },
      { env: { S3_BUCKET: 'vdr.kit', S3_REGION: 'eu-west-1' }, cfg: { region: 'eu-west-1' }, bucket: 'vdr.kit' },
      { env: { S3_BUCKET: 'vdrkit', S3_REGION: 'eu-west-1', S3_FORCE_PATH_STYLE: 'true' }, cfg: { region: 'eu-west-1', forcePathStyle: true } },
      { env: { STORAGE_DRIVER: 's3', S3_BUCKET: 'vdrkit', S3_ENDPOINT: 'https://garage.example.com:3900', S3_REGION: 'garage', S3_FORCE_PATH_STYLE: '1' },
        cfg: { region: 'garage', endpoint: 'https://garage.example.com:3900', forcePathStyle: true } },
      { env: { S3_BUCKET: 'vdrkit', S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', S3_REGION: 'auto' },
        cfg: { region: 'auto', endpoint: 'https://acc.r2.cloudflarestorage.com' } },
    ];
    for (const c of cases) {
      const client = new S3Client({ ...c.cfg, credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
      const url = await getSignedUrl(client, new UploadPartCommand({ Bucket: c.bucket ?? 'vdrkit', Key: 'quarantine/x', UploadId: 'u', PartNumber: 1, ContentLength: 5 }), { expiresIn: 60 });
      expect(uploadOrigins(c.env), JSON.stringify(c.env)).toEqual([new URL(url).origin]);
      expect(contentSecurityPolicy({ nonce: 'n', dev: false, connect: uploadOrigins(c.env) })).toContain(`connect-src 'self' ${new URL(url).origin};`);
    }
    expect(uploadOrigins({})).toEqual([]);
    expect(uploadOrigins({ STORAGE_DRIVER: 'local', S3_BUCKET: 'vdrkit' })).toEqual([]);
    expect(uploadOrigins({ CSP_CONNECT_SRC: 'https://files.example.com/x  javascript:alert(1) nonsense' })).toEqual(['https://files.example.com']);
  });
});

describe('the other front end headers', () => {
  it('sets each header once', () => {
    expect(Object.fromEntries(FIXED_HEADERS.map((h) => [h.key, h.value]))).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'accelerometer=(), bluetooth=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), '
        + 'magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
  });

  it('lets Caddy add HSTS without replacing the CSP', () => {
    const caddy = readFileSync(fileURLToPath(new URL('../../../Caddyfile', import.meta.url)), 'utf8');
    expect(caddy).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    // "?" only: an unconditional CSP would overwrite the nonce
    expect(caddy).toMatch(/\n\t\t\?Content-Security-Policy "default-src 'none'; frame-ancestors 'none'/);
    expect(caddy).not.toMatch(/\n\t\tContent-Security-Policy/);
  });
});
