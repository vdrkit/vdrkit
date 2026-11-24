// SPDX-License-Identifier: AGPL-3.0-only
import type { APIRequestContext } from '@playwright/test';
import { API_URL, expect, hydrated, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const DEV = { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001' };
const ANIKA = 'a369f772-bdd8-4e7f-a614-11dc069feb12';

async function newRoom(request: APIRequestContext): Promise<string> {
  const name = `NDA default ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const res = await request.fetch(`${API_URL}/v1/workspaces`, {
    method: 'POST', headers: { ...DEV, 'x-dev-person': ANIKA, 'content-type': 'application/json' },
    data: { name, timeZone: 'Africa/Johannesburg', start: 'empty' },
  });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).id;
}

test('publishing the first NDA turns on "Ask for the NDA"', async ({ page, persona, request }) => {
  const ws = await newRoom(request);
  await persona('anika');
  await page.goto(`/rooms/${ws}/dashboard`);
  const steps = page.locator('.steps2 li');
  const step5 = steps.nth(4);
  await expect(step5).toContainText('Ask for the NDA');
  await expect(step5).toContainText('Bidders accept it before they see a document.');
  await expect(step5).not.toHaveClass(/done/);
  await expect(page.locator('.ready h2')).toHaveText('1 of 7 done');

  const go = step5.getByRole('link', { name: 'Open NDA settings' });
  await expect(go).toHaveAttribute('href', `/rooms/${ws}/settings?tab=nda`);
  await go.click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ws}/settings\\?tab=nda$`));
  await hydrated(page);
  await expect(page.getByRole('tab', { name: 'NDA' })).toHaveAttribute('aria-selected', 'true');
  const ask = page.getByRole('switch', { name: 'Ask for the NDA' });
  await expect(ask).toHaveAttribute('aria-checked', 'false');
  await expect(ask).toBeDisabled();

  await page.getByRole('button', { name: 'Publish the first version' }).click();
  const dlg = page.getByRole('dialog', { name: 'Publish NDA version 1' });
  await expect(dlg).toContainText('Publishing it turns on Ask for the NDA.');
  await dlg.getByLabel('Name', { exact: true }).fill('NDA default NDA');
  await dlg.getByLabel('Text of the agreement').fill('Confidentiality undertaking for the NDA default room, clauses 1 to 12.');
  await dlg.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('NDA version 1 published');
  await expect(page.locator('.toast')).toContainText('Ask for the NDA is now on');
  await expect(ask).toHaveAttribute('aria-checked', 'true');
  await expect(ask).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Ask for the NDA' })).toHaveAttribute('aria-checked', 'true');

  await page.goto(`/rooms/${ws}/dashboard`);
  await expect(step5).toHaveClass(/done/);
  await expect(step5.getByRole('link')).toHaveCount(0);
  await expect(page.locator('.ready h2')).toHaveText('2 of 7 done');
});
