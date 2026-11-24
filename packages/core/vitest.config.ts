// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // stay under Postgres max_connections
    ...(process.env.TEST_DATABASE_URL ? { maxWorkers: 6 } : {}),
  },
});
