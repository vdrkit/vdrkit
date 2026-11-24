// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@vdrkit/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000, pool: 'forks',
    // no real mail from tests
    env: { SMTP_HOST: '', SMTP_URL: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASSWORD: '', MAIL_FROM: '', VDRKIT_DEMO_EMAIL_DOMAINS: '' },
    ...(process.env.TEST_DATABASE_URL ? { maxWorkers: 6 } : {}),
  },
});
