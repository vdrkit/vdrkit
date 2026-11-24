// SPDX-License-Identifier: AGPL-3.0-only
import type { APIRequestContext, Page } from '@playwright/test';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';
import { API_URL, expect, hydrated, NODE, PERSONAS, ROOM_ID, test, type PersonaKey } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const W = `${API_URL}/v1/workspaces/${ROOM_ID}`;
const idOf = (key: PersonaKey) => PERSONAS.find((p) => p.key === key)!.id;
const headers = (key: PersonaKey, seeAs?: string) => ({
  'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': idOf(key), ...(seeAs ? { 'x-vdrkit-see-as': seeAs } : {}),
});

interface Team { id: string; name: string; side: string }
async function team(request: APIRequestContext, name: string): Promise<Team> {
  const r = await request.get(`${W}/see-as`, { headers: headers('anika') });
  expect(r.status()).toBe(200);
  const t = (await r.json()).teams.find((x: Team) => x.name === name);
  expect(t, name).toBeTruthy();
  return t;
}

const asTeam = (teamId: string) => `${ROOM_ID}~${teamId}`;
const docs = (room: string, folder?: string) => `/rooms/${room}/documents${folder ? `/${folder}` : ''}`;

// skip Renumbered tags, other specs renumber
async function seen(page: Page, path: string) {
  await page.goto(path);
  await hydrated(page);
  await expect(page.locator('main, .main').first()).toBeVisible();
  return {
    folders: (await page.locator('a.fo').evaluateAll((els) => els.map((el) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll('[data-renumbered-from]').forEach((b) => b.remove());
      return c.textContent ?? '';
    }))).map((t) => t.replace(/\s+/g, ' ').trim()),
    docs: (await page.locator('.dr .nm b').allInnerTexts()).map((t) => t.trim()),
    count: (await page.locator('.side .nav a', { hasText: 'Documents' }).innerText()).replace(/\s+/g, ' ').trim(),
    menu: (await page.locator('.side .nav a').allInnerTexts()).map((t) => t.split('\n')[0]!.trim()),
  };
}

test('picker opens the room as Bidder A; one click leaves', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(`/rooms/${ROOM_ID}/dashboard`);
  await hydrated(page);
  await expect(page.getByText('Preview the room as')).toHaveCount(0);
  await page.getByTestId('see-as-picker').click();
  const menu = page.getByRole('menu', { name: 'See the room as' });
  await expect(menu).toContainText('Bidders');
  await expect(menu).toContainText('Seller team');
  await expect(menu).not.toContainText('Room admins');
  await menu.getByRole('menuitem', { name: /^Bidder A/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}~[0-9a-f-]{36}/dashboard$`));
  const bar = page.getByTestId('see-as-bar');
  await expect(bar).toContainText('You are seeing the room as Bidder A. Nothing you do here is recorded.');
  await expect(page.locator('[data-dashboard="admin"]')).toHaveCount(0);
  await expect(page.locator('.side .nav')).not.toContainText('Permissions');
  await expect(page.locator('#clear-new')).toHaveCount(0);
  await page.locator('.side .nav a', { hasText: 'Documents' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}~[0-9a-f-]{36}/documents$`));
  await expect(bar).toBeVisible();
  await bar.getByRole('link', { name: 'Stop seeing as Bidder A' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/documents$`));
  await expect(page.getByTestId('see-as-bar')).toHaveCount(0);
  await expect(page.locator('.side .nav')).toContainText('Permissions');
});

test('shows exactly the documents Bidder A sees', async ({ page, persona, request }) => {
  const a = await team(request, 'Bidder A');
  await persona('jan');
  const janTop = await seen(page, docs(ROOM_ID));
  const jan24 = await seen(page, docs(ROOM_ID, NODE['2.4']));
  await persona('anika');
  const own24 = await seen(page, docs(ROOM_ID, NODE['2.4']));
  const asTop = await seen(page, docs(asTeam(a.id)));
  const as24 = await seen(page, docs(asTeam(a.id), NODE['2.4']));
  expect(asTop).toEqual(janTop);
  expect(as24).toEqual(jan24);
  expect(own24.docs.length).toBeGreaterThan(as24.docs.length);
  expect(jan24.docs.length).toBeGreaterThan(0);
});

test('subgroup sees no more than its parent', async ({ page, persona, request }) => {
  test.slow();
  const fin = await team(request, 'Bidder C financiers');
  const c = await team(request, 'Bidder C');
  const tops = (await (await request.get(`${W}/nodes`, { headers: headers('lars') })).json()).items as { id: string; kind: string }[];
  const folder = tops.find((n) => n.kind === 'folder');
  // another spec may renumber in between
  await expect(async () => {
    await persona('lars');
    const larsTop = await seen(page, docs(ROOM_ID));
    const larsIn = folder ? await seen(page, docs(ROOM_ID, folder.id)) : null;
    await persona('anika');
    expect(await seen(page, docs(asTeam(fin.id)))).toEqual(larsTop);
    if (folder && larsIn) expect(await seen(page, docs(asTeam(fin.id), folder.id))).toEqual(larsIn);
  }).toPass({ timeout: 60_000 });
  const lv = async (g: string) => new Map(((await (await request.get(`${W}/nodes${folder ? `?parent=${folder.id}` : ''}`, { headers: headers('anika', g) })).json()).items as
    { id: string; access: { level: number } }[]).map((n) => [n.id, n.access.level]));
  const [subLv, parentLv] = [await lv(fin.id), await lv(c.id)];
  for (const [id, level] of subLv) expect(level, id).toBeLessThanOrEqual(parentLv.get(id) ?? 0);
});

test('seller team view has no upload or release', async ({ page, persona, request }) => {
  const finance = await team(request, 'Drosvelt Holdings finance');
  expect(finance.side).toBe('seller');
  const kids = (await (await request.get(`${W}/nodes?parent=${NODE['3']}`, { headers: headers('maria') })).json()).items as { id: string; indexNumber: string }[];
  const aud = kids.find((k) => k.indexNumber === '3.2')!.id;
  await persona('maria');
  const maria = await seen(page, docs(ROOM_ID, aud));
  await expect(page.getByRole('button', { name: /Upload files|Choose files/ }).first()).toBeVisible();
  await persona('anika');
  const as = await seen(page, docs(asTeam(finance.id), aud));
  expect(as).toEqual(maria);
  await expect(page.getByTestId('see-as-bar')).toContainText('You are seeing the room as Drosvelt Holdings finance.');
  await expect(page.getByRole('button', { name: /Upload files|Choose files|Upload a new version/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Release review/ })).toHaveCount(0);
  await expect(page.locator('.dr .icon-btn')).toHaveCount(0);
});

test('only room admins can enter the mode', async ({ page, persona, request }) => {
  const a = await team(request, 'Bidder A');
  for (const key of ['jan', 'maria', 'liesl'] as const) {
    const api = await request.get(`${W}/shell`, { headers: headers(key, a.id) });
    expect(api.status(), key).toBe(404);
    await persona(key);
    await page.goto(`/rooms/${asTeam(a.id)}/dashboard`);
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    await expect(page.getByTestId('see-as-bar')).toHaveCount(0);
  }
  expect((await request.put(`${W}/grants`, { headers: headers('jan', a.id), data: { changes: [] } })).status()).toBe(404);
  expect((await request.get(`${W}/see-as`, { headers: headers('jan') })).status()).toBe(403);
});

test('seller observers see their Activity', async ({ page, persona, request }) => {
  const observers = (await (await request.get(`${W}/see-as`, { headers: headers('anika') })).json()).teams
    .find((t: { roleTemplate: string }) => t.roleTemplate === 'observer') as Team;
  expect(observers).toBeTruthy();
  await persona('liesl');
  await page.goto(`/rooms/${ROOM_ID}/activity`);
  const liesl = await page.locator('h1').first().innerText();
  await persona('anika');
  await page.goto(`/rooms/${asTeam(observers.id)}/dashboard`);
  await hydrated(page);
  await page.locator('.side .nav a', { hasText: 'Activity' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}~${observers.id}/activity`));
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toHaveCount(0);
  await expect(page.locator('h1').first()).toHaveText(liesl);
  await expect(page.getByTestId('see-as-bar')).toBeVisible();
});

test('keeps the banner on pages the team cannot open', async ({ page, persona, request }) => {
  const a = await team(request, 'Bidder A');
  await persona('anika');
  await page.goto(`/rooms/${asTeam(a.id)}/permissions`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  const bar = page.getByTestId('see-as-bar');
  await expect(bar).toContainText('You are seeing the room as Bidder A.');
  await expect(page.getByText('Room admins see every attempt in Activity.')).toHaveCount(0);
  await bar.getByRole('link', { name: 'Stop seeing as Bidder A' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/permissions$`));
  await expect(page.getByTestId('see-as-bar')).toHaveCount(0);
});

test('records no reading and offers no download', async ({ page, persona, request }) => {
  const a = await team(request, 'Bidder A');
  const coverage = async () => (await (await request.get(`${W}/nodes/${NODE['2.4.2']}/coverage`, { headers: headers('anika') })).json()).people
    .map((p: { personId: string; pagesSeen: number; lastSeenAt: string }) => `${p.personId}:${p.pagesSeen}:${p.lastSeenAt}`).sort();
  const opened = async () => (await (await request.get(`${W}/events?action=document.opened&limit=1`, { headers: headers('anika') })).json()).matching;
  const [covBefore, openedBefore] = [await coverage(), await opened()];

  await persona('anika');
  await page.goto(`/rooms/${asTeam(a.id)}/view/${NODE['2.4.2']}`);
  await expect(page.getByTestId('see-as-bar')).toContainText('You are seeing the room as Bidder A.');
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#dl-btn')).toHaveCount(0);

  expect(await coverage()).toEqual(covBefore);
  expect(await opened()).toBe(openedBefore);
  const log = await (await request.get(`${W}/events?action=room.seen_as&limit=5`, { headers: headers('anika') })).json();
  expect(log.items.some((e: { item: string | null }) => e.item === 'Saw the room as Bidder A')).toBe(true);
  const put = await request.put(`${W}/grants`, { headers: headers('anika', a.id), data: { changes: [] } });
  expect(put.status()).toBe(403);
});

test('link from Permissions opens Documents as the group', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(`/rooms/${ROOM_ID}/permissions`);
  await hydrated(page);
  const select = page.locator('#viewas');
  const value = await select.locator('option', { hasText: /^Bidder A$/ }).getAttribute('value');
  await select.selectOption(value!);
  const link = page.getByTestId('see-as-link');
  await expect(link).toHaveText('See the room as Bidder A');
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}~${value}/documents$`));
  await expect(page.getByTestId('see-as-bar')).toContainText('You are seeing the room as Bidder A.');
});

test('as Bidder A: My team and the ways out', async ({ page, persona, request }) => {
  const a = await team(request, 'Bidder A');
  await persona('anika');
  await page.goto(`/rooms/${asTeam(a.id)}/dashboard`);
  await hydrated(page);
  const side = page.locator('.side .nav a');
  await expect.poll(async () => (await side.allInnerTexts()).map((t) => t.split('\n')[0]!.trim()))
    .toEqual(['Dashboard', 'Documents', 'Search', 'Timeline', 'My team']);
  await expect(side.filter({ hasText: 'My team' }).locator('em')).toHaveText(/^\d+$/);
  await expect(page.getByRole('link', { name: 'Request to add a colleague' })).toHaveCount(0);

  await side.filter({ hasText: 'My team' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}~${a.id}/team$`));
  await expect(page.locator('[data-team="member"] h1')).toHaveText('My team');
  await expect(page.getByTestId('see-as-bar')).toBeVisible();
  await expect(page.getByRole('button', { name: /Request to add a colleague/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask to remove' })).toHaveCount(0);
  const own = Number(await side.filter({ hasText: 'My team' }).locator('em').innerText());
  await expect(page.locator('.tm[data-person]')).toHaveCount(own);
  await expect(page.locator('.tm[data-person="Anika Pillay"]')).toHaveCount(0);

  const item = page.getByRole('menuitem', { name: /Profile and notifications/ });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole('button', { name: 'Account menu: profile, notification settings, about, sign out' }).click();
    await expect(item).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/profile$`));
  await expect(page.getByTestId('see-as-bar')).toHaveCount(0);
  await page.goto(`/rooms/${asTeam(a.id)}/profile?tab=notifications`);
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/profile\\?tab=notifications$`));
  await expect(page.getByTestId('see-as-bar')).toHaveCount(0);

  await page.goto(`/rooms/${asTeam(a.id)}/dashboard`);
  const sw = page.locator('.side .room .sw');
  await expect(sw).toHaveText('Switch');
  await expect(async () => {
    await sw.click();
    await expect(page).toHaveURL(/\/rooms$/, { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('see-as-bar')).toHaveCount(0);
});

test('previews a room still being prepared as if open', async ({ page, persona, request }) => {
  const name = `See as preparing ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const made = await request.post(`${API_URL}/v1/workspaces`, { headers: headers('anika'), data: { name, timeZone: 'Africa/Johannesburg', start: 'standard' } });
  expect(made.status()).toBe(201);
  const ws: string = (await made.json()).id;
  const shell = await (await request.get(`${API_URL}/v1/workspaces/${ws}/shell`, { headers: headers('anika') })).json();
  expect(shell.room.state).toBe('preparing');
  const corporate = shell.index.find((f: { indexNumber: string | null }) => f.indexNumber === '1');
  const group = await request.post(`${API_URL}/v1/workspaces/${ws}/groups`, { headers: headers('anika'),
    data: { name: 'Bidder P', newParty: { name: 'Bidder P', kind: 'bidder' }, access: [{ nodeId: corporate.id, level: 20 }] } });
  expect(group.status(), await group.text()).toBe(201);
  const groupId: string = (await group.json()).id;
  const published = await request.post(`${API_URL}/v1/workspaces/${ws}/publish`, { headers: headers('anika'), data: { nodeIds: [corporate.id] } });
  expect(published.status(), await published.text()).toBe(200);

  await persona('anika');
  await page.goto(`/rooms/${ws}~${groupId}/documents`);
  await hydrated(page);
  const bar = page.getByTestId('see-as-bar');
  await expect(bar).toContainText('You are seeing the room as Bidder P. Nothing you do here is recorded. The room is not open yet.');
  await expect(page.getByRole('heading', { name: 'Room not open yet' })).toHaveCount(0);
  await expect(page.locator('a.fo')).toHaveCount(1);
  await expect(page.locator('a.fo').first()).toContainText('Corporate');
  const a = await team(request, 'Bidder A');
  await page.goto(`/rooms/${asTeam(a.id)}/dashboard`);
  await expect(page.getByTestId('see-as-bar')).toBeVisible();
  await expect(page.getByTestId('see-as-bar')).not.toContainText('not open yet');
});
