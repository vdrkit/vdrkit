// SPDX-License-Identifier: AGPL-3.0-only
import { request as pwRequest, type Page } from '@playwright/test';
import { DEV_TENANT_ID, PERSONAS } from '../src/dev-tools/personas';
import { API_URL, expect, ROOM_ID, roomPath, test } from './fixtures';
import { nextEmail, totp } from './signin-helpers';

test.skip(process.env.E2E_PROD === '1', 'Site settings run against next dev with the API');

const RUTH = '7552e510-4502-4b86-8704-631d20813723';
const ANIKA = PERSONAS.find((p) => p.key === 'anika')!.id;
const SITE = '/site/settings';
const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function as<T>(personId: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': personId, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function openTab(page: Page, name: string) {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}

async function ready(page: Page) {
  await expect(page.locator('.g2 .stabs')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('.g2 .stab');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps'));
  });
}

test.describe('who sees Site settings', () => {
  for (const key of ['jan', 'pieter', 'lars', 'maria', 'johan', 'liesl'] as const) {
    test(`${key} gets "not available"`, async ({ page, persona }) => {
      await persona(key);
      for (const path of [SITE, `${SITE}/accounts`]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
        await expect(page.locator('body')).not.toContainText('Site settings');
      }
    });
  }

  test('hidden from room admins who are not site admins', async ({ page, persona }) => {
    await persona('maria');
    await page.goto(roomPath('dashboard'));
    await expect(page.locator('.side .nav')).not.toContainText('Server settings');
  });

  test('unknown tab is not available', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(`${SITE}/nope`);
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  });

  test('site admins see no room content until they join', async ({ page, persona }) => {
    await persona('thabo');
    await page.goto(roomPath('dashboard'));
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Project Heron');
  });

  test('site admins find it in the menu outside a room', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(SITE);
    await expect(page.getByRole('heading', { name: 'Site settings', level: 1 })).toBeVisible();
    await expect(page.locator('.crumbs')).toHaveText(/Administration\s*\/\s*Site settings/);
    await expect(page.locator('.nav .sec')).toHaveText('Administration');
    await expect(page.locator('.nav a.on')).toHaveText('Server settings');
    await page.getByRole('tab', { name: 'Accounts' }).click();
    await expect(page.locator('.nav a.on')).toHaveText('Accounts');
    await page.locator('.side .nav').getByRole('link', { name: 'Rooms', exact: true }).click();
    await expect(page).toHaveURL(/\/site\/settings\/rooms$/);
    await expect(page.locator('.nav a.on')).toHaveText('Rooms');
    await page.locator('.side .nav').getByRole('link', { name: 'Server settings' }).click();
    await expect(page).toHaveURL(/\/site\/settings$/);
    await expect(page.locator('.nav')).toContainText('My rooms');
    await expect(page.locator('.nav')).toContainText('Create a room');
    await expect(page.locator('.user')).toContainText('Room and site admin · Quillmont Advisory');
    await expect(page.getByRole('tab')).toHaveText(['Branding', 'Outgoing email', 'Rooms', 'Accounts', /^Health/]);

    await persona('thabo');
    await page.goto(SITE);
    await expect(page.locator('.nav a.on')).toHaveText('Server settings');
  });

  test('opens from My rooms and goes back', async ({ page, persona }) => {
    await persona('thabo');
    await page.goto('/rooms');
    await expect(page.getByRole('heading', { name: 'My rooms', level: 1 })).toBeVisible();
    await page.locator('.side .nav').getByRole('link', { name: 'Server settings' }).click();
    await expect(page).toHaveURL(/\/site\/settings$/);
    await expect(page.getByRole('heading', { name: 'Site settings', level: 1 })).toBeVisible();
    await expect(page.locator('.side .user')).toContainText('Thabo Molefe');
    await page.locator('.side .nav').getByRole('link', { name: 'Create a room' }).click();
    await expect(page).toHaveURL(/\/rooms\/new$/);
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toHaveCount(0);
    await page.locator('.side .nav').getByRole('link', { name: 'Server settings' }).click();
    await expect(page.getByRole('heading', { name: 'Site settings', level: 1 })).toBeVisible();
    await page.locator('.side .nav').getByRole('link', { name: /^My rooms/ }).click();
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByRole('heading', { name: 'My rooms', level: 1 })).toBeVisible();
  });
});

test.describe('site settings', () => {
  test.describe.configure({ mode: 'serial' });

  test('tabs have their own URL; unsaved changes wait in the save bar', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(SITE);
    await ready(page);
    await openTab(page, 'Accounts');
    await expect(page).toHaveURL(/\/site\/settings\/accounts$/);
    await openTab(page, 'Branding');
    await expect(page).toHaveURL(/\/site\/settings$/);

    const name = page.locator('#f-org');
    await expect(name).toHaveValue('Quillmont Advisory');
    await name.fill('Quillmont Advisory Partners');
    await expect(page.locator('#f-org ~ .hint')).toHaveText('Used in emails: “Data rooms run by Quillmont Advisory Partners”.');
    const bar = page.locator('[data-save-bar]');
    await expect(bar).toContainText('1 unsaved change');
    await expect(bar).toContainText('Nothing changes for anyone until you save.');
    await expect(page.getByRole('tab', { name: /^Branding/ }).locator('em')).toHaveCount(1);
    await name.fill('');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(bar).toContainText('Check the fields marked in red. Nothing was saved.');
    await expect(page.locator('#f-org')).toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(bar).toHaveCount(0);
    await expect(name).toHaveValue('Quillmont Advisory');
  });

  test('uploads and removes a logo', async ({ page, persona }) => {
    for (const v of ['light', 'dark']) await as(ANIKA, 'DELETE', `/v1/site/branding/logos/${v}`);
    await persona('anika');
    await page.goto(SITE);
    await ready(page);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="168" height="40" viewBox="0 0 168 40"><rect width="40" height="40" fill="#B5543C"/><text x="48" y="28" font-size="20">G2 test</text></svg>');
    const light = page.locator('[data-logo=light]');
    const dark = page.locator('[data-logo=dark]');
    await expect(light).toContainText('None, showing the VDRkit mark');
    await light.getByRole('button', { name: 'Upload' }).click();
    await page.locator('[data-logo-input]').setInputFiles({ name: 'g2-logo.svg', mimeType: 'image/svg+xml', buffer: svg });
    await expect(light).toContainText('g2-logo.svg');
    await expect(dark).toContainText('None, using the light logo');
    await expect(page.locator('[data-save-bar]')).toContainText('1 unsaved change');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.toast')).toContainText('1 change saved');
    await expect(page.locator('.toast')).toContainText('Logged in the site log.');
    await expect(page.locator('[data-save-bar]')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('.side .org img.org-light')).toHaveAttribute('src', /^\/v1\/branding\/logos\/light(\?v=\w+)?$/);
    const png = await page.request.get('/v1/branding/logos/light');
    expect(png.headers()['content-type']).toBe('image/png');

    await light.getByRole('button', { name: 'Remove' }).click();
    await expect(light).toContainText('None, showing the VDRkit mark');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.toast')).toContainText('1 change saved');
    await page.reload();
    await expect(page.locator('.side .org img')).toHaveCount(0);
  });

  test('privacy notice as a link or as text', async ({ page, persona }) => {
    const reset = () => as(ANIKA, 'PATCH', '/v1/site/settings', { privacyNotice: null });
    await reset();
    try {
      const foot = page.locator('.pg-foot');
      await page.goto('/sign-in');
      await expect(foot).toContainText('Data rooms run by Quillmont Advisory');
      await expect(foot.getByRole('link', { name: 'Privacy notice' })).toHaveCount(0);

      await persona('anika');
      await page.goto(SITE);
      await ready(page);
      const panel = page.locator('[data-privacy]');
      await expect(panel.getByRole('radio', { name: /No privacy notice/ })).toHaveAttribute('aria-checked', 'true');

      await panel.getByRole('radio', { name: /A web address/ }).click();
      await page.locator('#f-privacyUrl').fill('quillmont.example/privacy');
      await expect(page.locator('[data-save-bar]')).toContainText('1 unsaved change');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.locator('#f-privacyUrl ~ .hint.err')).toHaveText('Give the full web address, starting with https://');
      await page.locator('#f-privacyUrl').fill('https://quillmont.example/privacy');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.locator('.toast')).toContainText('1 change saved');
      await expect(panel.locator('.pfoot a')).toHaveAttribute('href', 'https://quillmont.example/privacy');
      await page.goto('/sign-in');
      const link = foot.getByRole('link', { name: 'Privacy notice' });
      await expect(link).toHaveAttribute('href', 'https://quillmont.example/privacy');
      await expect(link).toHaveAttribute('target', '_blank');
      await page.goto('/sign-in/expired');
      await expect(foot.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', 'https://quillmont.example/privacy');

      await page.context().route('https://quillmont.example/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>Privacy</h1>' }));
      for (const path of [roomPath('dashboard'), '/rooms']) {
        await page.goto(path);
        await expect(page.locator('.side')).toBeVisible();
        await expect(page.locator('.pg-foot')).toHaveCount(0);
        await expect(async () => {
          if (!(await page.getByRole('menu').isVisible())) await page.getByRole('button', { name: /^Account menu/ }).click();
          await expect(page.getByRole('menuitem', { name: /Privacy notice/ })).toBeVisible({ timeout: 1000 });
        }).toPass();
        const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('menuitem', { name: /Privacy notice/ }).click()]);
        await popup.waitForLoadState();
        expect(popup.url()).toBe('https://quillmont.example/privacy');
        await popup.close();
      }

      await page.goto(SITE);
      await ready(page);
      await panel.getByRole('radio', { name: /Text shown on its own page/ }).click();
      await page.locator('#f-privacyText').fill('Quillmont Advisory keeps your name and email address.\n\n<b>Not bold</b> and a second paragraph.');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.locator('.toast')).toContainText('1 change saved');
      await page.goto('/sign-in');
      await expect(foot.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', '/privacy');
      await foot.getByRole('link', { name: 'Privacy notice' }).click();
      await expect(page).toHaveURL(/\/privacy$/);
      await expect(page.getByRole('heading', { name: 'Privacy notice', level: 1 })).toBeVisible();
      await expect(page.locator('.privacy-text p')).toHaveText(['Quillmont Advisory keeps your name and email address.', '<b>Not bold</b> and a second paragraph.']);
      await expect(page.locator('.privacy-text b')).toHaveCount(0);

      await page.goto(SITE);
      await ready(page);
      await panel.getByRole('radio', { name: /No privacy notice/ }).click();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.locator('.toast')).toContainText('1 change saved');
      await page.goto('/sign-in');
      await expect(foot.getByRole('link', { name: 'Privacy notice' })).toHaveCount(0);
      await page.goto(roomPath('dashboard'));
      await expect(page.locator('.side')).toBeVisible();
      await expect(async () => {
        if (!(await page.getByRole('menu').isVisible())) await page.getByRole('button', { name: /^Account menu/ }).click();
        await expect(page.getByRole('menuitem', { name: /Sign out/ })).toBeVisible({ timeout: 1000 });
      }).toPass();
      await expect(page.getByRole('menuitem', { name: /Privacy notice/ })).toHaveCount(0);
      await page.goto('/privacy');
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    } finally {
      await reset();
    }
  });

  test('only site admins may change the privacy notice', async () => {
    for (const key of ['maria', 'jan', 'liesl'] as const) {
      const id = PERSONAS.find((p) => p.key === key)!.id;
      await expect(as(id, 'PATCH', '/v1/site/settings', { privacyNotice: { url: 'https://evil.example' } })).rejects.toThrow(/403/);
    }
  });

  test('saves the mail server and sends a test email', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(`${SITE}/email`);
    await ready(page);
    await page.locator('#f-host').fill('smtp.quillmont.example');
    await page.locator('#f-security').selectOption('tls');
    await expect(page.locator('#f-port')).toHaveValue('465');
    await page.locator('#f-security').selectOption('starttls');
    await expect(page.locator('#f-port')).toHaveValue('587');
    await page.locator('#f-user').fill('dataroom@quillmont.example');
    await page.locator('#f-pw').fill('g2-secret-never-shown');
    await page.locator('#f-from').fill('dataroom@quillmont.example');
    await expect(page.locator('#f-fromName')).toHaveCount(0);
    await expect(page.getByText('Sender name')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /^Outgoing email/ }).locator('em')).toHaveCount(1);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.toast')).toContainText(/changes? saved/);

    await page.reload();
    await expect(page.locator('#f-host')).toHaveValue('smtp.quillmont.example');
    await expect(page.locator('#f-pw')).toHaveValue('');
    await expect(page.locator('#f-pw')).toHaveAttribute('placeholder', 'Saved. Type a new one to replace it');
    expect(await page.content()).not.toContain('g2-secret-never-shown');

    const check = page.locator('[data-domain-check]');
    await expect(check).toContainText('Checked for quillmont.example');
    await expect(check.locator('[data-record]')).toHaveCount(3);

    const since = Date.now() - 1000;
    await page.getByRole('button', { name: 'Send a test email' }).click();
    await expect(page.locator('[data-test-result=accepted]')).toContainText('Test email sent to anika@seller.example.com at');
    const mail = await nextEmail('anika@seller.example.com', since);
    expect(mail.subject).toBe('Test email from your data room site');
    expect(mail.text).toContain('Server: smtp.quillmont.example');
    expect(mail.text).toContain('Port: 587, STARTTLS');
  });

  test('manages who can create rooms', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(`${SITE}/rooms`);
    await ready(page);
    const panel = page.locator('[data-room-creators]');
    await expect(panel).toContainText('Site admins can always create rooms.');
    await expect(panel).toContainText('Other people who may create rooms (optional)');
    await expect(panel.locator('select, [role=radio], input[type=radio]')).toHaveCount(0);
    await expect(panel.locator('[data-creator]')).toContainText(['Lindiwe Zulu', 'Ruth Mahlangu']);
    const email = `${unique('creator')}@seller.example.com`;
    await page.locator('#f-cr').fill('not-an-address');
    await panel.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Enter a complete email address');
    await page.locator('#f-cr').fill(email);
    await panel.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('may now create rooms');
    const row = panel.locator(`[data-creator="${email}"]`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /^Remove/ }).click();
    await expect(page.locator('.toast')).toContainText('can no longer create rooms');
    await expect(row).toHaveCount(0);
    // Thabo is a site admin
    await page.locator('#f-cr').fill('thabo@seller.example.com');
    await panel.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Not added');
    await expect(page.locator('.toast')).toContainText('Thabo Molefe is a site admin. Site admins can always create rooms, so they are not listed here.');
    await expect(panel.locator('[data-creator="thabo@seller.example.com"]')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /^Rooms/ }).locator('em')).toHaveCount(0);
  });

  test('site admin joins a room with a reason', async ({ page, persona }) => {
    const name = `Project ${unique('G2')}`;
    const room = await as<{ id: string }>(RUTH, 'POST', '/v1/workspaces', { name, seller: 'Kranswyk Holdings' });
    await persona('thabo');
    await page.goto(`${SITE}/rooms`);
    await ready(page);
    const row = page.locator(`[data-room="${name}"]`);
    await expect(row).toContainText('Ruth Mahlangu');
    await expect(row).toContainText('Preparing');
    await expect(page.locator('[data-room="Project Heron"]')).toContainText('Join this room');
    await row.getByRole('button', { name: 'Join this room' }).click();
    const dlg = page.getByRole('dialog', { name: `Join ${name} as room admin` });
    await expect(dlg).toContainText('This is not silent.');
    await expect(dlg).toContainText('Ruth Mahlangu gets an email straight away with your name and reason.');
    await dlg.getByRole('button', { name: 'Join as room admin' }).click();
    await expect(dlg).toContainText('Give a reason.');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);

    await row.getByRole('button', { name: 'Join this room' }).click();
    await page.locator('#join-why').fill('Ruth is on leave and the seller needs a document withdrawn today');
    const since = Date.now() - 1000;
    await page.getByRole('dialog').getByRole('button', { name: 'Join as room admin' }).click();
    await expect(page.locator('.toast')).toContainText(`You joined ${name} as room admin`);
    await expect(page.locator('.toast')).toContainText('Ruth Mahlangu has been emailed.');
    await expect(row).toContainText('You are an admin');
    const mail = await nextEmail('ruth@seller.example.com', since);
    expect(mail.subject).toBe(`Thabo Molefe, site admin, joined ${name}`);
    expect(mail.text).toContain('Ruth is on leave and the seller needs a document withdrawn today');

    await page.goto(`/rooms/${room.id}/dashboard`);
    await expect(page.locator('body')).not.toContainText('This page is not available');
  });

  test('accounts: list, search, add a site admin, reset two-factor, disable', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(`${SITE}/accounts`);
    await ready(page);
    const panel = page.locator('[data-accounts]');
    await expect(panel.locator('[data-account]').first()).toContainText('Anika Pillay');
    await expect(panel.locator('[data-account="anika@seller.example.com"]')).toContainText('You');
    await expect(panel).toContainText('Site admin');
    await expect(panel).toContainText('Can create rooms');
    await expect(panel.getByRole('button', { name: 'Add a site admin' })).toBeVisible();

    await panel.getByRole('button', { name: 'Everyone' }).click();
    await expect(panel).toContainText('most recent sign-in first. Search to find anyone.');
    await expect(panel.getByRole('button', { name: 'Add a site admin' })).toHaveCount(0);
    await expect.poll(() => panel.locator('[data-account]').count()).toBeGreaterThan(8);
    await page.locator('#aq').fill('lars@bidder-c');
    await expect(panel.locator('[data-account]')).toHaveCount(1);
    await expect(panel).toContainText('1 found');
    await page.locator('#aq').fill('');
    await panel.getByRole('button', { name: 'Site admins and room creators' }).click();

    const email = `${unique('g2-admin')}@seller.example.com`;
    const since = Date.now() - 1000;
    await panel.getByRole('button', { name: 'Add a site admin' }).click();
    const add = page.getByRole('dialog', { name: 'Add a site admin' });
    await add.locator('#admin-email').fill(email);
    await add.locator('#admin-name').fill('Gita Two');
    await add.getByRole('button', { name: 'Add as site admin' }).click();
    await expect(page.locator('.toast')).toContainText('Gita Two is now a site admin');
    expect((await nextEmail(email, since)).subject).toBe('You are now a site admin of Quillmont Advisory data rooms');
    const row = panel.locator(`[data-account="${email}"]`);
    await expect(row).toContainText('Not set up');

    const api = await pwRequest.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: new URL(page.url()).origin } });
    const otpSince = Date.now() - 1000;
    expect((await api.post('/v1/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' } })).ok()).toBe(true);
    const otp = /(\d{3}) ?(\d{3})/.exec((await nextEmail(email, otpSince)).subject)!;
    expect((await api.post('/v1/auth/sign-in/email-otp', { data: { email, otp: `${otp[1]}${otp[2]}` } })).ok()).toBe(true);
    const enable = await api.post('/v1/auth/two-factor/enable', { data: {} });
    expect(enable.ok()).toBe(true);
    const secret = new URL((await enable.json()).totpURI).searchParams.get('secret')!;
    expect((await api.post('/v1/auth/two-factor/verify-totp', { data: { code: totp(secret) } })).ok()).toBe(true);
    expect((await api.get('/v1/site/settings')).ok()).toBe(true);

    await page.reload();
    await ready(page);
    await expect(row).toContainText('On');
    await row.getByRole('button', { name: 'Reset Gita Two’s two-factor sign-in' }).click();
    const reset = page.getByRole('dialog', { name: 'Reset Gita Two’s two-factor sign-in' });
    await expect(reset).toContainText('signed out everywhere');
    await reset.getByRole('button', { name: 'Reset two-factor sign-in' }).click();
    await expect(page.locator('.toast')).toContainText('Gita Two’s two-factor sign-in is reset');
    await expect(row).toContainText('Off');
    expect((await api.get('/v1/site/settings')).status()).toBe(401);
    await api.dispose();

    await row.getByRole('button', { name: 'Disable account' }).click();
    const off = page.getByRole('dialog', { name: 'Disable Gita Two’s account' });
    await expect(off).toContainText('can no longer sign in');
    await off.getByRole('button', { name: 'Disable account' }).click();
    await expect(page.locator('.toast')).toContainText('Gita Two’s account is disabled');
    await expect(row).toContainText('Disabled');
  });

  test('enabling an account leaves room access revoked', async ({ page, persona }) => {
    const u = unique('g2-enable');
    const people = await as<{ parties: { id: string; kind: string }[] }>(ANIKA, 'GET', `/v1/workspaces/${ROOM_ID}/people`);
    const groupName = `E2E Enable ${u.slice(-8)}`;
    const group = await as<{ id: string }>(ANIKA, 'POST', `/v1/workspaces/${ROOM_ID}/groups`, {
      name: groupName, partyId: people.parties.find((p) => p.kind === 'seller')!.id, organisation: 'Oskelby Capital', accessEndsAt: null });
    const email = `${u}@e2e.example`;
    const since = Date.now() - 1000;
    await as(ANIKA, 'POST', `/v1/workspaces/${ROOM_ID}/invitations`, { groupId: group.id, people: [{ email }] });
    const token = /\/invite\/([^\s"<>]+)/.exec((await nextEmail(email, since)).text)![1]!;
    const accept = await fetch(`${API_URL}/v1/public/invitations/accept`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: decodeURIComponent(token), givenName: 'Sam', familyName: 'Enable', company: 'Oskelby Capital' }) });
    expect(accept.ok, await accept.text()).toBe(true);
    const found = await as<{ items: { personId: string }[] }>(ANIKA, 'GET', `/v1/site/accounts?filter=everyone&q=${encodeURIComponent(email)}`);
    await as(ANIKA, 'POST', `/v1/site/accounts/${found.items[0]!.personId}/disable`, {});

    try {
      await persona('anika');
      await page.goto(`${SITE}/accounts`);
      await ready(page);
      const panel = page.locator('[data-accounts]');
      await page.locator('#aq').fill(email);
      const row = panel.locator(`[data-account="${email}"]`);
      await expect(row).toContainText('Disabled');
      await row.getByRole('button', { name: 'Enable account' }).click();
      const dlg = page.getByRole('dialog', { name: 'Enable Sam Enable’s account' });
      await expect(dlg).toContainText('Sam Enable can sign in again with their email address.');
      await expect(dlg).toContainText('does not come back by itself. In each room they were in, their access is shown as revoked, and the room admins give it back with Restore access, or invite them again if they never accepted.');
      await expect(dlg).toContainText('It is logged in the site log and in each of their rooms.');
      await dlg.getByRole('button', { name: 'Enable account' }).click();
      await expect(page.locator('.toast')).toContainText('Sam Enable’s account is enabled again');
      await expect(page.locator('.toast')).toContainText('They can sign in again, but their access to ');
      await expect(page.locator('.toast')).toContainText('stays revoked. Ask the room admins there to use Restore access, or to invite Sam Enable again if they never accepted. Logged in the site log.');
      await expect(row).not.toContainText('Disabled');
      await expect(row.getByRole('button', { name: 'Disable account' })).toBeVisible();
      const log = await as<{ items: { action: string; data: Record<string, unknown> }[] }>(ANIKA, 'GET', '/v1/site/events?limit=20');
      expect(log.items.find((e) => e.action === 'site.account.enabled')?.data).toMatchObject({ rooms: 1, memberships_revoked: 1 });

      await page.goto(roomPath('people'));
      await page.getByRole('tablist', { name: 'Whose groups' }).getByRole('tab', { name: /Seller team/ }).click();
      const g = page.locator(`.grp[data-group="${groupName}"]`);
      if ((await g.locator('.gh .tg').getAttribute('aria-expanded')) !== 'true') await g.locator('.gh .tg').click();
      const person = page.locator(`.mr[data-person="${email}"]`);
      await expect(person.locator('.st').first()).toContainText('Access revoked');
      await person.getByRole('button', { name: /Actions for/ }).click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'Restore access' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Restore access for Sam' }).click();
      await expect(page.locator('.toast')).toContainText('Access restored for Sam Enable');
      await expect(page.locator('.toast')).not.toContainText('two-factor');
      await expect(person.locator('.st').first()).toHaveText('Active');
    } finally {
      await as(ANIKA, 'POST', `/v1/workspaces/${ROOM_ID}/groups/${group.id}/revoke`, {}).catch(() => undefined);
    }
  });

  test('accounts: lists failed sign-ins, known address or not', async ({ page, persona }) => {
    const address = `${unique('nobody')}@nowhere.example`;
    const res = await fetch(`${API_URL}/v1/auth/sign-in/email-otp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
      body: JSON.stringify({ email: address, otp: '000000' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await persona('anika');
    await page.goto(`${SITE}/accounts`);
    await ready(page);
    const panel = page.locator('[data-failed-sign-ins]');
    await expect(panel.getByRole('heading', { name: 'Failed sign-ins' })).toBeVisible();
    await expect(panel).toContainText('An entry does not mean the address has an account. Kept for 30 days.');
    const entry = panel.locator('.tr', { hasText: address });
    await expect(entry).toContainText('Wrong email code');
    await expect(entry).toContainText('Chrome on Windows');
    await expect(entry).toContainText('IP address');
  });

  test('health: checks and alert settings', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(`${SITE}/health`);
    await ready(page);
    const health = page.locator('[data-health]');
    await expect(health.locator('[data-check]')).toHaveCount(6);
    await expect(health.locator('[data-check=database]')).toContainText('Working');
    await expect(health.locator('[data-check=virus_scanner]')).toContainText('Not installed');
    await expect(health).toContainText('VDRkit ');
    await expect(page.getByRole('tab', { name: /^Health/ }).locator('.pill')).toBeVisible();
    await expect(page.locator('.g2')).toContainText('Anika Pillay and Thabo Molefe');

    const alertTo = page.locator('#f-alertTo');
    const before = await alertTo.inputValue();
    await alertTo.fill('not an address');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#f-alertTo ~ .hint.err')).toHaveText('Give a complete email address, or leave it empty.');
    await alertTo.fill('it@seller.example.com');
    await page.locator('#f-alertMin').selectOption('60');
    await page.getByRole('switch', { name: 'Tell the site admins' }).click();
    await expect(page.locator('[data-save-bar]')).toContainText('3 unsaved changes');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.toast')).toContainText('3 changes saved');
    await page.reload();
    await expect(alertTo).toHaveValue('it@seller.example.com');
    await expect(page.locator('#f-alertMin')).toHaveValue('60');
    await expect(page.getByRole('switch', { name: 'Tell the site admins' })).toHaveAttribute('aria-checked', 'false');

    await alertTo.fill(before);
    await page.locator('#f-alertMin').selectOption('15');
    await page.getByRole('switch', { name: 'Tell the site admins' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.toast')).toContainText('saved');
  });

  test('health: monitor URL answers ok without sign-in', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(`${SITE}/health`);
    await ready(page);
    const code = page.locator('.g2 .note code').last();
    await expect(code).toHaveText(/^https?:\/\/[^/]+\/health$/);
    const url = (await code.textContent())!.trim();
    const monitor = await pwRequest.newContext();
    const res = await monitor.get(url, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    await monitor.dispose();
  });
});

test.describe('phone and dark mode', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`fits a phone screen in ${scheme} mode`, async ({ page, persona }) => {
      await persona('anika');
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${SITE}/rooms`);
      await ready(page);
      await expect(page.locator('.mm-btn')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.locator('.mm-btn').click();
      await expect(page.locator('.side .nav a.on')).toHaveText('Rooms');
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe(scheme === 'dark' ? 'rgb(15, 21, 28)' : 'rgb(244, 247, 250)');
    });
  }
});
