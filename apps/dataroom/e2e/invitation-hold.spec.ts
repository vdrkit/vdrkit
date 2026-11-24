// SPDX-License-Identifier: AGPL-3.0-only
import type { APIRequestContext, Page } from '@playwright/test';
import { API_URL, clickAndRefresh, expect, hydrated, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const DEV = { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001' };
const ANIKA = 'a369f772-bdd8-4e7f-a614-11dc069feb12';
const unique = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function api<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(`${API_URL}${path}`, {
    method, headers: { ...DEV, 'x-dev-person': ANIKA, 'content-type': 'application/json' }, ...(data !== undefined ? { data } : {}),
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}
const mails = async (request: APIRequestContext, to: string) =>
  (await api<{ messages: { subject: string; text: string }[] }>(request, 'GET', `/v1/dev/mailbox?to=${encodeURIComponent(to)}`)).messages;
const row = (page: Page, email: string) => page.locator(`.mr[data-person="${email}"]`);
async function showPeople(page: Page, group: string) {
  const toggle = page.getByRole('button', { name: `Show the people in ${group}` });
  if (await toggle.count()) await toggle.click();
}

test('holds bidder invitations until the room opens', async ({ page, persona, request }) => {
  const u = unique();
  const { id: ws } = await api<{ id: string }>(request, 'POST', '/v1/workspaces', { name: `Invitation hold ${u}`, timeZone: 'Africa/Johannesburg', start: 'empty' });
  await api(request, 'POST', `/v1/workspaces/${ws}/groups`, { name: 'Orrinby Capital', newParty: { name: 'Orrinby Capital', kind: 'bidder' } });
  const first = `kofi-${u}@invitation-hold.example`;
  const second = `ama-${u}@invitation-hold.example`;

  await persona('anika');
  await page.goto(`/rooms/${ws}/people`);
  await hydrated(page);

  await page.getByRole('button', { name: 'Invite people', exact: true }).click();
  const inv = page.getByRole('dialog', { name: 'Invite people' });
  await expect(inv.locator('#iv-group')).toHaveValue(/.+/);
  await inv.locator('#iv-group').selectOption({ label: 'Orrinby Capital' });
  await inv.locator('#iv-lead').fill(first);
  await expect(inv.getByTestId('invite-waits')).toHaveText('The room is not open yet, so no email goes out now. The invitations are sent when you open the room in Settings.');
  await clickAndRefresh(page, inv.getByRole('button', { name: 'Invite 1 when the room opens' }));
  await expect(page.locator('.toast')).toContainText('1 invitation waits for the room to open');
  await expect(page.locator('.toast')).toContainText('They are sent when you open the room.');

  await showPeople(page, 'Orrinby Capital');
  const kofi = row(page, first);
  await expect(kofi).toContainText('Invitation waits for the room to open');
  await expect(kofi.getByRole('button', { name: /^Remind/ })).toHaveCount(0);
  expect(await mails(request, first)).toEqual([]);

  await page.getByRole('button', { name: 'New group' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.locator('#ng-name').fill(`Quorvane Partners ${u}`);
  await dlg.getByRole('button', { name: 'Next: access' }).click();
  await dlg.getByRole('button', { name: 'Next: people' }).click();
  await dlg.locator('#iv-lead').fill(second);
  await expect(dlg.getByRole('button', { name: 'Create without inviting' })).toBeVisible();
  await expect(dlg.getByTestId('invite-waits')).toBeVisible();
  await dlg.getByRole('button', { name: 'Create, invite 1 when the room opens' }).click();
  await expect(dlg.locator('.okbox')).toContainText('1 invitation waits for the room to open, and goes out when you open it.');
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  expect(await mails(request, second)).toEqual([]);

  await page.goto(`/rooms/${ws}/settings`);
  await hydrated(page);
  await page.getByRole('radio', { name: /^Open/ }).click();
  await expect(page.locator('.note.warn')).toContainText('2 invitations will be sent.');
  // frozen admits bidders, closed doesn't
  await page.getByRole('radio', { name: /^Closed/ }).click();
  await expect(page.locator('.note.warn')).not.toContainText('will be sent');
  await page.getByRole('radio', { name: /^Open/ }).click();
  const bar = page.getByRole('region', { name: 'Unsaved changes' });
  await clickAndRefresh(page, bar.getByRole('button', { name: 'Save changes' }));
  await expect(page.locator('.toast')).toContainText('2 invitations are being sent.');

  await expect.poll(async () => (await mails(request, first)).length, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await mails(request, second)).length, { timeout: 20_000 }).toBe(1);
  expect((await mails(request, first))[0]!.text).toMatch(/\/invite\/\S+/);

  await page.goto(`/rooms/${ws}/people`);
  await hydrated(page);
  await showPeople(page, 'Orrinby Capital');
  await expect(kofi).toContainText(/Invited .*, not signed in/);
  await expect(kofi.getByRole('button', { name: /^Remind/ })).toBeVisible();
});

test('sends seller invitations at once', async ({ page, persona, request }) => {
  const u = unique();
  const { id: ws } = await api<{ id: string }>(request, 'POST', '/v1/workspaces', { name: `Invitation hold seller ${u}`, timeZone: 'Africa/Johannesburg', start: 'empty' });
  const thandi = `thandi-${u}@invitation-hold.example`;
  await persona('anika');
  await page.goto(`/rooms/${ws}/people`);
  await hydrated(page);
  await page.getByRole('tab', { name: /Seller team/ }).click();
  await page.getByRole('button', { name: 'Invite people', exact: true }).click();
  const inv = page.getByRole('dialog', { name: 'Invite people' });
  await inv.locator('#iv-group').selectOption({ label: 'Room admins' });
  await inv.locator('#iv-mails').fill(thandi);
  await expect(inv.getByTestId('invite-waits')).toHaveCount(0);
  await clickAndRefresh(page, inv.getByRole('button', { name: 'Send 1 invitation' }));
  await expect(page.locator('.toast')).toContainText('1 invitation sent');
  await expect.poll(async () => (await mails(request, thandi)).length, { timeout: 10_000 }).toBe(1);
});
