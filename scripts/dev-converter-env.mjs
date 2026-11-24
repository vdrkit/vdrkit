// SPDX-License-Identifier: AGPL-3.0-only
// dev only: GOTENBERG_URL from .env unless set in env (empty counts)
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const CONVERTER_KEYS = ['GOTENBERG_URL'];

export function devStackConverterEnv(env, dotenvPath, { noConverter = false } = {}) {
  if (noConverter) return Object.fromEntries(CONVERTER_KEYS.map((k) => [k, '']));
  if (CONVERTER_KEYS.some((k) => k in env)) return {};
  if (!dotenvPath || !existsSync(dotenvPath)) return {};
  const parsed = parseEnv(readFileSync(dotenvPath, 'utf8'));
  return Object.fromEntries(CONVERTER_KEYS.filter((k) => typeof parsed[k] === 'string').map((k) => [k, parsed[k]]));
}
