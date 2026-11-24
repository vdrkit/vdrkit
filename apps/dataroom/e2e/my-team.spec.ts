// SPDX-License-Identifier: AGPL-3.0-only
// shared demo room: unique names and emails
import type { APIRequestContext, Page } from '@playwright/test';
import { API_URL, expect, hydrated, ROOM_ID, roomPath, test, type PersonaKey } from './fixtures';
import { dayWithYear, LONDON, timeOf } from './demo-dates';

const A_END = '2027-01-29T15:00:00Z';
const A_ENDS = `${dayWithYear(A_END, LONDON)}, ${timeOf(A_END, LONDON)}`;

test.skip(process.env.E2E_PROD === '1', 'My team runs against next dev with the API');

const DEV = { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001' };
const ANIKA = 'a369f772-bdd8-4e7f-a614-11dc069feb12';
const JAN = '49ef5130-7c1a-459b-82c1-711e02ebe85e';

async function api(request: APIRequestContext, person: string, method: 'GET' | 'POST', path: string, data?: unknown) {
  return request.fetch(`${API_URL}/v1/workspaces/${ROOM_ID}${path}`, {
    method, headers: { ...DEV, 'x-dev-person': person, ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { data } : {}),
  });
}
async function ok(request: APIRequestContext, person: string, method: 'GET' | 'POST', path: string, data?: unknown) {
  const res = await api(request, person, method, path, data);
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}
const unique = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function openTeam(page: Page, persona: (k: PersonaKey) => Promise<void>, who: PersonaKey) {
  await persona(who);
  await page.goto(roomPath('team'));
  await hydrated(page);
}

test.describe('who sees My team', () => {
  for (const who of ['anika', 'maria', 'johan', 'liesl'] as const) {
    test(`${who} gets not available`, async ({ page, persona }) => {
      await persona(who);
      await page.goto(roomPath('team'));
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to Project Heron' })).toBeVisible();
      await page.goto(roomPath('dashboard'));
      await expect(page.locator('nav.nav')).not.toContainText('My team');
    });
  }

  test('shows My team in the menu with the team size', async ({ page, persona }) => {
    for (const who of ['jan', 'pieter', 'lars'] as const) {
      await openTeam(page, persona, who);
      const link = page.locator('nav.nav a', { hasText: 'My team' });
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(link.locator('em')).toHaveText(/^\d+$/);
      await expect(page.locator('h1')).toHaveText('My team');
    }
  });
});

test.describe('bidder lead', () => {
  test('sees everyone with status', async ({ page, persona }) => {
    await openTeam(page, persona, 'jan');
    const c6 = page.locator('[data-team="lead"]');
    await expect(c6.locator('.over')).toHaveText('Bidder A · Orrinby Capital');
    await expect(c6.locator('.sub')).toContainText(/^The \d+ people in Bidder A\. Everyone here sees the same documents at the same levels\./);
    await expect(c6.locator('.sub')).toContainText('As a lead you send them a request.');
    const team = page.getByRole('region', { name: 'People in Bidder A' });
    await expect(team.locator('.tm.h')).toHaveText(/^Person\s*Status$/);
    const jan = team.locator('[data-person="Jan de Vries"]');
    await expect(jan.locator('.badge.b-lead')).toHaveText('Lead');
    await expect(jan.locator('.you')).toHaveText('You');
    await expect(jan.locator('.firm')).toHaveText('Partner, Orrinby Capital');
    await expect(jan.locator('.badge.b-ok')).toHaveText('Active');
    await expect(jan.getByRole('button', { name: 'Ask to remove' })).toHaveCount(0);
    await expect(team.locator('[data-person="Pieter Nel"]').getByRole('button', { name: 'Ask to remove' })).toHaveCount(1);
    await expect(team).toContainText('Only room admins see what anyone reads.');
    await expect(page.locator('main.content')).not.toContainText(/opened \d+ of/i);

    const access = page.getByRole('region', { name: 'Access for Bidder A' });
    await expect(access.locator('.facts')).toContainText(`Ends${A_ENDS}`);
    await expect(access.locator('.facts')).toContainText(/Sees\d+ folders, [\d,]+ documents/);
    await expect(access.locator('.facts')).toContainText('Room adminAnika Pillay, Quillmont Advisory');
    await expect(access).toContainText('A new colleague gets this same access and end date.');
  });

  test('requests a colleague, then withdraws', async ({ page, persona }) => {
    await openTeam(page, persona, 'jan');
    await page.getByRole('button', { name: 'Request to add a colleague' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request to add a colleague' });
    await expect(dlg).toContainText('To Bidder A. The room admin, Anika Pillay, decides.');
    await expect(dlg.locator('#c-fn')).toBeFocused();
    await expect(dlg).toContainText(`see exactly what Bidder A sees, until ${dayWithYear(A_END, LONDON)}. You get an email when the room admin decides.`);

    await dlg.getByRole('button', { name: 'Send request' }).click();
    await expect(dlg.locator('.hint.err')).toHaveText([
      'Write their first name. Emails greet them by it.',
      'Write their last name. Lists in the room sort by it.',
      'Write their work email address. The invitation goes there.',
      'Write the company they work for, for example their advisory firm.',
    ]);
    await expect(dlg.locator('#c-fn')).toBeFocused();
    await expect(dlg.locator('#c-fn')).toHaveAttribute('aria-invalid', 'true');

    const id = unique();
    await dlg.locator('#c-fn').fill('Thandi');
    await dlg.locator('#c-ln').fill(`Mokoena${id}`);
    await dlg.locator('#c-co').fill('Orrinby Capital');
    await dlg.locator('#c-e').fill('thandi@');
    await expect(dlg.locator('#c-e-err')).toHaveText('This is not a complete email address.');
    await dlg.locator('#c-e').fill('jan@bidder-a.example.com');
    await expect(dlg.locator('#c-e-err')).toHaveText('Jan de Vries is already in Bidder A.');
    await dlg.locator('#c-e').fill(`thandi.${id}@gmail.com`);
    await expect(dlg.locator('.note.warn')).toContainText('This is a personal address. Room admins usually decline these.');
    await dlg.locator('#c-e').fill(`thandi.${id}@bidder-c.example.com`);
    await expect(dlg.locator('.note.warn')).toHaveCount(0);
    await expect(dlg.locator('.note.info')).toContainText('This address is outside bidder-a.example.com. That is fine for an adviser.');
    await dlg.locator('#c-r').fill('Tax manager');
    await dlg.locator('#c-why').fill('Reviews the tax folder for our offer');
    await dlg.getByRole('button', { name: 'Send request' }).click();

    await expect(dlg).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Request sent');
    const requests = page.getByRole('region', { name: 'Requests to add colleagues' });
    const row = requests.locator(`[data-request="Thandi Mokoena${id}"]`);
    await expect(row.locator('.badge')).toHaveText('Waiting', { timeout: 20_000 });
    await expect(row).toContainText('Tax manager, Orrinby Capital');
    await expect(row).toContainText('by Jan de Vries · waiting for the room admin');

    await page.getByRole('button', { name: 'Request to add a colleague' }).click();
    await dlg.locator('#c-fn').fill('Thandi');
    await dlg.locator('#c-ln').fill('Again');
    await dlg.locator('#c-co').fill('Orrinby Capital');
    await dlg.locator('#c-e').fill(`thandi.${id}@bidder-c.example.com`);
    await expect(dlg.locator('#c-e-err')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Send request' }).click();
    await expect(dlg.locator('#c-e-err')).toHaveText('There is already a request waiting for this address.');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);

    await row.getByRole('button', { name: 'Withdraw request' }).click();
    await expect(page.locator('.toast')).toContainText(`Thandi Mokoena${id} will not be invited. The room admin sees it as withdrawn.`);
    await expect(row.locator('.badge')).toHaveText('Withdrawn', { timeout: 20_000 });
    await expect(row).toContainText('by Jan de Vries');
    await expect(row.getByRole('button')).toHaveCount(0);
  });

  test('resends a declined request', async ({ page, persona, request }) => {
    const id = unique();
    const { id: reqId } = await ok(request, JAN, 'POST', '/team-requests',
      { givenName: 'Mark', familyName: `Hughes${id}`, email: `mark.${id}@gmail.com`, company: 'Quellbrook Consulting', jobTitle: 'Consultant' });
    await ok(request, ANIKA, 'POST', `/team-requests/${reqId}/decide`, { decision: 'decline', note: 'A personal email address. Please use their firm’s address.' });
    await openTeam(page, persona, 'jan');
    const row = page.locator(`[data-request="Mark Hughes${id}"]`);
    await expect(row.locator('.badge')).toHaveText('Declined');
    await expect(row).toContainText('by Anika Pillay');
    await expect(row.locator('q')).toHaveText('A personal email address. Please use their firm’s address.');
    await row.getByRole('button', { name: 'Request again with changes' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request to add a colleague' });
    await expect(dlg.locator('#c-fn')).toHaveValue('Mark');
    await expect(dlg.locator('#c-ln')).toHaveValue(`Hughes${id}`);
    await expect(dlg.locator('#c-co')).toHaveValue('Quellbrook Consulting');
    await expect(dlg.locator('#c-r')).toHaveValue('Consultant');
    await expect(dlg.locator('#c-e')).toHaveValue(`mark.${id}@gmail.com`);
    await expect(dlg.locator('#c-e')).toBeFocused();
    await page.keyboard.type(`mark.${id}@hughes.example`);
    await expect(dlg.locator('#c-e')).toHaveValue(`mark.${id}@hughes.example`);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
  });

  test('asks to remove a colleague', async ({ page, persona, request }) => {
    const id = unique();
    const name = `Ruan Venter${id}`;
    const { id: reqId } = await ok(request, JAN, 'POST', '/team-requests',
      { givenName: 'Ruan', familyName: `Venter${id}`, email: `ruan.${id}@bidder-c.example.com`, company: 'Thornquist Legal', jobTitle: 'Legal adviser' });
    await ok(request, ANIKA, 'POST', `/team-requests/${reqId}/decide`, { decision: 'approve' });
    await openTeam(page, persona, 'jan');
    const person = page.locator(`[data-person="${name}"]`);
    await expect(person.locator('.badge')).toHaveText('Not signed in yet');
    await expect(person.locator('.stat small')).toHaveText(/^Invited \w{3} \d+ \w{3}$/);
    await expect(person.locator('.avatar.inv')).toHaveCount(1);

    await person.getByRole('button', { name: 'Ask to remove' }).click();
    const dlg = page.getByRole('dialog', { name: `Ask to remove ${name}` });
    await expect(dlg).toContainText('The room admin removes them from Bidder A. Until then they keep their access.');
    await expect(dlg.locator('#rm-why')).toBeFocused();
    await dlg.getByRole('button', { name: 'Send to the room admin' }).click();
    await expect(dlg.locator('.hint.err')).toHaveText('Write a reason. The room admin needs it to decide.');
    await dlg.locator('#rm-why').fill('Left the deal team today');
    await dlg.getByRole('button', { name: 'Send to the room admin' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText(`${name} keeps access until Anika Pillay removes them. Logged in Activity.`);
    await expect(person.locator('.badge')).toHaveText('Removal requested', { timeout: 20_000 });
    await expect(person.getByRole('button', { name: 'Ask to remove' })).toHaveCount(0);

    // clean up
    const removal = (await ok(request, ANIKA, 'GET', '/removal-requests?status=pending')).items.find((r: { name: string }) => r.name === name);
    await ok(request, ANIKA, 'POST', `/removal-requests/${removal.id}/decide`, { decision: 'approve' });
    await page.reload();
    await expect(page.locator(`[data-person="${name}"]`)).toHaveCount(0);
  });
});

test.describe('bidder member', () => {
  test('sees the list without status or actions', async ({ page, persona }) => {
    await openTeam(page, persona, 'pieter');
    const c6 = page.locator('[data-team="member"]');
    await expect(c6.locator('.sub')).toContainText('Only the room admin adds or removes people, at the request of your leads.');
    await expect(page.getByRole('button', { name: 'Request to add a colleague' })).toHaveCount(0);
    const team = page.getByRole('region', { name: 'People in Bidder A' });
    await expect(team.locator('.tm.h')).toHaveText(/^Person\s*Role and company$/);
    await expect(team.locator('.badge.b-ok, .badge.b-warn, .badge.b-neutral')).toHaveCount(0);
    await expect(team.getByRole('button')).toHaveCount(0);
    await expect(team.locator('[data-person="Pieter Nel"] .you')).toHaveText('You');
    await expect(team).toContainText('Your leads are marked Lead. Ask them if a colleague needs access.');
    await expect(page.getByRole('region', { name: 'Requests to add colleagues' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Adding colleagues' }))
      .toContainText('Your lead, Jan de Vries, can request to add colleagues to Bidder A. The room admin approves each request.');
    await expect(page.getByRole('region', { name: 'Access for Bidder A' })).toContainText(A_ENDS);
  });

  test('API refuses requests from members', async ({ request }) => {
    const team = await ok(request, JAN, 'GET', '/my-team');
    const pieter = team.groups[0].members.find((m: { email: string }) => m.email === 'pieter@bidder-a.example.com');
    expect((await api(request, pieter.personId, 'GET', '/team-requests')).status()).toBe(404);
    expect((await api(request, pieter.personId, 'GET', '/removal-requests')).status()).toBe(404);
    const own = await ok(request, pieter.personId, 'GET', '/my-team');
    expect(own.groups[0].isLead).toBe(false);
    expect(JSON.stringify(own)).not.toContain('removalRequested');
  });
});

test.describe('financier in a subgroup', () => {
  test('sees only their own subgroup', async ({ page, persona }) => {
    await openTeam(page, persona, 'lars');
    await expect(page.locator('.c6 .over')).toHaveText('Bidder C financiers · Skarvik Bank');
    const team = page.getByRole('region', { name: 'People in Bidder C financiers' });
    await expect(team.locator('[data-person="Lars Eriksen"]')).toHaveCount(1);
    await expect(page.locator('main.content')).not.toContainText(/Bidder A|Bidder B|Sipho Ndlovu/);
    await expect(page.getByRole('region', { name: 'Adding colleagues' }))
      .toContainText('The room admin, Anika Pillay, adds people to Bidder C financiers. Ask them if a colleague needs access.');
  });

  test('subgroups have no leads', async ({ page, persona, request }) => {
    const people = await ok(request, ANIKA, 'GET', '/people');
    const lars = people.parties.flatMap((p: { groups: { members: { name: string; membershipId: string }[] }[] }) => p.groups)
      .flatMap((g: { members: { name: string; membershipId: string }[] }) => g.members).find((m: { name: string }) => m.name === 'Lars Eriksen');
    const refused = await api(request, ANIKA, 'POST', `/memberships/${lars.membershipId}/make-lead`);
    expect(refused.status()).toBe(400);
    expect((await refused.json()).detail).toBe('Only main groups have leads. People in a subgroup are members.');
    await openTeam(page, persona, 'lars');
    await expect(page.locator('[data-team="member"] h1')).toHaveText('My team');
    await expect(page.locator('[data-person="Lars Eriksen"] .badge.b-lead')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Request to add a colleague' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ask to remove' })).toHaveCount(0);
  });
});

test.describe('laptop width', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('Ask to remove is visible at 1280px', async ({ page, persona }) => {
    await openTeam(page, persona, 'jan');
    const wrap = page.locator('.c6 .tmwrap');
    expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const button = page.locator('[data-person="Pieter Nel"]').getByRole('button', { name: 'Ask to remove' });
    const box = (await button.boundingBox())!;
    const panel = (await wrap.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
  });
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('should not scroll sideways', async ({ page, persona }) => {
    for (const who of ['jan', 'pieter'] as const) {
      await openTeam(page, persona, who);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    }
    await expect(page.getByRole('button', { name: 'Request to add a colleague' })).toHaveCount(0);
    await openTeam(page, persona, 'jan');
    await page.getByRole('button', { name: 'Request to add a colleague' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request to add a colleague' });
    const box = await dlg.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});
