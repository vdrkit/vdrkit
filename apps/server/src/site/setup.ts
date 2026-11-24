// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, withTenant, type Database } from '@vdrkit/core';
import { linkPersonToLogin } from '../auth/person-link.js';
import { HttpProblem, badRequest } from '../problems.js';
import type { SmtpSettings } from '../mail/smtp.js';
import { envSettings, fromHeader, invalidateMail, mailFingerprint, mailFormFromEnv, PASSWORD_AGAIN, samePasswordTarget, wrapPassword, type MailForm } from './mail.js';
import { inspectLogo, logoView, storeLogo, removeLogo, type LogoVariant, type StoredLogo } from './logos.js';
import { VDRKIT_VERSION, type CheckResult } from './health.js';
import { domainOf } from './domain-check.js';
import { brandingFrom } from '../mail/branding.js';
import { MailFormBody, PersonName, sendTestEmail, type SiteContext } from './common.js';
import { visibleText } from '../routes/util.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 24 * 60 * 60_000;
// per IP: strangers can't lock the operator out
export const MAX_CODE_FAILURES = 10;
export const MAX_CODE_FAILURES_TOTAL = 1000;
export const SETUP_TOKEN_HEADER = 'x-vdrkit-setup-token';

export function generateSetupCode(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const normaliseCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

export interface SetupOptions {
  log?: (line: string) => void;
  generateCode?: () => string;
  fetch?: typeof fetch;
}

interface Draft {
  admin?: { givenName: string; familyName: string; company: string; email: string };
  orgName?: string;
  logos: Partial<Record<LogoVariant, StoredLogo>>;
  mail?: MailForm & { password?: string };
  tested?: { fingerprint: string; at: Date; to: string };
}

const closedProblem = () => new HttpProblem({ type: 'https://vdrkit.com/problems/not-found', title: 'Not found', status: 404,
  detail: 'Setup is finished. Sign in instead.' });
const lockedProblem = (detail = 'Unlock setup with the setup code first.') =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/unauthenticated', title: 'Setup code required', status: 401, detail });
const conflict = (detail: string) => new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Not possible', status: 409, detail });

export class SetupService {
  private code: { hash: Buffer; expiresAt: Date; failures: number; byIp: Map<string, number> } | null = null;
  private token: { hash: Buffer; expiresAt: Date } | null = null;
  private closed = false;
  private finishing = false;
  draft: Draft = { logos: {} };

  constructor(private readonly db: Database, private readonly dbRole: 'vdrkit_app' | undefined, private readonly now: () => Date, private readonly o: SetupOptions = {}) {}

  async isOpen(): Promise<boolean> {
    if (this.closed) return false;
    const open = await this.db.transaction(async (tx) => {
      if (this.dbRole) await tx.query(`set local role ${this.dbRole}`);
      return !!(await tx.query<{ open: boolean }>(`select site_setup_open() as open`)).rows[0]?.open;
    });
    if (!open) this.close();
    return open;
  }

  private close() {
    this.closed = true;
    this.code = null;
    this.token = null;
  }

  async prepare(): Promise<boolean> {
    if (!(await this.isOpen())) return false;
    const code = (this.o.generateCode ?? generateSetupCode)();
    this.code = { hash: sha(normaliseCode(code)), expiresAt: new Date(this.now().getTime() + CODE_TTL_MS), failures: 0, byIp: new Map() };
    this.token = null;
    const log = this.o.log ?? ((line: string) => console.log(line));
    log(`Setup code: ${code}`);
    return true;
  }

  async unlock(code: string, ip = 'unknown'): Promise<{ token: string; expiresAt: Date }> {
    if (!(await this.isOpen())) throw closedProblem();
    const c = this.code;
    if (!c) throw lockedProblem('No setup code is active. Restart the server and read the new code from its log.');
    if (c.expiresAt <= this.now()) throw lockedProblem('The setup code has expired. Restart the server and read the new code from its log.');
    if (c.failures >= MAX_CODE_FAILURES_TOTAL) throw lockedProblem('Too many wrong codes. Restart the server and read the new code from its log.');
    if ((c.byIp.get(ip) ?? 0) >= MAX_CODE_FAILURES) throw lockedProblem('Too many wrong codes from this address. Restart the server and read the new code from its log.');
    const given = sha(normaliseCode(code));
    if (!timingSafeEqual(given, c.hash)) {
      c.failures++;
      c.byIp.set(ip, (c.byIp.get(ip) ?? 0) + 1);
      throw lockedProblem('That is not the setup code. It has eight letters and digits, such as K7QM-4XWD.');
    }
    this.code = null;
    const token = randomBytes(32).toString('base64url');
    this.token = { hash: sha(token), expiresAt: c.expiresAt };
    return { token, expiresAt: c.expiresAt };
  }

  async require(req: FastifyRequest): Promise<void> {
    if (!(await this.isOpen())) throw closedProblem();
    const t = req.headers[SETUP_TOKEN_HEADER];
    if (typeof t !== 'string' || !this.token || this.token.expiresAt <= this.now() || !timingSafeEqual(sha(t), this.token.hash)) throw lockedProblem();
  }

  mailSettings(env: Record<string, string | undefined>): { form: MailForm; settings: SmtpSettings; passwordSource: 'typed' | 'env' | 'none' } | null {
    const fromEnv = mailFormFromEnv(env);
    const form: MailForm | null = this.draft.mail ?? fromEnv;
    if (!form) return null;
    let password = this.draft.mail?.password;
    let passwordSource: 'typed' | 'env' | 'none' = password ? 'typed' : 'none';
    // .env password only for the .env host and user
    const envMail = envSettings(env);
    if (!password && envMail?.password && samePasswordTarget(envMail, form)) {
      password = envMail.password;
      passwordSource = 'env';
    }
    const settings: SmtpSettings = { host: form.host, port: form.port, security: form.security, from: fromHeader(form.fromAddress) };
    if (form.user) {
      settings.user = form.user;
      if (password) settings.password = password;
    }
    return { form, passwordSource, settings };
  }

  async finish(ctx: SiteContext): Promise<{ tenantId: string; personId: string; email: string }> {
    if (this.finishing) throw conflict('Setup is being finished already.');
    this.finishing = true;
    try {
      const d = this.draft;
      if (!d.admin) throw badRequest('Fill in your account first: first name, last name, company and work email.');
      if (!d.orgName) throw badRequest('Give the name of your organisation first.');
      const mail = this.mailSettings(ctx.env);
      if (!mail) throw badRequest('Set the outgoing email server first.');
      if (!d.tested || d.tested.fingerprint !== mailFingerprint(mail.settings, d.admin.email)) {
        throw conflict(`Send a test email to ${d.admin.email} with these settings first. Finishing needs a test that the mail server accepted.`);
      }
      const testedAt = d.tested.at;
      const envForm = mailFormFromEnv(ctx.env);
      const sameAsEnv = !!envForm && mail.passwordSource !== 'typed' && JSON.stringify(stripPw(mail.form)) === JSON.stringify(stripPw(envForm));
      if (!sameAsEnv && mail.settings.password && !ctx.keyProvider) {
        throw new HttpProblem({ type: 'https://vdrkit.com/problems/not-configured', title: 'Not configured', status: 503,
          detail: 'The mail password is stored encrypted, which needs VDRKIT_MASTER_KEY in the installation file. Set it and restart, or keep the mail settings in the installation file.' });
      }
      const tenantId = randomUUID();
      const out = await withTenant(this.db, tenantId, async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtextextended('vdrkit.site_setup', 0))`);
        const open = (await tx.query<{ open: boolean }>(`select site_setup_open() as open`)).rows[0]?.open;
        if (!open) throw closedProblem();
        await tx.query(`insert into tenant (id, name) values (current_tenant_id(), $1)`, [d.orgName]);
        const a = d.admin!;
        const personId = (await tx.query<{ id: string }>(
          `insert into person (tenant_id, name, given_name, family_name, company, email, is_site_admin, can_create_rooms)
           values (current_tenant_id(), $1, $2, $3, $4, $5, true, true) returning id`,
          [`${a.givenName} ${a.familyName}`, a.givenName, a.familyName, a.company, a.email])).rows[0]!.id;
        await linkPersonToLogin(tx, personId);
        const wrapped = !sameAsEnv && mail.settings.password ? await wrapPassword(ctx.keyProvider!, tenantId, mail.settings.password) : null;
        await tx.query(
          `insert into site_settings (tenant_id, org_name, org_domain, logo_light, logo_dark, mail_host, mail_port, mail_security, mail_user,
                                      mail_password_wrapped, mail_from_address, updated_by)
           values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [d.orgName, domainOf(a.email), d.logos.light ? JSON.stringify(d.logos.light) : null, d.logos.dark ? JSON.stringify(d.logos.dark) : null,
            sameAsEnv ? null : mail.form.host, sameAsEnv ? null : mail.form.port, sameAsEnv ? null : mail.form.security,
            sameAsEnv ? null : mail.form.user, wrapped ? JSON.stringify(wrapped) : null,
            sameAsEnv ? null : mail.form.fromAddress, personId]);
        await tx.query(`insert into site_instance (tenant_id) values (current_tenant_id())`);
        await appendEvent(tx, {
          action: 'site.setup.completed', resourceType: 'site', resourceId: tenantId,
          data: { person_id: personId, actor_person_id: personId, mail_source: sameAsEnv ? 'env' : 'database',
            logos: Object.keys(d.logos), test_email_accepted_at: testedAt.toISOString() },
        });
        return { tenantId, personId, email: a.email };
      }, this.dbRole ? { role: this.dbRole } : {});
      this.close();
      this.draft = { logos: {} };
      return out;
    } finally {
      this.finishing = false;
    }
  }
}

const stripPw = (f: MailForm) => ({ host: f.host, port: f.port, security: f.security, user: f.user ?? null, fromAddress: f.fromAddress });

export async function webAddressCheck(publicUrl: string, f: typeof fetch = fetch): Promise<Omit<CheckResult, 'key'> & { key: 'web_address' }> {
  const base = { key: 'web_address' as const, label: 'Web address' };
  let u: URL;
  try {
    u = new URL(publicUrl);
  } catch {
    return { ...base, status: 'failing', detail: 'PUBLIC_URL is not a valid address.' };
  }
  if (u.protocol !== 'https:') {
    return { ...base, status: 'warning', detail: `${u.origin} has no certificate (http). Set PUBLIC_URL to an https address before inviting anyone.` };
  }
  try {
    const res = await f(`${u.origin}/health`, { signal: AbortSignal.timeout(5_000) });
    return { ...base, status: 'ok', detail: `${u.origin}, with a valid certificate${res.ok ? '' : `, answering ${res.status} on /health`}.` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, status: 'failing', detail: `${u.origin} cannot be reached with a valid certificate: ${message.slice(0, 160)}` };
  }
}

const Logo = z.object({
  filename: z.string(), mime: z.string(), size: z.number(), width: z.number().nullable(), height: z.number().nullable(),
  displaySize: z.object({ width: z.number(), height: z.number() }), url: z.string(),
}).nullable();

const DraftView = z.object({
  admin: z.object({ givenName: z.string(), familyName: z.string(), company: z.string(), email: z.string() }).nullable(),
  organisation: z.object({ name: z.string().nullable(), logos: z.object({ light: Logo, dark: Logo }) }),
  mail: z.object({
    host: z.string(), port: z.number(), security: z.enum(['starttls', 'tls']), user: z.string().nullable(),
    fromAddress: z.string(), passwordSet: z.boolean(), source: z.enum(['setup', 'env']),
  }).nullable(),
  testEmail: z.object({ sentTo: z.string(), acceptedAt: z.string(), current: z.boolean() }).nullable(),
});

const SETUP_CHECKS: string[] = ['database', 'storage', 'conversion', 'virus_scanner'];

const Check = z.object({ key: z.string(), label: z.string(), status: z.enum(['ok', 'warning', 'failing', 'not_checked']), detail: z.string() });

export function setupRoutes(service: SetupService, ctx: () => SiteContext, opts: SetupOptions = {}): FastifyPluginAsync {
  return async (app0) => {
    const app = app0 as unknown as FastifyInstance;
    const r = app0.withTypeProvider<ZodTypeProvider>();
    for (const type of ['image/png', 'image/svg+xml']) {
      app0.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: 600 * 1024 }, (_req, body, done) => done(null, body));
    }
    const Token = z.object({ [SETUP_TOKEN_HEADER]: z.string().optional() });
    // 404 before validation
    app0.addHook('onRequest', async (req) => {
      if (req.routeOptions.url !== '/v1/setup' && !(await service.isOpen())) throw closedProblem();
    });

    function draftView() {
      const d = service.draft;
      const c = ctx();
      const mail = service.mailSettings(c.env);
      const fp = mail && d.admin ? mailFingerprint(mail.settings, d.admin.email) : null;
      const url = (v: LogoVariant) => `/v1/setup/logos/${v}`;
      return {
        admin: d.admin ?? null,
        organisation: { name: d.orgName ?? null, logos: { light: logoView(d.logos.light, url('light')), dark: logoView(d.logos.dark, url('dark')) } },
        mail: mail ? { ...stripPw(mail.form), passwordSet: mail.passwordSource !== 'none', source: (d.mail ? 'setup' : 'env') as 'setup' | 'env' } : null,
        testEmail: d.tested ? { sentTo: d.tested.to, acceptedAt: d.tested.at.toISOString(), current: d.tested.fingerprint === fp } : null,
      };
    }

    r.get('/v1/setup', {
      schema: { summary: 'Whether first-run setup is open', tags: ['setup'],
        response: { 200: z.object({ open: z.boolean(), version: z.string().nullable() }) } },
    }, async () => {
      const open = await service.isOpen();
      return { open, version: open ? VDRKIT_VERSION : null };
    });

    r.post('/v1/setup/unlock', {
      schema: {
        summary: 'Unlock setup with the one-time code from the server log', tags: ['setup'],
        body: z.object({ code: z.string().trim().min(1).max(20) }),
        response: { 200: z.object({ token: z.string(), expiresAt: z.string(), header: z.string() }) },
      },
    }, async (req) => {
      const t = await service.unlock(req.body.code, req.ip);
      return { token: t.token, expiresAt: t.expiresAt.toISOString(), header: SETUP_TOKEN_HEADER };
    });

    r.get('/v1/setup/draft', {
      schema: { summary: 'Setup progress so far', tags: ['setup'], headers: Token, response: { 200: DraftView } },
    }, async (req) => {
      await service.require(req);
      return draftView();
    });

    r.get('/v1/setup/checks', {
      schema: {
        summary: 'Setup step 2: database, storage, conversion, virus scanner and web address', tags: ['setup'], headers: Token,
        response: { 200: z.object({ items: z.array(Check), ready: z.boolean() }) },
      },
    }, async (req) => {
      await service.require(req);
      const c = ctx();
      const items: z.infer<typeof Check>[] = [];
      for (const { error: _technical, ...check } of await c.probes.run()) {
        if (SETUP_CHECKS.includes(check.key)) items.push(check);
      }
      items.push(await webAddressCheck(app.deps.publicUrl, opts.fetch));
      return { items, ready: !items.some((i) => i.status === 'failing') };
    });

    r.put('/v1/setup/admin', {
      schema: {
        summary: 'Setup step 3: first site admin', tags: ['setup'], headers: Token,
        body: z.object({ givenName: PersonName, familyName: PersonName, company: visibleText(z.string().trim().min(1).max(200)), email: z.string().trim().toLowerCase().email().max(320) }),
        response: { 200: DraftView },
      },
    }, async (req) => {
      await service.require(req);
      service.draft.admin = req.body;
      return draftView();
    });

    r.put('/v1/setup/organisation', {
      schema: {
        summary: 'Setup step 4: organisation name', tags: ['setup'], headers: Token,
        body: z.object({ name: z.string().trim().min(2).max(120) }), response: { 200: DraftView },
      },
    }, async (req) => {
      await service.require(req);
      service.draft.orgName = req.body.name;
      return draftView();
    });

    const Variant = z.object({ variant: z.enum(['light', 'dark']) });
    r.put('/v1/setup/logos/:variant', {
      schema: {
        summary: 'Setup step 4: upload or replace a logo (PNG or SVG)', tags: ['setup'],
        headers: Token, params: Variant, querystring: z.object({ filename: z.string().max(200).optional() }), response: { 200: DraftView },
      },
    }, async (req) => {
      await service.require(req);
      const storage = app.deps.storage;
      if (!storage) {
        throw new HttpProblem({ type: 'https://vdrkit.com/problems/not-configured', title: 'Not configured', status: 503,
          detail: 'File storage is not configured, so logos cannot be stored. Add the logo later in Site settings.' });
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body)) throw badRequest('Send the logo as the request body, with Content-Type image/png or image/svg+xml.');
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
      const { png, meta } = await inspectLogo(body, type, req.query.filename);
      const v = req.params.variant;
      const before = service.draft.logos[v];
      service.draft.logos[v] = await storeLogo(storage, 'site', v, png, meta);
      await removeLogo(storage, before);
      return draftView();
    });

    r.delete('/v1/setup/logos/:variant', {
      schema: { summary: 'Setup step 4: remove a logo', tags: ['setup'], headers: Token, params: Variant, response: { 200: DraftView } },
    }, async (req) => {
      await service.require(req);
      const v = req.params.variant;
      if (app.deps.storage) await removeLogo(app.deps.storage, service.draft.logos[v]);
      delete service.draft.logos[v];
      return draftView();
    });

    r.get('/v1/setup/logos/:variant', {
      schema: { summary: 'Setup step 4: uploaded logo, for the preview', tags: ['setup'], headers: Token, params: Variant, hide: true },
    }, async (req, reply) => {
      await service.require(req);
      const l = service.draft.logos[req.params.variant];
      if (!l || !app.deps.storage) throw new HttpProblem({ type: 'https://vdrkit.com/problems/not-found', title: 'Not found', status: 404 });
      return reply.header('content-type', l.mime).header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox").send(await app.deps.storage.get(l.key));
    });

    r.put('/v1/setup/mail', {
      schema: {
        summary: 'Setup step 5: outgoing email', tags: ['setup'],
        headers: Token, body: MailFormBody, response: { 200: DraftView },
      },
    }, async (req) => {
      await service.require(req);
      const b = req.body;
      const prior = service.draft.mail?.password ? service.draft.mail : envSettings(ctx().env);
      const reusable = prior?.password && samePasswordTarget(prior, { host: b.host, user: b.user ?? null }) ? prior.password : undefined;
      if (b.user && !b.password && !b.removePassword && prior?.password && !reusable) throw badRequest(PASSWORD_AGAIN);
      const keep = service.draft.mail?.password && reusable === service.draft.mail.password ? reusable : undefined;
      const mail: NonNullable<Draft['mail']> = { host: b.host, port: b.port, security: b.security, user: b.user ?? null, fromAddress: b.fromAddress };
      if (b.password) mail.password = b.password;
      else if (keep && !b.removePassword) mail.password = keep;
      service.draft.mail = mail;
      return draftView();
    });

    r.post('/v1/setup/test-email', {
      schema: {
        summary: 'Setup step 5: send a test email to the new site admin', tags: ['setup'],
        headers: Token,
        body: z.object({
          timeZone: z.string().max(64).optional(),
        }).nullish(),
        response: { 200: z.object({ status: z.enum(['accepted', 'failed']), sentTo: z.string(), server: z.string(), sentAt: z.string(), error: z.string().optional() }) },
      },
    }, async (req) => {
      await service.require(req);
      const d = service.draft;
      if (!d.admin) throw badRequest('Fill in your account first, so the test email has somewhere to go.');
      const c = ctx();
      const mail = service.mailSettings(c.env);
      if (!mail) throw badRequest('Fill in the mail server first.');
      const brand = await brandingFrom({ org_name: d.orgName ?? null, logo_light: d.logos.light ?? null }, app.deps.storage, app.deps.publicUrl);
      const zone = req.body?.timeZone && knownZone(req.body.timeZone) ? req.body.timeZone : 'UTC';
      const result = await sendTestEmail(c, mail.settings, { personId: 'setup', email: d.admin.email }, brand, app.now(), zone);
      if (result.status === 'accepted') d.tested = { fingerprint: mailFingerprint(mail.settings, d.admin.email), at: app.now(), to: d.admin.email };
      else delete d.tested;
      return result;
    });

    r.post('/v1/setup/finish', {
      schema: {
        summary: 'Finish setup and close it for good', tags: ['setup'],
        headers: Token,
        response: { 201: z.object({ tenantId: z.string().uuid(), personId: z.string().uuid(), email: z.string(), signInUrl: z.string() }) },
      },
    }, async (req, reply) => {
      await service.require(req);
      const out = await service.finish(ctx());
      // may have cached "no mail server"
      invalidateMail(app.deps.mailer);
      return reply.code(201).send({ ...out, signInUrl: `${app.deps.publicUrl.replace(/\/$/, '')}/sign-in` });
    });
  };
}

function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
