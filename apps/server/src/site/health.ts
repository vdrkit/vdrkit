// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { appendEvent, withTenant, type Channel, type Database, type SqlClient } from '@vdrkit/core';
import type { Storage } from '../pipeline/pipeline.js';
import { brandingFrom, brandingRow } from '../mail/branding.js';
import { healthAlertEmail, healthRecoveryEmail, toMessage } from '../mail/templates.js';
import { siteTenantId } from './mail.js';

export type CheckStatus = 'ok' | 'warning' | 'failing' | 'not_checked';
export const CHECK_KEYS = ['database', 'storage', 'email', 'conversion', 'virus_scanner', 'backups', 'version'] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

export interface CheckResult {
  key: CheckKey;
  label: string;
  status: CheckStatus;
  detail: string;
  error?: string;
}

export const LABELS: Record<CheckKey, string> = {
  database: 'Database', storage: 'File storage', email: 'Outgoing email', conversion: 'Document conversion',
  virus_scanner: 'Virus scanner', backups: 'Backups', version: 'Version',
};

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: string | null;
  note: string | null;
}

export interface HealthProbes {
  run(): Promise<CheckResult[]>;
  update?(): Promise<UpdateInfo>;
}

export const VDRKIT_VERSION = process.env.VDRKIT_VERSION ?? '0.0.1';

// raw errors can leak paths and hosts
export function plainLastError(detail: string, error: string | undefined): string {
  const code = error ? /\b(E[A-Z]{3,12})\b/.exec(error)?.[1] : undefined;
  return code ? `${detail} Error code: ${code}.` : detail;
}

const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);

async function timed<T>(ms: number, p: Promise<T>): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} seconds`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

function clamPing(host: string, port: number, ms = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port });
    let got = '';
    s.setTimeout(ms, () => {
      s.destroy();
      reject(new Error('ClamAV did not answer'));
    });
    s.on('connect', () => s.write('zPING\0'));
    s.on('data', (d) => {
      got += d.toString();
      if (got.includes('PONG')) {
        s.end();
        resolve();
      }
    });
    s.on('error', reject);
    s.on('close', () => {
      if (!got.includes('PONG')) reject(new Error('ClamAV closed the connection without answering'));
    });
  });
}

export interface ProbeDeps {
  db: Database;
  dbRole?: 'vdrkit_app';
  storage?: Storage;
  mail?: { current?: () => Promise<{ channel: { verify?: () => Promise<void> }; source: string } | null> } | Channel;
  gotenbergUrl?: string;
  clamav?: { host: string; port: number } | null;
  fetch?: typeof fetch;
  version?: string;
  /** off unless set: no phoning home */
  updateUrl?: string | null;
  updateCacheMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

const UPDATE_STEP = 'Whoever installed VDRkit updates it with docker compose pull.';

// semver precedence; build metadata ignored
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    if (m) return { nums: [m[1], m[2], m[3]].map(Number), pre: m[4]?.split('.') ?? [] };
    return { nums: (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim()) ?? [0, 0, 0, 0]).slice(1).map(Number), pre: [] as string[] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i]! !== y.nums[i]!) return x.nums[i]! - y.nums[i]!;
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]!, q = y.pre[i]!;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

export function updateChecker(d: Pick<ProbeDeps, 'fetch' | 'version' | 'updateUrl' | 'updateCacheMs' | 'now'>): () => Promise<UpdateInfo> {
  const current = d.version ?? VDRKIT_VERSION;
  const now = d.now ?? (() => new Date());
  let cache: { until: number; info: UpdateInfo } | null = null;
  return async () => {
    if (!d.updateUrl) return { current, latest: null, available: false, checkedAt: null, note: 'Update checks are off. Set VDRKIT_UPDATE_URL to turn them on.' };
    const t = now();
    if (cache && cache.until > t.getTime()) return cache.info;
    let info: UpdateInfo;
    try {
      const res = await (d.fetch ?? fetch)(d.updateUrl, { signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`The release feed answered ${res.status}`);
      const body = (await res.json()) as { version?: unknown; tag_name?: unknown };
      let raw = '';
      if (typeof body.version === 'string') raw = body.version;
      else if (typeof body.tag_name === 'string') raw = body.tag_name;
      const m = /^v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,40})$/.exec(raw.trim());
      if (!m) throw new Error('The release feed did not name a version');
      info = { current, latest: m[1]!, available: compareVersions(m[1]!, current) > 0, checkedAt: t.toISOString(), note: null };
    } catch (err) {
      info = { current, latest: null, available: false, checkedAt: t.toISOString(), note: `Could not check for a newer version: ${short(err)}` };
    }
    const ttl = info.latest ? d.updateCacheMs ?? 6 * 3600_000 : 3600_000;
    cache = { until: t.getTime() + ttl, info };
    return info;
  };
}

const UNREACHABLE: Record<CheckKey, string> = {
  database: 'The database did not answer.',
  storage: 'Files could not be written or read.',
  email: 'The mail server could not be reached, so invitations and sign-in codes cannot be sent.',
  conversion: 'The document converter (Gotenberg) could not be reached, so Word, Excel and PowerPoint files cannot be converted.',
  virus_scanner: 'ClamAV did not answer, so new uploads cannot be processed: each one fails after a few tries. If ClamAV is not meant to run here, set CLAMAV_HOST= (empty) in the installation file.',
  backups: 'The backups could not be checked.',
  version: 'The version could not be checked.',
};

export function defaultProbes(d: ProbeDeps): HealthProbes {
  const f = d.fetch ?? fetch;
  const update = updateChecker(d);
  const checks: Record<CheckKey, () => Promise<Omit<CheckResult, 'key' | 'label'>>> = {
    database: async () => {
      const v = await d.db.transaction(async (tx) => {
        if (d.dbRole) await tx.query(`set local role ${d.dbRole}`);
        return (await tx.query<{ v: string }>(`select current_setting('server_version') as v`)).rows[0]?.v;
      });
      const postgres = v ? `Postgres ${v}` : 'Postgres';
      return { status: 'ok', detail: `${postgres}. Set in the installation file, because VDRkit needs it before it can start.` };
    },
    storage: async () => {
      if (!d.storage) return { status: 'failing', detail: 'No file storage is configured. Set STORAGE_DRIVER in the installation file.' };
      const key = `health/probe-${randomUUID()}`;
      await d.storage.put(key, Buffer.from('ok'));
      const back = await d.storage.get(key);
      await d.storage.delete?.(key);
      if (back.toString() !== 'ok') return { status: 'failing', detail: 'File storage returned something other than what was written.' };
      return { status: 'ok', detail: 'Files can be written and read. Set in the installation file. Moving storage means moving every file.' };
    },
    email: async () => {
      const m = d.mail as { current?: () => Promise<{ channel: { verify?: () => Promise<void> }; source: string } | null> } | undefined;
      const noServer = { status: 'failing', detail: 'No mail server is configured, so invitations and sign-in codes cannot be sent.' } as const;
      if (!m) return noServer;
      if (!m.current) return { status: 'ok', detail: 'A mail channel is configured.' };
      const c = await m.current();
      if (!c) return noServer;
      if (c.channel.verify) await c.channel.verify();
      return { status: 'ok', detail: `The mail server accepts connections. Settings from ${c.source === 'database' ? 'Site settings' : 'the installation file'}.` };
    },
    conversion: async () => {
      if (!d.gotenbergUrl) return { status: 'failing', detail: 'No document converter is configured. Set GOTENBERG_URL.' };
      const res = await f(`${d.gotenbergUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { status: 'failing', detail: `Gotenberg answered ${res.status}. Word, Excel and PowerPoint files cannot be converted.` };
      return { status: 'ok', detail: 'Gotenberg converts Word, Excel and PowerPoint to PDF.' };
    },
    virus_scanner: async () => {
      if (!d.clamav) return { status: 'warning', detail: 'ClamAV is not installed, so uploads are not scanned for viruses. Recommended for any room with outside contributors.' };
      await clamPing(d.clamav.host, d.clamav.port);
      return { status: 'ok', detail: 'ClamAV answers.' };
    },
    backups: async () => ({ status: 'not_checked', detail: 'Backups are made outside VDRkit and are not checked yet.' }),
    version: async () => {
      const u = await update();
      if (u.available) return { status: 'ok', detail: `VDRkit ${u.current}. Version ${u.latest} is available. ${UPDATE_STEP}` };
      if (u.latest) return { status: 'ok', detail: `VDRkit ${u.current}, the latest version.` };
      return { status: 'ok', detail: `VDRkit ${u.current}. ${u.note}` };
    },
  };
  return {
    update,
    async run() {
      return Promise.all(CHECK_KEYS.map(async (key) => {
        try {
          return { key, label: LABELS[key], ...(await timed(10_000, checks[key]())) };
        } catch (err) {
          d.log?.(`Health check ${key} failed: ${short(err)}`);
          return { key, label: LABELS[key], status: 'failing' as const, detail: UNREACHABLE[key], error: short(err) };
        }
      }));
    },
  };
}

export function probesFromEnv(d: Omit<ProbeDeps, 'gotenbergUrl' | 'clamav'>, env: Record<string, string | undefined> = process.env): HealthProbes {
  const clamHost = env.CLAMAV_HOST?.trim();
  return defaultProbes({
    log: (msg) => console.warn(`[health] ${msg}`),
    ...d,
    gotenbergUrl: env.GOTENBERG_URL ?? 'http://gotenberg:3000',
    clamav: clamHost ? { host: clamHost, port: Number(env.CLAMAV_PORT ?? 3310) } : null,
    updateUrl: env.VDRKIT_UPDATE_URL?.trim() || null,
  });
}

export interface StateRow {
  check_key: string; status: CheckStatus; detail: string | null; failing_since: string | Date | null; alerted_at: string | Date | null; last_checked_at: string | Date;
}

export async function readStates(tx: SqlClient): Promise<StateRow[]> {
  return (await tx.query<StateRow>(`select check_key, status, detail, failing_since, alerted_at, last_checked_at from site_health_state order by check_key`)).rows;
}

export interface AlertOptions {
  db: Database;
  dbRole?: 'vdrkit_app';
  probes: HealthProbes;
  mailer?: Channel;
  publicUrl?: string;
  storage?: Storage;
}

export interface AlertRun {
  tenantId: string | null;
  results: CheckResult[];
  alerted: CheckKey[];
  recovered: CheckKey[];
}

interface Recipient { personId: string; email: string; timeZone: string }

const EXTRA_ADDRESS = 'alert-extra-address';

export async function siteTimeZone(tx: SqlClient): Promise<string> {
  const r = (await tx.query<{ tz: string | null }>(
    `select coalesce(
       (select time_zone from person where is_site_admin and disabled_at is null and erased_at is null
         group by time_zone order by count(*) desc, time_zone limit 1),
       (select time_zone from workspace group by time_zone order by count(*) desc, time_zone limit 1)) as tz`)).rows[0];
  return r?.tz || 'UTC';
}

export async function runHealthAlerts(o: AlertOptions): Promise<AlertRun> {
  const tenantId = await siteTenantId(o.db, o.dbRole);
  const results = await o.probes.run();
  if (!tenantId) return { tenantId, results, alerted: [], recovered: [] };
  const role = o.dbRole ? { role: o.dbRole } : {};

  const plan = await withTenant(o.db, tenantId, async (tx) => {
    const s = (await tx.query<{ alert_admins: boolean; alert_extra_email: string | null; alert_after_minutes: number; org_name: string | null }>(
      `select alert_admins, alert_extra_email, alert_after_minutes, org_name from site_settings`)).rows[0]
      ?? { alert_admins: true, alert_extra_email: null, alert_after_minutes: 15, org_name: null };
    // one run at a time across workers
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('vdrkit.site_health', 0))`);
    // db clock only
    const now = new Date((await tx.query<{ now: string | Date }>(`select record_clock() as now`)).rows[0]!.now);
    const states = new Map((await readStates(tx)).map((r) => [r.check_key, r]));
    const alerted: (CheckResult & { since: Date })[] = [];
    const recovered: (CheckResult & { since: Date | null })[] = [];
    for (const r of results) {
      const prev = states.get(r.key);
      let failingSince = prev?.failing_since ? new Date(prev.failing_since) : null;
      let alertedAt = prev?.alerted_at ? new Date(prev.alerted_at) : null;
      if (r.status === 'failing') {
        failingSince ??= now;
        if (!alertedAt && now.getTime() - failingSince.getTime() >= s.alert_after_minutes * 60_000) {
          alertedAt = now;
          alerted.push({ ...r, since: failingSince });
        }
      } else {
        if (alertedAt) recovered.push({ ...r, since: failingSince });
        failingSince = null;
        alertedAt = null;
      }
      await tx.query(
        `insert into site_health_state (tenant_id, check_key, status, detail, failing_since, alerted_at, last_checked_at)
         values (current_tenant_id(), $1, $2, $3, $4, $5, $6)
         on conflict (tenant_id, check_key) do update set status = excluded.status, detail = excluded.detail,
           failing_since = excluded.failing_since, alerted_at = excluded.alerted_at, last_checked_at = excluded.last_checked_at`,
        [r.key, r.status, r.detail, failingSince?.toISOString() ?? null, alertedAt?.toISOString() ?? null, now.toISOString()]);
    }
    let recipients: Recipient[] = [];
    if (alerted.length || recovered.length) {
      if (s.alert_admins) {
        recipients = (await tx.query<Recipient>(
          `select id as "personId", email, time_zone as "timeZone" from person where is_site_admin and disabled_at is null and erased_at is null order by name`)).rows;
      }
      const extra = s.alert_extra_email?.trim();
      if (extra && !recipients.some((x) => x.email.toLowerCase() === extra.toLowerCase())) {
        recipients.push({ personId: EXTRA_ADDRESS, email: extra, timeZone: await siteTimeZone(tx) });
      }
    }
    const brandRow = recipients.length ? await brandingRow(tx) : null;
    return { alerted, recovered, recipients, brandRow, now };
  }, role);
  const brand = plan.recipients.length ? await brandingFrom(plan.brandRow, o.storage, o.publicUrl ?? '') : null;

  type Send = { kind: 'alert' | 'recovery'; checks: CheckKey[]; to: Recipient; status: string; error?: string };
  const sends: Send[] = [];
  const healthUrl = `${(o.publicUrl ?? '').replace(/\/$/, '')}/site/settings/health`;
  for (const [kind, list] of [['alert', plan.alerted], ['recovery', plan.recovered]] as const) {
    for (const c of list) {
      for (const to of plan.recipients) {
        const siteAdmin = to.personId !== EXTRA_ADDRESS;
        const words = { brand: brand!, check: c.key, label: c.label, now: plan.now, timeZone: to.timeZone, healthUrl, siteAdmin };
        let mail: ReturnType<typeof healthAlertEmail> | null = null;
        let buildError: string | null = null;
        try {
          if (kind === 'alert') mail = healthAlertEmail({ ...words, since: c.since!, lastError: plainLastError(c.detail, c.error) });
          else mail = healthRecoveryEmail({ ...words, since: c.since });
        } catch (e) {
          buildError = `The email could not be built: ${short(e)}`;
        }
        let r: { status: string; error?: string };
        if (!mail) r = { status: 'failed', error: buildError ?? 'The email could not be built' };
        else if (!o.mailer) r = { status: 'failed', error: 'No mail server is configured' };
        else {
          r = await o.mailer.send(toMessage(mail, to.personId, to.email))
            .catch((e: unknown) => ({ status: 'failed' as const, error: short(e) }));
        }
        const sent: Send = { kind, checks: [c.key], to, status: r.status };
        if (r.error) sent.error = r.error;
        sends.push(sent);
      }
      if (plan.recipients.length === 0) {
        sends.push({ kind, checks: [c.key], to: { personId: '', email: '', timeZone: 'UTC' }, status: 'no_recipient',
          error: 'Alerts are switched off and no other address is set' });
      }
    }
  }
  if (sends.length) {
    await withTenant(o.db, tenantId, async (tx) => {
      for (const x of sends) {
        const ok = x.status === 'accepted';
        await appendEvent(tx, {
          action: `site.health.${x.kind}_${ok ? 'sent' : 'not_sent'}`, resourceType: 'site', resourceId: tenantId,
          data: { checks: x.checks, ...(x.to.personId && x.to.personId !== 'alert-extra-address' ? { recipient_person_id: x.to.personId } : {}),
            ...(x.to.personId === 'alert-extra-address' ? { recipient: 'extra_address' } : {}), delivery_status: x.status, ...(ok ? {} : { error: x.error ?? null }) },
        });
      }
    }, role);
  }
  return { tenantId, results, alerted: plan.alerted.map((c) => c.key), recovered: plan.recovered.map((c) => c.key) };
}

export const STALE_MINUTES = 10;

// stale state = failing (worker stopped)
export async function overallHealth(db: Database, dbRole: 'vdrkit_app' | undefined): Promise<'ok' | 'failing'> {
  try {
    const tenant = await siteTenantId(db, dbRole);
    if (!tenant) return 'ok';
    const s = await withTenant(db, tenant, (tx) => healthSummary(tx), dbRole ? { role: dbRole } : {});
    return s.stale || s.failing.length ? 'failing' : 'ok';
  } catch {
    return 'failing';
  }
}

export interface HealthSummary {
  stale: boolean;
  lastCheckedAt: string | null;
  failing: { key: string; failingSince: string | null; alerted: boolean }[];
}

export async function healthSummary(tx: SqlClient): Promise<HealthSummary> {
  const rows = (await tx.query<{ check_key: string; status: CheckStatus; failing_since: string | Date | null; alerted_at: string | Date | null;
    last_checked_at: string | Date; stale: boolean }>(
    `select check_key, status, failing_since, alerted_at, last_checked_at,
            record_clock() - last_checked_at > make_interval(mins => $1) as stale
       from site_health_state order by check_key`, [STALE_MINUTES])).rows;
  const iso = (d: string | Date | null) => (d ? new Date(d).toISOString() : null);
  let last: Date | null = null;
  for (const r of rows) {
    const checked = new Date(r.last_checked_at);
    if (!last || checked > last) last = checked;
  }
  let neverChecked = false;
  if (rows.length === 0) {
    const tenant = (await tx.query<{ stale: boolean }>(
      `select record_clock() - created_at > make_interval(mins => $1) as stale from tenant where id = current_tenant_id()`, [STALE_MINUTES])).rows[0];
    neverChecked = !!tenant?.stale;
  }
  return {
    stale: neverChecked || rows.some((r) => r.stale),
    lastCheckedAt: last ? last.toISOString() : null,
    failing: rows.filter((r) => r.status === 'failing').map((r) => ({ key: r.check_key, failingSince: iso(r.failing_since), alerted: !!r.alerted_at })),
  };
}
