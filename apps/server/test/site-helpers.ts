// SPDX-License-Identifier: AGPL-3.0-only
import { crc32, deflateSync } from 'node:zlib';
import type { OutgoingMessage } from '@vdrkit/core';
import type { SmtpSettings } from '../src/mail/smtp.js';
import type { MailTransportFactory } from '../src/site/mail.js';
import type { CheckResult, HealthProbes } from '../src/site/health.js';
import { LABELS, CHECK_KEYS } from '../src/site/health.js';
import type { TxtResolver } from '../src/site/domain-check.js';

export function fakeTransport() {
  const sent: { settings: SmtpSettings; msg: OutgoingMessage }[] = [];
  const state = { accept: true, verifyFails: false, error: '535 Authentication failed' };
  const factory: MailTransportFactory = (settings) => ({
    name: 'email',
    async send(msg) {
      sent.push({ settings, msg });
      return state.accept ? { status: 'accepted' as const, providerMessageId: `fake-${sent.length}` } : { status: 'failed' as const, error: state.error };
    },
    async verify() { if (state.verifyFails) throw new Error('connect ECONNREFUSED'); },
  });
  return { sent, state, factory };
}

export function fakeProbes(overrides: Partial<Record<(typeof CHECK_KEYS)[number], CheckResult['status']>> = {}) {
  const status = { ...overrides };
  const probes: HealthProbes & { status: typeof status } = {
    status,
    async run() {
      return CHECK_KEYS.map((key) => ({
        key, label: LABELS[key],
        status: status[key] ?? (key === 'virus_scanner' ? 'warning' : key === 'backups' ? 'not_checked' : 'ok'),
        detail: status[key] === 'failing' ? `${LABELS[key]} is down` : 'fine',
      }));
    },
  };
  return probes;
}

export function fakeResolver(table: Record<string, string[]>): TxtResolver {
  return {
    async resolveTxt(name) {
      const v = table[name];
      if (!v) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return v.map((t) => [t]);
    },
  };
}

export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([0x00, 0x33, 0x66], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const TEST_ENV = {
  SMTP_HOST: 'smtp.quillmont.example', SMTP_PORT: '587', SMTP_USER: 'dataroom@quillmont.example', SMTP_PASSWORD: 'env-secret-pw',
  MAIL_FROM: '"Quillmont data rooms" <dataroom@quillmont.example>',
};
