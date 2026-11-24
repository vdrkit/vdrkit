// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expect, hydrated, NODE, roomPath, ROOM_ID, setPersona, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const menu = (page: Page) => page.locator('nav.nav a').allTextContents().then((xs) => xs.map((x) => x.replace(/[\d,]+$/, '').trim()));

test.describe('room menus', () => {
  test('bidders get Dashboard, Documents, Search, Timeline and My team', async ({ page, persona }) => {
    for (const who of ['jan', 'pieter', 'lars'] as const) {
      await persona(who);
      await page.goto(roomPath('dashboard'));
      await expect.poll(() => menu(page)).toEqual(['Dashboard', 'Documents', 'Search', 'Timeline', 'My team']);
    }
  });

  test('observers get Timeline and Activity, contributors neither', async ({ page, persona }) => {
    await persona('liesl');
    await page.goto(roomPath('dashboard'));
    await expect.poll(() => menu(page)).toEqual(['Dashboard', 'Documents', 'Search', 'Timeline', 'Activity']);
    await persona('maria');
    await page.goto(roomPath('dashboard'));
    await expect.poll(() => menu(page)).toEqual(['Dashboard', 'Documents', 'Search']);
    const res = await page.goto(roomPath('timeline'));
    expect(res?.status()).toBe(404);
  });
});

test.describe('Timeline for bidders and seller observers', () => {
  test('shows bidders their dates, read-only', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    await page.locator('nav').getByRole('link', { name: 'Timeline' }).click();
    await expect(page).toHaveURL(/\/timeline$/);
    await expect(page.locator('h1')).toHaveText('Timeline');
    await expect(page.locator('.f2 .sub')).toContainText('that apply to you. Times are in your time zone, GMT.');
    await expect(page.locator('[data-phase]').first()).toBeVisible();
    await expect(page.locator('.nav a.on')).toHaveAttribute('href', roomPath('timeline'));
    await expect(page.getByRole('button', { name: /Edit|Add a phase|Add an event/ })).toHaveCount(0);
    await expect(page.locator('.crumbs')).not.toContainText('Administration');
    await expect(page.locator('.content')).not.toContainText('Bidder B');
    await expect(page.locator('.content')).not.toContainText('All bidder groups');
  });

  test('a seller observer reads it too', async ({ page, persona }) => {
    await persona('liesl');
    await page.goto(roomPath('timeline'));
    await expect(page.locator('h1')).toHaveText('Timeline');
    await expect(page.getByRole('button', { name: /Edit/ })).toHaveCount(0);
  });

  test('filters dates by group', async ({ page, persona }) => {
    const content = page.locator('.content');
    // Lars: Bidder C subgroup
    for (const [who, own, other] of [['jan', 'Bidder A', 'Bidder C'], ['lars', 'Bidder C', 'Bidder A']] as const) {
      await persona(who);
      await page.goto(roomPath('timeline'));
      await expect(content).toContainText('Non-binding offers due');
      await expect(content).toContainText(`Management presentation, ${own}`);
      await expect(content).not.toContainText(`Management presentation, ${other}`);
    }
    await persona('liesl');
    await page.goto(roomPath('timeline'));
    await expect(content).toContainText('Binding offers due');
    await expect(content).toContainText('Management presentation, Bidder A');
    await expect(content).toContainText('Management presentation, Bidder C');
  });
});

test.describe('renumbering', () => {
  // Tax has 133 documents, Budgets 19
  test('old numbers still find documents', async ({ page }) => {
    await setPersona(page, 'anika');
    await page.goto(roomPath('dashboard'));
    const kids = (await (await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes?parent=${NODE['3']}`)).json()).items as { id: string; indexNumber: string; name: string }[];
    const budgets = kids.find((n) => n.indexNumber === '3.3')!;
    const tax = kids.find((n) => n.indexNumber === '3.4')!;
    expect([budgets.name, tax.name]).toEqual(['Budgets and forecasts', 'Tax']);
    const move = (id: string) => page.request.patch(`/v1/workspaces/${ROOM_ID}/nodes/${id}`, { data: { position: 3, confirmRenumberPublished: true } });
    const before = new Date(Date.now() - 1000).toISOString();
    expect((await move(tax.id)).status()).toBe(200);
    try {
      await setPersona(page, 'jan');
      await page.goto(roomPath('documents', NODE['3']));
      const row = (ix: string) => page.locator('.fo').filter({ has: page.locator('.ix', { hasText: new RegExp(`^${ix.replace(/\./g, '\\.')}$`) }) });
      await expect(row('3.3')).toContainText('Tax');
      await expect(row('3.3').locator('.badge', { hasText: 'Renumbered' })).toHaveAttribute('title', 'Was 3.4');
      await expect(row('3.4').locator('.badge', { hasText: 'Renumbered' })).toHaveAttribute('title', 'Was 3.3');
      await expect(row('3.1').locator('.badge', { hasText: 'Renumbered' })).toHaveCount(0);

      await row('3.3').click();
      await expect(page.locator('.content h1')).toContainText('Renumbered');
      await expect(page.locator('.dr').first().locator('.badge', { hasText: 'Renumbered' })).toBeVisible();

      await hydrated(page);
      await page.locator('.top .qs-in').fill('3.4.100');
      await expect(page.locator('.qs-opt', { hasText: 'was 3.4.100' })).toContainText('3.3.100');
      await page.goto(`${roomPath('search')}?q=3.4.100`);
      await expect(page.locator('.hit').first()).toContainText('was 3.4.100');
      await expect(page.locator('.hit').first().locator('.n')).toHaveText('3.3.100');

      await page.goto(`/rooms/${ROOM_ID}/number?n=3.4.100`);
      await expect(page.locator('.doct')).toContainText('3.3.100');
      // 3.4.5 is a Budgets document now
      await page.goto(`/rooms/${ROOM_ID}/number?n=3.4.5&at=${encodeURIComponent(before)}`);
      await expect(page.locator('.doct')).toContainText('3.3.5');
      await page.goto(`/rooms/${ROOM_ID}/number?n=3.4.5`);
      await expect(page.locator('.doct')).toContainText('3.4.5');
    } finally {
      await setPersona(page, 'anika');
      expect((await move(budgets.id)).status()).toBe(200);
    }
    await setPersona(page, 'jan');
    await page.goto(roomPath('documents', NODE['3']));
    await expect(page.locator('.fo').first()).toBeVisible();
    await expect(page.locator('.fo .badge', { hasText: 'Renumbered' })).toHaveCount(0);
  });
});

test.describe('removing own drafts', () => {
  test('contributor removes a draft from Versions and details', async ({ page, persona }) => {
    await persona('maria');
    await page.goto(roomPath('documents', NODE['3']));
    await page.locator('.fo', { hasText: 'Treasury' }).click();
    await hydrated(page);
    const draft = page.locator('.dr', { has: page.locator('.badge', { hasText: 'Draft' }) }).last();
    const name = (await draft.locator('.nm b').textContent())!;
    await draft.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: /Versions and details/ }).click();
    await expect(page).toHaveURL(/\/details\//);
    await page.getByRole('button', { name: 'Remove draft' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('leaves the index before anyone outside the seller team has seen it.');
    await expect(dlg).toContainText('Its number is not given to another document.');
    await dlg.getByRole('button', { name: 'Remove draft' }).click();
    await expect(page).toHaveURL(/\/documents\//);
    await expect(page.locator('.dr', { hasText: name })).toHaveCount(0);
  });
});

test.describe('invitation signature', () => {
  test('uses the room admin in the From line and signature', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(`${roomPath('settings')}?tab=invite`);
    const mail = page.getByTestId('mail-preview');
    await expect(page.getByLabel('Message')).toHaveValue(/Kind regards,\n\{signature\}$/);
    await expect(mail.locator('.mh')).toContainText('Anika Pillay, Quillmont Advisory');
    await expect(mail.locator('.fill').last()).toHaveText('Anika Pillay\nQuillmont Advisory');
    await expect(page.getByText('Leave it empty to use the name of the room admin who sends the invitation, such as Anika Pillay, Quillmont Advisory.')).toBeVisible();
  });

  test('invitation message ends with the admin name', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('people'));
    await hydrated(page);
    await page.getByRole('button', { name: 'Invite people', exact: true }).click();
    await expect(page.getByRole('dialog').locator('#iv-msg')).toHaveValue(/Kind regards,\nAnika Pillay\nQuillmont Advisory$/);
  });
});
