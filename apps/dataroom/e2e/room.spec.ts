// SPDX-License-Identifier: AGPL-3.0-only
import { API_URL, expect, NODE, roomPath, ROOM_ID, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

test('opens the room of the current persona', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/dashboard$`));
  await expect(page.locator('.crumbs')).toContainText('Project Heron');
  await expect(page.locator('[data-dashboard] h1')).toBeVisible();
});

test('room admin sees administration, counts and the index', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(roomPath('documents', NODE['2.4']));
  await expect(page.locator('.user .avatar')).toHaveText('AP');
  await expect(page.locator('.nav .sec')).toHaveText('Administration');
  await expect(page.locator('.nav a.on')).toContainText('1,248');
  await expect(page.locator('.stree .sf.on')).toContainText('Material contracts');
  await expect(page.locator('.crumbs')).toContainText('2 Legal');
  await expect(page.locator('.proto')).toBeVisible();
});

test('bidder lead sees no administration or other bidders', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(roomPath('dashboard'));
  await expect(page.locator('.user')).toContainText('Bidder A · Lead');
  await expect(page.locator('.nav .sec')).toHaveCount(0);
  await expect(page.locator('.side .room')).toContainText('Run by Quillmont Advisory');
  await expect(page.locator('body')).not.toContainText('Bidder B');
  await expect(page.locator('.clock')).toContainText('GMT');
});

test('switching persona reloads the page', async ({ page }) => {
  await page.goto(roomPath('dashboard'));
  await page.locator('.proto select').selectOption('pieter');
  await expect(page.locator('.user')).toContainText('Pieter Nel', { timeout: 30_000 });
});

test('index rows open their folder', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(roomPath('documents'));
  await page.locator('.stree .sf', { hasText: 'Finance' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/documents/${NODE['3']}$`), { timeout: 30_000 });
  await expect(page.locator('.content h1')).toHaveText('3Finance');
});

test('hidden documents are not found', async ({ page, persona }) => {
  await persona('lars');   // Bidder C financiers see 3 Finance only
  const res = await page.goto(roomPath('view', NODE['2.4.2']));
  expect(res?.status()).toBe(404);
  await persona('jan');
  const ok = await page.goto(roomPath('view', NODE['2.4.2']));
  expect(ok?.status()).toBe(200);
  await expect(page.locator('.doct')).toContainText('2.4.2');
  await expect(page.locator('.doct h1')).toHaveText('Tarnley Logistics supply agreement');
});

test('dev proxy serves watermarked pages', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(roomPath('dashboard'));
  const opened = await page.request.post(`/v1/workspaces/${ROOM_ID}/nodes/${NODE['2.4.2']}/open`);
  expect(opened.status()).toBe(200);
  const { sessionId, pageCount } = await opened.json();
  expect(pageCount).toBeGreaterThanOrEqual(3);
  const img = await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes/${NODE['2.4.2']}/pages/1?session=${sessionId}`);
  expect(img.headers()['content-type']).toBe('image/webp');
  expect((await img.body()).length).toBeGreaterThan(20_000);
});

test('API refuses calls without dev headers', async ({ request }) => {
  const res = await request.get(`${API_URL}/v1/me/workspaces`);
  expect(res.status()).toBe(401);
});
