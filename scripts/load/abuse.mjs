#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Rate-limit abuse checks (flood, code guessing, no session) against the running API.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { API, WORK } from './config.mjs';

const TOOLS = `${WORK}/tools`;
if (!existsSync(`${TOOLS}/node_modules/autocannon`)) {
  mkdirSync(TOOLS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd install --prefix "' + TOOLS + '" --no-save --no-audit --no-fund autocannon@7.15.0' : `npm install --prefix '${TOOLS}' --no-save --no-audit --no-fund autocannon@7.15.0`, { stdio: 'inherit', shell: true });
}
const autocannon = createRequire(`${TOOLS}/package.json`)('autocannon');
const S = JSON.parse(readFileSync(`${WORK}/sessions.json`, 'utf8'));
const ws = S.heron;
const by = (k) => S.people.find((p) => p.key === k);

const flood = ({ path, ...opts }) => new Promise((ok, fail) => autocannon({ url: `${API}${path}`, connections: 20, duration: 20, ...opts }, (e, r) => (e ? fail(e) : ok(r))));
const summary = (r) => ({ requests: r.requests.total, rps: Math.round(r.requests.average), p50: r.latency.p50, p97_5: r.latency.p97_5, statuses: r.statusCodeStats ?? {}, non2xx: r.non2xx });

async function reader(cookie, path, seconds, headers = {}) {
  const seen = {};
  const until = Date.now() + seconds * 1000;
  let c = cookie;
  while (Date.now() < until) {
    const r = await fetch(`${API}${path}`, { headers: { ...(c ? { cookie: `vdrkit.session_token=${c}` } : {}), ...headers } });
    const m = /vdrkit\.session_token=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
    if (m) c = m[1];
    seen[r.status] = (seen[r.status] ?? 0) + 1;
    await r.arrayBuffer();
    await new Promise((x) => setTimeout(x, 1000));
  }
  return seen;
}

async function main() {
  const out = {};
  const abuser = by('bb2');
  const other = by('bb3');
  console.log('1. One bidder floods the folder listing; another reads normally.');
  const [f1, r1] = await Promise.all([
    flood({ path: `/v1/workspaces/${ws}/nodes`, headers: { cookie: `vdrkit.session_token=${abuser.cookie}` } }),
    reader(other.cookie, `/v1/workspaces/${ws}/nodes`, 20),
  ]);
  out.listingFlood = { flood: summary(f1), otherBidder: r1 };
  console.log(JSON.stringify(out.listingFlood));

  console.log('2. One address guesses email codes; another address signs in.');
  const guess = JSON.stringify({ email: 'load-bb4@bidder-b.example.com', otp: '000000' });
  const [f2, r2] = await Promise.all([
    flood({ path: '/v1/auth/sign-in/email-otp', method: 'POST', body: guess, connections: 5, duration: 15,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.17', origin: API } }),
    (async () => {
      const seen = {};
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${API}/v1/auth/sign-in/email-otp`, { method: 'POST', body: JSON.stringify({ email: 'load-bb5@bidder-b.example.com', otp: '123456' }),
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.21', origin: API } });
        seen[r.status] = (seen[r.status] ?? 0) + 1;
        await r.arrayBuffer();
        await new Promise((x) => setTimeout(x, 2000));
      }
      return seen;
    })(),
  ]);
  out.codeGuessing = { flood: summary(f2), otherAddress: r2 };
  console.log(JSON.stringify(out.codeGuessing));

  console.log('3. Calls without a session from one address.');
  const [f3, r3] = await Promise.all([
    flood({ path: '/v1/me', connections: 10, duration: 15, headers: { 'x-forwarded-for': '203.0.113.18' } }),
    reader(other.cookie, '/v1/me', 15),
  ]);
  out.anonymousFlood = { flood: summary(f3), signedInReader: r3 };
  console.log(JSON.stringify(out.anonymousFlood));
  writeFileSync(`${WORK}/abuse.json`, JSON.stringify(out, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
