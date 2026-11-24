// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import type { SmtpSettings } from '../src/mail/smtp.js';
import { devMailChannel } from '../scripts/dev/mail.js';
// @ts-expect-error: a plain .mjs module of the repository's dev scripts, without type declarations.
import { MAIL_KEYS, devStackMailEnv, mailEnvFromDotenv } from '../../../scripts/dev-mail-env.mjs';

const MSG: OutgoingMessage = { to: 'jan@bidder-a.example.com', subject: 'Your sign-in code is 482 913', lines: ['Hello Jan'], personId: 'p1' } as OutgoingMessage;

function fakes(realStatus: 'accepted' | 'failed' = 'accepted') {
  const box: OutgoingMessage[] = [];
  const sent: { settings: SmtpSettings; msg: OutgoingMessage }[] = [];
  const mailbox: Channel = { name: 'email', async send(m) { box.push(m); return { status: 'accepted' }; } };
  const transport = (settings: SmtpSettings) => ({
    name: 'email',
    async send(m: OutgoingMessage) { sent.push({ settings, msg: m }); return realStatus === 'accepted' ? { status: 'accepted' as const } : { status: 'failed' as const, error: 'ECONNREFUSED' }; },
  });
  return { box, sent, mailbox, transport };
}

describe('dev stack mail channel', () => {
  it('uses the dev mailbox without a mail server', async () => {
    for (const env of [{}, { SMTP_HOST: '', SMTP_URL: '', MAIL_FROM: '' }, { MAIL_FROM: 'Data room <info@example.com>' }]) {
      const f = fakes();
      const d = devMailChannel(f.mailbox, env, f.transport);
      expect(d.realServer).toBeNull();
      expect(d.problem).toBeNull();
      expect(await d.channel.send(MSG)).toEqual({ status: 'accepted' });
      expect(f.box).toHaveLength(1);
      expect(f.sent).toHaveLength(0);
    }
  });

  it('sends with SMTP_HOST and MAIL_FROM', async () => {
    const f = fakes();
    const d = devMailChannel(f.mailbox, { SMTP_HOST: 'localhost', SMTP_PORT: '2525', MAIL_FROM: 'Data room <info@example.com>' }, f.transport);
    expect(d.realServer).toBe('localhost:2525 (STARTTLS required)');
    expect(await d.channel.send(MSG)).toEqual({ status: 'accepted' });
    expect(f.box).toEqual([MSG]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.settings).toMatchObject({ host: 'localhost', port: 2525, from: 'Data room <info@example.com>' });
  });

  it('supports SMTP_URL and reports failed sends', async () => {
    const f = fakes('failed');
    const d = devMailChannel(f.mailbox, { SMTP_URL: 'smtps://mail.example.com', MAIL_FROM: 'info@example.com' }, f.transport);
    expect(d.realServer).toBe('mail.example.com:465 (TLS)');
    expect(await d.channel.send(MSG)).toEqual({ status: 'failed', error: 'ECONNREFUSED' });
    expect(f.box).toHaveLength(1);
  });

  it('needs MAIL_FROM to send', async () => {
    const f = fakes();
    const d = devMailChannel(f.mailbox, { SMTP_HOST: 'localhost' }, f.transport);
    expect(d.realServer).toBeNull();
    expect(d.problem).toMatch(/MAIL_FROM/);
    await d.channel.send(MSG);
    expect(f.sent).toHaveLength(0);
  });
});

describe('dev:stack mail settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vdrkit-dev-mail-'));
  const dotenv = join(dir, '.env');
  writeFileSync(dotenv, [
    'DATABASE_URL=postgres://not-for-the-dev-stack', 'SMTP_HOST=mail.example.com', 'SMTP_PORT=587', 'SMTP_USER=info@example.com',
    'SMTP_PASSWORD="pw with # and spaces"', 'MAIL_FROM="Data room <info@example.com>"', 'BETTER_AUTH_SECRET=nope'].join('\n'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('takes only the mail settings from .env', () => {
    expect(mailEnvFromDotenv({}, dotenv)).toEqual({
      SMTP_HOST: 'mail.example.com', SMTP_PORT: '587', SMTP_USER: 'info@example.com', SMTP_PASSWORD: 'pw with # and spaces', MAIL_FROM: 'Data room <info@example.com>',
    });
  });

  it('prefers the environment, even when empty', () => {
    for (const k of MAIL_KEYS as string[]) expect(mailEnvFromDotenv({ [k]: '' }, dotenv)).toEqual({});
    expect(mailEnvFromDotenv({ SMTP_HOST: 'localhost' }, dotenv)).toEqual({});
  });

  it('adds nothing without a .env file', () => {
    expect(mailEnvFromDotenv({}, join(dir, 'missing.env'))).toEqual({});
  });

  it('blanks mail settings with --no-real-mail', () => {
    const blank = Object.fromEntries((MAIL_KEYS as string[]).map((k) => [k, '']));
    // cmd and PowerShell drop empty variables
    expect(devStackMailEnv({}, dotenv, { noRealMail: true })).toEqual(blank);
    expect(devStackMailEnv({ SMTP_HOST: 'localhost', MAIL_FROM: 'x@example.com' }, dotenv, { noRealMail: true })).toEqual(blank);
    expect(devStackMailEnv({}, dotenv)).toEqual(mailEnvFromDotenv({}, dotenv));
  });
});
