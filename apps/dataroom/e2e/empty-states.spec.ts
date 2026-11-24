// SPDX-License-Identifier: AGPL-3.0-only
import type { APIRequestContext, Page } from '@playwright/test';
import { API_URL, expect, hydrated, ROOM_ID, roomPath, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Empty states run against next dev with the API');

const DEV = { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001' };
const ANIKA = 'a369f772-bdd8-4e7f-a614-11dc069feb12';

async function call<T = any>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(`${API_URL}/v1${path}`, {
    method, headers: { ...DEV, 'x-dev-person': ANIKA, ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { data } : {}),
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

// room names are unique per person
async function newRoom(request: APIRequestContext, start: 'empty' | 'standard'): Promise<{ id: string; name: string }> {
  const name = `Empty states ${start} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const { id } = await call<{ id: string }>(request, 'POST', '/workspaces', { name, timeZone: 'Africa/Johannesburg', start });
  return { id, name };
}

async function folderId(request: APIRequestContext, ws: string, ix: string): Promise<string> {
  const shell = await call<{ index: { id: string; indexNumber: string | null }[] }>(request, 'GET', `/workspaces/${ws}/shell`);
  return shell.index.find((f) => f.indexNumber === ix)!.id;
}

const empty = (page: Page) => page.locator('main .empty').first();

test.describe('empty room', () => {
  test('dashboard checklist', async ({ page, persona, request }) => {
    const room = await newRoom(request, 'empty');
    await persona('anika');
    await page.goto(`/rooms/${room.id}/dashboard`);
    const c1 = page.locator('[data-dashboard="new-room"]');
    await expect(c1.getByRole('heading', { level: 1 })).toHaveText(`Get ${room.name} ready`);
    await expect(c1.locator('.ready h2')).toHaveText('1 of 7 done');
    await expect(c1.locator('.steps2 li.done')).toContainText('without folders.');
    await expect(c1.locator('.steps2 .btn')).toHaveText(['Bulk import', 'Go to People', 'Go to Permissions', 'Open NDA settings', 'Release review', 'Open the room']);
    await expect(c1.getByRole('link', { name: 'Release review' })).toHaveAttribute('href', `/rooms/${room.id}/release`);
  });

  test('documents offers the standard index', async ({ page, persona, request }) => {
    const room = await newRoom(request, 'empty');
    await persona('anika');
    await page.goto(`/rooms/${room.id}/documents`);
    await hydrated(page);
    await expect(page.locator('main h1')).toHaveText('Documents');
    await expect(page.locator('main .head .sub')).toHaveText('No documents yet. The room was created without a folder structure.');
    await expect(empty(page).locator('h2')).toHaveText('Drop a folder here to start');
    await expect(empty(page).getByRole('button')).toHaveText(['Choose a folder', 'New folder']);
    await expect(page.locator('.side .stree')).toBeHidden();
    await expect(page.locator('main p.sub').last()).toContainText('Prefer a ready-made structure? Create the folders from the standard M&A index (11 folders, 40 subfolders) in one click.');
    await page.getByRole('button', { name: 'Use the standard index' }).click();
    await expect(page.locator('main a.fo')).toHaveCount(11);
    await expect(page.locator('main a.fo').first()).toContainText('Corporate');
    await expect(page.locator('.side .stree')).toBeVisible();
    await page.goto(`/rooms/${room.id}/dashboard`);
    await expect(page.locator('[data-dashboard="new-room"] .steps2 li.done')).toContainText('with the standard M&A index of 11 folders.');
  });

  test('admin screens without folders', async ({ page, persona, request }) => {
    const room = await newRoom(request, 'empty');
    await persona('anika');

    await page.goto(`/rooms/${room.id}/release`);
    await expect(empty(page).locator('h2')).toHaveText('Nothing waiting for release');
    await expect(empty(page).getByRole('link')).toHaveText('Go to Documents');

    await page.goto(`/rooms/${room.id}/people`);
    await expect(empty(page).locator('h2')).toHaveText('No bidder groups yet');
    await expect(empty(page).locator('p')).toHaveText('Create one group per bidder, such as Orrinby Capital. You then add its people and choose a lead, who can ask for colleagues to be added.');
    await expect(empty(page).getByRole('button')).toHaveText('Create a bidder group');

    await page.goto(`/rooms/${room.id}/timeline`);
    await expect(empty(page).locator('h2')).toHaveText('No dates yet');
    await expect(empty(page).getByRole('button')).toHaveText('Add a phase');

    await page.goto(`/rooms/${room.id}/permissions`);
    await expect(empty(page).locator('h2')).toHaveText('No folders yet');
    await expect(empty(page).getByRole('link')).toHaveText('Go to Documents');
    await expect(empty(page).getByRole('link')).toHaveAttribute('href', `/rooms/${room.id}/documents`);
  });
});

test.describe('room with the standard index', () => {
  test('empty folder', async ({ page, persona, request }) => {
    const room = await newRoom(request, 'standard');
    const finance = await folderId(request, room.id, '3');
    await call(request, 'POST', `/workspaces/${room.id}/groups`, {
      name: 'Orrinby Capital', newParty: { name: 'Orrinby Capital', kind: 'bidder' }, access: [{ nodeId: finance, level: 20 }],
    });
    await persona('anika');
    await page.goto(`/rooms/${room.id}/documents/${await folderId(request, room.id, '3.5')}`);
    await expect(page.locator('main h1')).toHaveText('3.5Treasury');
    await expect(page.locator('main .head .sub')).toHaveText('Visible to Orrinby Capital once documents are published.');
    await expect(page.locator('main .head .acts .btn')).toHaveText(['New subfolder', 'Upload files']);
    await expect(empty(page).locator('h2')).toHaveText('This folder is empty');
    await expect(empty(page).locator('p')).toHaveText('Drop files here. They are numbered 3.5.1, 3.5.2 and so on, and arrive as drafts for Release review.');
    await expect(empty(page).getByRole('button')).toHaveText('Upload files');
  });

  test('Permissions without groups', async ({ page, persona, request }) => {
    const room = await newRoom(request, 'standard');
    await persona('anika');
    await page.goto(`/rooms/${room.id}/permissions`);
    await hydrated(page);
    await expect(empty(page).locator('h2')).toHaveText('No bidder groups yet');
    await expect(empty(page).getByRole('link')).toHaveText('Go to People');
    await page.getByRole('tab', { name: /Seller team/ }).click();
    await expect(empty(page).locator('h2')).toHaveText('No seller team groups yet');
    await expect(empty(page).getByRole('link')).toHaveAttribute('href', `/rooms/${room.id}/people`);
  });

  test('bidder before anything is published', async ({ page, persona, request }) => {
    const room = await newRoom(request, 'standard');
    const group = await call<{ id: string }>(request, 'POST', `/workspaces/${room.id}/groups`, {
      name: 'Orrinby Capital', newParty: { name: 'Orrinby Capital', kind: 'bidder' }, access: [{ nodeId: await folderId(request, room.id, '3'), level: 20 }],
    });
    await call(request, 'PATCH', `/workspaces/${room.id}/settings`, { state: 'open' });
    await persona('anika');
    const asTeam = `${room.id}~${group.id}`;

    await page.goto(`/rooms/${asTeam}/documents`);
    await expect(empty(page).locator('h2')).toHaveText('No documents shared with Orrinby Capital yet');
    await expect(empty(page).locator('p')).toContainText('The seller is still preparing the documents. We email you when the first ones are published');

    await page.goto(`/rooms/${asTeam}/dashboard`);
    const c1 = page.locator('[data-dashboard="waiting"]');
    await expect(c1.locator('.empty h2')).toHaveText('No documents shared with Orrinby Capital yet');
    await expect(c1.getByRole('link', { name: 'Change how you are told' })).toBeVisible();

    await page.goto(`/rooms/${asTeam}/search?q=lease`);
    await expect(page.locator('.c4 .empty h2')).toHaveText('No documents shared with Orrinby Capital yet');
    await expect(page.locator('.c4 .empty p')).toHaveText('There is nothing to search yet. Search covers the names and text of documents once they are shared with you.');
  });
});

test.describe('Project Heron', () => {
  test('search without results', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(`${roomPath('search')}?q=${encodeURIComponent('lease agreement Durban')}`);
    const none = page.locator('.c4 .empty.none');
    await expect(none.locator('h2')).toHaveText('No documents match “lease agreement Durban”');
    await expect(none.locator('p')).toHaveText(/^Search looks inside the text of the [\d,]+ documents shared with Bidder A\.$/);
    await expect(none.locator('.tips li').first()).toHaveText('Use fewer words. Every word must appear in the document.');
    await expect(none.getByRole('button', { name: 'Search for “lease Durban”' })).toBeVisible();
  });

  test('activity without matches', async ({ page, persona, request }) => {
    const summary = await call<{ groups: { id: string; name: string }[] }>(request, 'GET', `/workspaces/${ROOM_ID}/activity/summary`);
    const fin = summary.groups.find((g) => g.name === 'Bidder C financiers')!;
    await persona('anika');
    await page.goto(`${roomPath('activity')}?kind=download&group=${fin.id}`);
    await hydrated(page);
    const es = page.locator('.f1 .empty.es');
    await expect(es.locator('h2')).toHaveText('No activity matches these filters');
    await expect(es.locator('p')).toHaveText('Bidder C financiers has not downloaded anything in the last 7 days.');
    await es.getByRole('button', { name: 'Clear the filters' }).click();
    await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.ev').first()).toBeVisible();

    // observers see only part of the log
    await persona('liesl');
    await page.goto(`${roomPath('activity')}?kind=download&group=${fin.id}`);
    await hydrated(page);
    await expect(es.locator('h2')).toHaveText('No activity matches these filters');
    await expect(es.locator('p')).toHaveText('Nothing in the log fits every filter you chose. Clear a filter to see more.');
  });

  // bell is hidden behind SHOW_BELL in NotificationsButton.tsx
  test('no notification bell yet', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    await hydrated(page);
    await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveCount(0);
    await page.getByRole('button', { name: /^Account menu/ }).click();
    await expect(page.getByRole('menuitem', { name: /Profile and notifications/ })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.goto('/rooms');
    await expect(page.getByRole('heading', { name: 'My rooms' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveCount(0);
    await expect(async () => {
      if (!(await page.getByRole('menu').isVisible())) await page.getByRole('button', { name: /^Account menu/ }).click();
      await expect(page.getByRole('menuitem', { name: /Profile and notifications/ })).toBeVisible({ timeout: 1000 });
    }).toPass();
  });

  test('fits 400px', async ({ page, persona, request }) => {
    await page.setViewportSize({ width: 400, height: 860 });
    const room = await newRoom(request, 'empty');
    await persona('anika');
    await page.goto(`/rooms/${room.id}/documents`);
    await hydrated(page);
    await expect(empty(page).locator('h2')).toHaveText('Drop a folder here to start');
    const box = await empty(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(16);
    expect(box!.x + box!.width).toBeLessThanOrEqual(400 - 16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
  });
});
