// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs module of the repository's dev scripts, without type declarations.
import { CONVERTER_KEYS, devStackConverterEnv } from '../../../scripts/dev-converter-env.mjs';

describe('dev:stack converter setting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vdrkit-dev-converter-'));
  const dotenv = join(dir, '.env');
  writeFileSync(dotenv, [
    'DATABASE_URL=postgres://not-for-the-dev-stack', 'GOTENBERG_URL=http://127.0.0.1:3130', 'SMTP_HOST=mail.example.com',
    'SMTP_PASSWORD="not for the converter"', 'MAIL_FROM="Data room <info@example.com>"'].join('\n'));
  const noUrl = join(dir, 'mail-only.env');
  writeFileSync(noUrl, 'SMTP_HOST=mail.example.com\nSMTP_PASSWORD=secret\n');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads only GOTENBERG_URL', () => {
    expect(CONVERTER_KEYS).toEqual(['GOTENBERG_URL']);
  });

  it('takes only GOTENBERG_URL from .env', () => {
    expect(devStackConverterEnv({}, dotenv)).toEqual({ GOTENBERG_URL: 'http://127.0.0.1:3130' });
    expect(devStackConverterEnv({}, noUrl)).toEqual({});
  });

  it('prefers the environment, even when empty', () => {
    expect(devStackConverterEnv({ GOTENBERG_URL: 'http://localhost:3000' }, dotenv)).toEqual({});
    expect(devStackConverterEnv({ GOTENBERG_URL: '' }, dotenv)).toEqual({});
  });

  it('adds nothing without a .env file', () => {
    expect(devStackConverterEnv({}, join(dir, 'missing.env'))).toEqual({});
    expect(devStackConverterEnv({}, undefined)).toEqual({});
  });

  it('blanks GOTENBERG_URL with --no-converter', () => {
    expect(devStackConverterEnv({}, dotenv, { noConverter: true })).toEqual({ GOTENBERG_URL: '' });
    expect(devStackConverterEnv({ GOTENBERG_URL: 'http://localhost:3000' }, dotenv, { noConverter: true })).toEqual({ GOTENBERG_URL: '' });
  });
});
