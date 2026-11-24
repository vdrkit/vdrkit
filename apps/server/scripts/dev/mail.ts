// SPDX-License-Identifier: AGPL-3.0-only
// Dev only. Always copies to the dev mailbox; also sends for real if SMTP_* is set
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { describeSmtp, smtpSettingsFromEnv } from '../../src/mail/smtp.js';
import { nodemailerTransport, type MailTransportFactory } from '../../src/site/mail.js';

type Env = Record<string, string | undefined>;

export interface DevMail {
  channel: Channel;
  realServer: string | null;
  problem: string | null;
}

export function devMailChannel(mailbox: Channel, env: Env, transport: MailTransportFactory = nodemailerTransport): DevMail {
  let settings;
  try {
    settings = smtpSettingsFromEnv(env);
  } catch (err) {
    return { channel: mailbox, realServer: null, problem: err instanceof Error ? err.message : String(err) };
  }
  if (!settings) return { channel: mailbox, realServer: null, problem: null };
  const real = transport(settings);
  const channel: Channel = {
    name: 'email',
    async send(msg: OutgoingMessage) {
      await mailbox.send(msg);
      return real.send(msg);
    },
  };
  return { channel, realServer: describeSmtp(env), problem: null };
}
