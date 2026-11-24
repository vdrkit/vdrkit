// SPDX-License-Identifier: AGPL-3.0-only
// Runs in order and puts back what it changes in the shared demo room.
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';
import { API_URL, clickAndRefresh, hydrated, pageHydrated, PERSONAS, roomPath, ROOM_ID, test, type PersonaKey } from './fixtures';
import { freshTotp, invite, nextEmail, signInParts, signInWithCode, totp, typeCode } from './signin-helpers';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const PROFILE = roomPath('profile');
const id = (key: PersonaKey) => PERSONAS.find((p) => p.key === key)!.id;

async function as<T = any>(key: PersonaKey, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': id(key), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const row = (page: Page, key: string) => page.locator(`.nrow[data-event="${key}"]`);
const toast = (page: Page) => page.locator('.toast');
const saveBar = (page: Page) => page.getByRole('region', { name: 'Unsaved changes' });

async function open(page: Page, tab?: 'details' | 'notifications' | 'sign-in') {
  await page.goto(tab ? `${PROFILE}?tab=${tab}` : PROFILE);
  await hydrated(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Profile and notifications' })).toBeVisible();
}

test('opens from the account menu', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(roomPath('dashboard'));
  await hydrated(page);
  const item = page.getByRole('menuitem', { name: /Profile and notifications/ });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole('button', { name: 'Account menu: profile, notification settings, about, sign out' }).click();
    await expect(item).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await item.click();
  await expect(page).toHaveURL(new RegExp(`${PROFILE}$`));
  await expect(page.locator('.crumbs')).toHaveText(/Your account\s*\/\s*Profile and notifications/);
  await expect(page.locator('.stab')).toHaveText(['Your details', 'Email notifications', 'Sign-in']);
  await expect(page.locator('.stab[aria-selected="true"]')).toHaveText('Your details');
  await expect(page.locator('#f-fn')).toHaveValue('Jan');
  await expect(page.locator('#f-ln')).toHaveValue('de Vries');
  await expect(page.locator('#f-email')).toHaveAttribute('readonly', '');
  await expect(page.getByText('You sign in with this address. Ask the room admin to change it.')).toBeVisible();
  await expect(page.locator('#f-tz')).toHaveValue(/^London, GMT/);
  await expect(page.locator('.pfoot .cap').first()).toHaveText('Changes to your name, company or role are recorded in the activity log.');
  await expect(page.locator('.a5 .head .sub')).toHaveCount(0);
  await expect(page.getByText('Shown to the room admin and, for bidders, to your own team.')).toHaveCount(0);
  await expect(page.getByText('Deadlines, the activity log and your daily summary use it.')).toHaveCount(0);
  await expect(saveBar(page)).toHaveCount(0);
  await expect(page.locator('.nav a.on')).toHaveCount(0);
  await expect(page.locator('.stab[tabindex="0"]')).toHaveText('Your details');
  await page.locator('.stab[aria-selected="true"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.stab[aria-selected="true"]')).toHaveText('Email notifications');
  await expect(page.locator('.stab:focus')).toHaveText('Email notifications');
  await expect(page).toHaveURL(/\?tab=notifications$/);
  await page.keyboard.press('End');
  await expect(page.locator('.stab[aria-selected="true"]')).toHaveText('Sign-in');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.stab[aria-selected="true"]')).toHaveText('Your details');
});

test('shows bidder events and the summary time in their zone', async ({ page, persona }) => {
  await persona('jan');
  await open(page, 'notifications');
  await expect(page.locator('.stab[aria-selected="true"]')).toHaveText('Email notifications');
  await expect(page.getByRole('heading', { name: 'Email notifications', exact: true })).toBeVisible();
  await expect(page.locator('#f-room option:checked')).toHaveText('Project Heron');
  await expect(row(page, 'documents')).toContainText('New documents');
  await expect(row(page, 'requests')).toContainText('Your requests to add a colleague');
  await expect(row(page, 'requests')).toContainText('When the room admin decides');
  for (const key of ['drafts', 'processing_failed']) await expect(row(page, key)).toHaveCount(0);
  await expect(page.locator('.when')).toContainText('One email at 08:00 GMT, listing everything since the last one.');
  await expect(page.locator('.when')).toContainText('One email once things go quiet for 10 minutes, at most an hour after the first event.');
});

test('only room admins get admin events', async ({ page, persona }) => {
  for (const p of PERSONAS.filter((x) => x.key !== 'thabo')) {
    await persona(p.key as PersonaKey);
    await open(page, 'notifications');
    await expect(page.locator('.user')).toContainText(p.name);
    await expect(row(page, 'documents')).toBeVisible();
    await expect(row(page, 'processing_failed')).toHaveCount(p.key === 'anika' ? 1 : 0);
  }
});

test('should show not available for unknown rooms', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(`/rooms/${randomUUID()}/profile`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Project Heron');
  await expect(page.locator('.stabs')).toHaveCount(0);
});

test('saves details and logs the change', async ({ page, persona }) => {
  const before = await as('lars', 'GET', '/v1/me');
  const company = `Skarvik Bank ${Math.floor(Math.random() * 1e6)}`;
  try {
    await persona('lars');
    await open(page);
    await page.locator('#f-ro').fill('Credit director');
    await expect(page.locator('.note.warn')).toContainText('A change to your name, company or role is logged.');
    await expect(page.locator('.stab').first().locator('em')).toBeVisible();
    await expect(saveBar(page)).toContainText('Nothing changes until you save.');
    await saveBar(page).getByRole('button', { name: 'Discard' }).click();
    await expect(saveBar(page)).toHaveCount(0);
    await expect(page.locator('#f-ro')).toHaveValue(before.jobTitle ?? '');
    await expect(page.locator('.note.warn')).toHaveCount(0);

    await page.locator('#f-ro').fill('Credit director');
    await page.locator('#f-fn').fill('');
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(toast(page)).toContainText('Enter your first and last name');
    await page.locator('#f-fn').fill(before.givenName);
    await page.locator('#f-co').fill('');
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(toast(page)).toContainText('Enter your company');

    await page.locator('#f-co').fill(company);
    await clickAndRefresh(page, saveBar(page).getByRole('button', { name: 'Save changes' }));
    await expect(toast(page)).toContainText('Saved');
    await expect(toast(page)).toContainText('The change to your details is recorded in the activity log of Project Heron.');
    await expect(saveBar(page)).toHaveCount(0);
    expect(await as('lars', 'GET', '/v1/me')).toMatchObject({ company, jobTitle: 'Credit director' });

    const log = await as('anika', 'GET', `/v1/workspaces/${ROOM_ID}/events?action=person.details_changed&limit=20`);
    const mine = log.items.find((e: any) => e.resourceId === id('lars'));
    expect(mine?.personal).toMatchObject({ after: { company } });
  } finally {
    await as('lars', 'PATCH', '/v1/me', { givenName: before.givenName, familyName: before.familyName, company: before.company ?? 'Skarvik Bank', jobTitle: before.jobTitle });
  }
});

test('daily summary follows the time zone', async ({ page, persona }) => {
  const before = await as('pieter', 'GET', '/v1/me');
  try {
    await persona('pieter');
    await open(page);
    await page.locator('#f-tz').click();
    await page.locator('#f-tz').fill('amsterdam');
    await page.getByRole('option', { name: /Amsterdam/ }).click();
    await expect(page.locator('#f-tz')).toHaveValue(/^Amsterdam, CET, UTC\+1/);
    await expect(page.locator('.note.warn')).toHaveCount(0); // A time zone is not logged.
    await page.getByRole('tab', { name: /Email notifications/ }).click();
    await expect(page.locator('.when')).toContainText('One email at 08:00 CET');
    await clickAndRefresh(page, saveBar(page).getByRole('button', { name: 'Save changes' }));
    await expect(toast(page)).toContainText('Your changes apply from now on.');
    expect((await as('pieter', 'GET', '/v1/me')).timeZone).toBe('Europe/Amsterdam');
  } finally {
    await as('pieter', 'PATCH', '/v1/me', { timeZone: before.timeZone });
  }
});

test('saves notification settings per event', async ({ page, persona }) => {
  try {
    await persona('pieter');
    await open(page, 'notifications');
    const docs = row(page, 'documents');
    await expect(docs).toContainText('Room default');
    await docs.getByRole('switch', { name: 'Email me about New documents' }).click();
    await expect(docs.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(docs.locator('.tg-l')).toHaveText('Off');
    await expect(docs.locator('select')).toBeDisabled();
    await expect(docs).toContainText('Off. Room default: on, bundled');

    const versions = row(page, 'versions');
    await versions.locator('select').selectOption({ label: 'Daily summary' });
    await expect(versions).toContainText('Your choice. Room default: bundled');
    await expect(page.locator('.stab').nth(1).locator('em')).toBeVisible();
    await clickAndRefresh(page, saveBar(page).getByRole('button', { name: 'Save changes' }));
    await expect(toast(page)).toContainText('Your changes apply from now on.');

    const saved = await as('pieter', 'GET', `/v1/workspaces/${ROOM_ID}/me/notifications`);
    expect(saved.events.find((e: any) => e.key === 'documents')).toMatchObject({ enabled: false, personal: true });
    expect(saved.events.find((e: any) => e.key === 'versions')).toMatchObject({ enabled: true, frequency: 'digest', personal: true });

    await open(page, 'notifications');
    await expect(row(page, 'documents').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await row(page, 'versions').locator('select').selectOption({ label: 'Bundled' });
    await expect(row(page, 'versions')).toContainText('Room default');
    await clickAndRefresh(page, saveBar(page).getByRole('button', { name: 'Save changes' }));
    await expect(toast(page)).toContainText('Saved');
    const back = await as('pieter', 'GET', `/v1/workspaces/${ROOM_ID}/me/notifications`);
    expect(back.events.find((e: any) => e.key === 'versions')).toMatchObject({ frequency: 'bundled', personal: false });
  } finally {
    await as('pieter', 'PUT', `/v1/workspaces/${ROOM_ID}/me/notifications`, { events: { documents: null, versions: null } });
  }
});

test('locks mandatory events except for room admins', async ({ page, persona }) => {
  const set = (mandatory: boolean) => as('anika', 'PATCH', `/v1/workspaces/${ROOM_ID}/settings`,
    { notifications: { deadlines: { enabled: true, mode: 'immediate', mandatory } } });
  await set(true);
  try {
    await persona('liesl');
    await open(page, 'notifications');
    const t = row(page, 'deadlines');
    await expect(t.getByRole('switch', { name: 'Email me about Timeline changes' })).toBeDisabled();
    await expect(t).toContainText('Required by the room admin. You choose how often.');
    await expect(t.locator('select')).toBeEnabled();

    await persona('anika');
    await open(page, 'notifications');
    const a = row(page, 'deadlines');
    await expect(a).toContainText('Mandatory for everyone else in this room.');
    await expect(a.getByRole('link', { name: 'Change in Room settings' })).toHaveAttribute('href', roomPath('settings'));
    await expect(a.getByRole('switch')).toBeEnabled();
  } finally {
    await set(false);
  }
});

test('observers do not get the NDA event', async ({ page, persona }) => {
  await persona('liesl');
  await open(page, 'notifications');
  await expect(row(page, 'documents')).toBeVisible();
  await expect(row(page, 'agreements')).toHaveCount(0);
  await persona('anika');
  await open(page, 'notifications');
  await expect(page.locator('.nrow[data-event]')).toHaveCount(9);
  await expect(row(page, 'agreements')).toContainText('New NDA version');
  await expect(row(page, 'publish_dropped')).toContainText('A publish I asked for did not happen');
});

test('keeps settings per room', async ({ page, persona }) => {
  const name = `Project Osprey ${Math.floor(Math.random() * 1e6)}`;
  const osprey = (await as('anika', 'POST', '/v1/workspaces', { name })).id as string;
  try {
    await persona('anika');
    await open(page, 'notifications');
    await expect(page.getByRole('heading', { name: 'Email notifications', exact: true })).toBeVisible();
    const pick = page.locator('#f-room');
    // other specs add rooms in parallel
    await expect(pick.locator('option', { hasText: 'Project Heron' })).toHaveCount(1);
    await expect(pick.locator('option', { hasText: name })).toHaveCount(1);
    await expect(pick).toHaveValue(ROOM_ID);
    await pick.selectOption({ label: name });
    await row(page, 'drafts').locator('select').selectOption({ label: 'Right away' });
    await pick.selectOption({ label: 'Project Heron' });
    await expect(row(page, 'drafts').locator('select')).toHaveValue('digest');
    await clickAndRefresh(page, saveBar(page).getByRole('button', { name: 'Save changes' }));
    await expect(toast(page)).toContainText('Saved');
    const there = await as('anika', 'GET', `/v1/workspaces/${osprey}/me/notifications`);
    const here = await as('anika', 'GET', `/v1/workspaces/${ROOM_ID}/me/notifications`);
    expect(there.events.find((e: any) => e.key === 'drafts')).toMatchObject({ frequency: 'immediate', personal: true });
    expect(here.events.find((e: any) => e.key === 'drafts')).toMatchObject({ frequency: 'digest', personal: false });

    await persona('jan');
    await page.goto(`/rooms/${osprey}/profile`);
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(name);
  } finally {
    await as('anika', 'PATCH', `/v1/workspaces/${osprey}/settings`, { state: 'deleted' });
  }
});

test('Sign-in tab is empty without a real session', async ({ page, persona }) => {
  await persona('maria');
  await open(page, 'sign-in');
  await expect(page.getByRole('heading', { name: 'Sign-in', exact: true })).toBeVisible();
  await expect(page.getByText('You sign in with a link or code sent to your email. There is no password.')).toBeVisible();
  await expect(page.locator('[data-row="no-session"]')).toContainText('You opened this page with the prototype’s View as switcher. It works without signing in, so there is no sign-in to show. Sign in with your email to see your two-factor sign-in and trusted browsers, and to sign out everywhere.');
  await expect(page.getByRole('button', { name: 'Sign out everywhere' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move to a new phone' })).toHaveCount(0);
  await expect(page.locator('[data-row="two-factor"]')).toHaveCount(0);
});

test('should not scroll sideways on a phone', async ({ page, persona }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await persona('jan');
  for (const tab of ['details', 'notifications', 'sign-in'] as const) {
    await open(page, tab);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});


const SIGNIN = `http://127.0.0.1:${process.env.SIGNIN_PORT ?? String(Number(process.env.PORT ?? '3100') + 2)}`;

async function onboard(page: Page, prefix: string): Promise<{ email: string; secret: string; used: string }> {
  const { email, link } = await invite(prefix);
  await page.goto(link);
  await page.locator('#f-fn').fill('Sanne');
  await page.locator('#f-ln').fill('Visser');
  await page.locator('#f-co').fill('Orrinby Capital');
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await typeCode(page, signInParts(await nextEmail(email, since)).code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();
  await expect(page.getByTestId('manual-key')).toHaveText(/[A-Z2-7]{4}/);
  const secret = (await page.getByTestId('manual-key').textContent())!.replace(/\s/g, '');
  const used = totp(secret);
  await typeCode(page, used);
  await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
  // full page load to the NDA
  await expect(page).toHaveURL(/\/nda/, { timeout: 30_000 });
  await pageHydrated(page);
  await page.locator('#f-accept').check();
  await page.getByRole('button', { name: 'Accept and enter the room' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/dashboard$`), { timeout: 30_000 });
  return { email, secret, used };
}

// dashboard.spec.ts counts Bidder A's members
async function offboard(email: string) {
  const people = await as<{ parties: { groups: { members: { membershipId: string; email: string; status: string }[] }[] }[] }>(
    'anika', 'GET', `/v1/workspaces/${ROOM_ID}/people`);
  const m = people.parties.flatMap((p) => p.groups).flatMap((g) => g.members).find((x) => x.email === email && x.status !== 'revoked');
  if (m) await as('anika', 'POST', `/v1/workspaces/${ROOM_ID}/memberships/${m.membershipId}/revoke`);
}

test.describe('Sign-in tab with a real session', () => {
  test.use({ baseURL: SIGNIN });
  test.describe.configure({ timeout: 180_000 });

  test('manages trusted browsers, phone and sessions', async ({ page, browser }) => {
    const who = await onboard(page, 'a5');
    try {
      await page.context().clearCookies();
      await signInWithCode(page, who.email, PROFILE);
      await expect(page.getByRole('heading', { name: 'Enter the code from your authenticator app' })).toBeVisible();
      await expect(page.locator('#f-trust')).toBeChecked();
      const second = await freshTotp(who.secret, who.used);
      await typeCode(page, second);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(new RegExp(`${PROFILE}$`), { timeout: 30_000 });

      const other = await browser.newContext({ baseURL: SIGNIN });
      const otherPage = await other.newPage();
      await signInWithCode(otherPage, who.email, PROFILE);
      await typeCode(otherPage, await freshTotp(who.secret, second));
      await otherPage.locator('#f-trust').uncheck();
      await otherPage.getByRole('button', { name: 'Sign in' }).click();
      await expect(otherPage).toHaveURL(new RegExp(`${PROFILE}$`), { timeout: 30_000 });

      await page.goto(`${PROFILE}?tab=sign-in`);
      const tfa = page.locator('[data-row="two-factor"]');
      await expect(tfa.locator('.badge')).toHaveText('On');
      await expect(tfa).toContainText(/Authenticator app set up on \w{3} \d{1,2} \w{3} \d{4}\./);

      await expect(page.locator('.br').first()).toContainText('This browser');
      const mine = page.locator('.br', { hasText: 'This browser' });
      await expect(mine).toContainText('Trusted until');
      await mine.getByRole('button', { name: 'Stop trusting' }).click();
      await expect(page.locator('.toast')).toContainText('Stopped trusting');
      await expect(page.locator('.toast')).toContainText('It asks for the authenticator code at the next sign-in.');
      await expect(page.getByText('No trusted browsers. Every sign-in asks for the authenticator code.')).toBeVisible();

      await page.getByRole('button', { name: 'Move to a new phone' }).click();
      const dialog = page.getByRole('dialog', { name: 'Move to a new phone' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('new-phone-key')).toHaveText(/[A-Z2-7]{4}/);
      const key = (await dialog.getByTestId('new-phone-key').textContent())!.replace(/\s/g, '');
      expect(key).toMatch(/^[A-Z2-7]{16,}$/);
      const oldCode = await freshTotp(who.secret, second);
      await dialog.getByRole('group', { name: 'Code from your old phone' }).locator('input').first().click();
      await page.keyboard.type(oldCode);
      await dialog.getByRole('group', { name: 'Code from your new phone' }).locator('input').first().click();
      await page.keyboard.type(totp(key));
      await dialog.getByRole('button', { name: 'Move to the new phone' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.toast')).toContainText('Moved to your new phone');

      await page.getByRole('button', { name: 'Sign out everywhere' }).click();
      await expect(page.locator('.toast')).toContainText('Signed out everywhere else');
      await otherPage.goto(PROFILE);
      await expect(otherPage).toHaveURL(/\/sign-in/);
      await page.goto(`${PROFILE}?tab=sign-in`);
      await expect(page.locator('[data-row="two-factor"] .badge')).toHaveText('On');
      await other.close();
    } finally {
      await offboard(who.email);
    }
  });
});
