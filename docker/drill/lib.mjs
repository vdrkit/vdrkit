// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertThrowaway, composeEnv, isThrowaway } from '../throwaway.mjs';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(repo, 'apps', 'dataroom', 'package.json'));
export const { chromium, request: pwRequest } = require('@playwright/test');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export async function until(what, fn, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

export function pdf(title = 'VDRkit smoke test', pages = 2) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + 2 * pages;
  const pageIds = [];
  for (let n = 1; n <= pages; n++) {
    const text = `BT /F1 24 Tf 72 720 Td (${title}, page ${n}) Tj ET`;
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  const pagesObj = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  if (pagesObj !== pagesId) throw new Error('PDF object numbering');
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let out = '%PDF-1.7\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const rtf = (text = 'VDRkit smoke test: this file was converted to PDF by Gotenberg.') =>
  Buffer.from(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs28 ${text}\\par}\n`, 'latin1');

/** RFC 6238, SHA-1, 30 s, 6 digits */
export function totp(secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const hex = () => randomBytes(24).toString('hex');

// keys must survive a restore; db passwords needn't
export function newSecrets() {
  return {
    POSTGRES_PASSWORD: hex(),
    VDRKIT_OWNER_PASSWORD: hex(),
    VDRKIT_APP_PASSWORD: hex(),
    VDRKIT_QUEUE_PASSWORD: hex(),
    VDRKIT_BACKUP_PASSWORD: hex(),
    VDRKIT_MASTER_KEY: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
  };
}

// backups are root-only: on Linux only a container can read or delete them
export function stack({ project, dir, httpPort, httpsPort, mailPort, overlays = [], backupDir = './backups', run = spawnSync, start = spawn }) {
  const base = `https://localhost:${httpsPort}`;
  const envKeys = new Set();
  const files = () => [join(repo, 'docker-compose.yml'), join(repo, 'docker', 'smoke', 'compose.smoke.yml'), ...overlays];
  const args = (more) => {
    assertThrowaway(project, dir);
    return ['compose', '-p', project, '--project-directory', dir, ...files().flatMap((f) => ['-f', f]), ...more];
  };
  // or the shell's VDRKIT_TAG wins over .env
  const childEnv = () => composeEnv(process.env, { drop: envKeys, extra: { SMOKE_MAIL_PORT: mailPort } });
  const s = {
    project, dir, base, overlays,
    mailApi: `http://127.0.0.1:${mailPort}/api/v1`,
    compose(more, opts = {}) {
      const all = args(more);
      const r = run('docker', all, { encoding: 'utf8', env: childEnv(), maxBuffer: 64 * 1024 * 1024, ...opts });
      if (r.status !== 0 && !opts.allowFail) throw new Error(`docker ${all.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
      return opts.both ? `${r.stdout ?? ''}${r.stderr ?? ''}` : r.stdout ?? '';
    },
    composeAsync(more) {
      const all = args(more);
      return new Promise((done, fail) => {
        const child = start('docker', all, { env: childEnv() });
        let output = '';
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        child.on('error', fail);
        child.on('close', (status) => done({ status, output }));
      });
    },
    prepare({ image, tag, secrets, profiles = 'postgres', extra = [] }) {
      assertThrowaway(project, dir);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, 'docker'), { recursive: true });
      cpSync(join(repo, 'Caddyfile'), join(dir, 'Caddyfile'));
      for (const sub of ['postgres-init', 'backup']) cpSync(join(repo, 'docker', sub), join(dir, 'docker', sub), { recursive: true });
      const ssl = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
      ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=VDRkit drill CA');
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'mailpit-key.pem', '-out', 'mailpit.csr', '-subj', '/CN=mailpit');
      writeFileSync(join(dir, 'san.ext'), 'subjectAltName=DNS:mailpit\nextendedKeyUsage=serverAuth\n');
      ssl('x509', '-req', '-in', 'mailpit.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial', '-out', 'mailpit.pem', '-days', '2', '-extfile', 'san.ext');
      s.writeEnv({ image, tag, secrets, profiles, extra });
    },
    writeEnv({ image, tag, secrets, profiles = 'postgres', extra = [] }) {
      assertThrowaway(project, dir);
      const lines = [
        '# Generated by a VDRkit drill: throwaway values for one run.',
        `VDRKIT_IMAGE=${image}`, `VDRKIT_TAG=${tag}`,
        `COMPOSE_PROFILES=${profiles}`, 'CLAMAV_HOST=',
        'SITE_ADDRESS=localhost', `PUBLIC_URL=${base}`,
        'BIND_ADDRESS=127.0.0.1', `HTTP_PORT=${httpPort}`, `HTTPS_PORT=${httpsPort}`,
        'STORAGE_DRIVER=local', `BACKUP_DIR=${backupDir}`,
        ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`),
        'SMTP_HOST=', 'SMTP_URL=', 'SMTP_USER=', 'SMTP_PASSWORD=', 'MAIL_FROM=',
        ...extra, '',
      ];
      for (const line of lines) {
        const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
        if (key) envKeys.add(key);
      }
      writeFileSync(join(dir, '.env'), lines.join('\n'));
    },
    destroy({ keepBackups = false } = {}) {
      if (!isThrowaway(project, dir) || !isThrowaway(project, resolve(dir, backupDir))) return;
      if (!keepBackups && existsSync(resolve(dir, backupDir))) {
        s.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'backup', '-c',
          'rm -rf /backups/vdrkit-* /backups/.partial-* /backups/LATEST /backups/LAST_SUCCESS'], { allowFail: true });
      }
      s.compose(['down', '-v', '--remove-orphans'], { allowFail: true });
      for (const f of ['.env', 'ca-key.pem', 'mailpit-key.pem']) rmSync(join(dir, f), { force: true });
    },
    /** superuser SQL via the socket; rows as `|`-separated fields */
    sql(query) {
      const out = s.compose(['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-U', 'postgres', '-d', 'vdrkit', '-c', query]);
      return out.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split('|'));
    },
    containerStates() {
      const lines = s.compose(['ps', '-a', '--format', 'json']).trim().split('\n').filter(Boolean);
      const states = {};
      for (const c of JSON.parse(`[${lines.join(',')}]`)) {
        let state = c.State;
        if (c.Health) state += ` (${c.Health})`;
        if (c.State === 'exited') state += ` exit ${c.ExitCode}`;
        states[c.Service] = state;
      }
      return states;
    },
  };
  return s;
}

export async function waitForStack(s, api, { setupOpen }) {
  await until('the API through Caddy', async () => (await api.get('/v1/health')).status() === 200, 300_000);
  const landing = setupOpen ? '/setup' : '/sign-in';
  await until('the web front end through Caddy', async () => {
    const r = await api.get('/sign-in');
    return r.status() === 200 && new URL(r.url()).pathname === landing && (await r.text()).includes('<html');
  }, 120_000);
}

export function apiContext(s) {
  return pwRequest.newContext({ baseURL: s.base, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: s.base } });
}

export async function openBrowser(s) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: s.base, viewport: { width: 1280, height: 900 } });
  return { browser, page: await context.newPage() };
}

export function printLogs(s, tail) {
  try {
    console.error(s.compose(['logs', '--no-color', '--tail', String(tail)], { allowFail: true }));
  } catch {}
}

export async function mail(s, to, subject, since) {
  return until(`an email "${subject}" to ${to}`, async () => {
    const res = await fetch(`${s.mailApi}/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages = [] } = await res.json();
    const m = messages.find((x) => subject.test(x.Subject) && new Date(x.Created).getTime() >= since);
    if (!m) return null;
    return (await fetch(`${s.mailApi}/message/${m.ID}`)).json();
  }, 90_000, 500);
}

export async function firstRunSetup(s, api, admin) {
  const code = await until('the setup code in the API log', async () => {
    const apiLog = s.compose(['logs', '--no-color', 'api']);
    return /Setup code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(apiLog)?.[1];
  }, 90_000);
  const unlock = await api.post('/v1/setup/unlock', { data: { code } });
  if (!unlock.ok()) throw new Error(`unlock: ${unlock.status()} ${await unlock.text()}`);
  const { token, header } = await unlock.json();
  const call = async (method, path, data) => {
    const opts = { method, headers: { [header]: token } };
    if (data !== undefined) opts.data = data;
    const r = await api.fetch(path, opts);
    if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };
  await until('the setup checks (database, storage, conversion)', async () => {
    const { items } = await call('GET', '/v1/setup/checks');
    const by = Object.fromEntries(items.map((i) => [i.key, i.status]));
    return by.database === 'ok' && by.storage === 'ok' && by.conversion === 'ok';
  }, 180_000, 3000);
  await call('PUT', '/v1/setup/admin', admin);
  await call('PUT', '/v1/setup/organisation', { name: admin.company });
  await call('PUT', '/v1/setup/mail', { host: 'mailpit', port: 1025, security: 'starttls', user: null, fromAddress: 'dataroom@drill.example' });
  const sentAt = Date.now() - 2000;
  const test = await call('POST', '/v1/setup/test-email', { timeZone: 'Africa/Johannesburg' });
  if (test.status !== 'accepted') throw new Error(`Test email not accepted: ${JSON.stringify(test)}`);
  await mail(s, admin.email, /./, sentAt);
  return call('POST', '/v1/setup/finish');
}

async function typeCode(page, code) {
  await page.locator('.card .code input').first().click();
  await page.keyboard.type(code);
}

export async function signIn(s, page, email, secret) {
  await page.goto('/sign-in');
  await page.locator('#f-email').fill(email);
  const since = Date.now() - 2000;
  const asked = Date.now();
  const answer = page.waitForResponse((r) => r.url().includes('/v1/auth/sign-in/magic-link'), { timeout: 60_000 })
    .then((r) => `${r.status()} after ${Date.now() - asked} ms`, () => 'no answer within 60 s');
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  try {
    await page.getByRole('heading', { name: 'Check your email' }).waitFor({ timeout: 60_000 });
  } catch {
    const shown = await page.locator('.hint.err').textContent({ timeout: 1000 }).catch(() => null);
    throw new Error(`No "Check your email" page. Sign-in email request: ${await answer}. Page: ${page.url()}${shown ? `, showing "${shown}"` : ''}`);
  }
  const took = Date.now() - asked;
  if (took > 5000) console.log(`[drill] the sign-in email request took ${took} ms (${await answer})`);
  const m = await mail(s, email, /\d{3} ?\d{3}/, since);
  await typeCode(page, /(\d{3}) ?(\d{3})/.exec(m.Subject).slice(1).join(''));
  await page.getByRole('button', { name: 'Continue' }).click();
  const setUp = page.getByRole('heading', { name: 'Set up two-factor sign-in' });
  const enter = page.getByRole('heading', { name: 'Enter the code from your authenticator app' });
  const next = await until('the two-factor step or the signed-in page', async () => {
    if (await setUp.isVisible().catch(() => false)) return 'set-up';
    if (await enter.isVisible().catch(() => false)) return 'enter';
    if (!new URL(page.url()).pathname.startsWith('/sign-in')) return 'in';
    return null;
  }, 30_000, 250);
  let used = secret;
  if (next === 'set-up') {
    used = (await page.getByTestId('manual-key').textContent()).replace(/\s/g, '');
    await typeCode(page, totp(used));
    await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
  } else if (next === 'enter') {
    if (!secret) throw new Error('Asked for an authenticator code, but no secret is known');
    await typeCode(page, totp(secret));
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 30_000 });
  const me = await page.request.get('/v1/me/workspaces');
  if (!me.ok()) throw new Error(`Signed in, but /v1/me/workspaces answered ${me.status()}`);
  return { secret: used, twoFactor: next };
}

export async function post(page, base, path, data) {
  const r = await page.request.post(path, { data, headers: { origin: base } });
  if (!r.ok()) throw new Error(`POST ${path}: ${r.status()} ${await r.text()}`);
  return r.json();
}

export async function upload(page, base, roomId, folderId, name, bytes, mime) {
  const sess = await post(page, base, `/v1/workspaces/${roomId}/upload-sessions`, { targetFolderId: folderId, path: name, size: bytes.length, sha256: sha256(bytes), mime });
  const put = await page.request.put(sess.uploadUrl, { data: bytes, headers: { origin: base, 'content-type': 'application/octet-stream' } });
  if (put.status() !== 204) throw new Error(`PUT ${sess.uploadUrl}: ${put.status()} ${await put.text()}`);
  const done = await post(page, base, `/v1/workspaces/${roomId}/upload-sessions/${sess.id}/complete`, {});
  await viewPage1(page, roomId, done.nodeId, name);
  return done.nodeId;
}

export async function viewPage1(page, roomId, nodeId, name) {
  const t = Date.now();
  await until(`page 1 of ${name} in the viewer`, async () => {
    await page.goto(`/rooms/${roomId}/view/${nodeId}`);
    const img = page.locator('#p1 img');
    await img.waitFor({ state: 'visible', timeout: 5000 });
    return img.evaluate((el) => el.complete && el.naturalWidth > 0);
  }, 180_000, 2000);
  return Date.now() - t;
}

export async function downloadOriginal(page, roomId, nodeId) {
  const r = await page.request.get(`/v1/workspaces/${roomId}/nodes/${nodeId}/download?format=original`);
  if (!r.ok()) throw new Error(`download ${nodeId}: ${r.status()} ${await r.text()}`);
  return sha256(await r.body());
}

export async function verifyRoomChain(page, roomId) {
  const r = await page.request.get(`/v1/workspaces/${roomId}/events/verify`);
  if (!r.ok()) throw new Error(`verify: ${r.status()} ${await r.text()}`);
  return r.json();
}

export function snapshot(s) {
  const counts = Object.fromEntries(s.sql(`
    select n.nspname || '.' || c.relname,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname in ('public', 'pgboss') and not c.relispartition
     order by 1`));
  const chains = s.sql(`select ch.chain_key, ch.length, v.checked, coalesce(v.first_broken::text, '')
                          from event_chain ch, lateral verify_chain(ch.chain_key) v order by ch.chain_key`)
    .map(([key, length, checked, broken]) => ({ key, length: Number(length), checked: Number(checked), intact: broken === '' }));
  const migrations = s.sql('select name from schema_migrations order by name').map(([n]) => n);
  const find = `find . -type f ! -path './quarantine/*' ! -path './health/*' ! -name '*.tmp'`;
  const [count, digest] = s.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'backup', '-c',
    `cd /data/storage && ${find} | wc -l && ${find} -exec sha256sum {} + | LC_ALL=C sort -k2 | sha256sum | cut -c1-64`])
    .trim().split(/\r?\n/).slice(-2);
  return { counts, chains, migrations, files: { count: Number(count), digest } };
}

export function countDiff(a, b, ignore = /^pgboss\./) {
  const changed = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ignore.test(k) || a[k] === b[k]) continue;
    changed.push(`${k}: ${a[k] ?? 'missing'} -> ${b[k] ?? 'missing'}`);
  }
  return changed;
}

export function logger(tag) {
  const results = { steps: [] };
  return {
    results,
    log: (msg) => console.log(`[${tag}] ${msg}`),
    step(name, extra = {}) {
      results.steps.push({ name, ...extra });
      const detail = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
      console.log(`[${tag}] ok  ${name}${detail}`);
    },
  };
}
