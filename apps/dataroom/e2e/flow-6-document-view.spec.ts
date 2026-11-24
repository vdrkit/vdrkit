// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { clickAndRefresh, expect, test } from './fixtures';
import {
  as, bidderGroup, expectNotAvailable, folderByNumber, go, grant, inviteLink, join, newActor, newRoomCreator, publish, roomFor,
  signIn, unique, uploadPdf,
} from './flow-helpers';

// WebKit dev bundles are slow
test.describe.configure({ timeout: 900_000 });

// embedded font: the watermark text is glyph ids
function pdfText(buf: Buffer): string {
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  let out = '';
  for (let i = 0; i < doc.countPages(); i++) out += doc.loadPage(i).toStructuredText('preserve-whitespace').asText();
  return out;
}

test('bidder views and downloads a watermarked document', async ({ browser }) => {
  const u = unique();
  const room = `Project Swift ${u}`;
  const admin = await newActor(browser, 'Rosa Pretorius', `rosa-${u}@e2e.example`);
  const adminId = await newRoomCreator('Rosa Pretorius', admin.email);
  const leadA = await newActor(browser, 'Jana Venter', `jana-${u}@e2e.example`);
  const leadB = await newActor(browser, 'Mei Chen', `mei-${u}@e2e.example`);
  const title = 'Audited financial statements FY2025';

  const ws = await roomFor(adminId, room);
  const finance = await folderByNumber(adminId, ws, '3');
  const folder = await folderByNumber(adminId, ws, '3.2');
  const doc = await uploadPdf(adminId, ws, folder.id, `${title}.pdf`, `AFS ${u}`);
  await publish(adminId, ws, [doc.nodeId]);
  expect(doc.indexNumber).toBe('3.2.1');
  const groupA = await bidderGroup(adminId, ws, 'Bidder A', 'Orrinby Capital');
  const groupB = await bidderGroup(adminId, ws, 'Bidder B', 'Quorvane Partners');
  await grant(adminId, ws, groupA, [{ nodeId: finance.id, level: 50 }]);
  await grant(adminId, ws, groupB, [{ nodeId: finance.id, level: 20 }]);
  await join(leadA, await inviteLink(adminId, ws, groupA, leadA.email, 'lead'), { given: 'Jana', family: 'Venter', company: 'Orrinby Capital' }, room, ws, false);
  await join(leadB, await inviteLink(adminId, ws, groupB, leadB.email, 'lead'), { given: 'Mei', family: 'Chen', company: 'Quorvane Partners' }, room, ws, false);

  await test.step('watermark settings', async () => {
    await signIn(admin);
    await go(admin, `/rooms/${ws}/settings?tab=wm`);
    await admin.page.getByRole('switch', { name: 'Email address' }).click();
    await admin.page.getByRole('switch', { name: 'IP address' }).click();
    const bar = admin.page.getByRole('region', { name: 'Unsaved changes' });
    await clickAndRefresh(admin.page, bar.getByRole('button', { name: 'Save changes' }));
    await expect(admin.page.locator('.toast')).toContainText(/saved/);
    await expect(admin.page.getByRole('switch', { name: 'Email address' })).not.toBeChecked();
    await expect(admin.page.getByRole('switch', { name: 'IP address' })).toBeChecked();
  });

  await test.step('open from the folder', async () => {
    const p = leadA.page;
    await go(leadA, `/rooms/${ws}/documents/${folder.id}`);
    await p.locator('.dr', { hasText: title }).locator('.nm').click();
    await expect(p).toHaveURL(new RegExp(`/rooms/${ws}/view/${doc.nodeId}`));
    await expect(p.locator('.doct .ix')).toHaveText('3.2.1');
    await expect(p.locator('.doct h1')).toHaveText(title);
    await expect(p.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    await expect(p.locator('#info')).toContainText('WatermarkedYes');
    await expect(p.locator('.vroot')).not.toContainText('Bidder B');
    await expect(p.locator('.vroot')).not.toContainText('Opened by');
  });

  let download = '';
  await test.step('download', async () => {
    const p = leadA.page;
    await p.locator('#dl-btn').click();
    const dialog = p.getByRole('dialog', { name: 'Download' });
    await expect(dialog).toContainText('Download 3.2.1');
    await expect(dialog).toContainText('PDF with watermarkEvery page carries Jana Venter, Bidder A, today’s date and time and your IP address.');
    await expect(p.locator('#info .right')).toContainText(
      'Every page of the PDF carries your name, your group, today’s date and time and your IP address.');
    await expect(dialog).toContainText('Downloads are recorded in the activity log.');
    const [dl] = await Promise.all([p.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe(`${title}.pdf`);
    await expect(p.locator('.toast')).toContainText('PDF downloaded');
    await expect(p.locator('.toast')).toContainText('Every page carries your name, your group, today’s date and time and your IP address.');
    download = (await dl.path())!;
    const text = pdfText(readFileSync(download));
    expect(text).toContain('Jana Venter');
    expect(text).toContain('Bidder A');
    expect(text).toContain('127.0.0.1');
    expect(text).not.toContain(leadA.email);
  });

  await test.step('view only', async () => {
    const p = leadB.page;
    await go(leadB, `/rooms/${ws}/view/${doc.nodeId}`);
    await expect(p.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    await expect(p.locator('#dl-btn')).toHaveCount(0);
    await expect(p.locator('#info .right .lvl')).toHaveText('View');
    await expect(p.locator('#info .right')).toContainText('Downloading and printing are not available for this document.');
    await expect(p.locator('.vroot')).not.toContainText('Bidder A');
    const res = await p.request.get(`/v1/workspaces/${ws}/nodes/${doc.nodeId}/download?format=pdf`);
    expect(res.ok()).toBe(false);
    expect((await leadA.page.request.get(`/v1/workspaces/${ws}/nodes/${doc.nodeId}/download?format=original`)).ok()).toBe(false);
  });

  await test.step('activity log', async () => {
    const events = (await as<{ items: { action: string }[] }>(adminId, 'GET', `/v1/workspaces/${ws}/events?limit=200`)).items.map((e) => e.action);
    expect(events.filter((a) => a === 'document.downloaded')).toHaveLength(1);
    expect(events.filter((a) => a === 'document.opened').length).toBeGreaterThanOrEqual(2);
    await go(admin, `/rooms/${ws}/activity`);
    await expect(admin.page.locator('.chain')).toContainText(/Log intact · checked \d\d:\d\d/);
    const jana = admin.page.locator('.ev', { hasText: 'Jana Venter' }).filter({ hasText: title });
    await expect(jana.filter({ has: admin.page.locator('.act', { hasText: /^Viewed$/ }) }).first()).toBeVisible();
    await expect(jana.filter({ has: admin.page.locator('.act', { hasText: /^Downloaded$/ }) })).toHaveCount(1);
    const mei = admin.page.locator('.ev', { hasText: 'Mei Chen' }).filter({ hasText: title });
    await expect(mei.filter({ has: admin.page.locator('.act', { hasText: /^Viewed$/ }) }).first()).toBeVisible();
    await expect(mei.filter({ has: admin.page.locator('.act', { hasText: /^Downloaded$/ }) })).toHaveCount(0);
  });

  await test.step('page access', async () => {
    const legal = await uploadPdf(adminId, ws, (await folderByNumber(adminId, ws, '2.1')).id, 'Litigation register.pdf', `Lit ${u}`);
    await publish(adminId, ws, [legal.nodeId]);
    await go(leadB, `/rooms/${ws}/view/${legal.nodeId}`);
    await expectNotAvailable(leadB.page);
    expect((await leadB.page.request.get(`/v1/workspaces/${ws}/nodes/${legal.nodeId}/pages/1`)).ok()).toBe(false);
  });
});
