// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, withTenant, type Database, type OutgoingMessage, type SqlClient } from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { linkPersonToLogin } from '../auth/person-link.js';
import { badRequest, HttpProblem, notFound, type Problem } from '../problems.js';
import { personOf, visibleText } from './util.js';
import { endMembership } from './people.js';
import { SELLER_ID_SQL, sellerNameSql } from './seller.js';
import { deleted, resetTwoFactorOf } from './sign-in.js';
import { browserLabel } from '../auth/sessions.js';
import { FAILED_SIGN_IN_DAYS, MailFormBody, requireSiteAdmin, sendTestEmail, type SiteContext } from '../site/common.js';
import { checkDomain, domainOf } from '../site/domain-check.js';
import { CHECK_KEYS, healthSummary, LABELS, overallHealth, readStates, VDRKIT_VERSION } from '../site/health.js';
import { inspectLogo, logoBytes, logoView, removeLogo, storeLogo, type LogoVariant, type StoredLogo } from '../site/logos.js';
import { effectiveMailSettings, fromHeader, invalidateMail, mailFormFromEnv, PASSWORD_AGAIN, readMailRow, samePasswordTarget, siteTenantId, wrapPassword } from '../site/mail.js';
import type { SmtpSettings } from '../mail/smtp.js';
import { mailBranding } from '../mail/branding.js';
import { sourceUrl } from './about.js';
import { notificationsUrl, siteAdminJoinedEmail, siteRightEmail, toMessage, type Email } from '../mail/templates.js';
import { mailEvent } from '../mail/proof.js';

// Site admin gives no access to room content. Never return folders or documents from /v1/site.

const ROOM_ADMINS_AT = (at: string) => `select m.person_id, g.workspace_id from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
  where g.role_template = 'admin' and pa.kind = 'seller' and m.status = 'active' and m.valid_from <= ${at} and ${at} < m.valid_to
    and m.recorded_at <= ${at} and ${at} < m.superseded_at and g.valid_from <= ${at} and ${at} < g.valid_to`;

function conflict(detail: string, reason?: string) {
  const problem: Problem = { type: 'https://vdrkit.com/problems/conflict', title: 'Not possible', status: 409, detail };
  if (reason) problem.reason = reason;
  return new HttpProblem(problem);
}
const notConfigured = (detail: string) => new HttpProblem({ type: 'https://vdrkit.com/problems/not-configured', title: 'Not configured', status: 503, detail });

const Logo = z.object({
  filename: z.string(), mime: z.string(), size: z.number(), width: z.number().nullable(), height: z.number().nullable(),
  displaySize: z.object({ width: z.number(), height: z.number() }), url: z.string(),
}).nullable();

const PrivacyNotice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('url'), url: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
]);
const PrivacyUrl = z.string().trim().max(2000).regex(/^https?:\/\/[^\s<>"]+$/, 'Give a full web address that starts with https://');
const PrivacyText = z.string().transform((t) => t.replace(/\r\n?/g, '\n').trim()).pipe(z.string().min(1).max(50_000));

function privacyOf(s: { privacy_url: string | null; privacy_text: string | null }): z.infer<typeof PrivacyNotice> {
  if (s.privacy_url) return { kind: 'url', url: s.privacy_url };
  if (s.privacy_text) return { kind: 'text', text: s.privacy_text };
  return { kind: 'none' };
}

const Settings = z.object({
  organisation: z.object({ name: z.string().nullable(), domain: z.string().nullable(), logos: z.object({ light: Logo, dark: Logo }), privacyNotice: PrivacyNotice }),
  mail: z.object({
    source: z.enum(['database', 'env', 'none']),
    host: z.string().nullable(), port: z.number().nullable(), security: z.enum(['starttls', 'tls']).nullable(), user: z.string().nullable(),
    passwordSet: z.boolean(),
    fromAddress: z.string().nullable(), dkimSelector: z.string(),
  }),
  rooms: z.object({
    creators: z.array(z.object({ personId: z.string().uuid(), name: z.string(), email: z.string() })),
  }),
  alerts: z.object({ notifySiteAdmins: z.boolean(), extraEmail: z.string().nullable(), afterMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]) }),
  updatedAt: z.string().nullable(),
});
type Settings = z.infer<typeof Settings>;

interface Row {
  org_name: string | null; org_domain: string | null; logo_light: StoredLogo | null; logo_dark: StoredLogo | null;
  privacy_url: string | null; privacy_text: string | null;
  mail_host: string | null; mail_port: number | null; mail_security: 'starttls' | 'tls' | null; mail_user: string | null;
  mail_password_wrapped: unknown; mail_from_address: string | null; dkim_selector: string;
  alert_admins: boolean; alert_extra_email: string | null; alert_after_minutes: 5 | 15 | 60;
  updated_at: string | Date | null;
}

async function settingsRow(tx: SqlClient): Promise<Row> {
  const r = (await tx.query<Row>(`select * from site_settings where tenant_id = current_tenant_id()`)).rows[0];
  if (r) return r;
  const t = (await tx.query<{ name: string }>(`select name from tenant where id = current_tenant_id()`)).rows[0];
  return {
    org_name: t?.name ?? null, org_domain: null, logo_light: null, logo_dark: null, privacy_url: null, privacy_text: null,
    mail_host: null, mail_port: null, mail_security: null, mail_user: null, mail_password_wrapped: null, mail_from_address: null, dkim_selector: 'default',
    alert_admins: true, alert_extra_email: null, alert_after_minutes: 15, updated_at: null,
  };
}

async function ensureRow(tx: SqlClient): Promise<void> {
  await tx.query(`insert into site_settings (tenant_id, org_name) select current_tenant_id(), name from tenant where id = current_tenant_id()
                  on conflict (tenant_id) do nothing`);
}

async function siteEvent(tx: SqlClient, req: FastifyRequest, caller: Caller, action: string, data: Record<string, unknown>) {
  await appendEvent(tx, {
    action, actorId: caller.actorId, resourceType: 'site', resourceId: caller.tenantId, requestId: req.id,
    data: { actor_person_id: personOf(caller), ...data },
    context: { ip: req.ip, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null },
  });
}

export function siteRoutes(ctx: () => SiteContext): FastifyPluginAsync {
  return async (app0) => {
    const app = app0 as unknown as FastifyInstance;
    const r = app0.withTypeProvider<ZodTypeProvider>();
    for (const type of ['image/png', 'image/svg+xml']) {
      app0.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: 600 * 1024 }, (_req, body, done) => done(null, body));
    }

    function mailView(s: Row): Settings['mail'] {
      if (s.mail_host) {
        return { source: 'database', host: s.mail_host, port: s.mail_port, security: s.mail_security, user: s.mail_user, passwordSet: !!s.mail_password_wrapped,
          fromAddress: s.mail_from_address, dkimSelector: s.dkim_selector };
      }
      const env = mailFormFromEnv(ctx().env);
      if (env) {
        return { source: 'env', host: env.host, port: env.port, security: env.security, user: env.user, passwordSet: env.passwordSet,
          fromAddress: env.fromAddress, dkimSelector: s.dkim_selector };
      }
      return { source: 'none', host: null, port: null, security: null, user: null, passwordSet: false, fromAddress: null, dkimSelector: s.dkim_selector };
    }

    async function readSettings(tx: SqlClient): Promise<Settings> {
      const s = await settingsRow(tx);
      const creators = (await tx.query<{ personId: string; name: string; email: string }>(
        `select id as "personId", name, email from person where can_create_rooms and not is_site_admin and disabled_at is null and erased_at is null order by name`)).rows;
      return {
        organisation: { name: s.org_name, domain: s.org_domain, logos: {
          light: logoView(s.logo_light, '/v1/branding/logos/light'), dark: logoView(s.logo_dark, '/v1/branding/logos/dark') },
          privacyNotice: privacyOf(s) },
        mail: mailView(s),
        rooms: { creators },
        alerts: { notifySiteAdmins: s.alert_admins, extraEmail: s.alert_extra_email, afterMinutes: s.alert_after_minutes },
        updatedAt: s.updated_at ? new Date(s.updated_at).toISOString() : null,
      };
    }

    // Keep the stored password only for the same host and user. Never send it to another server
    async function settingsFromForm(tx: SqlClient, tenantId: string, b: MailFormBody): Promise<SmtpSettings> {
      let password: string | undefined = b.password || undefined;
      if (!password && !b.removePassword && b.user) {
        const { keyProvider, env } = ctx();
        const eff = await effectiveMailSettings(tx, tenantId, keyProvider, env);
        if (eff?.settings.password) {
          if (!samePasswordTarget(eff.settings, { host: b.host, user: b.user })) throw badRequest(PASSWORD_AGAIN);
          password = eff.settings.password;
        }
      }
      const settings: SmtpSettings = { host: b.host, port: b.port, security: b.security, from: fromHeader(b.fromAddress) };
      if (b.user) {
        settings.user = b.user;
        if (password) settings.password = password;
      }
      return settings;
    }

    const siteUrl = (path: string) => `${app.deps.publicUrl.replace(/\/$/, '')}${path}`;

    async function deliver(message: OutgoingMessage): Promise<{ status: string; providerMessageId?: string; error?: string }> {
      if (!app.deps.mailer) return { status: 'no_mailer', error: 'No mail server is configured' };
      try {
        return await app.deps.mailer.send(message);
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message.slice(0, 200) : 'failed' };
      }
    }

    r.get('/v1/site/settings', {
      schema: { summary: 'Site settings', tags: ['site'], response: { 200: Settings } },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      await requireSiteAdmin(tx, caller);
      return readSettings(tx);
    }));

    r.patch('/v1/site/settings', {
      schema: {
        summary: 'Save site settings (omitted sections unchanged)', tags: ['site'],
        body: z.object({
          organisationName: z.string().trim().min(2).max(120).optional(),
          organisationDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/).nullable().optional(),
          mail: MailFormBody.optional(),
          dkimSelector: z.string().trim().regex(/^[A-Za-z0-9._-]{1,63}$/).optional(),
          privacyNotice: z.union([z.object({ url: PrivacyUrl }).strict(), z.object({ text: PrivacyText }).strict()]).nullable().optional(),
          alerts: z.object({
            notifySiteAdmins: z.boolean().optional(),
            extraEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
            afterMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]).optional(),
          }).optional(),
        }),
        response: { 200: Settings },
      },
    }, async (req) => {
      const out = await app.inTenant(req, async (tx, caller) => {
        await requireSiteAdmin(tx, caller);
        const b = req.body;
        await ensureRow(tx);
        const before = await settingsRow(tx);
        const changed: string[] = [];
        const set = async (col: string, value: unknown, field: string, cast = '') => {
          const prev = (before as unknown as Record<string, unknown>)[col];
          if (JSON.stringify(prev ?? null) === JSON.stringify(value ?? null)) return;
          await tx.query(`update site_settings set ${col} = $1${cast}, updated_by = $2 where tenant_id = current_tenant_id()`, [value, personOf(caller)]);
          changed.push(field);
        };
        if (b.organisationName !== undefined) {
          await set('org_name', b.organisationName, 'organisationName');
          await tx.query(`update tenant set name = $1 where id = current_tenant_id()`, [b.organisationName]);
        }
        if (b.organisationDomain !== undefined) await set('org_domain', b.organisationDomain, 'organisationDomain');
        if (b.dkimSelector !== undefined) await set('dkim_selector', b.dkimSelector, 'dkimSelector');
        if (b.privacyNotice !== undefined) {
          const url = b.privacyNotice && 'url' in b.privacyNotice ? b.privacyNotice.url : null;
          const text = b.privacyNotice && 'text' in b.privacyNotice ? b.privacyNotice.text : null;
          if (before.privacy_url !== url || before.privacy_text !== text) {
            await tx.query(`update site_settings set privacy_url = $1, privacy_text = $2, updated_by = $3 where tenant_id = current_tenant_id()`, [url, text, personOf(caller)]);
            changed.push('privacyNotice');
          }
        }
        if (b.alerts) {
          if (b.alerts.notifySiteAdmins !== undefined) await set('alert_admins', b.alerts.notifySiteAdmins, 'alerts.notifySiteAdmins');
          if (b.alerts.extraEmail !== undefined) await set('alert_extra_email', b.alerts.extraEmail, 'alerts.extraEmail');
          if (b.alerts.afterMinutes !== undefined) await set('alert_after_minutes', b.alerts.afterMinutes, 'alerts.afterMinutes');
        }
        let passwordChanged = false;
        if (b.mail) {
          const c = ctx();
          const s = await settingsFromForm(tx, caller.tenantId, b.mail);
          if (s.password && !c.keyProvider) {
            throw notConfigured('The mail password is stored encrypted, which needs VDRKIT_MASTER_KEY in the installation file.');
          }
          const prevPassword = (await effectiveMailSettings(tx, caller.tenantId, c.keyProvider, c.env))?.settings.password;
          const wrapped = s.password ? await wrapPassword(c.keyProvider!, caller.tenantId, s.password) : null;
          const prev = [before.mail_host, before.mail_port, before.mail_security, before.mail_user, before.mail_from_address];
          const next = [b.mail.host, b.mail.port, b.mail.security, b.mail.user ?? null, b.mail.fromAddress];
          passwordChanged = (prevPassword ?? null) !== (s.password ?? null);
          await tx.query(
            `update site_settings set mail_host = $1, mail_port = $2, mail_security = $3, mail_user = $4, mail_password_wrapped = $5,
                    mail_from_address = $6, updated_by = $7 where tenant_id = current_tenant_id()`,
            [b.mail.host, b.mail.port, b.mail.security, b.mail.user ?? null, wrapped ? JSON.stringify(wrapped) : null,
              b.mail.fromAddress, personOf(caller)]);
          if (JSON.stringify(prev) !== JSON.stringify(next) || passwordChanged) changed.push('mail');
        }
        if (changed.length) {
          // never log the password, not even its length
          await siteEvent(tx, req, caller, 'site.settings.changed', { fields: changed, ...(b.mail ? { mail_password_changed: passwordChanged } : {}) });
        }
        return readSettings(tx);
      });
      if (req.body.mail) invalidateMail(app.deps.mailer);
      return out;
    });

    r.delete('/v1/site/settings/mail', {
      schema: { summary: 'Reset mail settings to the .env values', tags: ['site'], response: { 200: Settings } },
    }, async (req) => {
      const out = await app.inTenant(req, async (tx, caller) => {
        await requireSiteAdmin(tx, caller);
        if (await readMailRow(tx)) {
          await tx.query(`update site_settings set mail_host = null, mail_port = null, mail_security = null, mail_user = null, mail_password_wrapped = null,
                                 mail_from_address = null, updated_by = $1 where tenant_id = current_tenant_id()`, [personOf(caller)]);
          await siteEvent(tx, req, caller, 'site.settings.changed', { fields: ['mail'], mail_source: 'env' });
        }
        return readSettings(tx);
      });
      invalidateMail(app.deps.mailer);
      return out;
    });


    const Variant = z.object({ variant: z.enum(['light', 'dark']) });
    r.put('/v1/site/branding/logos/:variant', {
      schema: {
        summary: 'Upload or replace a site logo (PNG or SVG)', tags: ['site'],
        params: Variant, querystring: z.object({ filename: z.string().max(200).optional() }), response: { 200: Settings },
      },
    }, async (req) => {
      const storage = app.deps.storage;
      if (!storage) throw notConfigured('File storage is not configured, so logos cannot be stored.');
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body)) throw badRequest('Send the logo as the request body, with Content-Type image/png or image/svg+xml.');
      const { png, meta } = await inspectLogo(body, String(req.headers['content-type'] ?? '').split(';')[0]!.trim(), req.query.filename);
      const v: LogoVariant = req.params.variant;
      const col = v === 'light' ? 'logo_light' : 'logo_dark';
      let stored: StoredLogo | null = null;
      let old: StoredLogo | null = null;
      try {
        const out = await app.inTenant(req, async (tx, caller) => {
          await requireSiteAdmin(tx, caller);
          await ensureRow(tx);
          old = (await settingsRow(tx))[col];
          stored = await storeLogo(storage, `site/${caller.tenantId}`, v, png, meta);
          await tx.query(`update site_settings set ${col} = $1, updated_by = $2 where tenant_id = current_tenant_id()`, [JSON.stringify(stored), personOf(caller)]);
          await siteEvent(tx, req, caller, old ? 'site.logo.replaced' : 'site.logo.uploaded', { variant: v, mime: meta.mime, size: meta.size, sha256: meta.sha256 });
          return readSettings(tx);
        });
        await removeLogo(storage, old);
        return out;
      } catch (err) {
        await removeLogo(storage, stored);
        throw err;
      }
    });

    r.delete('/v1/site/branding/logos/:variant', {
      schema: { summary: 'Remove a site logo', tags: ['site'], params: Variant, response: { 200: Settings } },
    }, async (req) => {
      const v: LogoVariant = req.params.variant;
      const col = v === 'light' ? 'logo_light' : 'logo_dark';
      let old: StoredLogo | null = null;
      const out = await app.inTenant(req, async (tx, caller) => {
        await requireSiteAdmin(tx, caller);
        old = (await settingsRow(tx))[col];
        if (old) {
          await tx.query(`update site_settings set ${col} = null, updated_by = $1 where tenant_id = current_tenant_id()`, [personOf(caller)]);
          await siteEvent(tx, req, caller, 'site.logo.removed', { variant: v });
        }
        return readSettings(tx);
      });
      if (app.deps.storage) await removeLogo(app.deps.storage, old);
      return out;
    });


    r.post('/v1/site/mail/test', {
      schema: {
        summary: 'Send a test email to yourself', tags: ['site'],
        body: z.object({ mail: MailFormBody.optional() }).optional(),
        response: { 200: z.object({ status: z.enum(['accepted', 'failed']), sentTo: z.string(), server: z.string(), sentAt: z.string(), error: z.string().optional() }) },
      },
    }, async (req) => {
      const prep = await app.inTenant(req, async (tx, caller) => {
        const me = await requireSiteAdmin(tx, caller);
        const c = ctx();
        const s = req.body?.mail ? await settingsFromForm(tx, caller.tenantId, req.body.mail)
          : (await effectiveMailSettings(tx, caller.tenantId, c.keyProvider, c.env))?.settings;
        if (!s) throw badRequest('No mail server is set. Fill in the mail server first.');
        const p = (await tx.query<{ email: string; time_zone: string }>(`select email, time_zone from person where id = $1`, [me])).rows[0]!;
        return { s, me, email: p.email, tz: p.time_zone, brand: await mailBranding(tx, app.deps.storage, app.deps.publicUrl) };
      });
      const result = await sendTestEmail(ctx(), prep.s, { personId: prep.me, email: prep.email }, prep.brand, app.now(), prep.tz);
      await app.inTenant(req, (tx, caller) => siteEvent(tx, req, caller, result.status === 'accepted' ? 'site.mail.test_sent' : 'site.mail.test_not_sent', {
        recipient_person_id: prep.me, server: result.server, saved_settings: !req.body?.mail, ...(result.error ? { error: result.error } : {}) }));
      return result;
    });

    const RecordCheck = z.object({ name: z.string(), status: z.enum(['pass', 'missing']), record: z.string().nullable(), fix: z.string().nullable() });
    r.get('/v1/site/mail/domain-check', {
      schema: {
        summary: 'Check SPF, DKIM and DMARC for the sending domain', tags: ['site'],
        querystring: z.object({ selector: z.string().trim().regex(/^[A-Za-z0-9._-]{1,63}$/).optional() }),
        response: { 200: z.object({ domain: z.string(), checkedAt: z.string(), spf: RecordCheck, dkim: RecordCheck.extend({ selector: z.string() }), dmarc: RecordCheck }) },
      },
    }, async (req) => {
      const { domain, selector, alertTo } = await app.inTenant(req, async (tx, caller) => {
        await requireSiteAdmin(tx, caller);
        const c = ctx();
        const s = await settingsRow(tx);
        const eff = await effectiveMailSettings(tx, caller.tenantId, undefined, c.env).catch(() => null);
        const from = s.mail_from_address ?? (eff ? eff.settings.from : null);
        const d = from ? domainOf(from.replace(/^.*<|>.*$/g, '')) : null;
        if (!d) throw badRequest('Set a sending address first. The check looks at its domain.');
        return { domain: d, selector: req.query.selector ?? s.dkim_selector, alertTo: s.alert_extra_email };
      });
      const check = await checkDomain(ctx().resolver, domain, selector, alertTo);
      return { ...check, checkedAt: app.now().toISOString() };
    });


    r.get('/v1/site/rooms', {
      schema: {
        summary: 'List all rooms on the site (no content access)', tags: ['site'],
        response: {
          200: z.object({
            items: z.array(z.object({
              id: z.string().uuid(), name: z.string(), seller: z.string().nullable(), state: z.string(),
              roomAdmins: z.array(z.object({ personId: z.string().uuid(), name: z.string() })),
              people: z.number(), storageBytes: z.number(), createdAt: z.string(), youAreAdmin: z.boolean(),
            })),
            totals: z.object({ rooms: z.number(), storageBytes: z.number() }),
          }),
        },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const me = await requireSiteAdmin(tx, caller);
      const now = app.now().toISOString();
      const { rows } = await tx.query<any>(
        `select w.id, w.name, w.state, w.created_at,
                ${sellerNameSql('w.id')} as seller,
                coalesce((select json_agg(json_build_object('personId', x.id, 'name', x.name) order by x.name)
                            from (select distinct p.id, p.name from (${ROOM_ADMINS_AT('$2::timestamptz')}) a join person p on p.id = a.person_id
                                   where a.workspace_id = w.id) x), '[]') as admins,
                (select count(distinct m.person_id) from membership m join groups g on g.id = m.group_id
                  where g.workspace_id = w.id and m.status = 'active' and m.valid_from <= $2 and $2 < m.valid_to
                    and m.superseded_at = 'infinity' and g.valid_from <= $2 and $2 < g.valid_to)::int as people,
                (select coalesce(sum(dv.size_bytes), 0) from document_version dv join node n on n.id = dv.node_id where n.workspace_id = w.id)::bigint as storage,
                is_workspace_admin($1, w.id, $2) as you_admin
           from workspace w where w.state <> 'deleted' order by w.created_at desc, w.name`, [me, now]);
      const items = rows.map((w: any) => ({
        id: w.id, name: w.name, seller: w.seller, state: w.state, roomAdmins: w.admins, people: Number(w.people),
        storageBytes: Number(w.storage), createdAt: new Date(w.created_at).toISOString(), youAreAdmin: w.you_admin,
      }));
      let storageBytes = 0;
      for (const item of items) storageBytes += item.storageBytes;
      return { items, totals: { rooms: items.length, storageBytes } };
    }));

    r.post('/v1/site/rooms/:ws/join', {
      schema: {
        summary: 'Join a room as room admin (reason required; logged and admins emailed)', tags: ['site'],
        params: z.object({ ws: z.string().uuid() }),
        body: z.object({ reason: z.string().trim().min(3).max(1000) }),
        response: {
          200: z.object({ workspaceId: z.string().uuid(), membershipId: z.string().uuid(),
            notified: z.array(z.object({ personId: z.string().uuid(), status: z.string() })) }),
        },
      },
    }, async (req) => {
      const ws = req.params.ws;
      const joined = await app.inTenant(req, async (tx, caller) => {
        const me = await requireSiteAdmin(tx, caller);
        const now = app.now();
        await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`site.join:${ws}:${me}`]);
        const room = (await tx.query<{ name: string }>(`select name from workspace where id = $1 and state <> 'deleted'`, [ws])).rows[0];
        if (!room) throw notFound();
        if ((await tx.query<{ ok: boolean }>(`select is_workspace_admin($1, $2, $3) as ok`, [me, ws, now.toISOString()])).rows[0]?.ok) {
          throw conflict('You are already a room admin of this room.');
        }
        const admins = (await tx.query<{ id: string; name: string; email: string; time_zone: string }>(
          `select distinct p.id, p.name, p.email, p.time_zone from (${ROOM_ADMINS_AT('$3::timestamptz')}) a join person p on p.id = a.person_id
            where a.workspace_id = $2 and p.id <> $1 and p.disabled_at is null and p.erased_at is null order by p.name`,
          [me, ws, now.toISOString()])).rows;
        let group = (await tx.query<{ id: string }>(
          `select g.id from groups g join party pa on pa.id = g.party_id
            where g.workspace_id = $1 and g.role_template = 'admin' and pa.kind = 'seller' and g.parent_group_id is null
              and g.valid_from <= $2 and $2 < g.valid_to order by g.created_at limit 1`, [ws, now.toISOString()])).rows[0]?.id;
        if (!group) {
          let party = (await tx.query<{ id: string }>(SELLER_ID_SQL, [ws])).rows[0]?.id;
          party ??= (await tx.query<{ id: string }>(`insert into party (tenant_id, workspace_id, name, kind) values (current_tenant_id(), $1, 'Seller', 'seller') returning id`, [ws])).rows[0]!.id;
          group = (await tx.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values (current_tenant_id(), $1, $2, 'Room admins', 'admin') returning id`, [ws, party])).rows[0]!.id;
        }
        const membershipId = (await tx.query<{ id: string }>(
          `insert into membership (tenant_id, person_id, group_id, role, metadata) values (current_tenant_id(), $1, $2, 'admin', $3) returning id`,
          [me, group, JSON.stringify({ joined_as_site_admin: true })])).rows[0]!.id;
        const ctxInfo = { ip: req.ip, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null };
        await appendEvent(tx, { action: 'workspace.site_admin_joined', workspaceId: ws, actorId: caller.actorId, resourceType: 'person', resourceId: me,
          data: { person_id: me, reason: req.body.reason, membership_id: membershipId, group_id: group }, requestId: req.id, context: ctxInfo });
        await siteEvent(tx, req, caller, 'site.room_joined', { workspace_id: ws, reason: req.body.reason });
        const joiner = (await tx.query<{ name: string }>(`select name from person where id = $1`, [me])).rows[0]!.name;
        return { membershipId, admins, joiner, roomName: room.name, now, brand: await mailBranding(tx, app.deps.storage, app.deps.publicUrl) };
      });
      const notified: { personId: string; email: string; subject: string; status: string; providerMessageId?: string; error?: string }[] = [];
      for (const a of joined.admins) {
        const mail = siteAdminJoinedEmail({ brand: joined.brand, room: joined.roomName, joiner: joined.joiner, joinedAt: joined.now, timeZone: a.time_zone,
          reason: req.body.reason, activityUrl: siteUrl(`/rooms/${ws}/activity`),
          notificationsUrl: notificationsUrl(app.deps.publicUrl, ws) });
        const sent = await deliver(toMessage(mail, a.id, a.email));
        const n: (typeof notified)[number] = { personId: a.id, email: a.email, subject: mail.subject, status: sent.status };
        if (sent.providerMessageId) n.providerMessageId = sent.providerMessageId;
        if (sent.error) n.error = sent.error;
        notified.push(n);
      }
      if (notified.length) {
        await app.inTenant(req, async (tx, caller) => {
          for (const n of notified) {
            const m = mailEvent({ type: 'site_admin_joined', personId: n.personId, to: n.email, subject: n.subject, result: n });
            await appendEvent(tx, { action: n.status === 'accepted' ? 'workspace.join_notice_sent' : 'workspace.join_notice_not_sent', workspaceId: ws,
              actorId: caller.actorId, resourceType: 'person', resourceId: personOf(caller), requestId: req.id, data: m.data, context: m.context });
          }
        });
      }
      return { workspaceId: ws, membershipId: joined.membershipId, notified: notified.map((n) => ({ personId: n.personId, status: n.status })) };
    });


    async function personForEmail(tx: SqlClient, email: string, name: string | undefined): Promise<{ id: string; name: string; created: boolean }> {
      const p = (await tx.query<{ id: string; name: string; disabled_at: string | null; erased_at: string | null }>(
        `select id, name, disabled_at, erased_at from person where lower(email) = lower($1)`, [email])).rows[0];
      if (p?.erased_at) throw conflict('This person was erased and cannot be given rights again.');
      if (p?.disabled_at) throw conflict('This account is disabled.');
      if (p) return { id: p.id, name: p.name, created: false };
      const words = email.split('@')[0]!.split(/[._-]+/).filter(Boolean);
      const nm = name?.trim() || words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
      const id = (await tx.query<{ id: string }>(`insert into person (tenant_id, name, email) values (current_tenant_id(), $1, $2) returning id`, [nm, email])).rows[0]!.id;
      await linkPersonToLogin(tx, id);
      return { id, name: nm, created: true };
    }

    async function tellPerson(req: FastifyRequest, personId: string, email: string, mail: Email, action: string) {
      const r1 = await deliver(toMessage(mail, personId, email));
      await app.inTenant(req, (tx, caller) => siteEvent(tx, req, caller, r1.status === 'accepted' ? `${action}_sent` : `${action}_not_sent`, {
        recipient_person_id: personId, channel: 'email', delivery_status: r1.status, ...(r1.error ? { error: r1.error } : {}) }));
      return r1.status;
    }

    const AddPerson = z.object({ email: z.string().trim().toLowerCase().email().max(320), name: visibleText(z.string().trim().min(1).max(200)).optional() });
    const Added = z.object({ personId: z.string().uuid(), name: z.string(), created: z.boolean(), emailStatus: z.string() });

    r.post('/v1/site/room-creators', {
      schema: { summary: 'Allow someone to create rooms', tags: ['site'], body: AddPerson, response: { 200: Added } },
    }, async (req) => {
      const out = await app.inTenant(req, async (tx, caller) => {
        await requireSiteAdmin(tx, caller);
        const p = await personForEmail(tx, req.body.email, req.body.name);
        if ((await tx.query<{ a: boolean }>(`select is_site_admin as a from person where id = $1`, [p.id])).rows[0]?.a) {
          throw conflict(`${p.name} is a site admin. Site admins can always create rooms, so they are not listed here.`, 'already_site_admin');
        }
        await tx.query(`update person set can_create_rooms = true where id = $1`, [p.id]);
        await siteEvent(tx, req, caller, 'site.room_creator.added', { person_id: p.id, created: p.created });
        return { ...p, brand: await mailBranding(tx, app.deps.storage, app.deps.publicUrl) };
      });
      const emailStatus = await tellPerson(req, out.id, req.body.email,
        siteRightEmail({ brand: out.brand, right: 'room_creator', signInUrl: siteUrl('/sign-in') }), 'site.room_creator.notice');
      return { personId: out.id, name: out.name, created: out.created, emailStatus };
    });

    r.delete('/v1/site/room-creators/:personId', {
      schema: { summary: 'Remove the right to create rooms', tags: ['site'], params: z.object({ personId: z.string().uuid() }), response: { 204: z.null() } },
    }, async (req, reply) => {
      await app.inTenant(req, async (tx, caller) => {
        await requireSiteAdmin(tx, caller);
        const p = (await tx.query<{ can: boolean }>(`select can_create_rooms as can from person where id = $1`, [req.params.personId])).rows[0];
        if (!p) throw notFound();
        if (p.can) {
          await tx.query(`update person set can_create_rooms = false where id = $1`, [req.params.personId]);
          await siteEvent(tx, req, caller, 'site.room_creator.removed', { person_id: req.params.personId });
        }
      });
      return reply.code(204).send(null);
    });

    r.post('/v1/site/admins', {
      schema: { summary: 'Add a site admin', tags: ['site'], body: AddPerson, response: { 200: Added } },
    }, async (req) => {
      const out = await app.inTenant(req, async (tx, caller) => {
        await requireSiteAdmin(tx, caller);
        const p = await personForEmail(tx, req.body.email, req.body.name);
        const was = (await tx.query<{ a: boolean }>(`select is_site_admin as a from person where id = $1`, [p.id])).rows[0]!.a;
        if (was) throw conflict('This person is a site admin already.');
        await tx.query(`update person set is_site_admin = true where id = $1`, [p.id]);
        await siteEvent(tx, req, caller, 'site.admin.added', { person_id: p.id, created: p.created });
        return { ...p, brand: await mailBranding(tx, app.deps.storage, app.deps.publicUrl) };
      });
      const emailStatus = await tellPerson(req, out.id, req.body.email,
        siteRightEmail({ brand: out.brand, right: 'site_admin', signInUrl: siteUrl('/sign-in') }), 'site.admin.notice');
      return { personId: out.id, name: out.name, created: out.created, emailStatus };
    });

    const Account = z.object({
      personId: z.string().uuid(), name: z.string(), email: z.string(), isSiteAdmin: z.boolean(), canCreateRooms: z.boolean(),
      rooms: z.number(), roomNames: z.array(z.string()), lastSignInAt: z.string().nullable(), twoFactor: z.enum(['on', 'off', 'not_set_up']),
      disabledAt: z.string().nullable(), isYou: z.boolean(),
    });

    r.get('/v1/site/accounts', {
      schema: {
        summary: 'List accounts, searchable by name or email', tags: ['site'],
        querystring: z.object({
          filter: z.enum(['staff', 'everyone']).default('staff'),
          q: z.string().trim().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.object({ items: z.array(Account), total: z.number(), limit: z.number(), offset: z.number() }) },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const me = await requireSiteAdmin(tx, caller);
      const { filter, q, limit, offset } = req.query;
      const now = app.now().toISOString();
      const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const { rows } = await tx.query<any>(
        `with acc as (
           select p.id, p.name, p.email, p.is_site_admin, p.disabled_at, person_can_create_rooms(p.id) as can_create,
                  lg.user_id,
                  (select max(s.created_at) from auth_session s where s.user_id = lg.user_id) as last_sign_in,
                  (select u.two_factor_enabled from auth_user u where u.id = lg.user_id) as two_factor,
                  array(select distinct w.name from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
                    where m.person_id = p.id and m.status = 'active' and m.valid_from <= $1 and $1 < m.valid_to and m.superseded_at = 'infinity'
                      and w.state <> 'deleted' order by w.name) as room_names
             from person p left join auth_person ap on ap.person_id = p.id and ap.tenant_id = p.tenant_id
             -- the link is empty until the first sign-in, and again after an enable
             left join lateral (select coalesce(ap.user_id, (select u.id from auth_user u where lower(u.email) = lower(p.email) and u.email_verified)) as user_id) lg on true
            where p.erased_at is null
              and ($2::text = 'everyone' or $3::text is not null or p.is_site_admin or p.can_create_rooms)
              and ($3::text is null or p.name ilike $3 or p.email ilike $3))
         select *, count(*) over () as total from acc
          order by case when $2::text = 'staff' then (case when is_site_admin then 0 else 1 end) else 0 end,
                   case when $2::text = 'everyone' then last_sign_in end desc nulls last, name, id
          limit $4 offset $5`,
        [now, filter, like, limit, offset]);
      const items = rows.map((a: any) => {
        let twoFactor: 'on' | 'off' | 'not_set_up' = a.two_factor ? 'on' : 'off';
        if (a.user_id == null || a.two_factor == null) twoFactor = 'not_set_up';
        return {
          personId: a.id, name: a.name, email: a.email, isSiteAdmin: a.is_site_admin, canCreateRooms: a.can_create, rooms: a.room_names.length, roomNames: a.room_names,
          lastSignInAt: a.last_sign_in ? new Date(a.last_sign_in).toISOString() : null,
          twoFactor,
          disabledAt: a.disabled_at ? new Date(a.disabled_at).toISOString() : null, isYou: a.id === me,
        };
      });
      let total = 0;
      if (rows.length) {
        total = Number(rows[0].total);
      } else if (offset > 0) {
        const counted = await tx.query<{ n: string }>(
          `select count(*) n from person p where p.erased_at is null and ($1::text = 'everyone' or $2::text is not null or p.is_site_admin or p.can_create_rooms)
             and ($2::text is null or p.name ilike $2 or p.email ilike $2)`, [filter, like]);
        total = Number(counted.rows[0]!.n);
      }
      return { items, total, limit, offset };
    }));

    r.post('/v1/site/accounts/:personId/disable', {
      schema: {
        summary: 'Disable an account', tags: ['site'],
        params: z.object({ personId: z.string().uuid() }),
        response: { 200: z.object({ personId: z.string().uuid(), disabledAt: z.string(), sessionsEnded: z.number() }) },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const me = await requireSiteAdmin(tx, caller);
      const id = req.params.personId;
      if (id === me) throw conflict('You cannot disable your own account. Ask another site admin.');
      const p = (await tx.query<{ disabled_at: string | null; erased_at: string | null }>(`select disabled_at, erased_at from person where id = $1`, [id])).rows[0];
      if (!p || p.erased_at) throw notFound();
      if (p.disabled_at) throw conflict('This account is disabled already.');
      // before the update: disabling removes the link. A login not linked yet is found by its address
      const logins = (await tx.query<{ id: string }>(
        `select user_id as id from auth_person where person_id = $1 and user_id is not null
         union select u.id from auth_user u join person p on lower(u.email) = lower(p.email) where p.id = $1 and u.email_verified`, [id])).rows.map((r) => r.id);
      const ended = await deleted(tx, `delete from auth_session where user_id = any($1::text[]) returning 1`, [logins]);
      const trustedBrowsersRemoved = await deleted(tx, `delete from auth_trusted_browser where user_id = any($1::text[]) returning 1`, [logins]);
      await tx.query(`delete from auth_verification where value = any($1::text[]) and identifier like 'trust-device-%'`, [logins]);
      // enabling must not bring an old request back to life
      const emailChangesClosed = await deleted(tx,
        `update email_change set status = 'replaced', closed_at = record_clock() where person_id = $1 and status = 'pending' returning 1`, [id]);
      const at = (await tx.query<{ disabled_at: string }>(
        `update person set disabled_at = record_clock(), disabled_by = $2 where id = $1 returning disabled_at`, [id, me])).rows[0]!.disabled_at;
      await siteEvent(tx, req, caller, 'site.account.disabled', { person_id: id, sessions_ended: ended,
        trusted_browsers_removed: trustedBrowsersRemoved, email_changes_closed: emailChangesClosed });
      // the invite stays in the event log; only the live pending invitation is cancelled
      await tx.query(
        `update invitation set status = 'revoked'
           where status = 'pending'
             and membership_id in (select id from membership where person_id = $1)`, [id]);
      const rooms = (await tx.query<{ workspace_id: string }>(
        `select distinct g.workspace_id from membership m join groups g on g.id = m.group_id
          where m.person_id = $1 and m.status = 'active' and m.superseded_at = 'infinity'`, [id])).rows;
      for (const w of rooms) {
        await appendEvent(tx, { action: 'account.disabled', workspaceId: w.workspace_id, actorId: caller.actorId, resourceType: 'person', resourceId: id,
          requestId: req.id, data: { person_id: id, by_person_id: me } });
      }
      return { personId: id, disabledAt: new Date(at).toISOString(), sessionsEnded: ended };
    }));

    r.post('/v1/site/accounts/:personId/enable', {
      schema: {
        summary: 'Enable a disabled account. Room memberships are not restored', tags: ['site'],
        params: z.object({ personId: z.string().uuid() }),
        response: { 200: z.object({ personId: z.string().uuid(), rooms: z.number().int(), roomNames: z.array(z.string()), membershipsRevoked: z.number().int() }) },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const me = await requireSiteAdmin(tx, caller);
      const id = req.params.personId;
      const p = (await tx.query<{ disabled_at: string | null; erased_at: string | null }>(`select disabled_at, erased_at from person where id = $1`, [id])).rows[0];
      if (!p || p.erased_at) throw notFound();
      if (!p.disabled_at) throw conflict('This account is not disabled.');
      const now = app.now();
      await tx.query(`update person set disabled_at = null, disabled_by = null where id = $1`, [id]);
      await linkPersonToLogin(tx, id);
      // memberships stay revoked
      const open = (await tx.query<{ id: string; workspace_id: string; group_id: string; role: string }>(
        `select m.id, g.workspace_id, m.group_id, m.role from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
          where m.person_id = $1 and m.superseded_at = 'infinity' and m.status in ('active', 'approved') and $2 < m.valid_to
            and not coalesce((m.metadata ->> 'revoked')::boolean, false)
            and g.valid_from <= $2 and $2 < g.valid_to and w.state <> 'deleted'
          order by g.workspace_id, m.group_id`, [id, now.toISOString()])).rows;
      const rooms = new Set<string>();
      for (const m of open) {
        const ended = await endMembership(tx, m.id, m.workspace_id, now, now, true, me);
        await tx.query(`update invitation set status = 'revoked' where membership_id = $1 and status = 'pending'`, [ended.id]);
        await appendEvent(tx, { action: 'membership.revoked', workspaceId: m.workspace_id, actorId: caller.actorId, resourceType: 'membership', resourceId: ended.id,
          data: { person_id: id, group_id: m.group_id, role: m.role, because: 'account_enabled', by_person_id: me }, occurredAt: now, requestId: req.id });
        rooms.add(m.workspace_id);
      }
      await siteEvent(tx, req, caller, 'site.account.enabled', { person_id: id, rooms: rooms.size, memberships_revoked: open.length });
      for (const ws of rooms) {
        await appendEvent(tx, { action: 'account.enabled', workspaceId: ws, actorId: caller.actorId, resourceType: 'person', resourceId: id,
          requestId: req.id, occurredAt: now, data: { person_id: id, by_person_id: me } });
      }
      const roomNames = (await tx.query<{ name: string }>(`select name from workspace where id = any($1::uuid[]) order by name`, [[...rooms]])).rows.map((w) => w.name);
      return { personId: id, rooms: rooms.size, roomNames, membershipsRevoked: open.length };
    }));

    // not your own
    r.post('/v1/site/accounts/:personId/reset-two-factor', {
      schema: {
        summary: 'Reset someone’s two-factor sign-in (site admin)',
        tags: ['site'],
        params: z.object({ personId: z.string().uuid() }),
        response: { 200: z.object({ personId: z.string().uuid(), hadTwoFactor: z.boolean(), sessionsEnded: z.number().int(), trustedBrowsersRemoved: z.number().int() }) },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const me = await requireSiteAdmin(tx, caller);
      const id = req.params.personId;
      const p = (await tx.query<{ disabled_at: string | null; erased_at: string | null }>(`select disabled_at, erased_at from person where id = $1`, [id])).rows[0];
      if (!p || p.erased_at) throw notFound();
      if (id === me) throw conflict('You cannot reset your own two-factor sign-in. Use Move to a new phone in your profile, or ask another site admin.');
      if (p.disabled_at) throw conflict('This account is disabled, so it cannot sign in anyway.');
      const done = await resetTwoFactorOf(tx, id);
      await siteEvent(tx, req, caller, 'site.account.two_factor_reset', { person_id: id, had_login: done.userId !== null, had_two_factor: done.hadTwoFactor,
        sessions_ended: done.sessionsEnded, trusted_browsers_removed: done.trustedBrowsersRemoved });
      const now = app.now().toISOString();
      const rooms = (await tx.query<{ id: string }>(
        `select distinct g.workspace_id as id from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
          where m.person_id = $1 and m.status = 'active' and m.superseded_at = 'infinity'
            and m.valid_from <= $2 and $2 < m.valid_to and g.valid_from <= $2 and $2 < g.valid_to and w.state <> 'deleted'`, [id, now])).rows;
      for (const room of rooms) {
        await appendEvent(tx, {
          action: 'auth.two_factor_reset', workspaceId: room.id, actorId: caller.actorId, resourceType: 'person', resourceId: id, requestId: req.id,
          data: { person_id: id, reset_here: false, reset_by_site_admin: true, by_person_id: me, had_login: done.userId !== null,
            had_two_factor: done.hadTwoFactor, sessions_ended: done.sessionsEnded, trusted_browsers_removed: done.trustedBrowsersRemoved },
          context: { ip: req.ip, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null },
        });
      }
      return { personId: id, hadTwoFactor: done.hadTwoFactor, sessionsEnded: done.sessionsEnded, trustedBrowsersRemoved: done.trustedBrowsersRemoved };
    }));

    r.get('/v1/site/me', {
      schema: {
        summary: 'My site rights',
        tags: ['site'],
        response: { 200: z.object({ isSiteAdmin: z.boolean(), canCreateRooms: z.boolean() }) },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      if (caller.principal.kind !== 'person') return { isSiteAdmin: false, canCreateRooms: false };
      const r1 = (await tx.query<{ admin: boolean | null; can: boolean | null }>(
        `select is_site_admin and disabled_at is null and erased_at is null as admin, person_can_create_rooms(id) as can from person where id = $1`,
        [caller.principal.personId])).rows[0];
      return { isSiteAdmin: !!r1?.admin, canCreateRooms: !!r1?.can };
    }));


    const HealthItem = z.object({
      key: z.string(), label: z.string(), status: z.enum(['ok', 'warning', 'failing', 'not_checked']), detail: z.string(),
      failingSince: z.string().nullable(), alertedAt: z.string().nullable(),
    });
    r.get('/v1/site/health', {
      schema: {
        summary: 'Site health checks', tags: ['site'],
        response: {
          200: z.object({
            checkedAt: z.string(), status: z.enum(['ok', 'failing']), problems: z.number(), version: z.string(), items: z.array(HealthItem),
            alerts: z.object({ notifySiteAdmins: z.boolean(), extraEmail: z.string().nullable(), afterMinutes: z.number() }),
            update: z.object({ current: z.string(), latest: z.string().nullable(), available: z.boolean(), checkedAt: z.string().nullable(), note: z.string().nullable() }),
            monitorUrl: z.string(),
          }),
        },
      },
    }, async (req) => {
      const { states, s } = await app.inTenant(req, async (tx, caller) => {
        await requireSiteAdmin(tx, caller);
        return { states: await readStates(tx), s: await settingsRow(tx) };
      });
      const c = ctx();
      const [results, update] = await Promise.all([c.probes.run(),
        c.probes.update ? c.probes.update() : Promise.resolve({ current: VDRKIT_VERSION, latest: null, available: false, checkedAt: null, note: 'Update checks are off.' })]);
      const byKey = new Map(states.map((x) => [x.check_key, x]));
      const items = [];
      for (const key of CHECK_KEYS) {
        const found = results.find((x) => x.key === key);
        if (!found) continue;
        const { error: _technical, ...x } = found;
        const st = x.status === 'failing' ? byKey.get(x.key) : undefined;
        items.push({ ...x,
          failingSince: st?.failing_since ? new Date(st.failing_since).toISOString() : null,
          alertedAt: st?.alerted_at ? new Date(st.alerted_at).toISOString() : null });
      }
      const problems = items.filter((i) => i.status === 'failing' || i.status === 'warning').length;
      const failing = items.some((i) => i.status === 'failing');
      return {
        checkedAt: app.now().toISOString(), status: failing ? 'failing' as const : 'ok' as const, problems,
        version: VDRKIT_VERSION, items,
        alerts: { notifySiteAdmins: s.alert_admins, extraEmail: s.alert_extra_email, afterMinutes: s.alert_after_minutes },
        update,
        monitorUrl: siteUrl('/health'),
      };
    });

    r.get('/v1/site/notice', {
      schema: {
        summary: 'Whether to show the site-health warning', tags: ['site'],
        response: {
          200: z.object({
            show: z.boolean(),
            items: z.array(z.object({ key: z.string(), label: z.string(), failingSince: z.string().nullable() })),
            workerStopped: z.boolean(),
            healthUrl: z.string().nullable(),
          }),
        },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      const none = { show: false, items: [], workerStopped: false, healthUrl: null };
      if (caller.principal.kind !== 'person') return none;
      const ok = (await tx.query<{ ok: boolean }>(
        `select is_site_admin and disabled_at is null and erased_at is null as ok from person where id = $1`, [caller.principal.personId])).rows[0]?.ok;
      if (!ok) return none;
      const h = await healthSummary(tx);
      const items = h.failing.filter((f) => f.alerted).map((f) => ({ key: f.key, label: LABELS[f.key as keyof typeof LABELS] ?? f.key, failingSince: f.failingSince }));
      return { show: items.length > 0 || h.stale, items, workerStopped: h.stale, healthUrl: siteUrl('/site/settings/health') };
    }));

    r.get('/v1/site/events', {
      schema: {
        summary: 'Site log, newest first', tags: ['site'],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), beforeSeq: z.coerce.number().int().positive().optional() }),
        response: {
          200: z.object({
            items: z.array(z.object({ id: z.string().uuid(), seq: z.number(), occurredAt: z.string(), action: z.string(), actorName: z.string().nullable(), data: z.record(z.string(), z.unknown()),
              personal: z.record(z.string(), z.unknown()).nullable() })),
            nextBeforeSeq: z.number().nullable(),
          }),
        },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      await requireSiteAdmin(tx, caller);
      const { limit, beforeSeq } = req.query;
      const { rows } = await tx.query<any>(
        `select e.id, e.seq, e.occurred_at, e.action, e.data, ec.personal,
                case when pe.erased_at is not null then 'Erased user' else pe.name end as actor_name
           from event e
           left join event_context ec on ec.event_id = e.id
           left join person pe on pe.id = case when e.data ->> 'actor_person_id' ~* '^[0-9a-f-]{36}$' then (e.data ->> 'actor_person_id')::uuid end
          where e.workspace_id is null and e.action like 'site.%' and ($1::bigint is null or e.seq < $1)
          order by e.seq desc limit $2`, [beforeSeq ?? null, limit]);
      const items = rows.map((e: any) => ({
        id: e.id, seq: Number(e.seq), occurredAt: new Date(e.occurred_at).toISOString(), action: e.action,
        actorName: e.actor_name, data: e.data, personal: e.personal ?? null,
      }));
      return { items, nextBeforeSeq: items.length === limit ? items[items.length - 1]!.seq : null };
    }));

    r.get('/v1/site/sign-in-failures', {
      schema: {
        summary: 'Failed sign-in attempts, last 30 days. Site admins only', tags: ['site'],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(20), beforeSeq: z.coerce.number().int().positive().optional() }),
        response: {
          200: z.object({
            items: z.array(z.object({
              id: z.string().uuid(), seq: z.number(), occurredAt: z.string(),
              email: z.string().nullable(),
              reason: z.enum(['wrong_code', 'expired_code', 'too_many_attempts', 'link_used_or_expired', 'wrong_authenticator_code', 'authenticator_locked']),
              method: z.enum(['email_link', 'email_code', 'authenticator']),
              ip: z.string().nullable(),
              browser: z.string().nullable(),
            })),
            last24Hours: z.number(),
            nextBeforeSeq: z.number().nullable(),
          }),
        },
      },
    }, async (req) => app.inTenant(req, async (tx, caller) => {
      await requireSiteAdmin(tx, caller);
      const { limit, beforeSeq } = req.query;
      const { rows } = await tx.query<{ id: string; seq: string; occurred_at: string; data: any; ip: string | null; user_agent: string | null; personal: any }>(
        `select e.id, e.seq, e.occurred_at, e.data, host(ec.ip) as ip, ec.user_agent, ec.personal
           from event e left join event_context ec on ec.event_id = e.id
          where e.workspace_id is null and e.action = 'auth.sign_in_failed' and ($1::bigint is null or e.seq < $1)
            and e.occurred_at > $3::timestamptz - make_interval(days => $4)
          order by e.seq desc limit $2`, [beforeSeq ?? null, limit, app.now().toISOString(), FAILED_SIGN_IN_DAYS]);
      const count = (await tx.query<{ n: string }>(
        `select count(*) as n from event where workspace_id is null and action = 'auth.sign_in_failed' and occurred_at > $1::timestamptz - interval '24 hours'`,
        [app.now().toISOString()])).rows[0]!.n;
      const items = rows.map((e) => ({
        id: e.id, seq: Number(e.seq), occurredAt: new Date(e.occurred_at).toISOString(),
        email: typeof e.personal?.email === 'string' ? e.personal.email : null,
        reason: e.data?.reason, method: e.data?.method,
        ip: e.ip ?? null,
        browser: e.user_agent ? browserLabel(e.user_agent) : null,
      }));
      return { items, last24Hours: Number(count), nextBeforeSeq: items.length === limit ? items[items.length - 1]!.seq : null };
    }));
  };
}

export function publicSiteRoutes(db: Database, dbRole: 'vdrkit_app' | undefined): FastifyPluginAsync {
  return async (app0) => {
    const app = app0 as unknown as FastifyInstance;
    const r = app0.withTypeProvider<ZodTypeProvider>();
    const role = dbRole ? { role: dbRole } : {};

    r.get('/health', {
      schema: {
        summary: 'Uptime check: "ok" when every check passes. No sign-in', tags: ['site'],
        response: { 200: z.object({ status: z.literal('ok') }), 503: z.object({ status: z.literal('failing') }) },
      },
    }, async (_req, reply) => {
      const s = await overallHealth(db, dbRole);
      return s === 'ok' ? { status: 'ok' as const } : reply.code(503).send({ status: 'failing' as const });
    });

    async function branding() {
      const tenant = await siteTenantId(db, dbRole);
      if (!tenant) return null;
      type Branding = {
        org_name: string | null; logo_light: StoredLogo | null; logo_dark: StoredLogo | null; privacy_url: string | null; privacy_text: string | null;
      };
      return withTenant(db, tenant, async (tx) => (await tx.query<Branding>(
        `select coalesce(s.org_name, t.name) as org_name, s.logo_light, s.logo_dark, s.privacy_url, s.privacy_text
           from tenant t left join site_settings s on s.tenant_id = t.id
          where t.id = current_tenant_id()`)).rows[0] ?? null, role);
    }

    r.get('/v1/branding', {
      schema: {
        summary: 'Public branding for the sign-in pages: name, logos, privacy notice and source code link', tags: ['site'],
        response: { 200: z.object({ organisationName: z.string().nullable(), logos: z.object({ light: Logo, dark: Logo }),
          privacyNotice: z.discriminatedUnion('kind', [z.object({ kind: z.literal('url'), url: z.string() }), z.object({ kind: z.literal('page') })]).nullable(),
          sourceCode: z.object({ url: z.string(), licence: z.literal('AGPL-3.0-only') }) }) },
      },
    }, async () => {
      const b = await branding();
      const p = b ? privacyOf(b) : { kind: 'none' as const };
      let privacyNotice: { kind: 'url'; url: string } | { kind: 'page' } | null = null;
      if (p.kind === 'url') privacyNotice = { kind: 'url', url: p.url };
      else if (p.kind === 'text') privacyNotice = { kind: 'page' };
      return { organisationName: b?.org_name ?? null, logos: {
        light: logoView(b?.logo_light, '/v1/branding/logos/light'), dark: logoView(b?.logo_dark, '/v1/branding/logos/dark') },
        privacyNotice,
        sourceCode: { url: sourceUrl(), licence: 'AGPL-3.0-only' as const } };
    });

    r.get('/v1/branding/privacy', {
      schema: {
        summary: 'Privacy notice text (plain text)', tags: ['site'],
        response: { 200: z.object({ organisationName: z.string().nullable(), text: z.string() }) },
      },
    }, async () => {
      const b = await branding();
      if (!b?.privacy_text || b.privacy_url) throw notFound();
      return { organisationName: b.org_name, text: b.privacy_text };
    });

    r.get('/v1/branding/logos/:variant', {
      schema: { summary: 'Logo file', tags: ['site'], params: z.object({ variant: z.enum(['light', 'dark']) }), hide: true },
    }, async (req, reply) => {
      const b = await branding();
      const l = req.params.variant === 'light' ? b?.logo_light : b?.logo_dark;
      if (!l || !app.deps.storage) throw notFound();
      const png = await logoBytes(app.deps.storage, l);
      if (!png) throw notFound();
      return reply.header('content-type', 'image/png').header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('cache-control', 'public, max-age=300').send(png);
    });
  };
}

