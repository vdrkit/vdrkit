// SPDX-License-Identifier: AGPL-3.0-only
import { expect, NODE, roomPath, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'The viewer runs against next dev with the API');

const viewPath = (id: string) => roomPath('view', id);

test('from the folder: Esc goes back to the folder', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(roomPath('documents', NODE['2.4']));
  await page.getByRole('link', { name: /Tarnley Logistics supply agreement/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`${viewPath(NODE['2.4.2'])}$`));
  await expect(page.locator('.doct h1')).toHaveText('Tarnley Logistics supply agreement');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`${roomPath('documents', NODE['2.4'])}$`));
  await expect(page.locator('.vroot')).toHaveCount(0);
});

test('from search results: Esc goes back to the search', async ({ page, persona }) => {
  await persona('jan');
  const results = `${roomPath('search')}?q=${encodeURIComponent('change of control')}`;
  await page.goto(results);
  await page.locator('a.hit').first().click();
  await expect(page.locator('.vroot')).toBeVisible();
  await page.locator('#canvas').focus();
  const first = page.url();
  if (await page.locator('[data-doc="1"]').isEnabled()) {
    await page.keyboard.press('j');
    await expect(page).not.toHaveURL(first);
    await expect(page.locator('.vroot')).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/search\?q=change(\+|%20)of(\+|%20)control/);
  await expect(page.locator('.vroot')).toHaveCount(0);
});

test('from the dashboard: Esc goes back to the dashboard', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(roomPath('dashboard'));
  const doc = page.locator('[data-dashboard] a.doc').first();
  await expect(doc, 'The seeded room should list new documents on the dashboard of Jan').toBeVisible();
  await doc.click();
  await expect(page.locator('.vroot')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`${roomPath('dashboard')}$`));
});

test('opened from outside the app: Esc goes to the folder', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(viewPath(NODE['2.4.2']));
  await expect(page.locator('.doct h1')).toHaveText('Tarnley Logistics supply agreement');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`${roomPath('documents', NODE['2.4'])}$`));
});

test('Esc closes open menus before the viewer', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(viewPath(NODE['2.4.2']));
  await expect(page.locator('.doct h1')).toHaveText('Tarnley Logistics supply agreement');

  await page.locator('#menu-btn').click();
  const menu = page.getByRole('dialog', { name: 'Room menu' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.vroot')).toBeVisible();

  await page.locator('#dl-btn').click();
  await expect(page.getByRole('dialog', { name: 'Download' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Download' })).toHaveCount(0);
  await expect(page.locator('.vroot')).toBeVisible();

  await page.locator('#theme-btn').click();
  await expect(page.getByRole('menu', { name: 'Theme' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Theme' })).toHaveCount(0);
  await expect(page.locator('#theme-btn')).toBeFocused();
  await expect(page.locator('.vroot')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`${roomPath('documents', NODE['2.4'])}$`));
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('Esc first closes the details drawer, then the viewer', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(viewPath(NODE['2.4.2']));
    await expect(page.locator('.doct h1')).toHaveText('Tarnley Logistics supply agreement');
    await page.locator('#info-btn').click();
    await expect(page.locator('#info')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#info')).toBeHidden();
    await expect(page.locator('.vroot')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`${roomPath('documents', NODE['2.4'])}$`));
  });
});
