// SPDX-License-Identifier: AGPL-3.0-only

// = DEMO_TENANT_ID; copied to keep the seed out of the start check
export const SANDBOX_TENANT_ID = 'de300000-0000-4000-8000-000000000001';

// bump to force a reload on sandbox-init
export const SANDBOX_SEED_VERSION = 2;

export const RESET_HOUR_UTC = 3;
export const RESET_TIME_TEXT = '03:00 UTC';

export const SANDBOX_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const SANDBOX_UPLOADS_PER_VISITOR_PER_DAY = 25;
// all visitors, per reset
export const SANDBOX_UPLOADS_PER_DAY = 300;

export const MAIL_SETTINGS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_URL', 'MAIL_FROM'] as const;

export type Env = Record<string, string | undefined>;

export function sandboxFlag(env: Env = process.env): boolean {
  const v = (env.VDRKIT_SANDBOX ?? '').trim();
  if (v === '' || v === '0') return false;
  if (v === '1') return true;
  throw new Error(`VDRKIT_SANDBOX is "${v}". Set it to 1 for the public sandbox, or leave it unset.`);
}

export function refuseUnsafeSandboxEnv(env: Env = process.env): void {
  const mail = MAIL_SETTINGS.filter((k) => (env[k] ?? '').trim() !== '');
  if (mail.length) {
    throw new Error(`Sandbox mode refuses to start while mail settings are set (${mail.join(', ')}): the sandbox never sends email. `
      + 'Remove them from the environment.');
  }
  if ((env.VDRKIT_DEMO_EMAIL_DOMAINS ?? '').trim() !== '') {
    throw new Error('Sandbox mode refuses to start while VDRKIT_DEMO_EMAIL_DOMAINS is set: the demo people keep their example.com addresses.');
  }
  const driver = env.STORAGE_DRIVER || (env.S3_BUCKET ? 's3' : '');
  if (driver !== 'local') {
    throw new Error('Sandbox mode needs STORAGE_DRIVER=local: the daily reset empties the files folder, which it never does to a bucket.');
  }
}

export function nextReset(now: Date): Date {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RESET_HOUR_UTC));
  return at.getTime() > now.getTime() ? at : new Date(at.getTime() + 86_400_000);
}

