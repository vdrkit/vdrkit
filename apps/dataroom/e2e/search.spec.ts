// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expect as baseExpect, NODE, roomPath, ROOM_ID, test } from './fixtures';

const expect = baseExpect.configure({ timeout: 20_000 });
const NAV = { timeout: 60_000 };

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const box = (page: Page) => page.locator('.top .qs-in[data-ready]');
const settled = (page: Page) => expect(page.locator('section[aria-label="Search results"]')).toHaveAttribute('aria-busy', 'false');

const search = (q: string, folder?: string) =>
  `${roomPath('search')}?q=${encodeURIComponent(q)}${folder ? `&folder=${folder}` : ''}`;

test('bidder finds matches in names and text', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(search('change of control'));
  await expect(page.locator('.top .qs-in')).toHaveValue('change of control');
  await expect(page.locator('.rhead h2')).toHaveText(/^\d+ results in all folders$/);
  const tracker = page.locator('.hit', { hasText: 'Change of control consents tracker' });
  await expect(tracker.locator('.ftype')).toHaveText('XLS');
  await expect(tracker.locator('.t .n')).toHaveText('2.4.6');
  await expect(tracker.locator('.path')).toHaveText('2 Legal › 2.4 Material contracts');
  const tarnley = page.locator('.hit', { hasText: 'Tarnley Logistics supply agreement' });
  await expect(tarnley.locator('.snip .pg')).toHaveText([/^Page \d+$/, /^Page \d+$/]);
  await expect(tarnley.locator('.snip mark').first()).toHaveText(/change of control/i);
  await expect(tarnley.locator('.snip')).toHaveCount(2);
  await expect(tarnley.locator('.snip').first()).not.toContainText(/Confidential|Page \d+ of \d+/);
  const letter = page.locator('.hit', { hasText: 'Management letter FY2022' });
  await expect(letter.locator('.snip')).toHaveCount(2);
  await expect(letter.locator('.more')).toHaveText(/^\d+ more (pages match|page matches)$/);
  await expect(page.locator('.hit', { hasText: 'Velarail' })).toHaveCount(0);
  await expect(page.locator('.b-draft')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Bidder B');
  await expect(page.locator('.side-note')).toContainText('Folders and documents outside your access never appear, not even as a count.');
  await expect(page.locator('.c4 .sub')).not.toContainText('drafts included');
});

test('room admin also finds drafts', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(search('change of control'));
  const velarail = page.locator('.hit', { hasText: 'Framework agreement Velarail Freight Rail' });
  await velarail.waitFor();
  expect(await velarail.locator('.b-draft').innerText()).toBe('Draft, bidders cannot see it');
  await expect(page.locator('.c4 .sub')).toContainText('you only see documents you can open, drafts included.');
  await expect(page.locator('.side-note')).toContainText('As room admin you also find drafts. Bidders never see them in their results.');
});

test('respects folder access', async ({ page, persona }) => {
  await persona('lars');
  await page.goto(search('change of control'));
  await expect(page.locator('.hit').first()).toBeVisible();
  for (const n of await page.locator('.hit .t .n').allInnerTexts()) expect(n.startsWith('3.')).toBe(true);
});

test('searches as you type in the top bar', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(roomPath('search'));
  await expect(box(page)).toBeAttached();
  await expect(page.locator('.c4 .empty b')).toHaveText('Type what you are looking for in the search bar at the top');
  await expect(page.locator('.top .qs-in')).toBeFocused();
  await page.locator('.chipq', { hasText: 'Ombeli' }).click();
  await expect(page.locator('.top .qs-in')).toHaveValue('Ombeli');
  await expect(page.locator('.hit', { hasText: 'Supply agreement Ombeli Chemicals' })).toBeVisible();
  await page.locator('.top .qs-in').fill('"supply agreement"');
  await expect(page).toHaveURL(/q=%22supply(\+|%20)agreement%22/);
  await expect(page.locator('.hit', { hasText: 'Packaging supply agreement Paxenfold' })).toBeVisible();
  await expect(page.locator('.hit', { hasText: 'Settlement agreement Ombeli' })).toHaveCount(0);
  await expect(page.locator('.qs-pop')).toBeHidden();
  await page.locator('.top .qs-in').fill('K');
  await expect(page.locator('.hit', { hasText: 'Tarnley Logistics supply agreement' })).toBeVisible();
  await page.locator('.top .qs-in').fill('Germist');
  await expect(page.locator('.hit').first()).toContainText(/Germiston/);
});

test('narrows by folder and handles no results', async ({ page, persona }) => {
  test.setTimeout(120_000);
  await persona('jan');
  await page.goto(search('lease agreement Durbanxx', NODE['2.4']));
  await expect(page.locator('#c4-folder')).toHaveValue(NODE['2.4']);
  await expect(box(page)).toBeAttached();
  const none = page.locator('.empty.none');
  await expect(none.locator('h2')).toHaveText('No documents match “lease agreement Durbanxx” in 2.4 Material contracts');
  await expect(none.locator('.tips li')).toHaveText([
    'Use fewer words. Every word must appear in the document.',
    'Search for an index number, such as 2.4.',
    'Search all folders instead.',
    'Browse 2.4 Material contracts in Documents.',
  ]);
  expect(await none.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
  await expect(none.locator('p')).toHaveText(/^Search looks inside the text of the \d+ documents? in 2\.4 Material contracts shared with Bidder A\.$/);
  await none.getByRole('button', { name: 'Search all folders' }).click();
  await expect(none.locator('h2')).toHaveText('No documents match “lease agreement Durbanxx”');
  await expect(page).not.toHaveURL(/folder=/);
  await none.getByRole('button', { name: 'Search for “lease agreement”' }).click();
  await expect(page.locator('.top .qs-in')).toHaveValue('lease agreement');
  await expect(page.locator('.rhead h2')).toHaveText(/results? in all folders/);
  await page.locator('#c4-folder').selectOption(NODE['2.4']);
  await expect(page.locator('.rhead h2')).toHaveText(/in 2\.4 Material contracts$/);
  await expect(page.locator('section[aria-label="Search results"]')).toHaveAttribute('aria-busy', 'false');
  for (const n of await page.locator('.hit .t .n').allInnerTexts()) expect(n.startsWith('2.4.')).toBe(true);
});

test('index order sorts the results by number', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(search('change of control'));
  await expect(box(page)).toBeAttached();
  await settled(page);
  await expect(page.locator('.hit').first()).toBeVisible();
  await page.getByRole('button', { name: 'Index order' }).click();
  await expect(page.getByRole('button', { name: 'Index order' })).toHaveAttribute('aria-pressed', 'true');
  await settled(page);
  const nums = await page.locator('.hit .t .n').allInnerTexts();
  expect(nums).toEqual([...nums].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
});

test('a result opens the viewer at the matching page', async ({ page, persona }) => {
  test.setTimeout(120_000);
  await persona('jan');
  await page.goto(search('change of control'));
  await expect(box(page)).toBeAttached();
  await settled(page);
  const tarnley = page.locator('.hit', { hasText: 'Tarnley Logistics supply agreement' });
  await expect(tarnley.locator('.snip .pg').first()).toBeVisible();
  const pg = (await tarnley.locator('.snip .pg').first().innerText()).replace('Page ', '').trim();
  await expect(tarnley).toHaveAttribute('aria-label', `Open 2.4.2 Tarnley Logistics supply agreement at page ${pg}`);
  await tarnley.click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/view/${NODE['2.4.2']}\\?page=${pg}$`), NAV);
});

test('quick search finds documents and folders by name or number', async ({ page, persona }) => {
  test.setTimeout(180_000);
  await persona('jan');
  await page.goto(roomPath('dashboard'));
  await expect(box(page)).toBeAttached();
  await page.keyboard.press('Control+k');
  await expect(page.locator('.top .qs-in')).toBeFocused();
  await page.keyboard.type('material');
  const pop = page.locator('.qs-pop');
  await expect(pop.locator('.qs-opt', { hasText: 'Material contracts' })).toContainText('Folder in 2 Legal');
  await page.locator('.top .qs-in').fill('ombeli');
  await expect(pop.locator('.qs-opt', { hasText: 'Supply agreement Ombeli Chemicals' })).toBeVisible();
  await expect(pop.locator('.qs-opt:not(.qs-all)')).toHaveCount(5);
  await page.locator('.top .qs-in').fill('2.4.7');
  await expect(pop.locator('.qs-opt', { hasText: 'Supply agreement' }).first()).toBeVisible();
  await page.locator('.top .qs-in').fill('2.4.2');
  const tarnley = pop.locator('.qs-opt', { hasText: 'Tarnley Logistics supply agreement' });
  await expect(tarnley).toContainText('2 Legal › 2.4 Material contracts');
  await tarnley.click();
  await expect(page).toHaveURL(new RegExp(`/view/${NODE['2.4.2']}$`), NAV);
  await page.goto(roomPath('dashboard'));
  await page.locator('.top .qs-in').fill('change of control');
  await expect(pop.locator('.qs-all')).toContainText('Search inside all documents for “change of control”');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=change%20of%20control$/, NAV);
  await expect(page.locator('.top .qs-in')).toHaveValue('change of control');
  await expect(page.locator('.hit').first()).toBeVisible();
});

test('quick search opens a folder', async ({ page, persona }) => {
  test.setTimeout(120_000);
  await persona('anika');
  await page.goto(roomPath('dashboard'));
  await box(page).fill('material contracts');
  const option = page.locator('.qs-pop .qs-opt', { hasText: 'Material contracts' }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page).toHaveURL(new RegExp(`/documents/${NODE['2.4']}$`), NAV);
});

test('shows the same document count everywhere', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(roomPath('search'));
  const placeholder = (await page.locator('.top .qs-in').getAttribute('placeholder')) ?? '';
  const count = /^Search ([\d,]+) documents$/.exec(placeholder)?.[1];
  expect(count).toBeTruthy();
  await expect(page.locator('.c4 .empty .cap')).toContainText(`the ${count} documents you can open`);
});
