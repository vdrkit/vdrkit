// SPDX-License-Identifier: AGPL-3.0-only
// liveness only; site health is /health
import { readFileSync, statSync } from 'node:fs';

const role = (() => { try { return readFileSync('/tmp/vdrkit-role', 'utf8').trim(); } catch { return 'unknown'; } })();

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
  return res.status;
}

try {
  if (role === 'web') {
    const status = await get(process.env.PORT ?? '3000', '/_next/static/vdrkit-alive');
    if (status >= 500) throw new Error(`web answered ${status}`);
  } else if (role === 'api') {
    const status = await get(process.env.PORT ?? '3001', '/v1/health');
    if (status !== 200) throw new Error(`api answered ${status}`);
  } else if (role === 'worker') {
    const age = Date.now() - statSync(process.env.VDRKIT_HEARTBEAT_FILE ?? '/tmp/vdrkit-heartbeat').mtimeMs;
    if (age > 90_000) throw new Error(`worker heartbeat is ${Math.round(age / 1000)} seconds old`);
  } else if (role !== 'migrate' && !role.startsWith('sandbox-')) {
    throw new Error(`unknown role "${role}"`);
  }
  process.exit(0);
} catch (err) {
  console.error(`unhealthy: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
