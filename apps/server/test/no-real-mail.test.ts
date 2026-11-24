// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { smtpSettingsFromEnv } from '../src/mail/smtp.js';

const MAIL_KEYS = ['SMTP_HOST', 'SMTP_URL', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'];

describe('no real mail in tests', () => {
  it('blanks mail settings for server tests', () => {
    for (const k of MAIL_KEYS) expect(process.env[k], k).toBe('');
    expect(smtpSettingsFromEnv(process.env)).toBeNull();
  });

  it('blanks mail settings for Playwright APIs', () => {
    const file = fileURLToPath(new URL('../../dataroom/playwright.config.ts', import.meta.url));
    const config = readFileSync(file, 'utf8');
    const blanks = /export const NO_REAL_MAIL = \{([^}]*)\};/.exec(config);
    expect(blanks, 'NO_REAL_MAIL in playwright.config.ts').not.toBeNull();
    for (const k of MAIL_KEYS) expect(blanks![1]).toMatch(new RegExp(`\\b${k}: ''`));
    const servers = config.split(/command:\s*/).slice(1);
    const apis = servers.filter((s) => /^[`'"][^`'"]*dev:pglite/.test(s));
    expect(apis.length).toBeGreaterThanOrEqual(2);
    for (const s of apis) expect(/env:\s*\{\s*\.\.\.NO_REAL_MAIL\b/.test(s), s.slice(0, 80)).toBe(true);
  });
});
