// SPDX-License-Identifier: AGPL-3.0-only
import { API_URL, expect, ROOM_ID, roomPath, test } from './fixtures';
import { dayOf, dayOfDate, dayWithYear, LONDON, re, SAST, timeOf, whenOf } from './demo-dates';
import { zoneAbbreviation } from '../src/lib/time';

const NBO = '2026-11-27T15:00:00Z';
const MP_A = '2026-12-08T08:00:00Z';

test.skip(process.env.E2E_PROD === '1', 'The dashboard runs against next dev with the API');

const DEV = { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001' };
const ANIKA = 'a369f772-bdd8-4e7f-a614-11dc069feb12';
const JAN = '49ef5130-7c1a-459b-82c1-711e02ebe85e';

async function api(request: import('@playwright/test').APIRequestContext, person: string, method: 'GET' | 'POST', path: string, data?: unknown) {
  const res = await request.fetch(`${API_URL}/v1/workspaces/${ROOM_ID}${path}`, {
    method, headers: { ...DEV, 'x-dev-person': person, ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { data } : {}),
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

test.describe('room admin, against the API', () => {
  test('shows To do, Insights and the timeline', async ({ page, persona, request }) => {
    await persona('anika');
    await page.goto(roomPath('dashboard'));
    const c1 = page.locator('[data-dashboard="admin"]');
    await expect(c1.locator('.head .over')).toHaveCount(0);
    await expect(c1.locator('.head .sub')).toHaveCount(0);
    await expect(c1.locator('h1')).toHaveText(/(One|Two|Three) tasks? needs? your action/);
    await expect(page.locator('.side .room')).toContainText('4 bidder groups');
    await expect(page.locator('.side .room')).not.toContainText('Sell-side');

    const drafts = c1.getByRole('region', { name: 'Drafts to review and publish' });
    // 441 or more: other specs add drafts
    await expect(async () => {
      const count = async () => (await api(request, ANIKA, 'GET', '/dashboard')).toDo.drafts.count as number;
      const before = await count();
      await page.reload();
      const shown = Number((await drafts.locator('.k').innerText()).replace(/,/g, ''));
      expect(await count()).toBe(before);
      expect(shown).toBe(before);
      expect(shown).toBeGreaterThanOrEqual(441);
    }).toPass({ timeout: 30_000 });
    await expect(drafts.locator('.badge')).toHaveText(/^Waiting \d+ (day|days|hours?)$/);
    await expect(drafts.getByRole('link', { name: 'Review and publish' })).toHaveAttribute('href', roomPath('release'));

    const activity = c1.getByRole('region', { name: 'Bidder activity' });
    await expect(activity.locator('.trow[data-group]')).toHaveCount(5);
    await expect(activity.locator('.trow[data-group="Bidder C financiers"]')).toContainText('subgroup');
    await expect(activity.locator('.trow[data-group]').last()).toHaveAttribute('data-group', 'Heron management');
    await expect(activity.getByRole('link', { name: 'Open activity log' })).toHaveAttribute('href', roomPath('activity'));

    const timeline = c1.getByRole('region', { name: 'Current phase' });
    await expect(timeline.locator('.over')).toHaveText('Phase 1 of 2 · First round');
    await expect(timeline.locator('.big small')).toHaveText(/days? left in this phase/);
    await expect(timeline.locator('.ms-what')).toHaveText('Ends with: non-binding offers due');
    await expect(timeline).toContainText(`${dayWithYear(NBO, SAST)}, ${timeOf(NBO, SAST)}`);
    await expect(timeline).toContainText(/Day \d+ of 24 in this phase/);
    await expect(timeline.locator('.phase')).toHaveText([/Phase 1 · First round\s*now/i, new RegExp(`Phase 2 · Second round\\s*from ${re(dayOfDate('2026-11-30'))}`, 'i')]);
    await expect(timeline.locator('.pend')).toHaveCount(2);
    await expect(timeline.locator('.pend.next')).toHaveAttribute('data-milestone', 'Non-binding offers due');
    await expect(timeline.locator('.pend.next')).toContainText('End of phase 1');
    await expect(timeline.locator('.pend.next .d')).toHaveText(whenOf(NBO, SAST));
    await expect(timeline.locator('[data-milestone="Room opened"] .d')).toHaveText(dayOf('2026-11-03T07:00:00Z', SAST));
    await expect(timeline.locator('[data-milestone="Room opened"]')).toContainText('All groups');
    await expect(timeline.locator('[data-milestone="Q&A cut-off"] .d')).toHaveText(whenOf('2027-01-22T15:00:00Z', SAST));
    await expect(timeline.locator('[data-milestone="Management presentation, Bidder C"] .chip')).toHaveText('Bidder C only');
    await expect(timeline).toContainText('Times in your time zone, Johannesburg (SAST).');
    await expect(timeline.getByRole('link', { name: 'Edit timeline' })).toHaveAttribute('href', roomPath('timeline'));
  });

  test('declines an access request', async ({ page, persona, request }) => {
    const family = `Mokoena${Date.now()}`;
    const name = `Thandi ${family}`;
    await api(request, JAN, 'POST', '/team-requests', {
      givenName: 'Thandi', familyName: family, email: `thandi.${Date.now()}@bidder-a.example.com`, company: 'Orrinby Capital', reason: 'Tax adviser on our team',
    });
    await persona('anika');
    await page.goto(roomPath('dashboard'));
    const card = page.getByRole('region', { name: 'Access requests to decide' });
    const ask = card.locator(`[data-request="${name}"]`);
    await expect(ask).toContainText(`${name} to join`);
    await expect(ask.locator('.chip')).toHaveText('Bidder A');
    await expect(ask.locator('.l2')).toContainText('Asked by Jan de Vries · today, ');
    await expect(ask.locator('.l2')).toContainText('SAST · “Tax adviser on our team”');
    await expect(card.locator('.badge')).toHaveText(/^Waiting/);
    await ask.getByRole('button', { name: 'Decline' }).click();
    const dlg = page.getByRole('dialog', { name: `Decline the request for ${name}?` });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Reason for Jan (optional)').fill('Not needed for this phase.');
    await dlg.getByRole('button', { name: 'Decline and tell Jan' }).click();
    await expect(page.locator('.toast')).toContainText('Request declined');
    // slow under a full suite run
    await expect(page.locator(`[data-request="${name}"]`)).toHaveCount(0, { timeout: 20_000 });
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    const mine = page.getByRole('region', { name: 'Your requests' });
    await expect(mine.locator('.req', { hasText: name })).toContainText('Declined');
  });

  test('shows the checklist in a new room', async ({ page, persona, request }) => {
    const roomName = `Project Osprey ${Date.now()}`;
    const res = await request.post(`${API_URL}/v1/workspaces`, {
      headers: { ...DEV, 'x-dev-person': ANIKA, 'content-type': 'application/json' },
      data: { name: roomName, timeZone: 'Africa/Johannesburg', start: 'standard' },
    });
    expect(res.status(), await res.text()).toBe(201);
    const { id } = await res.json();
    await persona('anika');
    await page.goto(`/rooms/${id}/dashboard`);
    const c1 = page.locator('[data-dashboard="new-room"]');
    await expect(c1.locator('h1')).toHaveText(`Get ${roomName} ready`);
    await expect(c1.locator('.ready h2')).toHaveText('1 of 7 done');
    await expect(c1.locator('.steps2 li')).toHaveCount(7);
    await expect(c1.locator('.steps2 li.done')).toContainText(/Done by Anika Pillay on \w{3} \d+ \w{3} \d{4}, with the standard M&A index of 11 folders\./);
    await expect(c1.locator('.steps2 li').nth(4)).toContainText('Ask for the NDABidders accept it before they see a document.');
    await expect(c1.getByRole('link', { name: 'Open NDA settings' })).toHaveAttribute('href', `/rooms/${id}/settings?tab=nda`);
    await expect(c1.getByRole('link', { name: 'Go to People' })).toHaveAttribute('href', `/rooms/${id}/people`);
    await expect(c1.getByRole('link', { name: 'Open the room' })).toHaveAttribute('href', `/rooms/${id}/settings`);
    await expect(page.locator('.side .room')).toContainText('Preparing · no bidders yet');
  });
});

test.describe('bidders and the seller side, against the API', () => {
  test('bidder lead sees new documents and team reading', async ({ page, persona, request }) => {
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    const c1 = page.locator('[data-dashboard="lead"]');
    await expect(c1.locator('.over').first()).toHaveText('Project Heron · Bidder A');
    await expect(c1.locator('h1')).toHaveText(/new documents?/);
    const list = c1.getByRole('region', { name: 'New since your last visit' });
    await expect(list.locator('.fhead').first()).toContainText('Corporate');
    await expect(list.locator('.doc').first()).toHaveAttribute('href', /\/view\//);
    const team = c1.getByRole('region', { name: "Your team's reading by folder" });
    await expect(team.locator('h2')).toHaveText(/^Your team has opened [\d,]+ of [\d,]+ documents$/);
    // another spec may add a colleague meanwhile
    await expect(async () => {
      const size = async () => ((await api(request, JAN, 'GET', '/my-team')).groups as { name: string; members: { status: string }[] }[])
        .find((g) => g.name === 'Bidder A')!.members.filter((m) => m.status === 'active').length;
      const before = await size();
      await page.reload();
      const shown = await team.innerText();
      expect(await size()).toBe(before);
      expect(shown).toContain(`Bidder A, all ${before} members · only leads see this`);
    }).toPass({ timeout: 30_000 });

    const timeline = c1.getByRole('region', { name: 'Current phase' });
    await expect(timeline.locator('.over')).toHaveText('Phase 1 of 2 · First round');
    await expect(timeline.locator('.pend.next .d')).toHaveText(whenOf(NBO, LONDON));
    await expect(timeline).toContainText(`${dayWithYear(NBO, LONDON)}, ${timeOf(NBO, LONDON)}`);
    await expect(timeline.locator('[data-milestone="Management presentation, Bidder A"] .d')).toHaveText(whenOf(MP_A, LONDON));
    await expect(timeline.locator('.vis')).toHaveCount(0);
    await expect(timeline).toContainText(`Times in your time zone, London (${zoneAbbreviation(new Date(), LONDON)}). Change it in your profile.`);
    await expect(c1.getByRole('region', { name: 'Your requests' }).getByRole('link', { name: 'Request to add a colleague' })).toBeVisible();
    for (const other of ['Bidder B', 'Bidder C', 'All groups', 'bidder groups']) await expect(page.locator('.app')).not.toContainText(other);
  });

  test('shows 5 new documents per folder', async ({ page, persona, request }) => {
    const dash = await api(request, JAN, 'GET', '/dashboard');
    const groups = dash.newSinceLastVisit as { folder: string | null; folderId: string | null; count: number; items: unknown[] }[];
    for (const f of groups) expect(f.items.length).toBe(Math.min(f.count, 5));
    // no earlier visit, so everything counts as new
    const big = groups.find((f) => f.count > 5 && f.folderId);
    expect(big, `The seeded room should give Jan a folder with more than 5 new documents; it gives ${JSON.stringify(groups.map((f) => [f.folder, f.count]))}`)
      .toBeTruthy();
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    const list = page.getByRole('region', { name: 'New since your last visit' });
    const group = list.locator('.fgroup', { has: page.locator('.fhead', { hasText: big!.folder!.split(' ').slice(1).join(' ') }) }).first();
    await expect(group.locator('.fhead em')).toHaveText(`5 of ${big!.count.toLocaleString('en-GB')} new`);
    await expect(group.locator('.doc')).toHaveCount(5);
    const showAll = group.getByRole('link', { name: `Show all of ${big!.folder} in Documents` });
    await expect(showAll).toHaveText('Show all');
    await showAll.click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/documents/${big!.folderId}$`));
  });

  test('Clear this list stays local', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    const list = page.getByRole('region', { name: 'New since your last visit' });
    await expect(list.locator('.doc').first()).toBeVisible();
    const calls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/v1/')) calls.push(`${r.method()} ${r.url()}`); });
    await list.getByRole('button', { name: 'Clear this list' }).click();
    await expect(list.locator('.doc')).toHaveCount(0);
    await expect(list).toContainText('You cleared this list.');
    expect(calls).toEqual([]);
  });

  test('bidder member sees own reading only', async ({ page, persona }) => {
    await persona('pieter');
    await page.goto(roomPath('dashboard'));
    const c1 = page.locator('[data-dashboard="member"]');
    await expect(c1.locator('.over').first()).toHaveText('Project Heron · Bidder A');
    const own = c1.getByRole('region', { name: 'Your reading by folder' });
    await expect(own.locator('h2')).toHaveText(/^You have opened [\d,]+ of [\d,]+ documents$/);
    await expect(own.locator('.ph .cap')).toHaveText('Only you see this');
    await expect(own).toContainText('Your lead sees how Bidder A reads as a team. Nobody else in your team sees your figures.');
    await expect(own.locator('.cov > div')).toHaveCount(7);
    await expect(page.getByText(/Your team has opened/)).toHaveCount(0);
    await expect(c1.getByRole('region', { name: 'Adding colleagues' })).toContainText('Jan de Vries');
    await expect(c1.getByRole('region', { name: 'Adding colleagues' })).toContainText('The room admin approves each request.');
    await expect(page.getByText('Request to add a colleague')).toHaveCount(0);
    await expect(c1.getByRole('region', { name: 'Current phase' })).toBeVisible();
  });

  test('no leads, no lead text', async ({ page, persona }) => {
    await persona('lars');
    await page.goto(roomPath('dashboard'));
    const c1 = page.locator('[data-dashboard="member"]');
    const own = c1.getByRole('region', { name: 'Your reading by folder' });
    await expect(own.locator('.pfoot')).toHaveText('Nobody else in your team sees your figures.');
    await expect(c1.getByRole('region', { name: 'Adding colleagues' })).toContainText('The leads of Bidder C financiers can request');
  });

  test('observer sees no bidder figures', async ({ page, persona }) => {
    await persona('liesl');
    await page.goto(roomPath('dashboard'));
    const c1 = page.locator('[data-dashboard="seller"]');
    await expect(c1.getByRole('region', { name: 'New since your last visit' })).toBeVisible();
    await expect(c1.getByRole('region', { name: 'Current phase' })).toBeVisible();
    await expect(page.getByText(/has opened|You have opened/)).toHaveCount(0);
  });
});

test.describe('/demo/dashboard', () => {
  test('bidder lead', async ({ page }) => {
    await page.goto('/demo/dashboard?as=lead');
    const c1 = page.locator('[data-dashboard="lead"]');
    await expect(c1.locator('h1')).toHaveText('14 new documents since your last visit');
    await expect(c1.locator('.head .sub')).toHaveText('Your last visit was Tue 10 Nov, 14:42 GMT. Most of what is new is in Finance.');
    const list = c1.getByRole('region', { name: 'New since your last visit' });
    await expect(list.locator('.fhead')).toHaveText(['2Legal3 new', '3Finance5 of 6 new', '4Commercial2 new', '5HR2 new', '7Property1 new']);
    await expect(list.locator('.doc')).toHaveCount(13);
    const showAll = list.getByRole('link', { name: 'Show all of 3 Finance in Documents' });
    await expect(showAll).toHaveText('Show all');
    await expect(showAll).toHaveAttribute('href', '/rooms/demo/documents/demo-f3');
    await expect(list.locator('.fmore')).toHaveCount(1);
    await expect(list.locator('.doc').first()).toContainText('2.4.12');
    await expect(list.locator('.doc').first().locator('.ft')).toHaveText('PDF');
    await expect(list.locator('.doc').first().locator('.tag-new')).toHaveText('NEW');
    await expect(list.locator('.doc').first().locator('.when')).toHaveText('Wed 11 Nov');
    const team = c1.getByRole('region', { name: "Your team's reading by folder" });
    await expect(team.locator('h2')).toHaveText('Your team has opened 398 of 887 documents');
    await expect(team).toContainText('Bidder A, all 7 members · only leads see this');
    await expect(team).toContainText('Nobody in your team has opened 6 IT yet: 27 documents.');
    const reqs = c1.getByRole('region', { name: 'Your requests' });
    await expect(reqs.locator('.req').first()).toContainText('Requested Wed 11 Nov · waiting for the room admin');
    await expect(reqs.locator('.req').first().locator('.badge')).toHaveText('Pending');
    await expect(reqs.locator('.req').nth(1)).toContainText('Approved Mon 9 Nov · now in Bidder A');
  });

  test('timeline card', async ({ page }) => {
    await page.goto('/demo/dashboard?as=lead');
    const card = page.getByRole('region', { name: 'Current phase' });
    await expect(card.locator('.over')).toHaveText('Phase 1 of 2 · First round');
    await expect(card.locator('.big')).toHaveText('15days left in this phase');
    await expect(card.locator('.ms-what')).toHaveText('Ends with: non-binding offers due');
    await expect(card).toContainText('Fri 27 Nov 2026, 15:00 GMT');
    await expect(card.locator('.bar i')).toHaveAttribute('style', /width: ?42%/);
    await expect(card).toContainText('Day 10 of 24 in this phase');
    await expect(card.locator('.tl > div')).toHaveText([
      /^Phase 1 · First round\s*now$/i,
      /^Room opened\s*Tue 3 Nov$/,
      /^Q&A round 1 closes\s*Fri 20 Nov, 15:00 GMT$/,
      /^Non-binding offers dueEnd of phase 1\s*Fri 27 Nov, 15:00 GMT$/,
      /^Phase 2 · Second round\s*from Mon 30 Nov$/i,
      /^Management presentation, Bidder A\s*Tue 8 Dec, 08:00 GMT$/,
      /^Q&A cut-off\s*Fri 22 Jan, 15:00 GMT$/,
      /^Binding offers dueEnd of phase 2\s*Fri 12 Feb, 15:00 GMT$/,
    ]);
    await expect(card.locator('.pend.next')).toHaveAttribute('data-milestone', 'Non-binding offers due');
    await expect(card).toContainText('Times in your time zone, London (GMT). Change it in your profile.');
    await expect(card).not.toContainText('Bidder C');
  });

  test('Clear this list stays cleared', async ({ page }) => {
    await page.goto('/demo/dashboard?as=lead');
    const list = page.getByRole('region', { name: 'New since your last visit' });
    await expect(list.locator('.doc')).toHaveCount(13);
    const calls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/v1/')) calls.push(r.url()); });
    await list.getByRole('button', { name: 'Clear this list' }).click();
    await expect(list.locator('.doc')).toHaveCount(0);
    await expect(list).toContainText('You cleared this list.');
    await expect(page.locator('[data-dashboard="lead"] h1')).toHaveText('Nothing new since you cleared the list');
    const sub = page.locator('[data-dashboard="lead"] .head .sub');
    await expect(sub).toContainText('You cleared the list ');
    await expect(sub).not.toContainText('Most of');
    await expect(sub).not.toContainText('first visit');
    expect(calls).toEqual([]);
    await page.reload();
    await expect(page.getByRole('region', { name: 'New since your last visit' }).locator('.doc')).toHaveCount(0);
  });

  test('bidder member', async ({ page }) => {
    await page.goto('/demo/dashboard?as=member');
    const c1 = page.locator('[data-dashboard="member"]');
    await expect(c1.locator('h1')).toHaveText('14 new documents since your last visit');
    await expect(page.getByText(/Your team has opened/)).toHaveCount(0);
    const own = c1.getByRole('region', { name: 'Your reading by folder' });
    await expect(own.locator('h2')).toHaveText('You have opened 87 of 887 documents');
    await expect(own.locator('.ph .cap')).toHaveText('Only you see this');
    await expect(own.locator('.cov .r')).toHaveText(['7 / 38', '21 / 214', '33 / 186', '19 / 342', '3 / 61', '0 / 27', '4 / 19']);
    await expect(own.locator('.pfoot')).toHaveText('Your leads see how Bidder A reads as a team. Nobody else in your team sees your figures.');
    await expect(c1.getByRole('region', { name: 'Adding colleagues' }))
      .toHaveText(/Your leads, Jan de Vries and Sipho Dlamini, can request to add colleagues to Bidder A\. The room admin approves each request\./);
    await expect(page.getByText('Request to add a colleague')).toHaveCount(0);
  });

  test('room admin', async ({ page }) => {
    await page.goto('/demo/dashboard?as=admin');
    const c1 = page.locator('[data-dashboard="admin"]');
    await expect(c1.locator('h1')).toHaveText('Three tasks need your action');
    await expect(c1.locator('.head .sub')).toHaveCount(0);
    await expect(c1.locator('.head .cta .btn')).toHaveText('See the room as…');
    await expect(c1.locator('.attn > .task .over')).toHaveText(['Drafts to publish', 'Access requests', 'Failed processing']);
    await expect(c1.locator('.attn > .task .badge')).toHaveText(['Waiting 3 days', 'Waiting 1 day', 'Failed']);
    await expect(c1.locator('[data-request="Lars Eriksen"] .l2')).toHaveText('Asked by Mei Tanaka · today, 08:10 SAST · “Lead arranger, Skarvik Bank”');
    const failed = c1.getByRole('region', { name: 'File that failed processing' });
    await expect(failed).toContainText('The file is password protected, so VDRkit cannot convert it for viewing. Uploaded by Maria Botha today, 09:40 SAST.');
    await expect(failed.locator('li')).toHaveCount(2);
    await expect(failed.locator('.pfoot .btn')).toHaveText(['Upload a new copy', 'Ask Maria Botha']);
    await failed.getByRole('button', { name: 'Ask Maria Botha' }).click();
    await expect(failed.getByRole('status')).toHaveText('Email sent to Maria Botha, asking for a copy without a password. Logged in Activity.');
    await expect(c1.getByRole('region', { name: 'Bidder activity' }).locator('h3')).toHaveText('Bidder C opened the most documents today');
    await expect(c1.locator('.trow[data-group]')).toHaveText([/^Bidder C/, /^Bidder A/, /^Bidder A · financier/, /^Bidder B/, /^Seller observers/]);
    await expect(c1.locator('.note')).toHaveText('Bidder B has slowed down. 22 documents opened last Friday, 4 so far today, and nothing from 3 of its 5 members this week.');
    await expect(c1.locator('.trow[data-group="Bidder B"] .spark')).toHaveClass(/fall/);
    await expect(c1.locator('.trow[data-group="Bidder B"] .spark')).toHaveAttribute('aria-label', /\. Slowed down: shown in yellow, as in the note below the table\.$/);
    await expect(c1.locator('.trow[data-group="Bidder B"] .spark title')).toHaveText('Slowed down. See the note below the table.');
    await expect(c1.locator('.trow[data-group="Bidder A"] .spark title')).toHaveCount(0);
    const top = await c1.locator('.trow[data-group="Bidder A"]').boundingBox();
    const sub = await c1.locator('.trow[data-group="Bidder A · financier"]').boundingBox();
    expect(sub!.width).toBeCloseTo(top!.width, 0);
    const timeline = c1.getByRole('region', { name: 'Current phase' });
    await expect(timeline.locator('[data-milestone="Management presentation, Bidder A"] .chip')).toHaveText('Bidder A only');
    await expect(timeline.locator('[data-milestone="Q&A round 1 closes"] .vis')).toHaveText('All groups');
    await expect(timeline.locator('.pend.next .d')).toHaveText('Fri 27 Nov, 17:00 SAST');
    await expect(timeline.locator('.big')).toHaveText('15days left in this phase');
    await expect(timeline).toContainText('Times in your time zone, Johannesburg (SAST).');
  });

  test('drafts card spacing', async ({ page }) => {
    await page.goto('/demo/dashboard?as=admin');
    const card = page.getByRole('region', { name: 'Drafts to review and publish' });
    const why = await card.locator('.why').boundingBox();
    const list = await card.locator('ul').boundingBox();
    expect(Math.round(list!.y - (why!.y + why!.height))).toBe(13);
  });

  test('empty states', async ({ page }) => {
    await page.goto('/demo/dashboard?as=new');
    await expect(page.locator('[data-dashboard="new-room"] h1')).toHaveText('Get Project Heron ready');
    await expect(page.locator('.steps2 .btn')).toHaveText(['Bulk import', 'Go to People', 'Go to Permissions', 'Open NDA settings', 'Release review', 'Open the room']);
    await page.goto('/demo/dashboard?as=waiting');
    const c1 = page.locator('[data-dashboard="waiting"]');
    await expect(c1.locator('.empty h2')).toHaveText('No documents shared with Bidder A yet');
    await expect(c1.locator('h1')).toHaveText('Dashboard');
    await expect(c1.locator('.empty p')).toHaveText('The seller is still preparing the documents. We email you when the first ones are published, in your daily summary at 08:00.');
    await expect(c1.getByRole('link', { name: 'Change how you are told' })).toBeVisible();
  });
});
