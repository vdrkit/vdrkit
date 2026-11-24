// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { DEV_TENANT_ID, PERSONAS } from '../src/dev-tools/personas';
import { API, invite, nextEmail } from './signin-helpers';

const ANIKA = PERSONAS.find((p) => p.key === 'anika')!.id;

test.skip(process.env.E2E_PROD === '1', 'The dev mailbox runs against next dev with the API');

test('renders an invitation with its plain text', async ({ page }) => {
  const since = Date.now() - 1000;
  const { email, link } = await invite('h3-mail');
  const mail = await nextEmail(email, since);

  expect(mail.subject).toBe('Invitation to the Project Heron data room');
  expect(mail.text).toContain(`Open the data room: ${link}`);
  expect(mail.text).toContain(`This invitation is for ${email} only and expires after 14 days.`);
  expect(mail.html).toContain('<meta name="color-scheme" content="light">');

  await page.setExtraHTTPHeaders({ 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': ANIKA });
  const res = await page.goto(`${API}/v1/dev/mailbox/view?to=${encodeURIComponent(email)}`);
  expect(res?.headers()['content-type']).toContain('text/html');
  await expect(page.getByText('Dear colleague,')).toBeVisible();
  await expect(page.getByText('Project Heron', { exact: true })).toBeVisible();
  await expect(page.locator('td[align="right"]').first()).toHaveText(/Project Heron\s*Invitation/);
  const button = page.getByRole('link', { name: 'Open the data room' });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('href', link);
  await expect(page.locator('td[style*="background:#13627A"] a')).toHaveCount(1);
  await expect(page.getByText(`This invitation is for ${email} only and expires after 14 days.`)).toBeVisible();
  await expect(page.getByText('Powered by VDRkit.', { exact: false })).toBeVisible();
  const remote = await page.locator('img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src).filter((s) => !s.startsWith('data:')));
  expect(remote).toEqual([]);
});

test('mailbox view requires dev headers', async ({ request }) => {
  const since = Date.now() - 1000;
  const { email } = await invite('h3-mail-gate');
  await nextEmail(email, since);
  const url = `${API}/v1/dev/mailbox/view?to=${encodeURIComponent(email)}`;
  const open = await request.get(url, { headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': ANIKA } });
  expect(open.status()).toBe(200);
  expect(await open.text()).toContain('Dear colleague,');

  const closed = await request.get(url);
  expect(closed.ok()).toBe(false);
  const body = await closed.text();
  expect(body).not.toContain('Dear colleague,');
  expect(body).not.toContain(email);
});
