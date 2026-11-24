// SPDX-License-Identifier: AGPL-3.0-only
import type pg from 'pg';
import type { Channel, Database } from '@vdrkit/core';
import type { AppOptions } from './app.js';
import type { AuthPool } from './auth/pool.js';
import type { VdrAuth } from './auth/better-auth.js';
import { DevHeaderAuthenticator } from './auth.js';
import type { Storage } from './pipeline/pipeline.js';
import type { SharedRateLimits } from './rate-limit.js';

type EnvAuth = Pick<AppOptions, 'auth' | 'plugins' | 'publicUrl'> & { betterAuth?: VdrAuth };

// header auth only in test or development, and only when asked for: NODE_ENV alone is not enough
export async function authFromEnv(db: Database, pool: pg.Pool, mailer: Channel | undefined, storage?: Storage,
  shared?: SharedRateLimits): Promise<EnvAuth> {
  const dev = ['test', 'development'].includes(process.env.NODE_ENV ?? '') && process.env.VDRKIT_DEV_AUTH === '1';
  const secret = process.env.BETTER_AUTH_SECRET;
  if (dev && !secret) return { auth: new DevHeaderAuthenticator() };
  if (!secret || secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be set to at least 32 random characters.');
  const publicUrl = process.env.PUBLIC_URL || (process.env.SITE_ADDRESS ? `https://${process.env.SITE_ADDRESS}` : undefined);
  if (!publicUrl) throw new Error('PUBLIC_URL is not set.');
  const { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth } = await import('./auth/better-auth.js');
  const { sessionRoutes } = await import('./auth/session-routes.js');
  const config: Parameters<typeof createBetterAuth>[0] = { db, pool: pool as unknown as AuthPool, secret, publicUrl };
  if (mailer) config.mailer = mailer;
  if (storage) config.storage = storage;
  if (shared) config.rateLimitStorage = shared.betterAuthStorage();
  const auth = createBetterAuth(config);
  return {
    auth: new BetterAuthAuthenticator(auth, db),
    plugins: [betterAuthRoutes(auth, publicUrl), sessionRoutes(auth)],
    publicUrl,
    betterAuth: auth,
  };
}
