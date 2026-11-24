// SPDX-License-Identifier: AGPL-3.0-only
import { clickAndRefresh, expect, PERSONAS, roomPath, test, type PersonaKey } from './fixtures';
import type { Page } from '@playwright/test';
import { roomFor, unique } from './flow-helpers';

// settings other specs read go in a separate room
test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const SETTINGS = roomPath('settings');
const TAB_NAMES = ['General', 'NDA', 'Sign-in', 'Watermark', 'Publishing', 'Notifications', 'Invitation email'];

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const ANIKA = PERSONAS.find((p) => p.key === 'anika')!.id;

async function open(page: Page, tab = '', settings = SETTINGS) {
  await page.goto(`${settings}${tab ? `?tab=${tab}` : ''}`);
  await expect(page.getByRole('heading', { name: 'Room settings' })).toBeVisible();
}
const bar = (page: Page) => page.getByRole('region', { name: 'Unsaved changes' });
async function saveAndWait(page: Page) {
  await clickAndRefresh(page, bar(page).getByRole('button', { name: 'Save changes' }));
  await expect(page.locator('.toast')).toContainText(/saved/);
  await expect(bar(page)).toHaveCount(0);
}

test('room admin sees the settings tabs', async ({ page, persona }) => {
  await persona('anika');
  await open(page);
  await expect(page.getByRole('tab')).toHaveText(TAB_NAMES);
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.nav a.on')).toHaveAttribute('href', SETTINGS);
  await expect(page.locator('.crumbs')).toContainText('Settings');
  await expect(page.getByLabel('Room name')).toHaveValue('Project Heron');
  await expect(page.getByRole('radio', { name: /Open\s*Now/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.pv .room')).toContainText('Run by Quillmont Advisory');
  await expect(page.locator('body')).not.toContainText(/hide document names/i);
  await page.getByRole('tab', { name: 'Sign-in' }).click();
  await expect(page).toHaveURL(/\?tab=signin$/);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Sign-in' })).toHaveAttribute('aria-selected', 'true');
});

for (const who of ['maria', 'johan', 'jan', 'pieter', 'lars', 'liesl'] as PersonaKey[]) {
  test(`${who} gets not available`, async ({ page, persona }) => {
    await persona(who);
    await page.goto(roomPath('dashboard'));
    await expect(page.locator('.nav')).toBeVisible();
    await expect(page.locator(`.nav a[href="${SETTINGS}"]`)).toHaveCount(0);
    await page.goto(SETTINGS);
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Room settings');
    await expect(page.locator('body')).not.toContainText('Two-factor');
  });
}

test('Discard puts changes back', async ({ page, persona }) => {
  await persona('anika');
  await open(page);
  await page.getByLabel('Seller').fill('Drosvelt Holdings (Pty) Ltd');
  await expect(page.getByRole('tab', { name: /General/ }).locator('em')).toBeVisible();
  await expect(bar(page)).toContainText('1 unsaved change');
  await expect(bar(page)).toContainText('Seller. Nothing changes for anyone until you save.');
  await page.getByRole('radio', { name: /Frozen/ }).click();
  await expect(page.locator('.note.warn')).toContainText('When you save, the room becomes frozen.');
  await expect(bar(page)).toContainText('2 unsaved changes');
  await page.getByRole('tab', { name: 'Sign-in' }).click();
  await page.getByLabel('Sign people out after this long without activity').selectOption('60');
  await expect(page.getByRole('tab', { name: /Sign-in/ }).locator('em')).toBeVisible();
  await expect(bar(page)).toContainText('3 unsaved changes');
  await bar(page).getByRole('button', { name: 'Discard' }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel('Sign people out after this long without activity')).toHaveValue('240');
  await page.getByRole('tab', { name: 'General' }).click();
  await expect(page.getByLabel('Seller')).toHaveValue('Drosvelt Holdings');
  await expect(page.getByRole('radio', { name: /Open\s*Now/ })).toHaveAttribute('aria-checked', 'true');
});

test('saves the seller and sign-out time', async ({ page, persona }) => {
  const ws = await roomFor(ANIKA, `Project Wren ${unique()}`);
  await persona('anika');
  await open(page, '', `/rooms/${ws}/settings`);
  const seller = page.getByLabel('Seller');
  await seller.fill('Drosvelt Holdings (Pty) Ltd');
  await page.getByRole('tab', { name: 'Sign-in' }).click();
  await page.getByLabel('Sign people out after this long without activity').selectOption('480');
  await expect(page.locator('ol.ol')).toContainText('After 8 hours without activity');
  await saveAndWait(page);
  await expect(page.locator('.toast')).toContainText('2 changes saved');
  await page.reload();
  await expect(page.getByLabel('Sign people out after this long without activity')).toHaveValue('480');
  await page.getByRole('tab', { name: 'General' }).click();
  await expect(seller).toHaveValue('Drosvelt Holdings (Pty) Ltd');
});

test('warns when two-factor is off', async ({ page, persona }) => {
  await persona('anika');
  await open(page, 'signin');
  await expect(page.getByLabel('Days a browser stays trusted')).toHaveValue('30');
  await page.getByRole('switch', { name: 'Require two-factor sign-in' }).click();
  await expect(page.locator('.note.warn')).toContainText('Without two-factor sign-in, the email alone opens the room.');
  await expect(page.getByLabel('Days a browser stays trusted')).toHaveCount(0);
  await expect(page.getByText('Not used')).toBeVisible();
  await expect(page.locator('ol.ol li')).toHaveCount(2);
  await page.getByRole('switch', { name: 'Require two-factor sign-in' }).click();
  await expect(bar(page)).toHaveCount(0);
  await page.getByLabel('Days a browser stays trusted').fill('120');
  await expect(page.getByText('Choose between 1 and 90 days.')).toBeVisible();
  await bar(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(bar(page).getByRole('alert')).toHaveText('Choose between 1 and 90 days.');
  await bar(page).getByRole('button', { name: 'Discard' }).click();
});

test('mandatory locks the notification default on', async ({ page, persona }) => {
  const ws = await roomFor(ANIKA, `Project Wren ${unique()}`);
  await persona('anika');
  await open(page, 'notif', `/rooms/${ws}/settings`);
  const row = page.locator('.nrow[data-event="drafts"]');
  await expect(row).toContainText('Drafts waiting');
  await row.getByRole('switch', { name: 'On by default: Drafts waiting' }).click();
  await expect(row.getByRole('combobox')).toBeDisabled();
  await row.getByRole('switch', { name: 'Mandatory: Drafts waiting' }).click();
  await expect(row.getByRole('switch', { name: 'On by default: Drafts waiting' })).toBeDisabled();
  await expect(row.getByRole('switch', { name: 'On by default: Drafts waiting' })).toHaveAttribute('aria-checked', 'true');
  await row.getByRole('combobox').selectOption('immediate');
  await saveAndWait(page);
  await page.reload();
  await expect(row.getByRole('switch', { name: 'Mandatory: Drafts waiting' })).toHaveAttribute('aria-checked', 'true');
  await expect(row.getByRole('combobox')).toHaveValue('immediate');
  await row.getByRole('switch', { name: 'Mandatory: Drafts waiting' }).click();
  await row.getByRole('combobox').selectOption('digest');
  await saveAndWait(page);
  await page.getByLabel('Most minutes to wait').fill('5');
  await expect(page.getByText('The longest wait is 10 to 240 minutes.')).toBeVisible();
  await bar(page).getByRole('button', { name: 'Discard' }).click();
});

test('publishing tab has no notify default', async ({ page, persona }) => {
  await persona('anika');
  await open(page, 'pub');
  const tab = page.getByRole('tabpanel');
  await expect(tab).toContainText('How people hear about new documents');
  await expect(tab).toContainText('Each person hears about new documents and new versions as they chose in their own notification settings.');
  await expect(tab).not.toContainText('When documents are published, tell bidders');
  await expect(page.getByRole('radiogroup', { name: 'Default for telling bidders' })).toHaveCount(0);
});

test('picks the time zone by city', async ({ page, persona }) => {
  await persona('anika');
  await open(page);
  const tz = page.getByRole('combobox', { name: 'Room time zone' });
  await expect(tz).toHaveValue(/Johannesburg, SAST, UTC\+2/);
  await tz.click();
  await tz.fill('kolkata');
  await page.getByRole('option', { name: /Kolkata/ }).click();
  await expect(tz).toHaveValue(/Kolkata/);
  await expect(bar(page)).toContainText('Time zone');
  await bar(page).getByRole('button', { name: 'Discard' }).click();
  await expect(tz).toHaveValue(/Johannesburg/);
});

test('invitation email preview', async ({ page, persona }) => {
  await persona('anika');
  await open(page, 'invite');
  const mail = page.getByTestId('mail-preview');
  await page.getByLabel('Subject').fill('Project Heron: your invitation');
  await expect(mail).toContainText('Project Heron: your invitation');
  const msg = page.getByLabel('Message');
  await msg.fill('Dear colleague,\n\nWelcome. Access ends ');
  await page.getByRole('button', { name: 'Insert the access end date' }).click();
  await expect(msg).toHaveValue('Dear colleague,\n\nWelcome. Access ends {until}');
  await expect(mail.locator('.fill')).toHaveText(/\d{1,2} \w+ \d{4}/);
  await expect(page.getByRole('button', { name: 'Go back to the VDRkit default text' })).toBeVisible();
  await expect(mail.locator('.leadp')).toHaveCount(0);
  await page.getByRole('button', { name: 'As a lead' }).click();
  await expect(mail.locator('.leadp')).toContainText('You are invited as a lead for Bidder A.');
  await page.getByLabel('Replies go to').fill('anika@');
  await bar(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(bar(page).getByRole('alert')).toContainText('Replies need a valid email address');
  await page.getByRole('button', { name: 'Go back to the VDRkit default text' }).click();
  await bar(page).getByRole('button', { name: 'Discard' }).click();
  await expect(bar(page)).toHaveCount(0);
});

test('uploads and removes a logo', async ({ page, persona }) => {
  await persona('anika');
  await open(page);
  await page.getByTestId('logo-file').setInputFiles({ name: 'heron.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('.pv .room-logo img').first()).toBeVisible();
  await expect(bar(page)).toContainText('Room logo');
  await saveAndWait(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Replace the logo' })).toBeVisible();
  await expect(page.locator('.logo-tile img').first()).toHaveJSProperty('complete', true);
  await page.getByRole('button', { name: 'Remove the logo' }).click();
  await expect(page.locator('.logo-tile')).toHaveText('PH');
  await saveAndWait(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Upload a logo' })).toBeVisible();
});

test('publishes an NDA correction', async ({ page, persona }) => {
  await persona('anika');
  await open(page, 'nda');
  const head = page.locator('.nver b').first();
  const before = Number((await head.innerText()).match(/Version (\d+)/)![1]);
  await expect(page.locator('.meter')).toContainText(/\d+ of \d+ people/);
  await expect(page.locator('.acc').first()).toContainText(/Bidder A\s*\d+ of \d+/);
  await page.getByRole('button', { name: 'Publish a new version' }).click();
  const dlg = page.getByRole('dialog', { name: `Publish NDA version ${before + 1}` });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: `Publish version ${before + 1}` }).click();
  await expect(dlg.getByRole('alert')).toContainText('The text is the same as version');
  const text = dlg.getByLabel('Text of the agreement');
  await text.fill(`${await text.inputValue()} Typing error corrected (${Date.now()}).`);
  await dlg.getByRole('radio', { name: /Only people who have not accepted yet/ }).click();
  await dlg.getByRole('button', { name: `Publish version ${before + 1}` }).click();
  await expect(page.locator('.toast')).toContainText(`NDA version ${before + 1} published`);
  await expect(dlg).toHaveCount(0);
  await expect(head).toContainText(`Version ${before + 1}`);
  await expect(page.locator('.nver .cap')).toContainText('by Anika Pillay');
  await expect(page.locator('.hist').first()).toContainText(`Version ${before}`);
  await page.getByRole('button', { name: 'Publish a new version' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('should not scroll sideways on a phone', async ({ page, persona }) => {
  await persona('anika');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['', 'nda', 'signin', 'wm', 'pub', 'notif', 'invite']) {
    await open(page, tab);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `tab ${tab || 'general'}`).toBeLessThanOrEqual(390);
  }
});

test('requires a seller name', async ({ page, persona }) => {
  await persona('anika');
  await open(page);
  const seller = page.getByLabel('Seller');
  const before = await seller.inputValue();
  await seller.fill('');
  await expect(page.locator('.hint.err')).toHaveText('Give the seller a name of at least two characters.');
  await bar(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(bar(page).locator('.err')).toHaveText('Give the seller a name of at least two characters.');
  await expect(page.locator('.toast')).toHaveCount(0);
  await seller.fill(` ${before} `);
  await expect(bar(page)).toHaveCount(0);
});

test('watermark preview names the example bidder', async ({ page, persona }) => {
  await persona('anika');
  await open(page, 'wm');
  await expect(page.locator('.aside > .over')).toHaveText('Preview, as Jan de Vries sees it');
});

test('scrolls the chosen tab into view on a phone', async ({ page, persona }) => {
  await persona('anika');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const strip = page.getByRole('tablist', { name: 'Settings areas' });
  await expect(strip).toHaveAttribute('data-more', 'right');
  await page.getByRole('tab', { name: 'Notifications' }).click();
  await expect.poll(async () => page.evaluate(() => {
    const el = document.querySelector('[role=tablist]')!.getBoundingClientRect();
    const b = document.getElementById('tab-notif')!.getBoundingClientRect();
    return b.left >= el.left - 1 && b.right <= el.right + 1;
  })).toBe(true);
  await expect(strip).toHaveAttribute('data-more', /left|both/);
});
