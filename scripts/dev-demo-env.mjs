// SPDX-License-Identifier: AGPL-3.0-only
// dev only: VDRKIT_DEMO_EMAIL_DOMAINS from .env unless set in env. Read only when demo data is created (fresh db or --reset)
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const DEMO_KEYS = ['VDRKIT_DEMO_EMAIL_DOMAINS'];

export function devStackDemoEnv(env, dotenvPath) {
  if (DEMO_KEYS.some((k) => k in env)) return {};
  if (!dotenvPath || !existsSync(dotenvPath)) return {};
  const parsed = parseEnv(readFileSync(dotenvPath, 'utf8'));
  return Object.fromEntries(DEMO_KEYS.filter((k) => typeof parsed[k] === 'string').map((k) => [k, parsed[k]]));
}
