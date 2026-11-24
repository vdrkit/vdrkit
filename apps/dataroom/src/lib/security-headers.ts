// SPDX-License-Identifier: AGPL-3.0-only
// No Next.js or Node imports: loaded by the API's tests.

// hash, not nonce: global-error.tsx has no request headers
export const THEME_BOOT_SCRIPT_HASH = 'sha256-nYXM1K1gJxMQIdLHyT4xNevRhWvzCKP/UfD+oPJMqik=';

export interface CspOptions {
  nonce: string;
  // React overlay needs eval; Turbopack styles have no nonce
  dev: boolean;
  connect?: string[];
}

export function contentSecurityPolicy({ nonce, dev, connect = [] }: CspOptions): string {
  const n = `'nonce-${nonce}'`;
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    ['script-src', "'self'", n, `'${THEME_BOOT_SCRIPT_HASH}'`, ...(dev ? ["'unsafe-eval'"] : [])],
    ['style-src', "'self'", ...(dev ? ["'unsafe-inline'"] : [n])],
    // React layout styles; attributes can't run script
    ['style-src-attr', "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:'],
    ['font-src', "'self'"],
    ['connect-src', "'self'", ...connect],
    ['media-src', "'none'"],
    ['object-src', "'none'"],
    ['frame-src', "'none'"],
    ['worker-src', "'none'"],
    ['manifest-src', "'self'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  return directives.map((d) => d.join(' ')).join('; ');
}

export const FIXED_HEADERS: { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // don't leak which data room a visitor came from
  { key: 'Referrer-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'accelerometer=(), bluetooth=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), '
      + 'magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

// CSP_CONNECT_SRC: extra origins, space-separated
export function uploadOrigins(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  const driver = env.STORAGE_DRIVER || (env.S3_BUCKET ? 's3' : '');
  const bucket = env.S3_BUCKET ?? '';
  if (driver === 's3' && bucket) {
    const pathStyle = ['1', 'true', 'yes'].includes((env.S3_FORCE_PATH_STYLE ?? '').toLowerCase());
    const region = env.S3_REGION || 'us-east-1';
    const endpoint = env.S3_ENDPOINT?.trim();
    // dotted bucket names can't be TLS host labels
    const virtual = !pathStyle && !bucket.includes('.');
    if (endpoint) {
      try {
        const u = new URL(endpoint);
        out.add(virtual ? `${u.protocol}//${bucket}.${u.host}` : u.origin);
      } catch {
        // the API won't start with it either
      }
    } else {
      out.add(virtual ? `https://${bucket}.s3.${region}.amazonaws.com` : `https://s3.${region}.amazonaws.com`);
    }
  }
  for (const o of (env.CSP_CONNECT_SRC ?? '').split(/\s+/)) {
    if (!o) continue;
    try {
      const u = new URL(o);
      if (u.protocol === 'https:' || u.protocol === 'http:') out.add(u.origin);
    } catch {
      // skip
    }
  }
  return [...out];
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
