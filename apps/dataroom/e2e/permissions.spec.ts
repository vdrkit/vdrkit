// SPDX-License-Identifier: AGPL-3.0-only
import { API_URL, expect, PERSONAS, roomPath, ROOM_ID, test, type PersonaKey } from './fixtures';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

// the save tests use folder 10 and put it back

const page_ = roomPath('permissions');
const cellOf = (group: string, folder: string) => `button.cell[aria-label^="${group}, ${folder} "]`;

async function adminApi(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}/v1/workspaces/${ROOM_ID}${path}`, {
    ...init,
    headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': PERSONAS.find((p) => p.key === 'anika')!.id, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return res;
}

test.describe('who opens Permissions', () => {
  for (const key of ['maria', 'johan', 'jan', 'pieter', 'lars', 'liesl'] as PersonaKey[]) {
    test(`${key} gets not available`, async ({ page, persona }) => {
      await persona(key);
      const res = await page.goto(page_);
      expect(res?.status()).toBe(404);
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Bidder B');
      await expect(page.locator('table.mx')).toHaveCount(0);
    });
  }

  test('no menu entry for bidders', async ({ page, persona }) => {
    await persona('jan');
    await page.goto(roomPath('dashboard'));
    await expect(page.locator('nav.nav')).toBeVisible();
    await expect(page.locator('nav.nav')).not.toContainText('Permissions');
  });
});

test.describe('room admin', () => {
  test.beforeEach(async ({ persona }) => { await persona('anika'); });

  test('shows the matrix', async ({ page }) => {
    await page.goto(page_);
    await expect(page.getByRole('heading', { name: 'Permissions', level: 1 })).toBeVisible();
    await expect(page.locator('.crumbs')).toHaveText(/Project Heron\s*\/\s*Administration\s*\/\s*Permissions/);
    await expect(page.locator('.sub').first()).toHaveText('What each group may see and do, folder by folder. Nothing changes for anyone until you save.');
    await expect(page.getByRole('tab', { name: /Bidders/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /Bidders/ })).toContainText('3 groups and 1 subgroup');
    await expect(page.locator('thead')).toContainText('Subgroup of Bidder C');
    await expect(page.locator(cellOf('Bidder A', '1'))).toContainText('Print');
    await expect(page.locator(cellOf('Bidder C financiers', '1'))).toContainText('None');
    await expect(page.locator('.note.warn')).toContainText('no bidder access yet');
    await expect(page.locator('tr', { hasText: 'Insurance' }).locator('.k-lock')).toHaveText('No bidder access');
    await expect(page.locator('tr', { hasText: 'Management accounts' })).toHaveCount(0);
    await expect(page.locator(cellOf('Bidder C financiers', '3')).locator('.more')).toHaveText('+1');
    await page.getByRole('button', { name: 'Open Finance' }).click();
    await expect(page.locator(cellOf('Bidder C financiers', '3.2'))).toContainText('View');
    await expect(page.locator(cellOf('Bidder A', '3.1'))).toHaveAttribute('aria-label', /same as the folder above/);
  });

  test('cell panel explains the subgroup cap', async ({ page }) => {
    await page.goto(page_);
    await page.getByRole('button', { name: 'Open Finance' }).click();
    await page.locator(cellOf('Bidder C financiers', '3.2')).click();
    const pop = page.getByRole('dialog', { name: 'Bidder C financiers, 3.2 Audited financials' });
    await expect(pop).toBeVisible();
    await expect(pop.locator('.capbox')).toContainText('Why some levels are capped');
    await expect(pop.locator('.capbox')).toContainText('It applies as View until Bidder C is raised');
    await expect(pop.getByRole('radio', { name: /Original/ })).toBeDisabled();
    const stored = pop.getByRole('radio', { name: /Download PDF/ });
    await expect(stored).toBeEnabled();
    await expect(stored).toBeChecked();
    await expect(stored).toBeFocused();
    await expect(pop).toContainText('Set here. Applies as View until Bidder C is raised');
    await expect(pop.getByRole('radio', { name: /Same as 3 Finance/ })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
  });

  test('Discard drops pending changes', async ({ page }) => {
    await page.goto(page_);
    await page.locator(cellOf('Bidder B', '9')).click();
    await page.getByRole('dialog').getByRole('radio', { name: /^View/ }).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await expect(bar).toContainText('1 unsaved change');
    await expect(bar).toContainText('Nothing changes for anyone until you save.');
    const barBox = await bar.boundingBox(), panelBox = await page.locator('section.panel').boundingBox();
    expect(Math.abs((barBox?.x ?? 0) - (panelBox?.x ?? 0))).toBeLessThanOrEqual(1);
    await expect(page.getByRole('tab', { name: /Bidders/ }).locator('em')).toHaveText('1');
    await expect(page.locator(cellOf('Bidder B', '9'))).toHaveAttribute('aria-label', /unsaved change/);
    await bar.getByRole('button', { name: 'Discard' }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.locator(cellOf('Bidder B', '9'))).toContainText('None');
  });

  test('a second cell opens with its own level', async ({ page }) => {
    await page.goto(page_);
    await page.locator(cellOf('Bidder B', '9')).click();
    await page.getByRole('dialog').getByRole('radio', { name: /^View/ }).check();
    await page.locator(cellOf('Bidder A', '1')).click();
    const pop = page.getByRole('dialog', { name: /^Bidder A, 1 / });
    await expect(pop.getByRole('radio', { name: /^Print/ })).toBeChecked();
    await pop.getByRole('radio', { name: /^Download PDF/ }).check();
    await pop.getByRole('button', { name: 'Apply' }).click();
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await expect(bar).toContainText('1 unsaved change');
    await expect(page.locator(cellOf('Bidder A', '1'))).toContainText('Download PDF');
    await expect(page.locator(cellOf('Bidder B', '9'))).toContainText('None');
    await bar.getByRole('button', { name: 'Discard' }).click();
  });

  test('Check what a group sees', async ({ page }) => {
    await page.goto(page_);
    await page.getByLabel('Check what a group sees').selectOption({ label: 'Bidder C financiers' });
    const note = page.getByTestId('view-as-note');
    await expect(note).toContainText('Bidder C financiers sees 1 of 11 folders');
    await expect(note).toContainText('Only room admins can open Permissions.');
    await note.getByRole('button', { name: 'Stop checking' }).click();
    await expect(note).toHaveCount(0);
  });

  test('Seller team tab', async ({ page }) => {
    await page.goto(page_);
    await page.getByRole('tab', { name: /Seller team/ }).click();
    await expect(page.locator('.notes')).toContainText('Room admins of Quillmont Advisory see and manage every folder.');
    await expect(page.locator('.notes')).toContainText('Johan Steyn in 3 Finance');
    await expect(page.locator(cellOf('Drosvelt Holdings finance', '3')).locator('.pill')).toHaveText('U');
    await page.locator(cellOf('Drosvelt Holdings finance', '3')).click();
    const pop = page.getByRole('dialog');
    await expect(pop.getByRole('switch', { name: /May add files/ })).toBeChecked();
    await expect(pop.getByRole('switch', { name: /May publish drafts/ })).not.toBeChecked();
    await pop.getByRole('button', { name: 'Cancel' }).click();
  });

  test('saves and shows the room as it was', async ({ page }) => {
    test.slow();
    await page.goto(page_);
    await page.locator(cellOf('Bidder C', '10')).click();
    await page.getByRole('dialog').getByRole('radio', { name: /^View/ }).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Review and save' }).click();
    const review = page.getByRole('dialog', { name: /1 change takes effect together when you save/ });
    await expect(review).toContainText('Bidder C');
    await expect(review).toContainText('Nothing becomes visible yet: all');
    await expect(review).toContainText('Logged in Activity as one entry, with you as the author.');
    await review.getByRole('button', { name: 'Save 1 change' }).click();
    await expect(page.getByRole('status')).toContainText('1 change saved');
    await expect(page.locator(cellOf('Bidder C', '10'))).toContainText('View');
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);

    const body = await (await adminApi('/permissions')).json();
    const folder10 = body.nodes.find((n: { indexNumber: string }) => n.indexNumber === '10');
    const bidderC = body.groups.find((g: { name: string }) => g.name === 'Bidder C');
    expect(body.effective.find((e: { groupId: string; nodeId: string }) => e.groupId === bidderC.id && e.nodeId === folder10.id).level).toBe(20);

    const at = page.getByLabel('Show the room as at');
    await expect(at.locator('option')).not.toHaveCount(1);
    // a date that does not load leaves the table, and the choice, on today
    const pastAt = (u: URL) => u.pathname.startsWith('/v1/') && u.searchParams.has('at');
    await page.route(pastAt, (r) => r.fulfill({ status: 503, contentType: 'application/problem+json', body: '{"title":"Service unavailable","status":503}' }));
    await at.selectOption({ index: 1 });
    await expect(at).toHaveValue('now');
    await expect(at).toBeEnabled();
    await expect(page.locator('.note.past')).toHaveCount(0);
    await page.unroute(pastAt);
    await at.selectOption({ index: 1 });
    await expect(page.locator('.note.past')).toContainText('The room as it stood on');
    await expect(page.locator(cellOf('Bidder C', '10'))).toBeDisabled();
    await expect(page.locator(cellOf('Bidder C', '10'))).toContainText('None');
    await page.getByRole('button', { name: 'Back to today' }).click();
    await expect(page.locator('.note.past')).toHaveCount(0);

    // put it back; this time the reload after saving fails
    await page.locator(cellOf('Bidder C', '10')).click();
    await page.getByRole('dialog').getByRole('radio', { name: /^No access/ }).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Review and save' }).click();
    await expect(page.getByRole('dialog', { name: /1 change takes effect/ })).toContainText('Bidder C loses access to 0 documents at once');
    let reloads = 0;
    await page.route((u) => u.pathname.startsWith('/v1/') && u.pathname.endsWith('/permissions') && !u.searchParams.has('at'), (r) => { reloads++; return r.fulfill({ status: 503, contentType: 'application/problem+json', body: '{"title":"Service unavailable","status":503}' }); });
    await page.getByRole('button', { name: 'Save 1 change' }).click();
    await expect.poll(() => reloads).toBe(1);
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);
    await expect(page.locator(cellOf('Bidder C', '10'))).toContainText('None');
  });

  test('asks before leaving with unsaved changes', async ({ page }) => {
    await page.goto(page_);
    await page.locator(cellOf('Bidder B', '9')).click();
    await page.getByRole('dialog').getByRole('radio', { name: /^View/ }).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toContainText('1 unsaved change');
    const asked = new Promise<string>((done) => page.once('dialog', (d) => { done(d.type()); void d.accept(); }));
    await page.close({ runBeforeUnload: true });
    expect(await asked).toBe('beforeunload');
  });

  test('the review stays open while it saves', async ({ page }) => {
    await page.goto(page_);
    await page.locator(cellOf('Bidder B', '9')).click();
    await page.getByRole('dialog').getByRole('radio', { name: /^View/ }).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Review and save' }).click();
    // answered here, so folder 9 keeps its rights
    await page.route('**/v1/workspaces/*/grants', async (r) => {
      await new Promise((done) => setTimeout(done, 1_000));
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const review = page.getByRole('dialog', { name: /1 change takes effect/ });
    await review.getByRole('button', { name: 'Save 1 change' }).click();
    await page.keyboard.press('Escape');
    await expect(review).toBeVisible();
    await expect(review.getByRole('button', { name: 'Close' })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('1 change saved');
  });

  test('shows a personal grant in the group column', async ({ page }) => {
    const { folder10, pieter } = await ids();
    await adminApi('/grants', { method: 'PUT', body: JSON.stringify({ changes: [{ nodeId: folder10, personId: pieter, effect: 'deny' }] }) });
    try {
      await page.goto(page_);
      await expect(page.getByTestId('people-note')).toContainText('Pieter');
      await expect(page.getByTestId('people-note')).toContainText('blocked in 10 Intellectual property');
      const mark = page.locator(cellOf('Bidder A', '10')).getByTestId('person-mark');
      await expect(mark).toHaveText('+1 person');
      await page.locator(cellOf('Bidder A', '10')).click();
      await expect(page.getByRole('dialog').getByTestId('person-box')).toContainText('blocked in 10 Intellectual property');
      await expect(page.locator(cellOf('Bidder B', '10')).getByTestId('person-mark')).toHaveCount(0);
    } finally {
      await adminApi('/grants', { method: 'PUT', body: JSON.stringify({ changes: [{ nodeId: folder10, personId: pieter, effect: 'deny', reset: true }] }) });
    }
  });

  test('shows when a scheduled change takes effect', async ({ page }) => {
    await page.goto(page_);
    await page.locator(cellOf('Bidder B', '10')).click();
    const pop = page.getByRole('dialog');
    await pop.getByRole('radio', { name: /^View/ }).check();
    const tomorrow = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10);
    await pop.getByLabel('From').fill(tomorrow);
    await pop.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Review and save' }).click();
    await page.getByRole('button', { name: 'Save 1 change' }).click();
    await expect(page.getByRole('status')).toContainText('In effect from');
    await expect(page.getByRole('status')).not.toContainText('In effect now');
  });

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(page_);
    await expect(page.getByRole('heading', { name: 'Permissions', level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const a = await page.getByLabel('Show the room as at').boundingBox(), b = await page.getByLabel('Check what a group sees').boundingBox();
    expect((b?.y ?? 0)).toBeGreaterThan((a?.y ?? 0) + (a?.height ?? 0));
    await page.locator(cellOf('Bidder A', '1')).click();
    const box = await page.getByRole('dialog').boundingBox();
    expect(box?.x).toBe(0);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
  });
});

async function ids() {
  const body = await (await adminApi('/permissions')).json();
  const folder10: string | undefined = body.nodes.find((n: { indexNumber: string }) => n.indexNumber === '10')?.id;
  const group = (name: string): string | undefined => body.groups.find((g: { name: string }) => g.name === name)?.id;
  return { body, folder10: folder10!, bidderB: group('Bidder B'), bidderC: group('Bidder C'), pieter: PERSONAS.find((p) => p.key === 'pieter')!.id };
}

test.afterAll(async () => {
  // restore folder 10 even after a failure
  const { body, folder10, bidderB, bidderC } = await ids();
  if (!folder10) return;
  const reset = [bidderB, bidderC].filter((gid) => gid && body.grants.some((g: { nodeId: string; groupId: string }) => g.nodeId === folder10 && g.groupId === gid))
    .map((groupId) => ({ nodeId: folder10, groupId, reset: true }));
  if (reset.length) await adminApi('/grants', { method: 'PUT', body: JSON.stringify({ changes: reset }) });
});
