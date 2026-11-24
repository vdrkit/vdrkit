// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, devices } from '@playwright/test';

// once per run, so a run past midnight still matches the seed
process.env.VDRKIT_DEMO_TODAY ||= new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
const prod = process.env.E2E_PROD === '1';
const port = process.env.PORT ?? '3100';
const apiPort = process.env.API_PORT ?? '3101';
const signinPort = process.env.SIGNIN_PORT ?? String(Number(port) + 2);
const base = `http://127.0.0.1:${port}`;
const signinBase = `http://127.0.0.1:${signinPort}`;
const setupPort = process.env.SETUP_PORT ?? String(Number(port) + 3);
const setupApiPort = process.env.SETUP_API_PORT ?? String(Number(port) + 4);
const setupBase = `http://127.0.0.1:${setupPort}`;
export const NO_REAL_MAIL = { SMTP_HOST: '', SMTP_URL: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASSWORD: '', MAIL_FROM: '' };
const SETUP_SPECS = /[\\/]first-run-setup\.spec\.ts$/;
const SETUP_TESTS = /an empty installation/;
// file name only; the worktree path may contain "signin"
const SIGNIN_SPECS = /[\\/](signin|flow-)[^\\/]*\.spec\.ts$/;
const { userAgent: _edgeAgent, ...edgeDevice } = devices['Desktop Edge'];
const BROWSER_DEVICES = {
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
  edge: { ...edgeDevice, channel: 'msedge' },
};
type BrowserKey = keyof typeof BROWSER_DEVICES;
const browserKeys: BrowserKey[] = (() => {
  const raw = (process.env.E2E_BROWSERS ?? '').trim();
  if (!raw) return [];
  const keys = raw === 'all' ? Object.keys(BROWSER_DEVICES) : raw.split(',').map((k) => k.trim()).filter(Boolean);
  for (const k of keys) if (!(k in BROWSER_DEVICES)) throw new Error(`E2E_BROWSERS: unknown browser "${k}" (firefox, webkit, edge or all)`);
  return keys as BrowserKey[];
})();

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 2),
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: base,
    navigationTimeout: 45_000,
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
  },
  projects: browserKeys.length ? browserKeys.flatMap((b) => {
    const use = BROWSER_DEVICES[b];
    return [
      { name: b, metadata: { role: 'chromium' }, testIgnore: [SIGNIN_SPECS], grepInvert: SETUP_TESTS, use: { ...use } },
      ...(prod ? [] : [
        { name: `${b}-signin`, metadata: { role: 'signin' }, testMatch: SIGNIN_SPECS, use: { ...use, baseURL: signinBase } },
        { name: `${b}-setup`, metadata: { role: 'setup' }, testMatch: SETUP_SPECS, grep: SETUP_TESTS, use: { ...use, baseURL: setupBase } },
      ]),
    ];
  }) : [
    { name: 'chromium', testIgnore: [SIGNIN_SPECS], grepInvert: SETUP_TESTS, use: { ...devices['Desktop Chrome'] } },
    ...(prod ? [] : [{ name: 'signin', testMatch: SIGNIN_SPECS, use: { ...devices['Desktop Chrome'], baseURL: signinBase } }]),
    ...(prod ? [] : [{ name: 'setup', testMatch: SETUP_SPECS, grep: SETUP_TESTS, use: { ...devices['Desktop Chrome'], baseURL: setupBase } }]),
  ],
  webServer: [
    ...(prod ? [] : [{
      command: `pnpm --filter @vdrkit/server dev:pglite${process.env.E2E_KEEP_DB === '1' ? '' : ' -- --reset'}`,
      url: `http://127.0.0.1:${apiPort}/v1/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        ...NO_REAL_MAIL, VDRKIT_DEMO_EMAIL_DOMAINS: '', API_PORT: apiPort, PORT: port, VDRKIT_DEV_DIR: '.dev-db-e2e', NODE_ENV: 'development',
        PUBLIC_URL: signinBase, VDRKIT_DEV_ORIGINS: base,
        VDRKIT_DEV_ACTIVITY: '0',
        VDRKIT_DEMO_TODAY: process.env.VDRKIT_DEMO_TODAY,
      },
    }]),
    {
      command: prod ? 'node scripts/next.mjs start' : 'node scripts/next.mjs dev',
      // demos 404 in production builds
      url: prod ? `${base}/sign-in` : `${base}/demo/shell`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { PORT: port, API_PORT: apiPort, NEXT_TELEMETRY_DISABLED: '1', ...(prod ? {} : { VDRKIT_DEV_AUTH: '1' }) },
    },
    ...(prod ? [] : [{
      command: 'node scripts/next.mjs dev',
      url: `${signinBase}/sign-in`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { PORT: signinPort, API_PORT: apiPort, NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-signin', VDRKIT_DEV_AUTH: '' },
    }]),
    ...(prod ? [] : [{
      command: 'pnpm --filter @vdrkit/server dev:pglite -- --empty --reset',
      url: `http://127.0.0.1:${setupApiPort}/v1/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { ...NO_REAL_MAIL, VDRKIT_DEMO_EMAIL_DOMAINS: '', API_PORT: setupApiPort, PORT: setupPort, VDRKIT_DEV_DIR: '.dev-db-e2e-setup', NODE_ENV: 'development', PUBLIC_URL: setupBase },
    }, {
      command: 'node scripts/next.mjs dev',
      url: `${setupBase}/setup`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { PORT: setupPort, API_PORT: setupApiPort, NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-setup', VDRKIT_DEV_AUTH: '' },
    }]),
  ],
});
