// SPDX-License-Identifier: AGPL-3.0-only
import { crc32, deflateSync } from 'node:zlib';
import type { Page, TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './a11y-helpers';
import { API_URL, PERSONAS, expect, test, type PersonaKey } from './fixtures';

const PORT = Number(process.env.PORT ?? '3100');
const SETUP_API = `http://127.0.0.1:${process.env.SETUP_API_PORT ?? String(PORT + 4)}`;
const DEV = { 'x-dev-tenant': '00000000-0000-4000-8000-000000000001', 'x-dev-person': '00000000-0000-4000-8000-000000000002' };
const ADMIN = { givenName: 'Thandi', familyName: 'Mokoena', company: 'Grenlodge Partners', email: 'thandi.mokoena@grenlodge.example' };
const SHOTS = process.env.G1_SHOTS === '1';

test.skip(process.env.E2E_PROD === '1', 'G1 runs against next dev with the API');

// other browsers: see metadata.role
const only = (info: TestInfo, project: string) =>
  test.skip((info.project.metadata?.role ?? info.project.name) !== project, `runs in the "${project}" project`);

interface Mail { to: string; subject: string; text: string; html: string; sentAt: string }

async function mailbox(to: string): Promise<Mail[]> {
  const res = await fetch(`${SETUP_API}/v1/dev/mailbox?to=${encodeURIComponent(to)}`, { headers: DEV });
  return ((await res.json()) as { messages: Mail[] }).messages;
}

async function nextMail(to: string, since: number, subject: RegExp): Promise<Mail> {
  for (let i = 0; i < 50; i++) {
    const m = (await mailbox(to)).find((x) => new Date(x.sentAt).getTime() >= since && subject.test(x.subject));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No email "${subject}" to ${to}`);
}

function png(width: number, height: number): Buffer {
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
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0)]);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = 0x13; row[2 + x * 3] = 0x62; row[3 + x * 3] = 0x7a; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function shots(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoAxeViolations(page, `G1 ${name} in ${scheme} mode`);
  }
  for (const [w, h] of [[320, 640], [390, 844], [1280, 900]] as const) {
    await page.setViewportSize({ width: w, height: h });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(wide, `${name} scrolls sideways at ${w} px`).toBe(false);
    if (!SHOTS) continue;
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `test-results/g1/${name}-${w}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const card = (page: Page) => page.locator('section.card');
const onStep = (page: Page, step: string) => expect(card(page)).toHaveAttribute('data-step', step);

test.describe('an empty installation', () => {
  test.describe.configure({ mode: 'serial' });
  // setup token lives in sessionStorage
  let tab: Page;
  test.beforeAll(async ({ browser }, info) => { tab = await (await browser.newContext({ baseURL: info.project.use.baseURL })).newPage(); });
  test.afterAll(async () => { await tab?.context().close(); });

  test('redirects to setup and refuses a wrong code', async ({ page }, info) => {
    only(info, 'setup');
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await page.goto('/sign-in');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'Set up VDRkit' })).toBeVisible();
    await expect(page.locator('.pg-top .mark')).toHaveText('VDRkit');
    await expect(page.locator('.pg-foot')).toContainText(/VDRkit \d+\.\d+\.\d+/);
    await expect(page.locator('.pg-foot').getByRole('link', { name: 'Source code' })).toHaveAttribute('href', 'https://github.com/vdrkit/vdrkit');
    await expect(page.locator('.steps li.on')).toHaveText('Unlock');
    await expect(page.locator('pre.cmd')).toHaveText('docker compose logs api | grep "Setup code"');
    await onStep(page, 'unlock');
    await shots(page, '1-unlock');

    await page.getByLabel('Setup code').fill('aaaa-bbbb');
    await expect(page.getByLabel('Setup code')).toHaveValue('AAAA-BBBB');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(card(page).getByRole('alert')).toHaveText('That is not the setup code. It has eight letters and digits, such as K7QM-4XWD.');
    await shots(page, '1-unlock-wrong');
  });

  test('unlock, checks, site admin and organisation', async ({}, info) => {
    only(info, 'setup');
    const page = tab;
    const { code } = (await (await fetch(`${SETUP_API}/v1/dev/setup-code`, { headers: DEV })).json()) as { code: string };
    expect((await fetch(`${SETUP_API}/v1/setup/draft`)).status).toBe(401);

    await page.goto('/setup');
    await page.getByLabel('Setup code').fill(code.toLowerCase().replace('-', ''));
    await page.getByRole('button', { name: 'Continue' }).click();

    await onStep(page, 'checks');
    await expect(page.getByRole('heading', { name: 'Everything VDRkit needs' })).toBeVisible();
    await expect(page.locator('.chkl > div')).toHaveCount(5);
    await expect(page.locator('[data-check=database] .pill')).toHaveText('Working');
    await expect(page.locator('[data-check=storage] .pill')).toHaveText('Working');
    await expect(page.locator('[data-check=virus_scanner] .pill')).toHaveText('Not installed');
    await expect(page.locator('[data-check=virus_scanner] small')).toHaveText('ClamAV is not installed, so uploads are not scanned. Add it later from the installation guide.');
    await expect(page.locator('[data-check=web_address] .pill')).toHaveText('No certificate');
    await expect(page.locator('.card .lead')).toHaveText(/^These were set in the installation file\. You can go on\. Fix the (document conversion and )?web address before you invite anyone\. The virus scanner is optional\.$/);
    await expect(page.locator('.steps li.done')).toHaveText(['Unlock']);
    await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0);
    await shots(page, '2-checks');
    await page.getByRole('button', { name: 'Continue' }).click();

    await onStep(page, 'you');
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.toast')).toContainText('Fill in all four fields');
    await page.getByLabel('First name').fill(ADMIN.givenName);
    await page.getByLabel('Last name').fill(ADMIN.familyName);
    await page.getByLabel('Company').fill(ADMIN.company);
    await page.getByLabel('Work email').fill(ADMIN.email);
    await shots(page, '3-you');
    await page.getByRole('button', { name: 'Continue' }).click();

    await onStep(page, 'org');
    await expect(page.getByRole('heading', { name: 'Your organisation' })).toBeVisible();
    await page.getByLabel('Organisation name').fill('Grenlodge Partners');
    await expect(page.getByRole('button', { name: 'Upload a logo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload a version for dark mode' })).toBeVisible();
    await page.locator('input[data-logo=light]').setInputFiles({ name: 'tarnley.png', mimeType: 'image/png', buffer: png(360, 80) });
    await expect(page.getByRole('button', { name: 'Replace the logo' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Logo' })).toBeVisible();
    await page.locator('input[data-logo=dark]').setInputFiles({ name: 'logo.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
    await expect(card(page).getByRole('alert')).toHaveText('Choose a PNG or SVG file.');
    await shots(page, '4-org');
    await page.getByRole('button', { name: 'Back' }).click();
    await onStep(page, 'you');
    await expect(page.getByLabel('Work email')).toHaveValue(ADMIN.email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await onStep(page, 'org');
    await page.getByRole('button', { name: 'Continue' }).click();
    await onStep(page, 'mail');

    await page.reload();
    await onStep(page, 'mail');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByLabel('Organisation name')).toHaveValue('Grenlodge Partners');
    await expect(page.getByRole('button', { name: 'Replace the logo' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await onStep(page, 'mail');
  });

  test('requires a test email before finishing', async ({}, info) => {
    only(info, 'setup');
    const page = tab;
    await onStep(page, 'mail');
    await expect(page.getByRole('heading', { name: 'Outgoing email' })).toBeVisible();
    const finish = page.getByRole('button', { name: 'Finish setup' });
    await expect(finish).toBeDisabled();
    await expect(card(page)).toContainText(`Send a test to ${ADMIN.email} before you finish.`);

    await page.getByLabel('Server').fill('smtp.grenlodge.example');
    await page.getByLabel('Encryption').selectOption('tls');
    await expect(page.getByLabel('Port')).toHaveValue('465');
    await page.getByLabel('Encryption').selectOption('starttls');
    await expect(page.getByLabel('Port')).toHaveValue('587');
    await page.getByLabel('Username').fill('dataroom@grenlodge.example');
    await page.getByLabel('Password').fill('not-a-real-password');
    await page.getByLabel('Sending address').fill('dataroom@grenlodge.example');
    await shots(page, '5-mail');

    const since = Date.now() - 1000;
    await page.getByRole('button', { name: 'Send a test email' }).click();
    await expect(page.locator('.note.info')).toContainText(`Test email sent to ${ADMIN.email}.`);
    const m = await nextMail(ADMIN.email, since, /Test email from your data room site/);
    expect(m.text).toContain('Server: smtp.grenlodge.example');
    expect(m.text).toContain('Port: 587, STARTTLS');
    await expect(finish).toBeEnabled();
    await shots(page, '5-mail-tested');

    await page.getByLabel('Sending address').fill('deals@grenlodge.example');
    await expect(finish).toBeDisabled();
    await page.getByRole('button', { name: 'Send a test email' }).click();
    await expect(finish).toBeEnabled();
    await finish.click();

    await onStep(page, 'done');
    await expect(page.getByRole('heading', { name: 'VDRkit is ready' })).toBeVisible();
    await expect(card(page)).toContainText(`Sign in with ${ADMIN.email} to set up two-factor sign-in, then create your first room.`);
    await expect(page.locator('.steps')).toHaveCount(0);
    await shots(page, '6-done');
  });

  test('closes setup for good once finished', async ({ page }, info) => {
    only(info, 'setup');
    expect(await (await fetch(`${SETUP_API}/v1/setup`)).json()).toEqual({ open: false, version: null });
    expect((await fetch(`${SETUP_API}/v1/setup/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"K7QM-4XWD"}' })).status).toBe(404);

    await page.goto('/setup');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.locator('.pg-top .org img.org-light')).toBeVisible();
    await expect(page.locator('.pg-foot')).toContainText('Data rooms run by Grenlodge Partners');

    await page.goto(`/sign-in?email=${encodeURIComponent(ADMIN.email)}`);
    await expect(page.locator('#f-email')).toHaveValue(ADMIN.email);
    const since = Date.now() - 1000;
    await page.getByRole('button', { name: 'Email me a link and a code' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const mail = await nextMail(ADMIN.email, since, /\d{3} ?\d{3}/);
    const digits = /(\d{3}) ?(\d{3})/.exec(mail.subject)!;
    const boxes = page.locator('.card .code input');
    await boxes.first().click();
    await page.keyboard.type(`${digits[1]}${digits[2]}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  });
});

test.describe('setup closed', () => {
  const keys = PERSONAS.map((p) => p.key as PersonaKey);

  for (const key of keys) {
    test(`${key} gets "not available" for /setup`, async ({ page, persona }, info) => {
      only(info, 'chromium');
      await persona(key);
      await page.goto('/setup');
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to my rooms' })).toBeVisible();
      await expect(page.getByText('Set up VDRkit')).toHaveCount(0);
      await expect(page.locator('section.card')).not.toContainText('Project Heron');
    });
  }

  test('setup routes answer 404', async ({ page, persona }, info) => {
    only(info, 'chromium');
    expect(await (await fetch(`${API_URL}/v1/setup`)).json()).toEqual({ open: false, version: null });
    const routes: [string, string][] = [
      ['POST', '/v1/setup/unlock'], ['GET', '/v1/setup/draft'], ['GET', '/v1/setup/checks'], ['PUT', '/v1/setup/admin'],
      ['PUT', '/v1/setup/organisation'], ['PUT', '/v1/setup/mail'], ['POST', '/v1/setup/test-email'], ['POST', '/v1/setup/finish'],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${API_URL}${path}`, { method, headers: { 'content-type': 'application/json', 'x-vdrkit-setup-token': 'x' }, ...(method === 'GET' ? {} : { body: '{"code":"K7QM-4XWD"}' }) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    await persona('anika');
    expect((await page.request.get('/v1/dev/setup-code')).status()).toBe(404);
    expect((await page.request.get('/v1/dev/mailbox?to=anika%40seller.example.com')).status()).toBe(404);
    await page.goto('/');
    await expect(page).toHaveURL(/\/rooms\/[^/]+\/dashboard$/);
  });
});
