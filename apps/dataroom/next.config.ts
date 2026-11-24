// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { FIXED_HEADERS } from './src/lib/security-headers';

export default function config(phase: string): NextConfig {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    reactStrictMode: true,
    devIndicators: false,
    poweredByHeader: false,
    async headers() {
      return [{ source: '/((?!v1/|v1$).*)', headers: FIXED_HEADERS }];
    },
    experimental: {
      agentUpgrade: false,
    },
    ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
    ...(process.env.NEXT_OUTPUT === 'standalone'
      ? { output: 'standalone' as const, outputFileTracingRoot: resolve(process.cwd(), '..', '..') }
      : {}),
    turbopack: {
      resolveAlias: {
        '@dev-tools': dev ? './src/dev-tools/index.tsx' : './src/dev-tools/stub.ts',
      },
    },
  };
}
