// SPDX-License-Identifier: AGPL-3.0-only
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, Page } from '@playwright/test';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';
import { expectNoAxeViolations, expectVisibleFocus } from './a11y-helpers';
import { pdf, writeTree } from './import-files';
import { API_URL, expect, hydrated, PERSONAS, ROOM_ID, roomPath, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');
test.describe.configure({ timeout: 120_000 });

const DIR = fileURLToPath(new URL('../test-results/a11y-retry-files', import.meta.url));
const W = `${API_URL}/v1/workspaces/${ROOM_ID}`;
const headers = { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': PERSONAS.find((p) => p.key === 'anika')!.id };

async function folder10(request: APIRequestContext): Promise<string> {
  const r = await request.get(`${W}/nodes`, { headers });
  return (await r.json()).items.find((n: { indexNumber: string }) => n.indexNumber === '10').id;
}

// mocks the upload; the first `fails` part uploads get a 503
async function standIn(page: Page, sid: string, fails: number) {
  let puts = 0;
  await page.route('**/upload-sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      id: sid, method: 'presigned', partSize: 10_000_000, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      parts: [{ partNumber: 1, url: `/__store/${sid}` }] }) });
  });
  await page.route(`**/upload-sessions/${sid}`, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      id: sid, status: 'open', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), method: 'presigned', size: 1, partSize: 10_000_000,
      received: [], parts: [{ partNumber: 1, url: `/__store/${sid}` }] }) });
  });
  await page.route(`**/upload-sessions/${sid}/complete`, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      nodeId: '5b0c4c39-3f43-4c1e-9a55-0d8c1f5e2c01', versionId: '6b0c4c39-3f43-4c1e-9a55-0d8c1f5e2c02', versionNo: 1, indexNumber: '10.98', createdFolders: [] }) });
  });
  await page.route('**/__store/**', async (route) => {
    if (++puts <= fails) return route.fulfill({ status: 503, body: '' });
    await route.fulfill({ status: 200, headers: { etag: '"e1"' }, body: '' });
  });
}

const inDialog = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));

test('Add files retry is accessible by keyboard', async ({ page, persona, request }) => {
  await persona('anika');
  // first try plus three automatic retries fail
  await standIn(page, '9d0c4c39-3f43-4c1e-9a55-0d8c1f5e2c00', 4);
  await page.goto(roomPath('documents', await folder10(request)));
  await hydrated(page);
  await page.getByRole('button', { name: 'Choose files' }).click();
  const dialog = page.getByRole('dialog');
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Browse your computer' }).click();
  const name = `A11y retry ${Date.now()}.pdf`;
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: pdf(name) });
  const add = dialog.getByRole('button', { name: 'Add 1 file as a draft' });
  await expect(add).toBeEnabled();
  await add.focus();
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');

  const countdown = dialog.getByTestId('retrying');
  await expect(countdown).toHaveText(/· trying again in \d+ s$/);
  await expect(countdown).toHaveAttribute('aria-hidden', 'true');
  const live = dialog.locator('p.sr-only[aria-live="polite"]');
  await expect(live).toContainText('Connection problem. Trying again by itself in a few seconds.');
  const said = await live.textContent();
  const shown = await countdown.textContent();
  await expect(countdown).not.toHaveText(shown!);
  expect(await live.textContent(), 'the live line does not change with each second').toBe(said);
  expect(await inDialog(page)).toBe(true);
  await expectNoAxeViolations(page, 'Add files while it waits to try again');

  const again = dialog.getByRole('button', { name: 'Try again (1 file)' });
  await expect(again).toBeVisible({ timeout: 45_000 });
  expect(await inDialog(page)).toBe(true);
  await expectNoAxeViolations(page, 'the Done step with Try again');
  for (let i = 0; i < 20 && !(await again.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(again).toBeFocused();
  await expectVisibleFocus(page);
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.okbox')).toContainText('1 file is in 10 ');
  await expect(dialog.getByRole('button', { name: /Try again/ })).toHaveCount(0);
  expect(await inDialog(page)).toBe(true);
  await expectNoAxeViolations(page, 'the Done step after Try again');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Bulk import announces the retry once, not the percentage', async ({ page, persona, request }) => {
  await persona('anika');
  await standIn(page, '9d0c4c39-3f43-4c1e-9a55-0d8c1f5e2c10', 2);
  const stamp = Date.now();
  const root = writeTree(DIR, `A11y_${stamp}`, { [`Set ${stamp}/Retry check.pdf`]: pdf(`A11y retry ${stamp}`) });
  try {
    await page.goto(roomPath('import') + `?into=${await folder10(request)}`);
    await page.getByTestId('d1-folder').setInputFiles(root);
    await expect(page.getByRole('heading', { name: 'Check the index before you upload' })).toBeVisible();
    await page.locator('#go-up').click();

    await expect(page.locator('#eta')).toContainText('trying again in', { timeout: 20_000 });
    const live = page.getByRole('region', { name: 'Upload progress' }).locator('p.sr-only[aria-live="polite"]');
    await expect(live).toHaveText('Connection problem. Trying again by itself in a few seconds.');
    await expect(page.locator('#pct')).not.toHaveAttribute('aria-live', /.+/);
    await expect(page.locator('#eta')).not.toHaveAttribute('aria-live', /.+/);
    await expectNoAxeViolations(page, 'Bulk import while it waits to try again');
    await expect(page.getByRole('heading', { name: '1 file uploaded as drafts' })).toBeVisible({ timeout: 45_000 });
    await expectNoAxeViolations(page, 'Bulk import done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
