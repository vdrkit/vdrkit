// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, devices } from '@playwright/test';

const port = process.env.SANDBOX_PORT ?? '3140';
const apiPort = process.env.SANDBOX_API_PORT ?? '3141';
const base = `http://127.0.0.1:${port}`;
const NO_REAL_MAIL = { SMTP_HOST: '', SMTP_URL: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASSWORD: '', MAIL_FROM: '' };

export default defineConfig({
  testDir: './e2e-sandbox',
  outputDir: './test-results/sandbox',
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 2),
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL: base, navigationTimeout: 45_000, actionTimeout: 20_000, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'pnpm --filter @vdrkit/server dev:sandbox -- --reset',
      url: `http://127.0.0.1:${apiPort}/v1/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: { ...NO_REAL_MAIL, VDRKIT_DEMO_EMAIL_DOMAINS: '', API_PORT: apiPort, PUBLIC_URL: base, VDRKIT_DEV_DIR: '.dev-db-sandbox-e2e', NODE_ENV: 'development' },
    },
    {
      command: 'node scripts/next.mjs dev',
      url: `${base}/try`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { PORT: port, API_PORT: apiPort, NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-sandbox', VDRKIT_DEV_AUTH: '', VDRKIT_REVIEW: '0', VDRKIT_SANDBOX: '1' },
    },
  ],
});
