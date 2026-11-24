// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { withTenant, type Channel, type Database, type SqlClient } from '@vdrkit/core';
import type { Authenticator, Caller } from './auth.js';
import { errorReference, HttpProblem, notFound, send, unauthenticated } from './problems.js';
import { nodeRoutes } from './routes/nodes.js';
import { grantRoutes } from './routes/grants.js';
import { uploadRoutes } from './routes/uploads.js';
import { eventRoutes } from './routes/events.js';
import { roomRoutes } from './routes/rooms.js';
import { peopleRoutes } from './routes/people.js';
import { peopleAdminRoutes } from './routes/people-admin.js';
import { emailChangeRoutes } from './routes/email-change.js';
import { documentRoutes } from './routes/documents.js';
import { timelineRoutes } from './routes/timeline.js';
import { viewerRoutes } from './routes/viewer.js';
import { searchRoutes } from './routes/search.js';
import { activityExportRoutes } from './routes/activity-export.js';
import { activityRoutes } from './routes/activity.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { profileRoutes } from './routes/profile.js';
import { signInRoutes } from './routes/sign-in.js';
import { notificationSettingsRoutes } from './routes/notification-settings.js';
import { BlockedLink, recordBlockedLink, requireRoom, withActor } from './routes/util.js';
import { roomShellRoutes } from './routes/room-shell.js';
import { myRoomsRoutes } from './routes/my-rooms.js';
import { audienceRoutes } from './routes/audience.js';
import { detailsRoutes } from './routes/details.js';
import { processAgainRoutes } from './routes/process-again.js';
import { releaseReviewRoutes } from './routes/release-review.js';
import { seeAsRoutes } from './routes/see-as.js';
import { aboutRoutes } from './routes/about.js';
import { checkAndRecordSeeAs, maySeeAs, requestedSeeAs, seeAsAllowed, seeAsCaller, seeAsReadOnly, SeeAsRollback } from './see-as.js';
import type { Storage } from './pipeline/pipeline.js';
import type { Keyring } from './crypto/keyring.js';
import type { JobQueue } from './worker/jobs.js';
import { normalisedPath, setupRateLimit, unclearPath, type RateLimitOptions } from './rate-limit.js';
import { checkOrigin, originsOf } from './origin-check.js';
import { publicSiteRoutes, siteRoutes } from './routes/site.js';
import { requireSiteAdmin } from './site/common.js';
import { SetupService, setupRoutes, type SetupOptions } from './site/setup.js';
import type { SiteContext } from './site/common.js';
import { nodemailerTransport, type MailTransportFactory } from './site/mail.js';
import { probesFromEnv, type HealthProbes, type ProbeDeps } from './site/health.js';
import { systemResolver, type TxtResolver } from './site/domain-check.js';
import type { KeyProvider } from './crypto/envelope.js';
import type { SandboxOptions } from './sandbox/plugin.js';

export interface SiteOptions {
  keyProvider?: KeyProvider;
  probes?: HealthProbes;
  mailTransport?: MailTransportFactory;
  resolver?: TxtResolver;
  env?: Record<string, string | undefined>;
  setup?: SetupOptions | false;
}

export interface AppOptions {
  db: Database;
  auth: Authenticator;
  dbRole?: 'vdrkit_app';
  logger?: FastifyServerOptions['logger'];
  now?: () => Date;
  storage?: Storage;
  keyring?: Keyring;
  queue?: JobQueue;
  plugins?: FastifyPluginAsync[];
  mailer?: Channel;
  publicUrl?: string;
  trustedOrigins?: string[];
  rateLimit?: RateLimitOptions | false;
  skipStartupTasks?: boolean;
  trustProxy?: boolean | string;
  site?: SiteOptions;
  /** Only after checkSandboxStart() */
  sandbox?: SandboxOptions;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller: Caller | null;
  }
  interface FastifyInstance {
    inTenant<T>(req: FastifyRequest, fn: (tx: SqlClient, caller: Caller) => Promise<T>): Promise<T>;
    inTenantId<T>(tenantId: string, fn: (tx: SqlClient) => Promise<T>): Promise<T>;
    now(): Date;
    deps: { storage?: Storage; keyring?: Keyring; mailer?: Channel; publicUrl: string; queue?: JobQueue };
    setup: SetupService | null;
  }
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const ROOM_GATE_EXEMPT = new Set(['/v1/site/rooms/:ws/join']);

// stored in the hash-chained log, which cannot be erased: no free text from the client
export function requestIdFrom(header: string | string[] | undefined): string {
  return typeof header === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(header) ? header : randomUUID();
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  if ((opts.auth as { devOnly?: boolean }).devOnly && !['test', 'development'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('The development authenticator is only allowed when NODE_ENV is test or development.');
  }

  const server: FastifyServerOptions = {
    logger: opts.logger ?? false,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id']),
  };
  if (opts.trustProxy !== undefined) server.trustProxy = opts.trustProxy;
  const app = Fastify(server).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'VDRkit API', version: '1.0.0', description: 'Core and /deal routes. Every call is permission-checked and audited.' },
    },
    transform: jsonSchemaTransform,
  });

  const role = opts.dbRole ? { role: opts.dbRole } : {};
  app.decorateRequest('caller', null);
  app.decorate('now', () => (opts.now ? opts.now() : new Date()));
  app.decorate('deps', {
    storage: opts.storage,
    keyring: opts.keyring,
    mailer: opts.mailer,
    publicUrl: opts.publicUrl ?? 'http://localhost',
    queue: opts.queue,
  });
  app.decorate('inTenantId', async function <T>(tenantId: string, fn: (tx: SqlClient) => Promise<T>) {
    return withTenant(opts.db, tenantId, fn, role);
  });
  app.decorate('inTenant', async function <T>(req: FastifyRequest, fn: (tx: SqlClient, caller: Caller) => Promise<T>) {
    const caller = req.caller;
    if (!caller) throw unauthenticated();
    const ws = ROOM_GATE_EXEMPT.has(req.routeOptions.url ?? '') ? undefined : (req.params as { ws?: unknown } | undefined)?.ws;
    const seeAs = requestedSeeAs(req);
    if (seeAs !== null) {
      if (seeAs === 'invalid' || typeof ws !== 'string') throw notFound();
      // own transaction: the one below always rolls back
      await withTenant(opts.db, caller.tenantId, async (tx) => {
        await requireRoom(tx, caller, ws, app.now());
        await checkAndRecordSeeAs(tx, caller, ws, seeAs, app.now(), req);
      }, role);
      try {
        await withTenant(opts.db, caller.tenantId, async (tx) => {
          await requireRoom(tx, caller, ws, app.now());
          const viewer = await seeAsCaller(tx, caller, ws, seeAs, app.now());
          throw new SeeAsRollback(await fn(tx, viewer));
        }, role);
      } catch (err) {
        if (err instanceof SeeAsRollback) return err.value as T;
        throw err;
      }
      throw new Error('A see-as request ended without an answer.');
    }
    try {
      return await withTenant(opts.db, caller.tenantId, async (tx) => {
        const actor = await withActor(tx, caller);
        if (typeof ws === 'string') await requireRoom(tx, actor, ws, app.now());
        return fn(tx, actor);
      }, role);
    } catch (err) {
      // after the rolled-back request has ended; must not change the response
      if (err instanceof BlockedLink) {
        await withTenant(opts.db, caller.tenantId, (tx) => recordBlockedLink(tx, caller, err.attempt, req), role)
          .catch((e: unknown) => req.log.error(e));
      }
      throw err;
    }
  });

  const limit = opts.rateLimit === false ? null : await setupRateLimit(app, opts.rateLimit ?? {});

  // API output is data only: nothing may run, load or be framed
  app.addHook('onSend', async (_req, reply, payload) => {
    const own = reply.getHeader('content-security-policy');
    if (typeof own !== 'string' || !own) reply.header('content-security-policy', API_CSP);
    else if (!/frame-ancestors/.test(own)) reply.header('content-security-policy', `${own}; frame-ancestors 'none'`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-resource-policy', 'same-origin');
    return payload;
  });

  // CSRF check, before auth
  const allowedOrigins = originsOf([opts.publicUrl ?? 'http://localhost', ...(opts.trustedOrigins ?? [])]);
  app.addHook('onRequest', async (req) => { checkOrigin(req, allowedOrigins); });

  app.addHook('onRequest', async (req, reply) => {
    // refuse paths that normalise differently (dot segments)
    const path = normalisedPath(req.url);
    if (path === null) throw unclearPath();
    if (path.startsWith('/v1/health')) return;
    if (path === '/health' || path === '/v1/setup' || path.startsWith('/v1/setup/') || path === '/v1/branding' || path.startsWith('/v1/branding/')) {
      await limit?.(req, reply); return;
    }
    if (path.startsWith('/v1/public/') || path.startsWith('/v1/auth/')) { await limit?.(req, reply); return; }
    if (path === '/v1/sandbox' || path.startsWith('/v1/sandbox/')) { await limit?.(req, reply); return; }
    req.caller = await opts.auth.authenticate(req, reply);
    // before the 401: throttle bad credentials too
    await limit?.(req, reply);
    if (!req.caller) throw unauthenticated();

    // off the see-as allowlist: 403 for admins who may use it, 404 for everyone else
    const seeAs = requestedSeeAs(req);
    if (seeAs !== null && !seeAsAllowed(req.method, req.routeOptions.url)) {
      const ws = (req.params as { ws?: unknown } | undefined)?.ws;
      const caller = req.caller;
      const may = seeAs !== 'invalid' && typeof ws === 'string' && await withTenant(opts.db, caller.tenantId,
        (tx) => maySeeAs(tx, caller, ws, seeAs, app.now()), role);
      throw may ? seeAsReadOnly() : notFound();
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpProblem) return send(reply, err.problem);
    if ((err as { code?: unknown }).code === 'VS001') {
      return send(reply, { type: 'https://vdrkit.com/problems/sandbox-address', title: 'Not in the sandbox', status: 422, reason: 'sandbox_address',
        detail: 'The sandbox takes only invented addresses, at example.com or ending in .test, so that no real person is invited into a public demo. Use one such as name@example.com.' });
    }
    const message = err instanceof Error ? err.message : String(err);
    if ((err as { validation?: unknown }).validation) {
      return send(reply, { type: 'https://vdrkit.com/problems/bad-request', title: 'Invalid request', status: 400, detail: message });
    }
    const { statusCode: status, code } = err as { statusCode?: number; code?: unknown };
    const fastifyClientError = typeof code === 'string' && code.startsWith('FST_');
    if (typeof status === 'number' && status >= 400 && status < 500 && fastifyClientError) {
      return send(reply, { type: 'https://vdrkit.com/problems/bad-request', title: 'Invalid request', status, detail: message });
    }
    const reference = errorReference(req.id);
    req.log.error({ err, reference }, `Request failed, reference ${reference}`);
    return send(reply, { type: 'https://vdrkit.com/problems/server-error', title: 'Something went wrong', status: 500, reference });
  });

  if (opts.sandbox) {
    const { installSandbox } = await import('./sandbox/plugin.js');
    await installSandbox(app, opts.db, opts.dbRole, opts.sandbox);
  }

  app.get('/v1/health', { schema: { hide: true } }, async () => ({ ok: true }));
  // site admins only
  app.get('/v1/openapi.json', { schema: { hide: true } }, async (req) => {
    await app.inTenant(req, (tx, caller) => requireSiteAdmin(tx, caller));
    return app.swagger();
  });

  await app.register(nodeRoutes);
  await app.register(grantRoutes);
  await app.register(uploadRoutes);
  await app.register(eventRoutes);
  await app.register(roomRoutes);
  await app.register(peopleRoutes);
  await app.register(peopleAdminRoutes);
  await app.register(emailChangeRoutes);
  await app.register(documentRoutes);
  await app.register(timelineRoutes);
  await app.register(viewerRoutes);
  await app.register(searchRoutes);
  await app.register(activityExportRoutes);
  await app.register(activityRoutes);
  await app.register(dashboardRoutes);
  await app.register(profileRoutes);
  await app.register(signInRoutes);
  await app.register(notificationSettingsRoutes);
  await app.register(roomShellRoutes);
  await app.register(myRoomsRoutes);
  await app.register(audienceRoutes);
  await app.register(detailsRoutes);
  await app.register(processAgainRoutes);
  await app.register(releaseReviewRoutes);
  await app.register(seeAsRoutes);
  await app.register(aboutRoutes);

  const site = opts.site ?? {};
  const env = site.env ?? process.env;
  const probeDeps: Omit<ProbeDeps, 'gotenbergUrl' | 'clamav'> = { db: opts.db };
  if (opts.dbRole) probeDeps.dbRole = opts.dbRole;
  if (opts.storage) probeDeps.storage = opts.storage;
  if (opts.mailer) probeDeps.mail = opts.mailer;
  const siteCtx: SiteContext = {
    probes: site.probes ?? probesFromEnv(probeDeps, env),
    transport: site.mailTransport ?? nodemailerTransport,
    resolver: site.resolver ?? systemResolver,
    env,
  };
  if (site.keyProvider) siteCtx.keyProvider = site.keyProvider;
  const setup = site.setup === false ? null : new SetupService(opts.db, opts.dbRole, () => app.now(), site.setup ?? {});
  app.decorate('setup', setup);
  if (setup) {
    await app.register(setupRoutes(setup, () => siteCtx, site.setup || {}));
    if (!opts.skipStartupTasks) app.addHook('onReady', async () => { await setup.prepare(); });
  }
  await app.register(siteRoutes(() => siteCtx));
  await app.register(publicSiteRoutes(opts.db, opts.dbRole));
  for (const plugin of opts.plugins ?? []) await app.register(plugin);
  return app;
}
