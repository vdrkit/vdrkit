// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expect, NODE, roomPath, ROOM_ID, test } from './fixtures';
import { rightsSentence, watermarkOn, watermarkSentence } from '../src/components/viewer/model';

test.skip(process.env.E2E_PROD === '1', 'The viewer runs against next dev with the API');

const DOC = {
  '2.4.1': 'b79a56a0-6ed9-47b0-947d-1f42654a3fe2',
  '2.4.3': '0319f936-65c8-4726-9782-e182c180a168',
  '2.4.4': 'd468ac7b-7ee6-4f26-83fe-59f840e3267d',
  '2.4.12': '747a89c4-3463-4efe-8983-2858aad9d3c5',
  '2.4.14': '9b345dbe-102f-43e6-9d80-f2739b051dd8',
  '3.2.7': '8a9cd8ee-890c-4516-86d5-a9c5044c0dbe',
} as const;

const view = (id: string, query = '') => `${roomPath('view', id)}${query}`;

function fullPagesFetched(page: Page): number[] {
  const seen: number[] = [];
  page.on('request', (r) => {
    const m = /\/pages\/(\d+)\?session=[^&]+$/.exec(r.url());
    if (m) seen.push(Number(m[1]));
  });
  return seen;
}

test('bidder lead reads watermarked pages', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('.doct .ix')).toHaveText('2.4.2');
  await expect(page.locator('.doct h1')).toHaveText('Tarnley Logistics supply agreement');
  await expect(page.locator('.back')).toHaveAttribute('href', roomPath('documents', NODE['2.4']));
  await expect(page.locator('.back')).toContainText('2.4 Material contracts');
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.side')).toHaveCount(0);
  await expect(page.locator('#dl-btn')).toHaveCount(0);
  const info = page.locator('#info');
  await expect(info).toContainText('WatermarkedYes');
  await expect(info.locator('.right .lvl')).toHaveText('Print');
  await expect(info.locator('.right')).not.toContainText('Bidder');
  await expect(info.getByRole('heading', { name: 'Other documents in 2.4 Material contracts' })).toBeVisible();
  await expect(info.locator('.near a.on')).toContainText('Tarnley Logistics supply agreement');
  await expect(info.locator('.near a')).toHaveCount(5);
  await expect(info.locator('.right')).toContainText('Printing and the encrypted PDF download are not available in the viewer yet.');
  await expect(page.locator('#menu-btn')).toHaveAttribute('aria-label', 'Room menu: Dashboard, Documents, Search, Timeline, My team');
  await expect(page).toHaveTitle('VDRkit Document viewer');
  await expect(page.locator('.vroot')).not.toContainText('Bidder B');
  await expect(page.locator('.vroot')).not.toContainText('Bidder C');
  await expect(page.locator('.vroot')).not.toContainText('Opened by');
});

test('marks unread documents per reader', async ({ page, persona }) => {
  await persona('pieter');
  const listing = async () => ((await (await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes?parent=${NODE['2.4']}`)).json()) as {
    items: { id: string; indexNumber: string | null; read?: boolean }[] }).items;
  await page.goto(view(NODE['2.4.2']));
  const near = page.locator('#info .near a');
  await expect(near).toHaveCount(5);
  const items = await listing();
  for (let i = 0; i < 5; i += 1) {
    const ix = (await near.nth(i).locator('.ix').textContent()) ?? '';
    const it = items.find((x) => x.indexNumber === ix);
    const unread = ix !== '2.4.2' && it?.read === false;
    await expect(near.nth(i).locator('.new')).toHaveCount(unread ? 1 : 0);
    if (unread) await expect(near.nth(i).locator('.new')).toHaveText('Unread');
  }
  await page.goto(view(DOC['2.4.4']));
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('#info .near a', { hasText: '2.4.4' }).locator('.new')).toHaveCount(0);
  await persona('anika');
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('#info .near a')).toHaveCount(5);
  await expect(page.locator('#info .near .new')).toHaveCount(0);
});

test('view-only observer sees the View sentence', async ({ page, persona }) => {
  await persona('liesl');
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('#info .right .lvl')).toHaveText('View');
  await expect(page.locator('#info .right')).toContainText('Your group can read this document online. Downloading and printing are not available for this document.');
  await expect(page.locator('#dl-btn')).toHaveCount(0);
});

test('room admin downloads the watermarked PDF', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('#vtag')).toHaveText(/^Version 1 of 1 · \d+ pages · PDF$/);
  const facts = page.locator('#info dl.kv');
  await expect(facts).toContainText(/FilePDF · [\d.]+ (MB|KB)/);
  await expect(facts).toContainText(/Published(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4}/);
  await expect(facts).toContainText('Uploaded by');
  await expect(facts).toContainText('Version1 of 1');
  await expect(facts.locator('dt')).toHaveText(['Index', 'Folder', 'Pages', 'File', 'Published', 'Watermarked', 'Uploaded by', 'Version']);
  await expect(page.locator('#info .right .lvl')).toHaveText('Original');
  await expect(page.locator('#info .adm')).toContainText(/Opened by|Not opened by any bidder yet/);
  await expect(page.locator('#info .adm a')).toHaveText('See who opened it in Activity');

  await page.locator('#dl-btn').click();
  const dialog = page.getByRole('dialog', { name: 'Download' });
  await expect(dialog).toContainText('Download 2.4.2');
  await expect(dialog).toContainText('PDF with watermark');
  await expect(dialog).toContainText(/Every page carries Anika Pillay, [^\s,]+@[^\s,]+, Room admins and today’s date and time\. [\d.]+ (MB|KB)\./);
  await expect(dialog).toContainText(/The file as uploaded, without a watermark\. [\d.]+ (MB|KB)\./);
  await expect(dialog).toContainText('Downloads are recorded in the activity log.');
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('Tarnley Logistics supply agreement.pdf');
  await expect(page.locator('.toast')).toContainText('PDF downloaded');
  await expect(page.locator('.toast')).toContainText('Every page carries your name, your email address, your group and today’s date and time. Recorded in the activity log.');
  await expect(dialog).toHaveCount(0);

  await page.locator('#dl-btn').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('opens at a start page and fetches only the pages shown', async ({ page, persona }) => {
  await persona('jan');
  const fetched = fullPagesFetched(page);
  await page.goto(view(NODE['2.4.2'], '?page=5'));
  await expect(page.locator('#p5 img')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#pg')).toHaveValue('5');
  await expect(page.locator('.th.on')).toContainText('5');
  expect(fetched).toContain(5);
  expect(fetched).not.toContain(1);

  await page.locator('#pg').fill('9');
  await page.locator('#pg').press('Enter');
  await expect(page.locator('#p9 img')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#pg')).toHaveValue('9');
  expect(fetched).not.toContain(7);
});

test('J and K step through the folder', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('.docnav [data-doc="1"]')).toHaveAttribute('title', '2.4.3 Tarnley Logistics addendum 2024');
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('j');
  await expect(page).toHaveURL(new RegExp(`/view/${DOC['2.4.3']}$`), { timeout: 20_000 });
  await expect(page.locator('.doct .ix')).toHaveText('2.4.3');
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('k');
  await expect(page).toHaveURL(new RegExp(`/view/${NODE['2.4.2']}$`), { timeout: 20_000 });
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('k');
  await expect(page).toHaveURL(new RegExp(`/view/${DOC['2.4.1']}$`), { timeout: 20_000 });
  await expect(page.locator('.docnav [data-doc="-1"]')).toBeDisabled();
});

test('the end of the document offers the next one', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(view(NODE['2.4.2'], '?page=12'));
  await expect(page.locator('#p12 img')).toBeVisible({ timeout: 20_000 });
  const next = page.locator('.nextdoc');
  await expect(next).toContainText('End of 2.4.2 · next in 2.4 Material contracts');
  await expect(next).toContainText('2.4.3 Tarnley Logistics addendum 2024');
  await next.getByRole('button', { name: 'Open next document' }).click();
  await expect(page).toHaveURL(new RegExp(`/view/${DOC['2.4.3']}$`), { timeout: 20_000 });
});

test('Details hides the panel; the room menu slides over', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(view(NODE['2.4.2']));
  const btn = page.locator('#info-btn');
  await expect(btn).toHaveText('Details');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await btn.click();
  await expect(page.locator('#info')).toBeHidden();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await expect(page.locator('#info')).toBeVisible();

  await page.locator('#menu-btn').click();
  const menu = page.getByRole('dialog', { name: 'Room menu' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.nav a.on')).toHaveText('Documents');
  await expect(menu.locator('.room')).toContainText('Run by Quillmont Advisory');
  await expect(menu.locator('.nav .sec')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('the room admin menu has the administration section', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(view(NODE['2.4.2']));
  await page.locator('#menu-btn').click();
  const menu = page.getByRole('dialog', { name: 'Room menu' });
  await expect(menu.locator('.nav .sec')).toHaveText('Administration');
  await expect(menu.locator('.room')).toContainText('4 bidder groups');
  await expect(menu.locator('.room')).not.toContainText('Sell-side');
  await menu.getByRole('button', { name: 'Close the room menu' }).click();
  await expect(menu).toHaveCount(0);
});

test('a 410 ends the session and reopening keeps the place', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(view(NODE['2.4.2'], '?page=3'));
  await expect(page.locator('#p3 img')).toBeVisible({ timeout: 20_000 });
  await page.route('**/pages/**', (r) => r.fulfill({ status: 410, contentType: 'application/problem+json', body: '{"title":"Viewing session ended","status":410}' }));
  await page.locator('#pg').fill('6');
  await page.locator('#pg').press('Enter');
  const ended = page.getByRole('alertdialog');
  await expect(ended).toContainText('This viewing session has ended');
  await expect(ended).toContainText('Your place is kept at page 6.');
  // nothing left under the notice to scroll to
  await expect(page.locator('#pages img, #strip img')).toHaveCount(0);
  await page.unroute('**/pages/**');
  const reopened = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/nodes/${NODE['2.4.2']}/open`));
  await ended.getByRole('button', { name: 'Open the document again' }).click();
  await reopened;
  await expect(ended).toHaveCount(0);
  await expect(page.locator('#p6 img')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#pg')).toHaveValue('6');
});

test('Open the document again clicked twice opens once', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  await page.route('**/pages/**', (r) => r.fulfill({ status: 410, contentType: 'application/problem+json', body: '{"title":"Viewing session ended","status":410}' }));
  await page.locator('#pg').fill('3');
  await page.locator('#pg').press('Enter');
  const ended = page.getByRole('alertdialog');
  await expect(ended).toContainText('This viewing session has ended');
  await page.unroute('**/pages/**');
  let opens = 0;
  await page.route(`**/nodes/${NODE['2.4.2']}/open`, async (r) => {
    opens++;
    await new Promise((done) => setTimeout(done, 500));
    return r.continue();
  });
  // each open is logged as a view
  await ended.getByRole('button', { name: 'Open the document again' }).evaluate((b: HTMLElement) => { b.click(); b.click(); });
  await expect(ended).toHaveCount(0);
  expect(opens).toBe(1);
});

test('session ends at expiresAt', async ({ page, persona }) => {
  await persona('jan');
  await page.clock.install();
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  await page.clock.fastForward('08:00:05');
  await expect(page.getByRole('alertdialog')).toContainText('This viewing session has ended');
  await expect(page.locator('#pages img, #strip img')).toHaveCount(0);
});

test('a page refused for a lost sign-in goes to sign-in', async ({ page, persona }) => {
  await persona('jan');
  await page.route('**/pages/**', (r) => r.fulfill({ status: 401, contentType: 'application/problem+json', body: '{"title":"Sign in","status":401}' }));
  const signIn = page.waitForRequest((r) => r.isNavigationRequest() && /\/sign-in\?next=%2Frooms%2F/.test(r.url()));
  await page.goto(view(NODE['2.4.2']));
  await signIn;
});

test('a document still being prepared says so', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(view(DOC['3.2.7']));
  await expect(page.locator('.ended[role="alert"]')).toContainText('This document is still being prepared', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Try opening it again' })).toBeVisible();
  await expect(page.locator('.ended[role="alert"] p')).toHaveText('Its pages appear here once they are ready. Try again in a minute.');
  await expect(page.locator('#vtag')).toContainText('Pages not ready yet');
  await expect(page.locator('.pager')).toBeHidden();
  await expect(page.locator('#info')).toContainText('PagesNot ready yet');
  await expect(page.locator('#dl-btn')).toHaveCount(0);
  await expect(page.locator('#info .near a.on .st')).toHaveText('Draft');
});

test('a 409 on open shows no page count', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(view(DOC['2.4.14']));
  await expect(page.locator('.ended[role="alert"]')).toContainText('This document is still being prepared', { timeout: 20_000 });
  await expect(page.locator('#vtag')).toHaveText(/^Version 1 of 1 · Pages not ready yet · PDF$/);
  await expect(page.locator('.pager')).toBeHidden();
  await expect(page.locator('#strip .th')).toHaveCount(0);
  await expect(page.locator('#pages .page')).toHaveCount(0);
  await expect(page.locator('#info')).toContainText('PagesNot ready yet');
  await expect(page.locator('#dl-btn')).toHaveCount(0);
});

test('retries a dropped connection on open', async ({ page, persona }) => {
  await persona('jan');
  const OPEN = '**/v1/workspaces/*/nodes/*/open';
  let drops = 1;
  await page.route(OPEN, (r) => (drops-- > 0 ? r.abort('failed') : r.continue()));
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ended[role="alert"]')).toHaveCount(0);
  await page.unroute(OPEN);

  let tries = 0;
  await page.route(OPEN, (r) => (++tries === 2 ? r.fulfill({ status: 503, contentType: 'application/problem+json', body: '{"detail":"The server is restarting."}' }) : r.abort('failed')));
  await page.goto(view(NODE['2.4.2']));
  const panel = page.locator('.ended[role="alert"]');
  await expect(panel).toContainText('This document could not be opened', { timeout: 30_000 });
  await expect(panel.locator('p')).toHaveText('The server could not be reached. Check your connection and try again.');
  expect(tries).toBe(3);
  await page.unroute(OPEN);
  await panel.getByRole('button', { name: 'Try opening it again' }).click();
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveCount(0);
});

test('a page cut off on the way offers to load it again', async ({ page, persona }) => {
  await persona('jan');
  let drops = 1;
  await page.route(/\/pages\/1\?session=[^&]+$/, (r) => (drops-- > 0 ? r.abort('failed') : r.continue()));
  await page.goto(view(NODE['2.4.2']));
  const p1 = page.locator('#p1');
  await expect(p1.locator('.pfail')).toContainText('Page 1 could not be shown.', { timeout: 20_000 });
  await p1.getByRole('button', { name: 'Load page 1 again' }).click();
  await expect(p1.locator('img')).toBeVisible({ timeout: 20_000 });
  await expect(p1.locator('.pfail')).toHaveCount(0);
});

test('a thumbnail cut off on the way loads on a later try', async ({ page, persona }) => {
  await persona('jan');
  let drops = 1;
  await page.route(/\/pages\/1\?session=[^&]+&size=thumb$/, (r) => (drops-- > 0 ? r.abort('failed') : r.continue()));
  await page.goto(view(NODE['2.4.2']));
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  expect(drops).toBeLessThan(1);
  await expect(page.locator('#strip .th').first().locator('img')).toBeVisible({ timeout: 20_000 });
});

test('a 5xx on every try shows the reason and Try again', async ({ page, persona }) => {
  await persona('jan');
  let tries = 0;
  await page.route('**/v1/workspaces/*/nodes/*/open', (r) => { tries++; return r.fulfill({ status: 503, contentType: 'application/problem+json', body: '{"detail":"The server is restarting. Try again in a minute."}' }); });
  await page.goto(view(NODE['2.4.2']));
  const panel = page.locator('.ended[role="alert"]');
  await expect(panel).toContainText('This document could not be opened', { timeout: 30_000 });
  await expect(panel.locator('p')).toHaveText('The server is restarting. Try again in a minute.');
  await expect(panel.getByRole('button', { name: 'Try opening it again' })).toBeVisible();
  expect(tries).toBe(3);
});

test('steps through published documents only', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(view(DOC['2.4.12']));
  // 2.4.13 is a draft
  await expect(page.locator('.docnav [data-doc="1"]')).toHaveAttribute('title', '2.4.14 Transport services agreement Tsamvo');
  await expect(page.locator('.nextdoc b')).toHaveText('2.4.14 Transport services agreement Tsamvo', { timeout: 20_000 });
  await expect(page.locator('#info .near')).not.toContainText('2.4.13');
  await expect(page.locator('#info .near a')).toHaveCount(5);
  const menuLabel = await page.locator('#menu-btn').getAttribute('aria-label');
  expect(menuLabel).toContain('Permissions');
  expect(menuLabel).not.toContain('Administration');
});

test('reports pages read as coverage', async ({ page, persona }) => {
  await persona('pieter');
  await page.goto(view(NODE['2.4.2'], '?page=2'));
  await expect(page.locator('#p2 img')).toBeVisible({ timeout: 20_000 });
  await persona('anika');
  const res = await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes/${NODE['2.4.2']}/coverage`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { people: { name: string; pagesSeen: number }[] };
  const pieter = body.people.find((p) => p.name === 'Pieter Nel');
  expect(pieter?.pagesSeen).toBeGreaterThanOrEqual(1);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('details panel starts closed', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(view(NODE['2.4.2']));
    await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#info')).toBeHidden();
    await expect(page.locator('#info-btn')).toHaveAttribute('aria-pressed', 'false');
    const title = await page.locator('.doct').boundingBox();
    const pager = await page.locator('.pager').boundingBox();
    expect(title!.y).toBeLessThan(pager!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.locator('#info-btn').click();
    await expect(page.locator('#info')).toBeVisible();
    await page.getByRole('button', { name: 'Close the details panel' }).click();
    await expect(page.locator('#info')).toBeHidden();
    await page.locator('#info-btn').click();
    await expect(page.locator('#info')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#info')).toBeHidden();
    await page.locator('#info-btn').click();
    await page.locator('.iscrim').click({ position: { x: 10, y: 400 } });
    await expect(page.locator('#info')).toBeHidden();
  });

  test('the download choice fits on the screen', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(view(NODE['2.4.2']));
    await page.locator('#dl-btn').click();
    const box = await page.getByRole('dialog', { name: 'Download' }).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(16);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 - 16);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await expect(page.getByRole('radio').first()).toBeInViewport();
  });
});

test('download note matches the watermark fields', () => {
  const all = { name: 'Jan de Vries', email: 'jan@bidder-a.example.com', group: 'Bidder A', dateTime: true, ip: true };
  expect(watermarkSentence(all, 'values')).toBe('Every page carries Jan de Vries, jan@bidder-a.example.com, Bidder A, today’s date and time and your IP address.');
  expect(watermarkSentence(all, 'you')).toBe('Every page carries your name, your email address, your group, today’s date and time and your IP address.');
  const nameAndDate = { name: 'Jan de Vries', email: null, group: null, dateTime: true, ip: false };
  expect(watermarkSentence(nameAndDate, 'you')).toBe('Every page carries your name and today’s date and time.');
  expect(watermarkSentence({ ...nameAndDate, dateTime: false }, 'values')).toBe('Every page carries Jan de Vries.');
  const none = { name: null, email: null, group: null, dateTime: false, ip: false };
  expect(watermarkOn(none)).toBe(false);
  expect(watermarkSentence(none, 'values')).toBe('This room prints no watermark on its pages.');
  expect(rightsSentence(50, false, nameAndDate)).toBe('Your group can read this document and download it as a PDF. Every page of the PDF carries your name and today’s date and time.');
  expect(rightsSentence(20, false, nameAndDate)).toBe('Your group can read this document online. Downloading and printing are not available for this document.');
});
