// SPDX-License-Identifier: AGPL-3.0-only
// dev only: SMTP_*/MAIL_FROM from .env unless any is set in env (empty counts).
// cmd/PowerShell drop empty vars, hence --no-real-mail
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const MAIL_KEYS = ['SMTP_HOST', 'SMTP_URL', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'];

export function mailEnvFromDotenv(env, dotenvPath) {
  if (MAIL_KEYS.some((k) => k in env)) return {};
  if (!dotenvPath || !existsSync(dotenvPath)) return {};
  const parsed = parseEnv(readFileSync(dotenvPath, 'utf8'));
  return Object.fromEntries(MAIL_KEYS.filter((k) => typeof parsed[k] === 'string').map((k) => [k, parsed[k]]));
}

export function devStackMailEnv(env, dotenvPath, { noRealMail = false } = {}) {
  if (noRealMail) return Object.fromEntries(MAIL_KEYS.map((k) => [k, '']));
  return mailEnvFromDotenv(env, dotenvPath);
}
