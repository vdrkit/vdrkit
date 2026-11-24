// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, NODE, ROOM_ID, roomPath, test, type PersonaKey } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const AUDITED = 'ce7385c5-8612-47d2-9896-ea1d7556ae85'; // 3.2 Audited financials

function pdf(text: string): Buffer {
  const body = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function uploadDraft(page: Page, folderId: string, name: string): Promise<{ nodeId: string; indexNumber: string }> {
  const buf = pdf(name);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const start = await page.request.post(`/v1/workspaces/${ROOM_ID}/upload-sessions`, {
    data: { targetFolderId: folderId, path: name, size: buf.length, sha256, mime: 'application/pdf' },
  });
  expect(start.ok(), await start.text()).toBe(true);
  const s = await start.json();
  expect(s.method).toBe('direct');
  const put = await page.request.put(s.uploadUrl.startsWith('/v1/') ? s.uploadUrl : `/v1/${s.uploadUrl.replace(/^\//, '')}`, {
    headers: { 'content-type': 'application/octet-stream' }, data: buf,
  });
  expect(put.ok(), await put.text()).toBe(true);
  const done = await page.request.post(`/v1/workspaces/${ROOM_ID}/upload-sessions/${s.id}/complete`, { data: {} });
  expect(done.ok(), await done.text()).toBe(true);
  return done.json();
}

const folder = (page: Page, ix: string) => page.locator('.fgrp').filter({ has: page.locator('.ft2 .n', { hasText: new RegExp(`^${ix.replace('.', '\\.')}$`) }) });
const row = (page: Page, ix: string) => page.locator('.rr').filter({ has: page.locator('.ix', { hasText: new RegExp(`^${ix.replace(/\./g, '\\.')}$`) }) });

test.describe('room admin', () => {
  test.beforeEach(async ({ persona }) => { await persona('anika'); });

  test('lists drafts by folder', async ({ page }) => {
    await page.goto(roomPath('release'));
    await expect(page.getByRole('heading', { level: 1, name: 'Release review' })).toBeVisible();
    await expect(page.locator('.content .head .over')).toHaveText('Documents');
    await expect(page.locator('.content .head .sub')).toHaveText(/^[\d,]+ first releases and \d+ replacements? waiting in \d+ folders\. Bidders see nothing until you publish\.$/);
    await expect(page.locator('.crumbs')).toContainText('Release review');
    await expect(page.locator('.nav a.on')).toContainText('Documents');

    const contracts = folder(page, '2.4');
    await expect(contracts.locator('.aud')).toHaveText(/^Once published: Bidder A: View and printBidder B: ViewBidder C: View$/);
    await expect(row(page, '2.4.3').locator('.k')).toHaveText('Replaces version 1');
    await expect(row(page, '2.4.3').locator('small')).toContainText('Uploaded by you');
    await expect(row(page, '2.4.3').locator('small')).toContainText('bidders see version 1 until you publish');
    await expect(row(page, '2.4.13').locator('.k')).toHaveText('First release');
    await expect(row(page, '2.4.13').locator('small')).toContainText('Uploaded by Maria Botha');
    await expect(row(page, '2.4.13').getByRole('link', { name: 'Preview 2.4.13 in the viewer' })).toHaveAttribute('href', new RegExp(`^${roomPath('view')}/[0-9a-f-]{36}$`));

    const proc = row(page, '3.2.7');
    await expect(proc.locator('.k')).toHaveText('Being prepared');
    await expect(proc.locator('small.why')).toHaveText('Still being prepared for viewing. Ready in about a minute.');
    await expect(proc.getByRole('checkbox')).toBeDisabled();

    const insurance = folder(page, '8');
    await expect(insurance).toHaveClass(/warn/);
    await expect(insurance.locator('.aud.none')).toHaveText('No bidder access yet. Published documents here stay with the seller team.');
    await expect(insurance.locator('.fwarn')).toContainText('8 Insurance has no bidder access yet. Publishing makes these documents final for the seller team');
    await expect(insurance.locator('.fwarn').getByRole('link', { name: 'Permissions' })).toHaveAttribute('href', roomPath('permissions'));
    await expect(insurance.locator('.rr')).toHaveCount(5);
    await expect(insurance.locator('.more-row')).toContainText(/^\d+ more drafts in 8/);
    await insurance.getByRole('button', { name: /^Show all \d+$/ }).click();
    await expect(insurance.locator('.more-row')).toHaveCount(0);
    expect(await insurance.locator('.rr').count()).toBeGreaterThan(5);

    const treasury = folder(page, '3.5');
    await expect(treasury.locator('.rr')).toHaveCount(0);
    await treasury.getByRole('button', { name: 'Open Treasury' }).click();
    await expect(treasury.locator('.rr')).toHaveCount(5);
    await expect(treasury.getByRole('button', { name: 'Close Treasury' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('filters by kind and selects all', async ({ page }) => {
    await page.goto(roomPath('release'));
    await page.getByRole('button', { name: /^Replacements · \d+$/ }).click();
    await expect(page.getByRole('button', { name: /^Replacements/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.fgrp')).toHaveCount(1);
    await expect(page.locator('.rr')).toHaveCount(1);
    await expect(row(page, '2.4.3')).toBeVisible();
    await page.locator('.sa').click();
    await expect(page.locator('.sa')).toHaveText('All 1 selected');
    await expect(page.getByRole('region', { name: 'Selection' })).toContainText('1 selected');
    await expect(page.getByRole('region', { name: 'Selection' }).getByRole('button', { name: 'Publish 1 draft' })).toBeVisible();
    await page.getByRole('region', { name: 'Selection' }).getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('region', { name: 'Selection' })).toHaveCount(0);

    await page.getByRole('button', { name: 'All', exact: true }).click();
    const label = (await page.locator('.sa').textContent())!;
    const n = Number(label.replace(/\D/g, ''));
    expect(label).toMatch(/^Select all [\d,]+$/);
    await page.locator('.sa').click();
    await expect(page.locator('.sa')).toHaveText(`All ${n.toLocaleString('en-GB')} selected`);
    await expect(page.getByRole('region', { name: 'Selection' })).toContainText(`${n.toLocaleString('en-GB')} selected`);
    await expect(row(page, '3.2.7').getByRole('checkbox')).not.toBeChecked();
  });

  test('publish dialog explains who is told', async ({ page }) => {
    await page.goto(roomPath('release'));
    // other specs add drafts to 2.4 in parallel: pick the demo's two
    await row(page, '2.4.3').getByRole('checkbox').check();
    await row(page, '2.4.13').getByRole('checkbox').check();
    await expect(folder(page, '2.4').locator('.fh2 .cap')).toHaveText('2 selected');
    const bar = page.getByRole('region', { name: 'Selection' });
    await expect(bar).toContainText('2 selectedCheck who will see them before they go live.');
    await bar.getByRole('button', { name: 'Publish 2 drafts' }).click();

    const dialog = page.getByRole('dialog', { name: 'Publish 2 drafts?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.over')).toHaveText('Release review');
    const who = dialog.locator('.wl > div');
    await expect(who.filter({ hasText: 'Bidder A' }).first()).toContainText('2 at View and print');
    await expect(who.filter({ hasText: 'Bidder C financiers' })).toContainText('Gets none of these');
    await expect(dialog.getByRole('radio')).toHaveCount(0);
    await expect(dialog).toContainText('Each person hears about new documents as they chose in their notification settings.');
    await expect(dialog.getByRole('checkbox', { name: /Release quietly, no email/ })).not.toBeChecked();
    await expect(dialog.locator('.facts')).toContainText('1 replacement takes the place of version 1 for bidders, under the same number.');
    await expect(dialog.locator('.facts')).toContainText('You can withdraw a published document later.');
    await expect(dialog.getByRole('button', { name: 'Publish 2 drafts' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row(page, '2.4.13')).toBeVisible();

    await folder(page, '8').locator('.rr').first().getByRole('checkbox').check();
    await bar.getByRole('button', { name: 'Publish 3 drafts' }).click();
    await expect(page.getByRole('dialog').locator('.wbox')).toHaveText('1 of these is in a folder without bidder access. It is published for the seller team only, and no bidder sees it until access is given in Permissions.');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('publishes quietly', async ({ page, persona }) => {
    // no other test counts drafts in 2.6
    const legal = await (await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes?parent=${NODE['2']}`)).json();
    const leases = legal.items.find((n: { indexNumber: string }) => n.indexNumber === '2.6').id as string;
    const name = `Release check ${unique()}.pdf`;
    const up = await uploadDraft(page, leases, name);
    await expect(async () => {
      await page.goto(roomPath('release'));
      // leftovers from an aborted run may keep 2.6 collapsed
      const f = folder(page, '2.6');
      if (await f.getByRole('button', { name: 'Open Property leases' }).count()) await f.getByRole('button', { name: 'Open Property leases' }).click();
      if (await f.getByRole('button', { name: /^Show all/ }).count()) await f.getByRole('button', { name: /^Show all/ }).click();
      await expect(row(page, up.indexNumber).getByRole('checkbox')).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(row(page, up.indexNumber).locator('small')).toContainText('Uploaded by you');
    await row(page, up.indexNumber).getByRole('checkbox').check();
    await page.getByRole('region', { name: 'Selection' }).getByRole('button', { name: 'Publish 1 draft' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish 1 draft?' });
    await expect(dialog.locator('.wl > div').filter({ hasText: 'Bidder A' }).first()).toContainText('1 at View and print');
    await dialog.getByRole('checkbox', { name: /Release quietly, no email/ }).check();
    await dialog.getByRole('button', { name: 'Publish 1 draft' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('1 draft published');
    await expect(page.locator('.toast')).toContainText('Nobody is emailed. They show as new in the room. Logged in Activity.');
    await expect(row(page, up.indexNumber)).toHaveCount(0);

    await persona('jan');
    const seen = await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes/${up.nodeId}`);
    expect(seen.status()).toBe(200);
    expect((await seen.json()).state).toBe('published');

    // withdraw so other specs see 1,248 published documents
    await persona('anika');
    expect((await page.request.post(`/v1/workspaces/${ROOM_ID}/nodes/${up.nodeId}/withdraw`, { data: {} })).ok()).toBe(true);
  });

  test('keeps the dialog open when publish is refused', async ({ page }) => {
    await page.route(`**/v1/workspaces/${ROOM_ID}/publish`, (route) => route.fulfill({
      status: 409, contentType: 'application/problem+json',
      body: JSON.stringify({ type: 'https://vdrkit.com/problems/room-frozen', title: 'Room frozen', status: 409, reason: 'room_frozen',
        detail: 'The room is frozen. Nobody can publish until a room admin opens it again in Room settings.' }),
    }));
    await page.goto(roomPath('release'));
    await row(page, '2.4.13').getByRole('checkbox').check();
    await page.getByRole('region', { name: 'Selection' }).getByRole('button', { name: 'Publish 1 draft' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish 1 draft?' });
    await dialog.getByRole('button', { name: 'Publish 1 draft' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The room is frozen. Nobody can publish until a room admin opens it again in Room settings.');
    await expect(row(page, '2.4.13')).toBeVisible();
  });

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(roomPath('release'));
    await expect(row(page, '2.4.13').locator('.k')).toBeHidden();
    await expect(row(page, '2.4.13').getByRole('link', { name: /^Preview/ })).toBeVisible();
    await row(page, '2.4.13').getByRole('checkbox').check();
    await page.getByRole('region', { name: 'Selection' }).getByRole('button', { name: 'Publish 1 draft' }).click();
    const box = await page.getByRole('dialog').boundingBox();
    expect(box && Math.round(box.width)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test('publisher sees only his folders', async ({ page, persona }) => {
  await persona('johan');
  await page.goto(roomPath('release'));
  await expect(page.locator('.content .head .sub')).toHaveText(/^\d+ first releases waiting in 3 Finance, where you may publish\. Who sees 3 Finance is set by the room admins\.$/);
  const shown = await page.locator('.fgrp .ft2 .n').allTextContents();
  expect(shown.length).toBeGreaterThan(0);
  for (const ix of shown) expect(ix).toMatch(/^3\./);
  await expect(folder(page, '3.2').locator('.aud')).toContainText('Bidder A: Download PDF');
  await expect(page.getByRole('link', { name: 'Permissions' })).toHaveCount(0);
  await expect(page.locator('.nav')).not.toContainText('Permissions');
  await expect(page.locator('.side .room')).toContainText('Run by Quillmont Advisory');
});

test.describe('other roles', () => {
  for (const p of ['maria', 'jan', 'pieter', 'lars', 'liesl'] as PersonaKey[]) {
    test(`${p} cannot open Release review`, async ({ page, persona }) => {
      await persona(p);
      await page.goto(roomPath('release'));
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Release review' })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('Bidder B');
      const api = await page.request.get(`/v1/workspaces/${ROOM_ID}/release-review`);
      expect(api.status()).toBe(404);
    });
  }
});

test('Documents leads to Release review', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(roomPath('documents', AUDITED));
  await page.getByRole('link', { name: /^Release review · [\d,]+$/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`${roomPath('release')}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Release review' })).toBeVisible();
});
