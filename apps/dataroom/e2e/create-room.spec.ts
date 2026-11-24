// SPDX-License-Identifier: AGPL-3.0-only
import { expect, ROOM_ID, test, type PersonaKey } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Create a room runs against next dev with the API');

const PATH = '/rooms/new';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#13627A"/></svg>');

async function ready(page: import('@playwright/test').Page) {
  await expect(page.getByRole('heading', { name: 'Create a room', level: 1 })).toBeVisible();
  await expect(page.locator('#f-tz')).not.toHaveValue('');
  await page.waitForLoadState('networkidle');
}

test.describe('who sees Create a room', () => {
  test('room creator sees the screen', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(PATH);
    await ready(page);
    await expect(page.locator('.side .nav a[aria-current="page"]')).toHaveText(/Create a room/);
    await expect(page.locator('.side .nav')).toContainText('My rooms');
    await expect(page.locator('.side .nav')).toContainText('Server settings');
    await expect(page.locator('.crumbs')).toContainText('My rooms');
    await expect(page.locator('.over')).toHaveText('Quillmont Advisory');
    for (const h of ['The room', 'Where to start', 'Room admins']) await expect(page.getByRole('heading', { name: h, level: 2 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Create the room' })).toContainText('Bidders cannot enter yet');
    await expect(page.getByRole('button', { name: 'Create room' })).toBeVisible();
  });

  for (const who of ['maria', 'johan', 'jan', 'pieter', 'lars', 'liesl'] as PersonaKey[]) {
    test(`${who} gets not available`, async ({ page, persona }) => {
      await persona(who);
      await page.goto(PATH);
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
      await expect(page.getByText('Create a room')).toHaveCount(0);
      await page.goto('/rooms-that-do-not-exist');
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    });
  }

  test('API refuses a bidder', async ({ page, persona }) => {
    await persona('jan');
    // no page visit: it would count as a visit in the dashboard tests
    expect((await page.request.get('/v1/room-templates/standard')).status()).toBe(404);
    expect((await page.request.get('/v1/workspaces/name-check?name=Project%20Heron')).status()).toBe(404);
    expect((await page.request.post('/v1/workspaces', { data: { name: 'Project Snoop' } })).status()).toBe(404);
    expect((await (await page.request.get('/v1/me')).json()).canCreateRooms).toBe(false);
  });
});

test.describe('filling in the room', () => {
  test.beforeEach(async ({ page, persona }) => {
    await persona('anika');
    await page.goto(PATH);
    await ready(page);
  });

  test('requires a name and checks for duplicates', async ({ page }) => {
    const hint = page.locator('#name-hint');
    await page.locator('#f-name').fill('Project Heron');
    await page.waitForResponse((r) => r.url().includes('/v1/workspaces/name-check'));
    await expect(hint).toHaveText('Use a code name. It appears in emails, so it should not reveal the company.');
    await page.locator('#f-name').fill('');
    await page.getByRole('button', { name: 'Create room' }).click();
    await expect(hint).toHaveText('Give the room a name. Most deals use a code name.');
    await expect(page.locator('#f-name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));

    await page.locator('#f-name').fill('project   heron');
    await expect(hint).toHaveText('There is already a room called project heron. Choose another name.');
    await page.locator('#f-name').fill('Project Ibis');
    await expect(hint).toHaveText('Use a code name. It appears in emails, so it should not reveal the company.');
    await expect(page.locator('#logo-tile')).toHaveText('PI');
    await expect(page.locator('.cbar')).toContainText('Project Ibis is created with the standard index.');
  });

  test('previews the start options', async ({ page }) => {
    await expect(page.locator('.sub2 b')).toHaveText('Standard M&A index: 11 folders, 40 subfolders');
    await expect(page.locator('.sub2 .tree li')).toHaveCount(11);
    await expect(page.locator('.sub2 .tree li').first()).toContainText('Corporate · 6 subfolders');

    await page.getByRole('radio', { name: /Copy a room you run/ }).click();
    await expect(page.getByRole('radio', { name: /Copy a room you run/ })).toHaveAttribute('aria-checked', 'true');
    await page.locator('#f-from').selectOption({ label: 'Project Heron' });
    await expect(page.locator('#f-from option:checked')).toHaveText('Project Heron');
    for (const c of ['Folder structure and numbers', 'Room settings', 'NDA', 'Invitation email']) {
      await expect(page.getByRole('checkbox', { name: new RegExp(`^${c}`) })).toBeChecked();
    }
    await expect(page.getByRole('checkbox', { name: /^Seller team groups/ })).not.toBeChecked();
    await expect(page.locator('.sub2')).toContainText('Bidder groups, people, documents and activity are never copied.');
    await expect(page.locator('.cbar')).toContainText('is created with a copy of Project Heron.');

    await page.getByRole('radio', { name: /Empty room/ }).click();
    await expect(page.locator('.sub2')).toHaveCount(0);
    await expect(page.locator('.cbar')).toContainText('is created with no folders.');
  });

  test('start options are a radio group', async ({ page }) => {
    const radios = page.getByRole('radio');
    await expect(radios.and(page.locator('[tabindex="0"]'))).toHaveCount(1);
    await page.getByRole('radio', { name: /Standard M&A index/ }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Copy a room you run/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: /Copy a room you run/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Empty room/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Standard M&A index/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('radio', { name: /Empty room/ })).toBeFocused();
  });

  test('confirms before opening the dashboard', async ({ page }) => {
    // hold the dashboard back so the confirmation stays up
    await page.route('**/v1/workspaces', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-4000-8000-0000000000b2', folders: 51, copied: null, invitedAdmins: [] }) })
      : route.continue());
    await page.route('**/rooms/00000000-0000-4000-8000-0000000000b2/**', () => undefined);
    await page.locator('#f-name').fill('Project Toast');
    await page.getByRole('button', { name: 'Create room' }).click();
    await expect(page.locator('.toast b')).toHaveText('Project Toast created');
    await expect(page.locator('.toast span')).toHaveText("Bidders cannot enter until you open it. Opening its dashboard. Next: upload documents, invite the seller team, then open the room to bidders. Logged in the room's activity log.");
  });

  test('hides server text on failure', async ({ page }) => {
    await page.route('**/v1/workspaces', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Internal', status: 500, detail: 'Internal error with SQL details' }) })
      : route.continue());
    await page.locator('#f-name').fill('Project Fails');
    await page.getByRole('button', { name: 'Create room' }).click();
    await expect(page.locator('.b2-fail')).toHaveText('The room was not created. Try again in a moment.');
    await expect(page.getByText('SQL')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  });

  test('adds and removes room admins', async ({ page }) => {
    const admins = page.getByRole('region', { name: 'Create the room' });
    await expect(page.locator('.adm').first()).toContainText('Anika Pillay');
    await expect(page.locator('.adm').first()).toContainText('You');
    await page.getByLabel('Add a room admin by email').fill('not-an-address');
    await page.getByRole('button', { name: 'Add as room admin' }).click();
    await expect(page.locator('.toast')).toContainText('Enter a complete email address');

    await page.getByLabel('Add a room admin by email').fill('co.adviser@seller.example.com');
    await page.getByLabel('Add a room admin by email').press('Enter');
    await expect(page.locator('.toast')).toContainText('Co Adviser added');
    await expect(page.locator('.toast')).toContainText('They get an invitation when you create the room.');
    const row = page.locator('.adm', { hasText: 'co.adviser@seller.example.com' });
    await expect(row.locator(':scope > div')).toHaveText(/^Co Adviser\s*co\.adviser@seller\.example\.com$/);
    await expect(row.locator('small')).toHaveText('co.adviser@seller.example.com');
    await expect(row.locator('.avatar.inv')).toHaveText('CA');
    await row.getByRole('button', { name: 'Remove co.adviser@seller.example.com' }).click();
    await expect(page.locator('.adm', { hasText: 'co.adviser@seller.example.com' })).toHaveCount(0);
    await expect(admins).toBeVisible();
  });

  test('takes light and dark logos', async ({ page }) => {
    await page.locator('input[data-logo="light"]').setInputFiles({ name: 'ibis.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.locator('#logo-tile img')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace the logo' })).toBeVisible();
    await page.locator('input[data-logo="dark"]').setInputFiles({ name: 'ibis-dark.svg', mimeType: 'image/svg+xml', buffer: SVG });
    await expect(page.locator('#logo-tile-dark img')).toBeVisible();
    const lightSrc = await page.locator('#logo-tile img').getAttribute('src');
    // CSP allows blob: for img, not connect-src
    expect(await page.evaluate((u) => new Promise<boolean>((done) => {
      const img = new Image();
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = u!;
    }), lightSrc)).toBe(true);
    await page.getByRole('button', { name: 'Remove the dark-mode version' }).click();
    await expect(page.locator('#logo-tile-dark')).toHaveCount(0);

    await page.locator('input[data-logo="dark"]').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(300 * 1024, 1) });
    await expect(page.locator('.fld.wide2 .hint')).toHaveText('The dark-mode logo is larger than 256 KB. Use a smaller image.');
  });

  test('Cancel creates nothing', async ({ page }) => {
    // stubbed so it does not count as a visit
    await page.route((url) => url.pathname === '/', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>My rooms</h1>' }));
    await page.locator('#f-name').fill('Project Never');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/\/$/);
    const rooms = await (await page.request.get('/v1/me/workspaces')).json();
    expect(rooms.items.map((r: { name: string }) => r.name)).not.toContain('Project Never');
  });
});

test('creates a room in Preparing and logs it', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(PATH);
  await ready(page);
  const name = `Project Ibis ${Date.now().toString(36)}`;
  await page.locator('#f-name').fill(name);
  await page.locator('#f-seller').fill('Ibis Packaging (Pty) Ltd');
  await page.locator('#f-tz').click();
  await page.locator('#f-tz').fill('london');
  await page.getByRole('option', { name: /London/ }).first().click();
  await expect(page.locator('#f-tz')).toHaveValue(/London/);
  await page.locator('input[data-logo="light"]').setInputFiles({ name: 'ibis.svg', mimeType: 'image/svg+xml', buffer: SVG });
  await page.getByLabel('Add a room admin by email').fill('co.adviser@seller.example.com');
  await page.getByRole('button', { name: 'Add as room admin' }).click();
  await expect(page.locator('#name-hint')).toHaveText('Use a code name. It appears in emails, so it should not reveal the company.');

  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}\/dashboard$/, { timeout: 45_000 });
  const ws = page.url().match(/\/rooms\/([0-9a-f-]{36})\//)![1]!;
  await expect(page.locator('.side .room b')).toHaveText(name);

  const shell = await (await page.request.get(`/v1/workspaces/${ws}/shell`)).json();
  expect(shell.room).toMatchObject({ name, state: 'preparing', timeZone: 'Europe/London' });
  const log = await (await page.request.get(`/v1/workspaces/${ws}/events?action=workspace.created`)).json();
  expect(log.items).toHaveLength(1);
  const folders = shell.index.filter((f: { parentId: string | null }) => !f.parentId);
  expect(folders).toHaveLength(11);
  expect((await page.request.get(`/v1/workspaces/${ws}/logo/light`)).headers()['content-type']).toBe('image/png');

  await persona('jan');
  await page.goto(`/rooms/${ws}/dashboard`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  await expect(page.getByText(name)).toHaveCount(0);
});

test('server-side duplicate check', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(PATH);
  await ready(page);
  // the live check never answers here
  await page.route('**/v1/workspaces/name-check**', () => undefined);
  await page.locator('#f-name').fill('Project Heron');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.locator('#name-hint')).toHaveText('There is already a room called Project Heron. Choose another name.');
  await expect(page).toHaveURL(new RegExp(`${PATH}$`));
});

test('copies folders but no bidders', async ({ page, persona }) => {
  await persona('anika');
  const heron = await (await page.request.get(`/v1/workspaces/${ROOM_ID}/shell`)).json();
  await page.goto(PATH);
  await ready(page);
  const name = `Project Kite ${Date.now().toString(36)}`;
  await page.locator('#f-name').fill(name);
  await page.getByRole('radio', { name: /Copy a room you run/ }).click();
  await page.locator('#f-from').selectOption({ label: 'Project Heron' });
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}\/dashboard$/, { timeout: 45_000 });
  const ws = page.url().match(/\/rooms\/([0-9a-f-]{36})\//)![1]!;
  const shell = await (await page.request.get(`/v1/workspaces/${ws}/shell`)).json();
  const top = (s: { index: { parentId: string | null; name: string }[] }) => s.index.filter((f) => !f.parentId).map((f) => f.name);
  expect(top(shell)).toEqual(top(heron));
  const log = await (await page.request.get(`/v1/workspaces/${ws}/events?action=workspace.created`)).json();
  expect(log.items).toHaveLength(1);
  const rooms = await (await page.request.get('/v1/me/workspaces')).json();
  expect(rooms.items.find((r: { id: string }) => r.id === ws)).toMatchObject({ state: 'preparing', isAdmin: true });
  const people = await (await page.request.get(`/v1/workspaces/${ws}/people`)).json() as
    { parties: { kind: string; groups: { members: { email?: string; name: string }[] }[] }[] };
  expect(people.parties.map((p) => p.kind)).toEqual(['seller']);
  expect(people.parties.flatMap((p) => p.groups.flatMap((g) => g.members.map((m) => m.name)))).toEqual(['Anika Pillay']);
});
