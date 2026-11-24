// SPDX-License-Identifier: AGPL-3.0-only
// usage: start.mjs web|api|worker|migrate|sandbox-*  (sandbox roles need VDRKIT_SANDBOX=1)
import { writeFileSync } from 'node:fs';

const role = process.argv[2] ?? 'api';
const roles = ['web', 'api', 'worker', 'migrate', 'sandbox-init', 'sandbox-reset', 'sandbox-scheduler'];
if (!roles.includes(role)) {
  console.error(`Unknown role "${role}". Use one of: ${roles.join(', ')}.`);
  process.exit(64);
}
try { writeFileSync('/tmp/vdrkit-role', role); } catch { /* read-only /tmp: the health check then reports unknown */ }

if (role === 'web') {
  process.env.PORT ??= '3000';
  process.env.HOSTNAME = process.env.WEB_BIND ?? '0.0.0.0';
  await import('/app/web/apps/dataroom/server.js');
} else {
  if (role === 'worker') process.env.VDRKIT_HEARTBEAT_FILE ??= '/tmp/vdrkit-heartbeat';
  await import('/app/server/dist/main.js');
}
