// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Database } from '@vdrkit/core';
import { HttpProblem } from './problems.js';

export interface Limit {
  max: number;
  windowMs: number;
}

export interface RateLimitOptions {
  general?: Limit;
  heavy?: Limit;
  upload?: Limit;
  signIn?: Limit;
  setupUnlock?: Limit;
  anonymous?: Limit;
  heavyRoutes?: string[];
  uploadRoutes?: string[];
  shared?: SharedRateLimits;
}

export class SharedRateLimits {
  static readonly PURGE_EVERY_MS = 5 * 60_000;
  private nextPurge = 0;

  constructor(private readonly db: Database, private readonly role?: 'vdrkit_app') {}

  async hit(key: string, windowMs: number): Promise<{ current: number; ttl: number }> {
    const row = await this.db.transaction(async (tx) => {
      if (this.role) await tx.query(`set local role ${this.role}`);
      const ms = Math.max(1, Math.round(windowMs));
      const { rows } = await tx.query<{ hits: number; ttl_ms: number }>(`select hits, ttl_ms from rate_limit_hit($1, $2)`, [key, ms]);
      return rows[0]!;
    });
    if (Date.now() >= this.nextPurge) {
      this.nextPurge = Date.now() + SharedRateLimits.PURGE_EVERY_MS;
      void this.purge().catch(() => undefined);
    }
    return { current: Number(row.hits), ttl: Number(row.ttl_ms) };
  }

  async purge(): Promise<number> {
    return this.db.transaction(async (tx) => {
      if (this.role) await tx.query(`set local role ${this.role}`);
      return Number((await tx.query<{ n: number }>(`select purge_rate_limits() as n`)).rows[0]?.n ?? 0);
    });
  }

  fastifyStore() {
    const shared = this;
    return class PgStore {
      incr(key: string, cb: (err: Error | null, res?: { current: number; ttl: number }) => void, timeWindow: number) {
        shared.hit(key, timeWindow).then((r) => cb(null, r), (e: Error) => cb(e));
      }
      child() { return new PgStore(); }
    };
  }

  betterAuthStorage(): CountStore {
    return {
      consume: async (key: string, rule: { window: number; max: number }) => {
        const r = await this.hit(`auth:${key}`, rule.window * 1000);
        if (r.current <= rule.max) return { allowed: true, retryAfter: null };
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(r.ttl / 1000)) };
      },
    };
  }
}

const MINUTE = 60_000;

export const DEFAULT_LIMITS: Required<Omit<RateLimitOptions, 'heavyRoutes' | 'uploadRoutes' | 'shared'>> = {
  general: { max: 600, windowMs: MINUTE },
  heavy: { max: 120, windowMs: MINUTE },
  upload: { max: 3000, windowMs: MINUTE },
  // about 25 people signing in from one office address within the window
  signIn: { max: 100, windowMs: 15 * MINUTE },
  setupUnlock: { max: 10, windowMs: 15 * MINUTE },
  anonymous: { max: 300, windowMs: MINUTE },
};

// per email address, whether or not it has an account
export const SIGN_IN_ADDRESS_LIMIT: Limit = { max: 10, windowMs: 15 * MINUTE };

export const signInAddressKey = (email: string) => `signInAddress:${email.trim().toLowerCase()}`;

export interface CountStore {
  consume(key: string, rule: { window: number; max: number }): Promise<{ allowed: boolean; retryAfter: number | null }>;
}

// RATE_LIMIT_STORE=memory: one process only
export function memoryCountStore(clock: () => number = Date.now): CountStore {
  const hits = new Map<string, { count: number; endsAt: number }>();
  return {
    consume: async (key, rule) => {
      const now = clock();
      for (const [k, v] of hits) if (v.endsAt <= now) hits.delete(k);
      const entry = hits.get(key) ?? { count: 0, endsAt: now + rule.window * 1000 };
      entry.count += 1;
      hits.set(key, entry);
      if (entry.count <= rule.max) return { allowed: true, retryAfter: null };
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.endsAt - now) / 1000)) };
    },
  };
}

export const HEAVY_ROUTES = [
  '/v1/workspaces/:ws/nodes',
  '/v1/workspaces/:ws/nodes/:id/pages/:page',
  '/v1/workspaces/:ws/nodes/:id/coverage',
  '/v1/workspaces/:ws/search',
  '/v1/workspaces/:ws/events',
  '/v1/workspaces/:ws/events/export.csv',
  '/v1/workspaces/:ws/release-preview',
  '/v1/workspaces/:ws/release-review',
];

// not upload-plans: open to every member, stays under the general limit
export const UPLOAD_ROUTES = [
  '/v1/workspaces/:ws/upload-sessions',
  '/v1/workspaces/:ws/upload-sessions/:id',
  '/v1/workspaces/:ws/upload-sessions/:id/content',
  '/v1/workspaces/:ws/upload-sessions/:id/complete',
];

const SIGN_IN_PATHS = /^\/v1\/auth\/(sign-in|sign-up|magic-link|email-otp|two-factor|forget-password|reset-password|verify-email)(\/|\?|$)/;

// Better Auth resolves dot segments, %2e%2e too: /v1/auth/x/%2e%2e/email-otp would dodge the sign-in limit
export function normalisedPath(rawUrl: string): string | null {
  const raw = rawUrl.split('?')[0]!.split('#')[0]!;
  let parsed: string;
  try {
    parsed = new URL(rawUrl, 'http://vdrkit.invalid').pathname;
  } catch {
    return null;
  }
  return parsed === raw ? parsed : null;
}

export const unclearPath = () => new HttpProblem({
  type: 'https://vdrkit.com/problems/bad-request', title: 'Invalid request', status: 400,
  detail: 'The address contains dot segments or similar parts that change where it leads. Send the plain path.',
});

type Bucket = 'general' | 'heavy' | 'upload' | 'signIn' | 'setupUnlock' | 'anonymous';
export type Limiter = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const rateLimited = (retryAfterSeconds: number) => new HttpProblem({
  type: 'https://vdrkit.com/problems/rate-limited', title: 'Too many requests', status: 429,
  detail: `Too many requests in a short time. Try again in ${retryAfterSeconds} seconds.`,
});

function who(req: FastifyRequest): string {
  const p = req.caller?.principal as { kind: string; personId?: string; onBehalfOfPersonId?: string } | undefined;
  const person = p?.personId ?? p?.onBehalfOfPersonId;
  return person ? `person:${req.caller!.tenantId}:${person}` : `ip:${req.ip}`;
}

// call after auth: limits are per person
export async function setupRateLimit(app: FastifyInstance, opts: RateLimitOptions = {}): Promise<Limiter> {
  await app.register(rateLimit, {
    global: false,
    ...(opts.shared ? { store: opts.shared.fastifyStore() as never } : {}),
    errorResponseBuilder: (_req, ctx) => rateLimited(Math.max(1, Math.ceil(ctx.ttl / 1000))),
  });
  const heavyRoutes = new Set(opts.heavyRoutes ?? HEAVY_ROUTES);
  const uploadRoutes = new Set(opts.uploadRoutes ?? UPLOAD_ROUTES);
  const make = (bucket: Bucket, key: (req: FastifyRequest) => string) => {
    const limit = { ...DEFAULT_LIMITS[bucket], ...opts[bucket] };
    return app.rateLimit({ max: limit.max, timeWindow: limit.windowMs, keyGenerator: (req) => `${bucket}:${key(req)}` });
  };
  const limiters: Record<Bucket, Limiter> = {
    general: make('general', who),
    heavy: make('heavy', who),
    upload: make('upload', who),
    signIn: make('signIn', (req) => req.ip),
    setupUnlock: make('setupUnlock', (req) => req.ip),
    anonymous: make('anonymous', (req) => req.ip),
  };
  return (req, reply) => {
    const path = normalisedPath(req.url);
    if (path === null) throw unclearPath();
    let bucket: Bucket;
    if (path === '/v1/setup/unlock') bucket = 'setupUnlock';
    else if (path.startsWith('/v1/public/') || SIGN_IN_PATHS.test(path)) bucket = 'signIn';
    else if (!req.caller) bucket = 'anonymous';
    else if (heavyRoutes.has(req.routeOptions.url ?? '')) bucket = 'heavy';
    else if (uploadRoutes.has(req.routeOptions.url ?? '')) bucket = 'upload';
    else bucket = 'general';
    return limiters[bucket](req, reply);
  };
}
