// SPDX-License-Identifier: AGPL-3.0-only
import { API_URL, expect, ROOM_ID, roomPath, test, type PersonaKey } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Activity runs against next dev with the API');

const DEV = { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001' };
const LARS = 'c78f0956-066e-4f08-bcb8-d8b17dd90ec6';
const AFS_2021 = '711aa96c-b06f-4648-9a16-f8ed943fdc28';

test.beforeAll(async ({ request }) => {
  const res = await request.fetch(`${API_URL}/v1/workspaces/${ROOM_ID}/nodes/${AFS_2021}/open`, {
    method: 'POST', headers: { ...DEV, 'x-dev-person': LARS },
  });
  expect(res.ok(), `open 3.2.1: ${res.status()} ${await res.text()}`).toBeTruthy();
  // records page coverage
  const { sessionId } = await res.json();
  const page = await request.fetch(`${API_URL}/v1/workspaces/${ROOM_ID}/nodes/${AFS_2021}/pages/1?session=${sessionId}`, { headers: { ...DEV, 'x-dev-person': LARS } });
  expect(page.ok(), `page 1: ${page.status()}`).toBeTruthy();
});

test.describe('room admin', () => {
  test('summarises bidder groups', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('activity'));
    await expect(page.locator('h1')).toHaveText('Activity');
    await expect(page.locator('.sub').first()).toHaveText('Every view, download, upload and access change in Project Heron, in your time zone. Nobody can edit or delete an entry. Every opening is recorded here, so you can show who saw which document and when. The dashboard counts differently: there, ‘Opened’ counts each document once per person per day, to show how active a group is.');
    await expect(page.locator('.chain')).toContainText(/Log intact · checked \d\d:\d\d/);
    await expect(page.getByRole('link', { name: 'Export to CSV' })).toBeVisible();
    await expect(page.locator('nav').getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');

    const eng = page.getByRole('region', { name: 'Engagement by bidder' });
    await expect(eng.getByRole('heading', { name: 'Bidders in the last 7 days' })).toBeVisible();
    await expect(eng.locator('.erow')).toHaveCount(4);
    await expect(eng.locator('.dayhead span').last()).toContainText('Today');
    const fin = eng.locator('.erow', { hasText: 'Bidder C financiers' });
    await expect(fin).toContainText('of Bidder C');
    await expect(fin).toContainText('Finance');

    await fin.click();
    await expect(fin).toHaveClass(/\bon\b/);
    await expect(page).toHaveURL(/group=/);
    const people = page.getByRole('region', { name: 'People in Bidder C financiers' });
    await expect(people).toContainText(/1 of 1 have signed in · since the room opened/);
    const lars = people.locator('.prow[data-person]', { hasText: 'Lars Eriksen' });
    await expect(lars).toContainText('Today');
    await expect(page.locator('.active-f')).toContainText('Showing');
    await expect(page.locator('.active-f .tag')).toHaveText('Bidder C financiers');
    const rows = page.locator('.ev');
    await expect(rows.first()).toContainText('Lars Eriksen');
    await expect(rows.locator('.pers b').filter({ hasNotText: 'Lars Eriksen' })).toHaveCount(0);

    await lars.click();
    await expect(page.locator('.active-f .tag')).toHaveCount(2);
    await page.getByRole('button', { name: 'Show everyone in the group' }).click();
    await expect(page.locator('.active-f .tag')).toHaveCount(1);
    await page.getByRole('button', { name: 'Show all groups' }).click();
    await expect(page.locator('.active-f')).toHaveCount(0);
    await expect(people).toHaveCount(0);
  });

  test('shows the log with page coverage', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('activity'));
    const entry = page.locator('.ev', { hasText: 'Lars Eriksen' }).filter({ hasText: 'Audited financial statements FY2021' }).first();
    await expect(entry).toContainText('Bidder C financiers');
    await expect(entry.locator('.act')).toHaveText('Viewed');
    await expect(entry.locator('.item .n')).toHaveText('3.2.1');
    await expect(entry.locator('.det')).toContainText(/of \d+ pages/);
    await expect(page.locator('.day').first()).toContainText(/^Today, /i);
    await expect(page.locator('.lfoot')).toContainText(/Showing [\d,]+ of [\d,]+ entries\./);
    await expect(page.locator('.lfoot')).toContainText('The export contains exactly what the filters show.');
  });

  test('expands a row to its details', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('activity'));
    const viewed = page.locator('.ev', { hasText: 'Lars Eriksen' }).filter({ hasText: 'Audited financial statements FY2021' }).first();
    await expect(viewed.locator('.act')).toHaveText('Viewed');
    const looks = await page.locator('.ev .act:not(.risk)').evaluateAll((els) => [...new Set(els.map((el) => {
      const s = getComputedStyle(el);
      return `${s.color}|${s.textDecorationLine}|${s.cursor}`;
    }))]);
    expect(looks).toHaveLength(1);
    expect(looks[0]!.split('|').slice(1)).toEqual(['none', 'default']);

    // the button's name changes with its state
    const toggle = viewed.locator('.xp button');
    await expect(toggle).toHaveAccessibleName('Show the proof details of this entry');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const proof = page.locator('.proof').first();
    await expect(proof).toContainText('Kept as proof');
    await expect(proof.locator('dt')).toContainText(['Version', 'Pages viewed', 'Time spent', 'Opened at']);
    await expect(proof.locator('dd').nth(1)).toContainText(/^\d+ of \d+: /);
    await viewed.getByRole('button', { name: 'Hide the proof details of this entry' }).click();
    await expect(page.locator('.proof')).toHaveCount(0);

    const emailed = page.locator('.ev', { hasText: 'Emailed' }).filter({ has: page.locator('.xp button') }).first();
    if (await emailed.count()) {
      await emailed.locator('.xp button').click();
      const mail = page.locator('.proof').first();
      await expect(mail.locator('dt')).toContainText(['Email', 'To', 'Room', 'Mail server']);
    }
  });

  test('filters by kind and words', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('activity'));
    await page.getByRole('button', { name: 'Views', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Views', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/kind=view/);
    await expect(page.locator('.ev').first()).toBeVisible();
    await expect(page.locator('.ev .act').filter({ hasNotText: 'Viewed' })).toHaveCount(0);

    await page.getByLabel('Filter by person, document or index number').fill('Eriksen');
    await expect(page).toHaveURL(/q=Eriksen/);
    await expect(page.locator('.ev .pers b').filter({ hasNotText: 'Lars Eriksen' })).toHaveCount(0);
    await expect(page.locator('.ev').first()).toContainText('Lars Eriksen');

    await page.getByLabel('Filter by person, document or index number').fill('no such words anywhere');
    await expect(page.getByRole('heading', { name: 'No activity matches these filters' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear the filters' }).click();
    await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.ev').first()).toBeVisible();
    await expect(page.getByLabel('Period')).toHaveValue('7d');
    await expect(page).not.toHaveURL(/[?&](q|kind|period)=/);
  });

  test('a filter that fails to load shows no old rows', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('activity'));
    await expect(page.locator('.ev').first()).toBeVisible();
    const EVENTS = /\/v1\/workspaces\/[^/]+\/events\?/;
    let cut = true;
    await page.route(EVENTS, (r) => (cut ? r.abort('failed') : r.continue()));
    await page.getByRole('button', { name: 'Views', exact: true }).click();
    const failed = page.locator('.logwrap [role="alert"]');
    await expect(failed.getByRole('heading', { name: 'The activity for these filters could not be loaded' })).toBeVisible();
    await expect(failed).toContainText('The server could not be reached. Check your connection and try again.');
    await expect(page.locator('.ev')).toHaveCount(0);
    await expect(page.locator('.logwrap')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.lfoot')).toContainText('No entries shown.');
    cut = false;
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect(failed).toHaveCount(0);
    await expect(page.locator('.ev').first()).toBeVisible();
    await expect(page.locator('.ev .act').filter({ hasNotText: 'Viewed' })).toHaveCount(0);
    await page.unroute(EVENTS);
  });

  test('exports the filtered log as CSV', async ({ page, persona, request }) => {
    await persona('anika');
    await page.goto(`${roomPath('activity')}?kind=view`);
    const href = await page.getByRole('link', { name: 'Export to CSV' }).getAttribute('href');
    expect(href).toContain('kind=view');
    expect(href).toContain('from=');
    const res = await request.fetch(`${API_URL}${href}`, { headers: { ...DEV, 'x-dev-person': 'a369f772-bdd8-4e7f-a614-11dc069feb12' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0]).toContain('Time,Person,Group,Action,Document,Details');
    for (const l of lines.slice(1)) expect(l).toContain(',Viewed,');
    expect(lines.some((l) => /,\d+ of \d+ pages? · /.test(l))).toBe(true);

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export to CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/^Project Heron activity \d{4}-\d{2}-\d{2}\.csv$/);
    await expect(page.getByText('Export started')).toBeVisible();
  });
});

test('Export clicked twice asks the server once', async ({ page, persona }) => {
  await persona('anika');
  let gets = 0;
  await page.route('**/events/export.csv*', async (r) => {
    gets++;
    await new Promise((done) => setTimeout(done, 500));
    return r.fulfill({ status: 200, contentType: 'text/csv', headers: { 'content-disposition': 'attachment; filename="activity.csv"' }, body: 'Time\r\n' });
  });
  await page.goto(roomPath('activity'));
  await page.getByRole('link', { name: 'Export to CSV' }).evaluate((a: HTMLElement) => { a.click(); a.click(); });
  await expect(page.getByText('Export started')).toBeVisible();
  await page.waitForTimeout(500);
  expect(gets).toBe(1);
});

test.describe('seller observer', () => {
  test('reads the log without export', async ({ page, persona }) => {
    await persona('liesl');
    await page.goto(roomPath('dashboard'));
    await page.locator('nav').getByRole('link', { name: 'Activity' }).click();
    await expect(page).toHaveURL(/\/activity/);
    await expect(page.locator('h1')).toHaveText('Activity');
    await expect(page.getByRole('link', { name: 'Export to CSV' })).toHaveCount(0);
    await expect(page.locator('.chain')).toContainText('Log intact');
    await expect(page.locator('.lfoot')).toContainText('Observers can read the log. Export is for room admins.');
    await expect(page.locator('.ev', { hasText: 'Lars Eriksen' }).first()).toBeVisible();
    await expect(page.locator('.ev .act', { hasText: 'Processed' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Access changes' }).click();
    await expect(page.getByRole('heading', { name: 'No activity matches these filters' })).toBeVisible();
    await page.locator('.erow').first().click();
    await expect(page.locator('.erow').first().locator('.rowbtn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Send reminder' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: /^People in / })).toHaveCount(0);
  });
});

test.describe('other roles', () => {
  for (const who of ['jan', 'pieter', 'lars', 'maria', 'johan'] as PersonaKey[]) {
    test(`${who} gets not available`, async ({ page, persona }) => {
      await persona(who);
      await page.goto(roomPath('dashboard'));
      await expect(page.locator('nav').getByRole('link', { name: 'Documents' })).toBeVisible();
      await expect(page.locator('nav').getByRole('link', { name: 'Activity' })).toHaveCount(0);
      await page.goto(roomPath('activity'));
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
      await expect(page.getByText('Bidders in the last 7 days')).toHaveCount(0);
    });
  }
});
