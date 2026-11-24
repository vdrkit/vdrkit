// SPDX-License-Identifier: AGPL-3.0-only
// Project Heron is read-only here (the dashboard specs count its dates); changes use a new room per test.
import { API_URL, expect, ROOM_ID, roomPath, test, type PersonaKey } from './fixtures';
import { dayOf, dayOfDate, dayWithYear, demoAt, demoDay, demoIso, LONDON, re, SAST, timeOf, whenOf } from './demo-dates';
import { formatTime, zoneAbbreviation } from '../src/lib/time';

test.skip(process.env.E2E_PROD === '1', 'The timeline runs against next dev with the API');

const DEV = { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001' };
const ANIKA = 'a369f772-bdd8-4e7f-a614-11dc069feb12';

type Request = import('@playwright/test').APIRequestContext;

const QA1 = '2026-11-20T15:00:00Z';
const NBO = '2026-11-27T15:00:00Z';
const MP_A = '2026-12-08T08:00:00Z';
const MP_C = '2026-12-09T08:00:00Z';
const BO = '2027-02-12T15:00:00Z';
// GMT or BST depending on today
const GMT_NOW = zoneAbbreviation(new Date(), LONDON);

async function api(request: Request, method: 'GET' | 'POST', path: string, data?: unknown) {
  const res = await request.fetch(`${API_URL}${path}`, {
    method, headers: { ...DEV, 'x-dev-person': ANIKA, ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { data } : {}),
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function newRoom(request: Request) {
  const { id } = await api(request, 'POST', '/v1/workspaces', { name: `Project Kite ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, timeZone: 'Africa/Johannesburg', start: 'empty' });
  const north = await api(request, 'POST', `/v1/workspaces/${id}/groups`, { name: 'Bidder North', newParty: { name: 'Bergholt Noord Capital', kind: 'bidder' } });
  const south = await api(request, 'POST', `/v1/workspaces/${id}/groups`, { name: 'Bidder South', newParty: { name: 'Suidkrans Partners', kind: 'bidder' } });
  return { id: id as string, north: north.id as string, south: south.id as string };
}

test.describe('room admin, demo room', () => {
  test('lists phases with their events', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('timeline'));
    const f2 = page.locator('[data-screen="timeline"]');
    await expect(page.locator('.crumbs')).toHaveText(/Project Heron\s*\/\s*Administration\s*\/\s*Timeline/);
    await expect(page.locator('.nav a[aria-current="page"]')).toHaveText('Timeline');
    await expect(f2.locator('h1')).toHaveText('Timeline');
    await expect(f2.locator('.head .sub')).toContainText('You set times in room time, SAST.');
    await expect(f2.getByRole('button', { name: 'Add a phase' })).toBeVisible();

    const first = f2.getByRole('region', { name: 'Phase 1' });
    await expect(first.locator('.over')).toHaveText('Phase 1 of 2');
    await expect(first.locator('h2')).toHaveText('First roundNow');
    await expect(first.locator('.phh .cap')).toHaveText(new RegExp(`^${re(dayOfDate('2026-11-03'))} to ${re(dayWithYear(NBO, SAST))} · \\d+ days? left$`));
    await expect(first.locator('[data-milestone="Room opened"]')).toHaveClass(/done/);
    await expect(first.locator('[data-milestone="Room opened"] .vis')).toHaveText('Done');
    await expect(first.locator('[data-milestone="Q&A round 1 closes"] .when')).toHaveText(`${dayOf(QA1, SAST)}${timeOf(QA1, SAST)}`);
    await expect(first.locator('[data-milestone="Q&A round 1 closes"] .vis')).toHaveText('All bidder groups');
    await expect(first.locator('.trow').last()).toHaveClass(/end/);
    await expect(first.locator('.trow.end .what')).toHaveText('Non-binding offers dueEnd of phase 1, the date bidders count down to · all bidder groups');
    await expect(first.getByRole('button', { name: 'Add an event to first round' })).toBeVisible();

    const second = f2.getByRole('region', { name: 'Phase 2' });
    await expect(second.locator('h2')).toHaveText('Second roundNext');
    await expect(second.locator('.phh .cap')).toHaveText(new RegExp(`^${re(dayOfDate('2026-11-30'))} to ${re(dayWithYear(BO, SAST))} · starts in \\d+ days?$`));
    await expect(second.locator('[data-milestone="Management presentation, Bidder C"] .chip')).toHaveText('Bidder C only');
    await expect(second.locator('[data-milestone="Binding offers due"] .when')).toHaveText(`${dayOf(BO, SAST)}${timeOf(BO, SAST)}`);
  });

  test('previews the card per bidder group', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('timeline'));
    const aside = page.getByLabel('What bidders see on their dashboard');
    const card = aside.getByRole('region', { name: 'Current phase' });
    await expect(aside.getByLabel('Show it as')).toHaveValue(/.+/);
    await expect(aside.locator('option')).toHaveText(['Bidder A', 'Bidder B', 'Bidder C', 'Bidder C financiers']);
    await expect(card.locator('.over')).toHaveText('Phase 1 of 2 · First round');
    await expect(card.locator('[data-milestone="Management presentation, Bidder A"] .d')).toHaveText(whenOf(MP_A, LONDON));
    await expect(card.locator('[data-milestone="Management presentation, Bidder C"]')).toHaveCount(0);
    await expect(card).toContainText(`Bidder A's lead works in ${GMT_NOW}, so times show in ${GMT_NOW}. Events for other bidders do not appear.`);
    await expect(card.locator('.chip')).toHaveCount(0);

    await aside.getByLabel('Show it as').selectOption({ label: 'Bidder C financiers' });
    await expect(card.locator('[data-milestone="Management presentation, Bidder C"] .d')).toHaveText(whenOf(MP_C, SAST));
    await expect(card.locator('[data-milestone="Management presentation, Bidder A"]')).toHaveCount(0);
    await expect(card).toContainText('Bidder C financiers works in SAST');
  });

  test("preview matches the bidder's own dashboard", async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('timeline'));
    const preview = await page.getByLabel('What bidders see on their dashboard').locator('.tl > div').allInnerTexts();
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    const own = await page.getByRole('region', { name: 'Current phase' }).locator('.tl > div').allInnerTexts();
    expect(own.length).toBeGreaterThan(4);
    expect(preview).toEqual(own);
  });

  test('edit dialog shows room and bidder time', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('timeline'));
    await page.getByRole('button', { name: 'Edit Management presentation, Bidder A' }).click();
    const dlg = page.getByRole('dialog', { name: 'Edit event' });
    await expect(dlg.getByLabel('Event')).toHaveValue('Management presentation, Bidder A');
    await expect(dlg.getByLabel('Date', { exact: true })).toHaveValue(demoDay('2026-12-08'));
    await expect(dlg.getByLabel('Time, SAST')).toHaveValue('10:00');
    await expect(dlg).toContainText(`Bidder A sees ${timeOf(MP_A, LONDON)}.`);
    await expect(dlg.getByLabel('Only some bidder groups')).toBeChecked();
    await expect(dlg.getByLabel('Bidder A', { exact: true })).toBeChecked();
    await expect(dlg.getByLabel('Email the groups that see it about this change')).toBeChecked();
    await expect(dlg.getByRole('button', { name: 'Remove event' })).toBeVisible();
    await dlg.getByLabel('Time, SAST').fill('11:30');
    await expect(dlg).toContainText(`Bidder A sees ${formatTime(new Date(demoAt(MP_A).getTime() + 90 * 60_000), LONDON)}.`);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('[data-milestone="Management presentation, Bidder A"] .when')).toHaveText(`${dayOf(MP_A, SAST)}${timeOf(MP_A, SAST)}`);

    await page.getByRole('button', { name: 'Edit Non-binding offers due' }).click();
    const end = page.getByRole('dialog', { name: 'Edit the end of first round' });
    await expect(end).toContainText('A phase deadline is shown to every bidder group.');
    await expect(end.getByLabel('Only some bidder groups')).toHaveCount(0);
    await expect(end.getByRole('button', { name: 'Remove event' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(end).toHaveCount(0);
  });
});

test.describe('room admin, new room', () => {
  test('adds, moves and removes dates', async ({ page, persona, request }) => {
    const room = await newRoom(request);
    await persona('anika');
    await page.goto(`/rooms/${room.id}/timeline`);
    const f2 = page.locator('[data-screen="timeline"]');

    await expect(f2.locator('.empty h2')).toHaveText('No dates yet');
    await f2.getByRole('button', { name: 'Add a phase' }).click();
    let dlg = page.getByRole('dialog', { name: 'Add a phase' });
    await dlg.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Name the phase and its deadline');
    await dlg.getByLabel('Name').fill('First round');
    await dlg.getByLabel('Starts').fill(demoDay('2026-11-02'));
    await dlg.getByLabel('Ends with').fill('Non-binding offers due');
    await dlg.getByLabel('Deadline date').fill(demoDay('2027-01-29'));
    await dlg.getByLabel(/^Time, /).fill('17:00');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Phase added');
    await expect(page.locator('.toast')).toContainText('All 2 bidder groups see it on their dashboard and are told by email. Logged in Activity.');
    const phase = f2.getByRole('region', { name: 'Phase 1' });
    await expect(phase.locator('h2')).toHaveText('First roundNow');
    await expect(phase.locator('.trow.end')).toHaveClass(/changed/);

    await phase.getByRole('button', { name: 'Add an event to first round' }).click();
    dlg = page.getByRole('dialog', { name: 'Add an event to first round' });
    await dlg.getByLabel('Event').fill('Management presentation');
    await dlg.getByLabel('Date', { exact: true }).fill(demoDay('2026-12-10'));
    await dlg.getByLabel('Time, SAST').fill('10:00');
    await dlg.getByLabel('Only some bidder groups').check();
    await dlg.getByLabel('Bidder North').uncheck();
    await dlg.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Choose at least one group');
    await dlg.getByLabel('Bidder South').check();
    await expect(dlg.getByLabel('Email the groups that see it about this new date')).toBeChecked();
    await dlg.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Event added');
    await expect(page.locator('.toast')).toContainText('Bidder South is told by email. Logged in Activity.');
    const row = phase.locator('[data-milestone="Management presentation"]');
    await expect(row.locator('.chip')).toHaveText('Bidder South only');
    await expect(row).toHaveClass(/changed/);

    const aside = page.getByLabel('What bidders see on their dashboard');
    await aside.getByLabel('Show it as').selectOption({ label: 'Bidder North' });
    await expect(aside.locator('[data-milestone="Management presentation"]')).toHaveCount(0);
    await aside.getByLabel('Show it as').selectOption({ label: 'Bidder South' });
    await expect(aside.locator('[data-milestone="Management presentation"]')).toHaveCount(1);
    await expect(aside).toContainText('Nobody in Bidder South has joined yet, so this uses room time, SAST.');

    await row.getByRole('button', { name: 'Edit Management presentation' }).click();
    dlg = page.getByRole('dialog', { name: 'Edit event' });
    await dlg.getByLabel('Date', { exact: true }).fill(demoDay('2026-12-11'));
    await dlg.getByLabel('Email the groups that see it about this change').uncheck();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast')).toContainText('Nobody is emailed. Logged in Activity.');
    await expect(row.locator('.when')).toHaveText(`${dayOf('2026-12-11T08:00:00Z', SAST)}${timeOf('2026-12-11T08:00:00Z', SAST)}`);

    await row.getByRole('button', { name: 'Edit Management presentation' }).click();
    await dlg.getByLabel('Time, SAST').fill('14:00');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast')).toContainText('Bidder South is told by email that the date moved.');

    // 14:00 SAST = 12:00 UTC
    const items = (await api(request, 'GET', `/v1/workspaces/${room.id}/milestones`)).items;
    const ev = items.find((m: { title: string }) => m.title === 'Management presentation');
    expect(ev.dueAt).toBe(demoIso('2026-12-11T12:00:00Z'));
    expect(ev.visibleToGroupIds).toEqual([room.south]);
    const end = items.find((m: { phase: unknown }) => m.phase);
    expect(end.phase).toEqual({ name: 'First round', startsOn: demoDay('2026-11-02') });
    expect(end.dueAt).toBe(demoIso('2027-01-29T15:00:00Z'));

    await phase.getByRole('button', { name: 'Add an event to first round' }).click();
    dlg = page.getByRole('dialog', { name: 'Add an event to first round' });
    await dlg.getByLabel('Date', { exact: true }).fill(demoDay('2027-03-01'));
    await expect(dlg).toContainText('This date is after the last phase deadline');
    await dlg.getByRole('button', { name: 'Cancel' }).click();

    const patches: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/milestones/')) patches.push(r.url()); });
    await row.getByRole('button', { name: 'Edit Management presentation' }).click();
    await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast')).toContainText('Nothing changed');
    await expect(page.locator('.toast')).toContainText('Nobody is emailed.');
    await phase.getByRole('button', { name: 'Edit phase' }).click();
    await page.getByRole('dialog', { name: 'Edit phase 1' }).getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast')).toContainText('Nothing changed');
    expect(patches).toEqual([]);

    await row.getByRole('button', { name: 'Edit Management presentation' }).click();
    dlg = page.getByRole('dialog', { name: 'Edit event' });
    await dlg.getByLabel('Email the groups that see it about this change').uncheck();
    const removed = page.waitForRequest((r) => r.method() === 'DELETE');
    await dlg.getByRole('button', { name: 'Remove event' }).click();
    expect((await removed).url()).toContain('notify=false');
    await expect(page.locator('.toast')).toContainText('Event removed');
    await expect(page.locator('.toast')).toContainText('Bidder South no longer sees it. Nobody is emailed.');
    await expect(row).toHaveCount(0);

    await phase.getByRole('button', { name: 'Edit phase' }).click();
    dlg = page.getByRole('dialog', { name: 'Edit phase 1' });
    await dlg.getByRole('button', { name: 'Remove phase' }).click();
    await expect(dlg.getByRole('alert')).toContainText('Removing the phase removes its deadline, Non-binding offers due');
    await expect(dlg.getByRole('alert')).toContainText('the groups that see it are told by email');
    await dlg.getByRole('button', { name: 'Yes, remove the phase' }).click();
    await expect(page.locator('.toast')).toContainText('Phase removed');
    await expect(page.locator('.toast')).toContainText('All 2 bidder groups are told by email.');
    await expect(f2.locator('.empty h2')).toHaveText('No dates yet');
  });

  test('refuses a phase that starts after its deadline', async ({ page, persona, request }) => {
    const room = await newRoom(request);
    await persona('anika');
    await page.goto(`/rooms/${room.id}/timeline`);
    await page.getByRole('button', { name: 'Add a phase' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add a phase' });
    await dlg.getByLabel('Name').fill('Final round');
    await dlg.getByLabel('Starts').fill(demoDay('2027-03-10'));
    await dlg.getByLabel('Ends with').fill('Signing');
    await dlg.getByLabel('Deadline date').fill(demoDay('2027-03-01'));
    await dlg.getByRole('button', { name: 'Add' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('A phase starts on or before its deadline. Change the start or the deadline date.');
    expect((await api(request, 'GET', `/v1/workspaces/${room.id}/milestones`)).items).toEqual([]);
  });
});

test.describe('other roles', () => {
  // bidders, financiers and observers can read it (fu-misc.spec.ts)
  for (const who of ['maria', 'johan'] as PersonaKey[]) {
    test(`${who} gets not available`, async ({ page, persona }) => {
      await persona(who);
      const res = await page.goto(roomPath('timeline'));
      expect(res?.status()).toBe(404);
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to Project Heron' })).toHaveAttribute('href', `/rooms/${ROOM_ID}/dashboard`);
      await expect(page.locator('body')).not.toContainText('Bidder C only');
      await page.goto(roomPath('dashboard'));
      await expect(page.locator('.nav')).toBeVisible();
      await expect(page.locator('.nav a', { hasText: 'Timeline' })).toHaveCount(0);
    });
  }

  test('API hides preview groups from bidders', async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/workspaces/${ROOM_ID}/timeline/groups`, { headers: { ...DEV, 'x-dev-person': '49ef5130-7c1a-459b-82c1-711e02ebe85e' } });
    expect(res.status()).toBe(404);
  });
});
