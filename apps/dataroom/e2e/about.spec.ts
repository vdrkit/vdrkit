// SPDX-License-Identifier: AGPL-3.0-only
import { expectNoAxeViolations } from './a11y-helpers';
import { API_URL, expect, roomPath, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Runs against next dev with the API');

const DEV = { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001', 'x-dev-person': 'a369f772-bdd8-4e7f-a614-11dc069feb12' };

test('shows version, licence and source link to a bidder', async ({ page, persona, request }) => {
  const api = await (await request.get(`${API_URL}/v1/about`, { headers: DEV })).json();
  expect(api.sourceUrl).toMatch(/^https?:\/\//);
  await persona('jan');
  await page.goto(roomPath('dashboard'));
  const btn = page.getByRole('button', { name: 'Account menu: profile, notification settings, about, sign out' });
  await btn.click();
  const item = page.getByRole('menuitem', { name: /^About and source code/ });
  await expect(item).toContainText('Shows the version and where to get the source code');
  await expect(page.getByRole('menu').getByRole('menuitem').last()).toHaveText(/^Sign out/);
  await item.click();

  const dialog = page.getByRole('dialog', { name: 'About and source code' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('VDRkit is free software under the GNU Affero General Public License, version 3. You may get its source code, change it and share it under the same licence.');
  await expect(dialog.locator('[data-about="version"]')).toHaveText(api.version);
  await expect(dialog).toContainText('GNU Affero General Public License v3.0 (AGPL-3.0-only)');
  const link = dialog.locator('[data-about="source"]');
  await expect(link).toHaveAttribute('href', api.sourceUrl);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveText(`${api.sourceUrl.replace(/^https?:\/\//, '')} (opens in a new tab)`);
  await expect(dialog.getByRole('button', { name: 'Close' }).last()).toBeFocused();
  await expectNoAxeViolations(page, 'About and source code');

  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(btn).toBeFocused();
});

test('works outside rooms', async ({ page, persona }) => {
  await persona('anika');
  await page.goto('/rooms');
  await page.getByRole('button', { name: /^Account menu/ }).click();
  await page.getByRole('menuitem', { name: /^About and source code/ }).click();
  const dialog = page.getByRole('dialog', { name: 'About and source code' });
  await expect(dialog.locator('[data-about="source"]')).toBeVisible();
  await expectNoAxeViolations(page, 'About and source code, outside rooms');
  await dialog.locator('.dw-f').getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens from the room menu drawer', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    await page.getByRole('button', { name: 'Open the room menu' }).click();
    await page.getByRole('button', { name: /^Account menu/ }).click();
    await page.getByRole('menuitem', { name: /^About and source code/ }).click();
    const dialog = page.getByRole('dialog', { name: 'About and source code' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-about="source"]')).toBeVisible();
    await expect(page.locator('.app')).not.toHaveClass(/mm-open/);
    const box = (await dialog.boundingBox())!;
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[role="dialog"]'), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
    await expectNoAxeViolations(page, 'About and source code on a phone');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open the room menu' })).toBeFocused();
  });
});

test('should link to the source code before sign-in', async ({ page, request }) => {
  const branding = await (await request.get(`${API_URL}/v1/branding`)).json();
  expect(branding.sourceCode).toEqual({ url: expect.stringMatching(/^https?:\/\//), licence: 'AGPL-3.0-only' });
  expect(branding.version).toBeUndefined();
  for (const path of ['/sign-in', '/signed-out', '/sign-in/expired']) {
    await page.goto(path);
    const link = page.locator('.pg-foot').getByRole('link', { name: 'Source code' });
    await expect(link, path).toHaveAttribute('href', branding.sourceCode.url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await page.goto('/sign-in');
  await expect(page.locator('.pg-foot')).toContainText('Powered by VDRkitSource code');
  await expectNoAxeViolations(page, 'the sign-in page with its Source code link');
});
