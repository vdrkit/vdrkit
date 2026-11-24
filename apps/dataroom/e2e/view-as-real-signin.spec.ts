// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from './fixtures';
import { onboard } from './signin-helpers';

test.describe.configure({ timeout: 150_000 });
test.skip(process.env.E2E_PROD === '1', 'The View as switcher exists under next dev with the API only');

test('real sign-in wins over View as', async ({ page, persona }) => {
  await persona('anika');
  await onboard(page, 'viewas', { here: true });
  await expect(page.locator('.user')).toContainText('Sanne Visser');
  await expect(page.locator('.user')).not.toContainText('Anika Pillay');
  const pill = page.locator('.proto');
  await expect(pill).toContainText('signed in as');
  await expect(pill).toContainText('Sanne Visser');
  await expect(pill.locator('select')).toHaveCount(0);
  const me = await page.request.get('/v1/me');
  expect((await me.json()).name).toBe('Sanne Visser');

  const item = page.getByRole('menuitem', { name: /Sign out/ });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole('button', { name: 'Account menu: profile, notification settings, about, sign out' }).click();
    await expect(item).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await item.click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/rooms');
  await expect(page.locator('.proto select')).toHaveCount(1);
  await expect(page.locator('.user')).toContainText('Anika Pillay');
});
