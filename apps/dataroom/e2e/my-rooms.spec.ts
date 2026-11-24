// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { API_URL, expect, roomPath, ROOM_ID, test } from './fixtures';
import { dayWithYear, LONDON, SAST } from './demo-dates';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';

test.skip(process.env.E2E_PROD === '1', 'My rooms runs against next dev with the API');

// demo seed ids
function stableId(key: string): string {
  const h = createHash('sha256').update(`vdrkit-demo:${DEV_TENANT_ID}:${key}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const WEAVER = stableId('workspace:weaver');
const MARLIN = stableId('workspace:marlin');
const KINGFISHER = stableId('workspace:kingfisher');
const THANDI = stableId('person:thandi');

type Page = import('@playwright/test').Page;
const cards = (page: Page, section: 'Your rooms' | 'Past rooms') =>
  page.getByRole('region', { name: section }).locator('.rc');
// exact match; other specs create rooms like "Project Osprey 1794681102547"
const cardOf = (page: Page, section: 'Your rooms' | 'Past rooms', name: string) =>
  cards(page, section).filter({ has: page.locator('.nm b', { hasText: new RegExp(`^${name}$`) }) });

test('room admin sees her rooms', async ({ page, persona }) => {
  await persona('anika');
  await page.goto('/rooms');
  await expect(page.getByRole('heading', { name: 'My rooms', level: 1 })).toBeVisible();
  await expect(page.locator('.side .nav')).toContainText('Create a room');
  await expect(page.locator('.side .nav .sec')).toHaveText('Administration');
  await expect(page.locator('.side .nav')).toContainText('Server settings');
  await expect(page.locator('.side .user')).toContainText('Room and site admin · Quillmont Advisory');
  await expect(page.locator('.sub')).toContainText('You go straight to Project Heron when you sign in.');

  // other specs add rooms, so don't count them
  const heron = cardOf(page, 'Your rooms', 'Project Heron');
  await expect(heron).toContainText('Drosvelt Holdings');
  await expect(heron).toContainText('You are Room admin');
  await expect(heron.locator('.badge')).toHaveText('Open');
  await expect(async () => {
    const rooms = (await (await page.request.get('/v1/me/rooms')).json()).rooms as { name: string; attention: { draftsWaiting: number } }[];
    const drafts = rooms.find((r) => r.name === 'Project Heron')!.attention.draftsWaiting;
    await page.reload();
    expect(await heron.innerText()).toContain(`${drafts.toLocaleString('en-GB')} drafts waiting in Release review`);
  }).toPass({ timeout: 30_000 });
  await expect(heron.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(cards(page, 'Your rooms').first().locator('.nm b')).toHaveText('Project Heron');
  for (const text of await cards(page, 'Your rooms').allTextContents()) {
    for (const m of text.matchAll(/· (\d+) days/g)) expect(Number(m[1])).toBeLessThanOrEqual(7);
  }
  const osprey = cardOf(page, 'Your rooms', 'Project Osprey');
  await expect(osprey).toContainText('Bidders cannot sign in yet');
  await expect(osprey).toContainText('12 drafts waiting in Release review');
  await expect(osprey.locator('.badge')).toHaveText('Preparing');
  const falcon = cardOf(page, 'Your rooms', 'Project Falcon');
  await expect(falcon).toContainText(/Signing (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}( \d{4})?\. Nobody can upload or publish/);
  await expect(falcon.locator('.badge')).toHaveText('Frozen');
  await expect(page.locator('.side .nav a.on')).toContainText('My rooms');

  const past = cards(page, 'Past rooms');
  await expect(past).toHaveCount(1);
  await expect(past).toContainText(`Closed ${dayWithYear('2026-10-30T15:00:00Z', SAST)}`);
  await expect(page.getByRole('region', { name: 'Past rooms' })).toContainText('Closed rooms stay here for the archive export');
  await past.getByRole('link', { name: /Open the archive/ }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${KINGFISHER}/dashboard$`));
});

test('filters rooms by name', async ({ page, persona }) => {
  await persona('anika');
  await page.goto('/rooms');
  const box = page.getByRole('textbox', { name: 'Find a room' });
  await expect(cardOf(page, 'Your rooms', 'Project Falcon')).toHaveCount(1);
  await box.fill('kwartsrand eng');
  await expect(cards(page, 'Your rooms')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Past rooms' })).toHaveCount(0);
  await box.fill('kingfisher');
  await expect(page.getByRole('region', { name: 'Your rooms' })).toContainText('No rooms match “kingfisher”.');
  await expect(cards(page, 'Past rooms')).toHaveCount(1);
});

test('single-room person goes straight into the room', async ({ page, persona }) => {
  await persona('pieter');
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/dashboard$`));
  await expect(page.locator('.side .room .sw')).toHaveCount(0);
  await page.goto('/rooms');
  await expect(cards(page, 'Your rooms')).toHaveCount(1);
  await expect(page.locator('.side .nav')).not.toContainText('Create a room');
  await expect(page.locator('.side .nav')).not.toContainText('Server settings');
});

test('observer sees no drafts or requests', async ({ page, persona }) => {
  await persona('liesl');
  await page.goto('/rooms');
  const heron = cards(page, 'Your rooms');
  await expect(heron).toHaveCount(1);
  await expect(heron).toContainText('Drosvelt Holdings');
  await expect(heron).toContainText('You are Heron management · Member');
  await expect(heron).not.toContainText('Release review');
  await expect(heron).not.toContainText('request');
});

test('publisher sees drafts to release', async ({ page, persona }) => {
  await persona('johan');
  await page.goto('/rooms');
  await expect(cards(page, 'Your rooms')).toContainText(/\d+ drafts waiting in Release review/);
});

test('financier sees only his own subgroup', async ({ page, persona }) => {
  await persona('lars');
  await page.goto('/rooms');
  const heron = cardOf(page, 'Your rooms', 'Project Heron');
  await expect(heron).toContainText('Run by Quillmont Advisory');
  await expect(heron).toContainText('You are Bidder C financiers · Member');
  await expect(page.locator('.b1')).not.toContainText(/Bidder [AB]|Drosvelt Holdings|Release review/);
  await expect(page.locator('.side .nav')).not.toContainText('Create a room');
});

test('refuses the room list without a session', async ({ playwright }) => {
  const anon = await playwright.request.newContext();
  const res = await anon.get(`${API_URL}/v1/me/rooms`);
  expect(res.status()).toBe(401);
  expect(await res.text()).not.toMatch(/Project|Heron/);
  await anon.dispose();
});

test('ended access shows not available', async ({ page, persona }) => {
  await persona('jan');
  await page.goto('/rooms');
  const past = cards(page, 'Past rooms');
  await expect(past).toHaveCount(1);
  await expect(past).toContainText('Project Marlin');
  await expect(past.locator('.badge')).toHaveText('Access ended');
  await expect(past).toContainText(`Your access ended ${dayWithYear('2026-10-01T00:00:00Z', LONDON)}`);
  await expect(past).toContainText('You can no longer open it');
  await expect(past.getByRole('link')).toHaveCount(0);

  await page.goto(`/rooms/${MARLIN}/dashboard`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Project Marlin');
  await expect(page.getByRole('link', { name: 'Go to my rooms' })).toHaveAttribute('href', '/rooms');
});

test('hides rooms the person never belonged to', async ({ page, persona }) => {
  await persona('pieter');
  await page.goto(`/rooms/${WEAVER}/dashboard`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Project Weaver');
  await page.goto('/rooms');
  await expect(page.locator('.b1')).not.toContainText('Weaver');
  const api = await page.request.get('/v1/me/rooms');
  expect(JSON.stringify(await api.json())).not.toContain('Weaver');
});

// shared start-page state
test.describe.serial('a bidder in two rooms', () => {
  test('lands on My rooms', async ({ page, persona }) => {
    await persona('jan');
    await page.goto('/');
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.locator('.sub')).toContainText('You start here when you sign in.');
    const rooms = cards(page, 'Your rooms');
    await expect(rooms).toHaveCount(2);
    const heron = rooms.filter({ hasText: 'Project Heron' });
    await expect(heron).toContainText('Run by Quillmont Advisory');
    await expect(heron).toContainText('You are Bidder A · Lead');
    await expect(heron).not.toContainText('Drosvelt Holdings');
    const weaver = rooms.filter({ hasText: 'Project Weaver' });
    await expect(weaver).toContainText('You are Bidder 2 · Member');
    // depends on his last visit, which other tests move
    const body = await (await page.request.get('/v1/me/rooms')).json();
    const fresh = body.rooms.find((r: { name: string }) => r.name === 'Project Weaver').attention.newDocuments.count as number;
    if (fresh > 0) await expect(weaver).toContainText(`${fresh} new document${fresh === 1 ? '' : 's'}`);
    else await expect(weaver).toContainText('Nothing new since your last visit');
    await expect(weaver).toContainText(/Management presentation (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}( \d{4})?, (09:00 GMT|10:00 BST)/);
    await expect(page.locator('.side .nav')).not.toContainText('Create a room');
    await expect(page.locator('.side .nav')).not.toContainText('Server settings');
    await expect(page.locator('.b1')).not.toContainText(/Bidder [BC]|Release review/);
  });

  test('Switch goes back to My rooms', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    const sw = page.locator('.side .room .sw');
    await expect(sw).toHaveText('Switch');
    await expect(async () => {
      await sw.click();
      await expect(page).toHaveURL(/\/rooms$/, { timeout: 3000 });
    }).toPass({ timeout: 30_000 });
    await cards(page, 'Your rooms').filter({ hasText: 'Project Weaver' }).getByRole('link', { name: /Open room/ }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${WEAVER}/dashboard$`));
    await expect(page.locator('.side .room')).toContainText('Project Weaver');
  });

  test('Open at sign-in sets the start page', async ({ page, persona }) => {
    await persona('jan');
    await page.goto('/rooms');
    const weaver = cards(page, 'Your rooms').filter({ hasText: 'Project Weaver' });
    const sw = weaver.getByRole('switch', { name: 'Open at sign-in' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    try {
      await expect(async () => {
        if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
        await expect(page.locator('.toast')).toContainText('Project Weaver opens at sign-in', { timeout: 3000 });
      }).toPass({ timeout: 30_000 });
      await expect(page.locator('.sub')).toContainText('You go straight to Project Weaver when you sign in.');
      await expect(weaver).toHaveClass(/home/);
      await page.goto('/');
      await expect(page).toHaveURL(new RegExp(`/rooms/${WEAVER}/dashboard$`));

      await page.goto('/rooms');
      await weaver.getByRole('switch').click();
      await expect(page.locator('.toast')).toContainText('You start on My rooms');
      await expect(weaver.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
      await page.goto('/');
      await expect(page).toHaveURL(/\/rooms$/);
    } finally {
      await page.request.put('/v1/me/open-at-sign-in', { data: { workspaceId: null } });
    }
  });

  test('ignores the start room once it is closed or preparing', async ({ page, persona, request }) => {
    await persona('jan');
    const setState = async (state: 'preparing' | 'open' | 'closed') => {
      const res = await request.patch(`${API_URL}/v1/workspaces/${WEAVER}/settings`, {
        headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': THANDI, 'content-type': 'application/json' }, data: { state } });
      expect(res.status()).toBe(200);
    };
    try {
      expect((await page.request.put('/v1/me/open-at-sign-in', { data: { workspaceId: WEAVER } })).status()).toBe(200);
      await setState('preparing');
      await page.goto('/');
      await expect(page).toHaveURL(/\/rooms$/);
      await expect(page.locator('.sub')).toContainText('You start here when you sign in.');
      const weaver = cardOf(page, 'Your rooms', 'Project Weaver');
      await expect(weaver).toContainText('Not open yet');
      await expect(weaver).not.toHaveClass(/home/);

      await setState('closed');
      await page.goto('/');
      await expect(page).toHaveURL(new RegExp(`${roomPath('dashboard')}$`));
      await page.goto('/rooms');
      await expect(page.locator('.sub')).toContainText('You start here when you sign in.');
      const past = page.getByRole('region', { name: 'Past rooms' });
      await expect(cardOf(page, 'Past rooms', 'Project Weaver')).toContainText('You can no longer open it');
      await expect(past).toContainText('Rooms where your access has ended');
      await expect(past).not.toContainText('archive export');
    } finally {
      await setState('open');
      await page.request.put('/v1/me/open-at-sign-in', { data: { workspaceId: null } });
    }
  });
});

test('opens the menu as a drawer on a phone', async ({ page, persona }) => {
  await persona('anika');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/rooms');
  await expect(page.locator('.side')).not.toBeInViewport();
  await expect(async () => {
    await page.getByRole('button', { name: 'Open the room menu' }).click();
    await expect(page.locator('.app')).toHaveClass(/mm-open/, { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.locator('.side .nav a.on')).toContainText('My rooms');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(wide).toBeLessThanOrEqual(390);
});
