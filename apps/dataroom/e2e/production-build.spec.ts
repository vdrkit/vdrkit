// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED_HEADERS, THEME_BOOT_SCRIPT_HASH } from '../src/lib/security-headers';
import { THEME_BOOT_SCRIPT } from '../src/lib/theme';
import { cspViolations, pageHydrated } from './fixtures';

const NEXT = fileURLToPath(new URL('../.next', import.meta.url));
const FORBIDDEN = ['x-dev-person', 'x-dev-tenant', 'Prototype · view as', 'Prototype \\u00b7 view as', 'Prototype · signed in as', 'View as is off', 'vdrkit-dev-persona', 'a369f772-bdd8-4e7f-a614-11dc069feb12',
  // review tool
  'Click the spot you want to comment on', 'vdrkit-review-pos', 'rv-picking', 'VDRKIT_REVIEW_DIR', 'domToCanvas'];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'dev' || name === 'cache') continue;
      yield* files(p);
    } else if (/\.(js|mjs|cjs|json|html|rsc|css|txt|map|body|meta)$/.test(name) || !name.includes('.')) {
      yield p;
    }
  }
}

test('build output has no dev tools', async () => {
  test.skip(!existsSync(join(NEXT, 'BUILD_ID')), 'Run `next build` first');
  const hits: string[] = [];
  let scanned = 0;
  for (const f of files(NEXT)) {
    const text = readFileSync(f, 'utf8');
    scanned++;
    for (const s of FORBIDDEN) if (text.includes(s)) hits.push(`${f}: ${s}`);
  }
  expect(scanned).toBeGreaterThan(20);
  expect(hits).toEqual([]);
});

const FORGED = {
  cookie: 'vdrkit-dev-persona=anika', 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001',
  'x-dev-person': 'a369f772-bdd8-4e7f-a614-11dc069feb12', 'x-dev-agent-max-level': '60',
};

test('does not answer /v1', async ({ request }) => {
  test.skip(process.env.E2E_PROD !== '1', 'Production server only');
  const res = await request.get('/v1/me/workspaces', { headers: { cookie: 'vdrkit-dev-persona=anika' } });
  expect(res.status()).toBe(404);
  expect((await request.get('/v1/me/workspaces', { headers: FORGED })).status()).toBe(404);
});

test('ignores forged identity headers and the persona cookie', async ({ request }) => {
  test.skip(process.env.E2E_PROD !== '1', 'Production server only');
  for (const path of ['/', '/rooms', '/rooms/b90253f5-0a8f-4005-9a3a-2a3d26bbf53e/dashboard', '/site/settings']) {
    const res = await request.get(path, { headers: FORGED, maxRedirects: 0 });
    expect(res.status(), path).toBe(307);
    expect(res.headers().location, path).toMatch(/^(https?:\/\/[^/]+)?\/sign-in(\?|$)/);
  }
});

test('has no dashboard demo', async ({ request }) => {
  test.skip(process.env.E2E_PROD !== '1', 'Production server only');
  const res = await request.get('/demo/dashboard?as=admin');
  expect(res.status()).toBe(404);
  expect(await res.text()).not.toContain('Three tasks need your action');
});

test('has no shell demos', async ({ request }) => {
  test.skip(process.env.E2E_PROD !== '1', 'Production server only');
  for (const path of ['/demo/shell', '/demo/shell-outside']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).not.toContain('Shell demo');
  }
});

test('sandbox is inert without VDRKIT_SANDBOX', async ({ request }) => {
  test.skip(process.env.E2E_PROD !== '1', 'Production server only');
  test.skip(process.env.VDRKIT_SANDBOX === '1', 'A normal installation only');
  const res = await request.get('/try', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toMatch(/^(https?:\/\/[^/]+)?\/sign-in\?next=%2Ftry$/);
  for (const path of ['/sign-in', '/demo/shell', '/no-such-page']) {
    const html = await (await request.get(path)).text();
    expect(html, path).not.toContain('sbx-bar');
    expect(html, path).not.toContain('Switch person');
  }
});

test('review tool has no route or button', async ({ request }) => {
  test.skip(process.env.E2E_PROD !== '1', 'Production server only');
  // an unknown page like any other: off to sign-in, never served
  for (const res of [await request.get('/dev-review', { maxRedirects: 0 }), await request.post('/dev-review', { data: { comment: 'x' }, maxRedirects: 0 })]) {
    expect(res.status()).toBe(307);
    expect(res.headers().location).toContain('/sign-in?next=%2Fdev-review');
  }
  expect(await (await request.get('/sign-in')).text()).not.toContain('More review options');
});

test('sends a strict CSP with a fresh nonce', async ({ request }) => {
  test.skip(process.env.E2E_PROD !== '1', 'Production server only');
  const nonces = new Set<string>();
  for (const path of ['/demo/shell', '/demo/shell-outside', '/sign-in', '/no-such-page', '/no-such-file.png']) {
    const res = await request.get(path);
    const h = res.headers();
    const csp = h['content-security-policy'] ?? '';
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1] ?? '';
    expect(nonce, path).not.toBe('');
    nonces.add(nonce);
    expect(csp, path).toBe([
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' '${THEME_BOOT_SCRIPT_HASH}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "style-src-attr 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "manifest-src 'self'",
      "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '));
    for (const { key, value } of FIXED_HEADERS) expect(h[key.toLowerCase()], `${path} ${key}`).toBe(value);
    expect(h['x-powered-by'], path).toBeUndefined();
    // theme script: allowed by hash
    const html = await res.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length, path).toBeGreaterThan(1);
    for (const tag of scripts) {
      if (tag.includes(`nonce="${nonce}"`)) continue;
      const body = html.slice(html.indexOf(tag) + tag.length, html.indexOf('</script>', html.indexOf(tag)));
      expect(body, `${path}: ${tag}`).toBe(THEME_BOOT_SCRIPT);
    }
  }
  expect(nonces.size).toBe(5);
  const asset = /src="(\/_next\/static\/[^"]+\.js)"/.exec(await (await request.get('/demo/shell')).text())![1]!;
  const js = await request.get(asset);
  expect(js.status()).toBe(200);
  expect(js.headers()['x-content-type-options']).toBe('nosniff');
});

test('pages without the API break no CSP rule', async ({ page }) => {
  test.skip(process.env.E2E_PROD !== '1', 'Production server only');
  const violations = cspViolations(page);
  for (const path of ['/demo/shell', '/demo/shell-outside', '/sign-in', '/no-such-page']) {
    await page.goto(path);
    await pageHydrated(page);
  }
  await page.evaluate(() => localStorage.setItem('vdrkit-theme', 'dark'));
  await page.goto('/sign-in');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(violations).toEqual([]);
});
