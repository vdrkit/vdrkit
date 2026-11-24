// SPDX-License-Identifier: AGPL-3.0-only
// Dev only: whole API on PGlite. Flags: --reset, --empty
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production') {
  console.error('dev:pglite: not for production (NODE_ENV=production)');
  process.exit(1);
}
// header auth needs development or test
process.env.NODE_ENV ??= 'development';

const { PGlite } = await import('@electric-sql/pglite');
const { ltree } = await import('@electric-sql/pglite/contrib/ltree');
const { fromPGlite, migrate } = await import('@vdrkit/core');
const { buildApp } = await import('../../src/app.js');
const { bodies } = await import('../../src/mail/smtp.js');
const { devOrSessionAuthenticator } = await import('../../src/auth.js');
const { BetterAuthAuthenticator, betterAuthRoutes, createBetterAuth } = await import('../../src/auth/better-auth.js');
const { sessionRoutes } = await import('../../src/auth/session-routes.js');
const { linkPersonToLogin } = await import('../../src/auth/person-link.js');
const { poolFromPGlite } = await import('../../src/auth/pool.js');
const { withTenant } = await import('@vdrkit/core');
const { LocalKeyProvider } = await import('../../src/crypto/envelope.js');
const { probesFromEnv, runHealthAlerts } = await import('../../src/site/health.js');
const { DbKeyring } = await import('../../src/crypto/keyring.js');
const { LocalDiskStorage } = await import('../../src/storage/local-disk.js');
const { GotenbergClient } = await import('../../src/pipeline/pipeline.js');
const { processVersion, sendDeadlineReminders, sendDueNotifications, sendWaitingInvitations, sweepStuckProcessing } = await import('../../src/worker/jobs.js');
const { markVersionFailed, tenantsWithDueNotifications, tenantsWithDueReminders } = await import('../../src/worker/runner.js');
const { InlineQueue, DEV_JOB_TIMEOUT_MS } = await import('../../src/worker/inline-queue.js');
const { DEMO_PEOPLE, DEMO_TENANT_ID, SITE_PEOPLE, seedDemo, seedDemoRooms, seedSiteDemo, stableId } = await import('../../src/demo/seed-demo.js');
const { seedDevFiles } = await import('../../src/demo/seed-files.js');
const { seedDevActivity } = await import('../../src/demo/seed-activity.js');
const { devMailChannel } = await import('./mail.js');
type Channel = import('@vdrkit/core').Channel;
type OutgoingMessage = import('@vdrkit/core').OutgoingMessage;
type Authenticator = import('../../src/auth.js').Authenticator;
type JobQueue = import('../../src/worker/jobs.js').JobQueue;
type WorkerContext = import('../../src/worker/jobs.js').WorkerContext;
type WaitingInvitationsPayload = import('../../src/worker/jobs.js').WaitingInvitationsPayload;

const here = fileURLToPath(new URL('.', import.meta.url));
const DIR = resolve(process.env.VDRKIT_DEV_DIR ?? resolve(here, '../../.dev-db'));
const PORT = Number(process.env.API_PORT ?? 3101);
const HOST = process.env.API_HOST ?? '127.0.0.1';
const reset = process.argv.includes('--reset');
const empty = process.argv.includes('--empty') || process.env.VDRKIT_DEV_EMPTY === '1';
const t0 = Date.now();
const log = (msg: string) => console.log(`[dev:pglite] ${msg}`);

if (reset && existsSync(DIR)) {
  rmSync(DIR, { recursive: true, force: true });
  log(`Removed ${DIR}`);
}
mkdirSync(DIR, { recursive: true });

const keyFile = resolve(DIR, 'master.key');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
const masterKey = readFileSync(keyFile, 'utf8').trim();

const lite = new PGlite(resolve(DIR, 'pgdata'), { extensions: { ltree } });
const db = fromPGlite(lite);
const applied = await migrate(db);
if (applied.length) log(`Applied migrations: ${applied.join(', ')}`);

const storage = new LocalDiskStorage(resolve(DIR, 'storage'));
const keyProvider = new LocalKeyProvider(masterKey);
const keyring = new DbKeyring(keyProvider);

interface DevMail {
  to: string; subject: string; text: string; html: string; fromName: string | null; replyTo: string | null; sentAt: string;
  inline: { cid: string; contentType: string; base64: string }[];
}

const mailbox = new Map<string, DevMail[]>();

const mailboxOnly: Channel = {
  name: 'email',
  async send(msg: OutgoingMessage) {
    const key = msg.to.trim().toLowerCase();
    const body = bodies(msg);
    const mail: DevMail = {
      to: msg.to, subject: msg.subject, text: body.text, html: body.html, fromName: msg.fromName ?? msg.fallbackFromName ?? null,
      replyTo: msg.replyTo ?? null, sentAt: new Date().toISOString(),
      inline: (msg.inline ?? []).map((a) => ({ cid: a.cid, contentType: a.contentType, base64: Buffer.from(a.content).toString('base64') })),
    };
    mailbox.set(key, [...(mailbox.get(key) ?? []), mail].slice(-10));
    const what = realServer ? 'Email to' : 'Email not sent (development) to';
    const indented = body.text.split('\n').map((line) => `    ${line}`).join('\n');
    console.log(`[dev:pglite] ${what} ${msg.to}: ${msg.subject}\n${indented}`);
    return { status: 'accepted', providerMessageId: `dev-${Date.now()}` };
  },
};

const { channel: logMailer, realServer, problem: mailProblem } = devMailChannel(mailboxOnly, process.env);

const gotenbergUrl = process.env.GOTENBERG_URL?.trim() || '';
const publicUrl = process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3100}`;

// demo "Office" files are really PDFs
class DevConverter extends GotenbergClient {
  constructor(private readonly real: InstanceType<typeof GotenbergClient> | null) { super('http://gotenberg.invalid'); }
  override async officeToPdf(filename: string, body: Buffer): Promise<Buffer> {
    if (body.subarray(0, 5).toString() === '%PDF-') return body;
    if (this.real) return this.real.officeToPdf(filename, body);
    throw new Error(`No converter in development: set GOTENBERG_URL to view ${filename}.`);
  }
}

const worker: WorkerContext = {
  db, storage, keyring, mailer: logMailer, dbRole: 'vdrkit_app', now: () => new Date(),
  publicUrl,
  gotenberg: new DevConverter(gotenbergUrl ? new GotenbergClient(gotenbergUrl) : null),
  clamav: (await import('../../src/pipeline/virus-scan.js')).clamAvFromEnv(),
};

function minutes(ms: number) {
  if (ms % 60_000 !== 0) return `${Math.round(ms / 1000)} seconds`;
  if (ms === 60_000) return '1 minute';
  return `${ms / 60_000} minutes`;
}
const inlineQueue: JobQueue & { idle(): Promise<void> } = new InlineQueue({
  async run(name, payload) {
    if (name === 'process-version') {
      const r = await processVersion(worker, String(payload.tenantId), String(payload.versionId));
      log(`Processed version ${payload.versionId}: ${r.status}${r.error ? `, ${r.error}` : ''}`);
    } else if (name === 'send-due-notifications' && payload.tenantId) {
      await sendDueNotifications(worker, String(payload.tenantId));
    } else if (name === 'send-waiting-invitations') {
      const r = await sendWaitingInvitations(worker, payload as unknown as WaitingInvitationsPayload);
      log(`Sent ${r.sent} waiting invitation${r.sent === 1 ? '' : 's'}${r.notSent ? `, ${r.notSent} not sent` : ''}`);
    }
  },
  async onFailure(name, payload, failure) {
    if (failure.kind === 'error') console.error(`[dev:pglite] Job ${name} failed:`, failure.error);
    else log(`Job ${name} ${String(payload.versionId ?? '')} took longer than ${minutes(failure.ms)} and was given up on.`);
    if (name !== 'process-version') return;
    const reason = failure.kind === 'timeout'
      ? `VDRkit stopped processing this file because it took longer than ${minutes(failure.ms)}. Upload it again.`
      : `VDRkit could not process this file: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`;
    await markVersionFailed(worker, String(payload.tenantId), String(payload.versionId), reason);
  },
  timeoutMs: DEV_JOB_TIMEOUT_MS,
});

if (empty) {
  log('Empty installation (--empty): no demo loaded. First-run setup is open until it is finished.');
  await lite.exec('analyze');
} else {
  const room = await seedDemo(db, { role: 'vdrkit_app' });
  log(room.skipped ? 'Project Heron is already loaded.' : `Loaded Project Heron: ${room.counts.folders} folders, ${room.counts.published} published documents, ${room.counts.drafts} drafts.`);
  const more = await seedDemoRooms(db, { role: 'vdrkit_app' });
  if (!more.skipped) log('Loaded Project Osprey, Falcon, Kingfisher, Weaver and Marlin for My rooms.');
  const site = await seedSiteDemo(db, { role: 'vdrkit_app' });
  if (!site.skipped) log('Loaded the site around it (G2): site admins Anika Pillay and Thabo Molefe, two room creators.');
  const files = await seedDevFiles({ db, storage, keyring, worker, tenantId: room.tenantId, fullPages: process.env.VDRKIT_DEV_FULL_PAGES === '1', log });
  if (files.versions) log(`Generated real pages for ${files.documents.join(', ')}: ${files.versions} versions, ${files.pages} pages.`);
  // no autovacuum in PGlite; without stats the plans are awful
  await lite.exec('analyze');

  await seedDevActivity(db, room.tenantId, log);

  await withTenant(db, room.tenantId, async (tx) => {
    for (const key of [...Object.keys(DEMO_PEOPLE), 'thandi', ...Object.keys(SITE_PEOPLE)]) await linkPersonToLogin(tx, stableId(room.tenantId, `person:${key}`));
  }, { role: 'vdrkit_app' });
}

const secretFile = resolve(DIR, 'auth.secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('base64'), { mode: 0o600 });
const extraOrigins = (process.env.VDRKIT_DEV_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
const originSet = new Set<string>();
for (const frontEnd of [publicUrl, ...extraOrigins]) {
  const { origin } = new URL(frontEnd);
  originSet.add(origin);
  originSet.add(origin.replace('127.0.0.1', 'localhost'));
  originSet.add(origin.replace('localhost', '127.0.0.1'));
}
const origins = [...originSet];
const betterAuth = createBetterAuth({
  db, pool: poolFromPGlite(lite), secret: readFileSync(secretFile, 'utf8').trim(), publicUrl, mailer: logMailer, storage, dbRole: 'vdrkit_app',
  trustedOrigins: origins, builtInRateLimit: false,
});
const sessions = new BetterAuthAuthenticator(betterAuth, db, 'vdrkit_app');
const auth: Authenticator & { devOnly: true } = devOrSessionAuthenticator(sessions);

const devMailbox: import('fastify').FastifyPluginAsync = async (a) => {
  a.get('/v1/dev/mailbox', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers['x-dev-person'] === undefined) return reply.code(404).send();
    const to = String((req.query as { to?: unknown }).to ?? '').trim().toLowerCase();
    return { messages: [...(mailbox.get(to) ?? [])].reverse().map(({ inline: _logo, ...m }) => m) };
  });
  a.get('/v1/dev/mailbox/view', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers['x-dev-person'] === undefined) return reply.code(404).send();
    const q = req.query as { to?: unknown; n?: unknown };
    const to = String(q.to ?? '').trim().toLowerCase();
    const m = [...(mailbox.get(to) ?? [])].reverse()[Number(q.n ?? 0) || 0];
    if (!m) return reply.code(404).send();
    let html = m.html;
    for (const i of m.inline) html = html.split(`cid:${i.cid}`).join(`data:${i.contentType};base64,${i.base64}`);
    return reply.type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
      .send(html);
  });
};

const devNotificationRun: import('fastify').FastifyPluginAsync = async (a) => {
  a.post('/v1/dev/notifications/run', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers['x-dev-person'] === undefined) return reply.code(404).send();
    const body = (req.body ?? {}) as { job?: unknown; at?: unknown };
    const at = typeof body.at === 'string' && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at) : new Date();
    const ctx = { ...worker, now: () => at };
    const totals = (runs: { sent: number; failed: number }[]) => {
      let sent = 0;
      let failed = 0;
      for (const r of runs) {
        sent += r.sent;
        failed += r.failed;
      }
      return { sent, failed };
    };
    if (body.job === 'reminders') {
      const tenants = await tenantsWithDueReminders(ctx);
      return totals(await Promise.all(tenants.map((id) => sendDeadlineReminders(ctx, id))));
    }
    if (body.job === 'notifications') {
      const tenants = await tenantsWithDueNotifications(ctx);
      return totals(await Promise.all(tenants.map((id) => sendDueNotifications(ctx, id))));
    }
    return reply.code(400).send({ detail: 'job must be "notifications" or "reminders".' });
  });
};

const devVirusScan: import('fastify').FastifyPluginAsync = async (a) => {
  a.post('/v1/dev/virus-scan', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers['x-dev-person'] === undefined) return reply.code(404).send();
    const b = (req.body ?? {}) as { versionId?: unknown; virusScan?: unknown; virusScanLimit?: unknown };
    if (typeof b.versionId !== 'string') return reply.code(400).send({ detail: 'versionId is required.' });
    let facts: { virusScan: string; virusScanLimit?: number } | null = null;
    if (b.virusScan != null) {
      facts = { virusScan: String(b.virusScan) };
      if (typeof b.virusScanLimit === 'number') facts.virusScanLimit = b.virusScanLimit;
    }
    await lite.query(facts
      ? `update document_version set metadata = (metadata - 'virusScan' - 'virusScanLimit') || $2::jsonb where id = $1`
      : `update document_version set metadata = metadata - 'virusScan' - 'virusScanLimit' where id = $1`,
    facts ? [b.versionId, JSON.stringify(facts)] : [b.versionId]);
    return reply.code(204).send();
  });
};

let setupCode: string | null = null;
const devSetupCode: import('fastify').FastifyPluginAsync = async (a) => {
  a.get('/v1/dev/setup-code', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers['x-dev-person'] === undefined || !setupCode) return reply.code(404).send();
    return { code: setupCode };
  });
};

// keep .env SMTP password away from servers typed into the form
const devTransport = () => Object.assign(Object.create(logMailer) as Channel, { verify: async () => undefined });
const siteEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SMTP_|MAIL_)/.test(k)));

const realProbes = probesFromEnv({ db, dbRole: 'vdrkit_app', storage, mail: logMailer, log: (m) => log(m) },
  { ...siteEnv, GOTENBERG_URL: gotenbergUrl });
const healthProbes: import('../../src/site/health.js').HealthProbes = {
  ...realProbes,
  async run() {
    const results = await realProbes.run();
    if (gotenbergUrl) return results;
    return results.map((r) => (r.key === 'conversion' && r.status === 'failing'
      ? { ...r, status: 'warning' as const, detail: 'Development only: generated demo files open without a converter. Set GOTENBERG_URL to convert real Word, Excel and PowerPoint files.' }
      : r));
  },
};
const healthRun = () => runHealthAlerts({ db, dbRole: 'vdrkit_app', probes: healthProbes, mailer: logMailer, storage, publicUrl })
  .catch((err) => console.error('[dev:pglite] Health run failed:', err));
await healthRun();

const app = await buildApp({
  db, auth, dbRole: 'vdrkit_app', logger: process.env.DEV_API_LOG === '1',
  storage, keyring, queue: inlineQueue, mailer: logMailer, rateLimit: false, publicUrl,
  trustedOrigins: origins,
  plugins: [betterAuthRoutes(betterAuth, publicUrl), sessionRoutes(betterAuth), devMailbox, devSetupCode, devNotificationRun, devVirusScan],
  site: {
    keyProvider, env: siteEnv, probes: healthProbes,
    mailTransport: devTransport,
    setup: { log: (line) => { setupCode = /Setup code: (\S+)/.exec(line)?.[1] ?? setupCode; console.log(`[dev:pglite] ${line}`); } },
  },
});
await app.listen({ host: HOST, port: PORT });

// requeue: the in-memory queue lost these on restart
{
  const left = (await lite.query<{ id: string; tenant_id: string }>(
    `select dv.id, dv.tenant_id from document_version dv join node n on n.id = dv.node_id
      where dv.processing_status = 'processing'
         or (dv.processing_status = 'ready' and dv.page_count is null and not dv.metadata ? 'pageCount' and not dv.metadata ? 'previewSkipped'
             and not dv.metadata ? 'placeholder' and lower(n.name) ~ '[.](jpe?g|png|gif|tiff?|bmp)$')
      order by dv.created_at`)).rows;
  for (const v of left) {
    await lite.query(`update document_version set queued_at = now() where id = $1`, [v.id]);
    await inlineQueue.enqueue('process-version', { tenantId: v.tenant_id, versionId: v.id });
  }
  if (left.length) log(`Processing ${left.length} ${left.length === 1 ? 'upload' : 'uploads'} again that the last run did not finish.`);
}
log(gotenbergUrl
  ? `Office conversion: real Word, Excel and PowerPoint uploads are converted by the Gotenberg that GOTENBERG_URL names.`
  : 'No converter: only the generated demo files open. Set GOTENBERG_URL to convert real Word, Excel and PowerPoint uploads.');
log(realServer
  ? `Real email: every email is sent through ${realServer}, and a copy goes to the dev mailbox.`
  : `No real email: emails go to the dev mailbox and this log only. ${mailProblem ? `The mail settings were not used: ${mailProblem}` : 'Set SMTP_HOST and MAIL_FROM to send them.'}`);

const notify = setInterval(() => {
  tenantsWithDueNotifications(worker)
    .then((ids) => Promise.all(ids.map((id) => sendDueNotifications(worker, id))))
    .catch((err) => console.error('[dev:pglite] Notification run failed:', err));
  tenantsWithDueReminders(worker)
    .then((ids) => Promise.all(ids.map((id) => sendDeadlineReminders(worker, id))))
    .catch((err) => console.error('[dev:pglite] Reminder run failed:', err));
  sweepStuckProcessing(worker)
    .then((r) => { if (r.failed) log(`Marked ${r.failed} stuck ${r.failed === 1 ? 'version' : 'versions'} as failed.`); })
    .catch((err) => console.error('[dev:pglite] Stuck processing sweep failed:', err));
}, 60_000);
const health = setInterval(() => { void healthRun(); }, 60_000);

const ready = `API on http://${HOST}:${PORT}/v1 (PGlite in ${DIR}), ready in ${((Date.now() - t0) / 1000).toFixed(1)} s.`;
if (empty) {
  log(`${ready} Empty installation: open ${publicUrl}/setup.`);
} else {
  log(`${ready} Tenant ${DEMO_TENANT_ID}, room ${stableId(DEMO_TENANT_ID, 'workspace')}.`);
  for (const [key, p] of Object.entries({ ...DEMO_PEOPLE, thabo: SITE_PEOPLE.thabo })) log(`  persona ${key.padEnd(7)} ${stableId(DEMO_TENANT_ID, `person:${key}`)}  ${p.name}`);
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(notify);
  clearInterval(health);
  await app.close().catch(() => undefined);
  await lite.close().catch(() => undefined);
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void stop(); });
