// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { pdf, writeTree } from './import-files';
import { clickAndRefresh, expect, pageHydrated, test } from './fixtures';
import {
  acceptInvitation, acceptNda, bidderGroup, expectNotAvailable, folderByNumber, go, grant, inviteLink, linkIn, mailTo,
  newActor, newRoomCreator, nodes, signIn, statusAs, unique,
} from './flow-helpers';

// WebKit is much slower on dev bundles
test.describe.configure({ timeout: 900_000 });

const DIR = mkdtempSync(join(tmpdir(), 'vdrkit-flow2-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const bar = (page: Page) => page.getByRole('region', { name: 'Unsaved changes' });
async function saveSettings(page: Page) {
  await clickAndRefresh(page, bar(page).getByRole('button', { name: 'Save changes' }));
  await expect(page.locator('.toast')).toContainText(/saved/);
  await expect(bar(page)).toHaveCount(0);
}
const cellOf = (page: Page, group: string, folder: string) => page.locator(`button.cell[aria-label^="${group}, ${folder} "]`);

test('admin sets up a room, contributors add drafts, bidders see only published files', async ({ browser }) => {
  const u = unique();
  const room = `Project Ibis ${u}`;
  const admin = await newActor(browser, 'Rosa Pretorius', `rosa-${u}@e2e.example`);
  const adminId = await newRoomCreator('Rosa Pretorius', admin.email);
  const finance = await newActor(browser, 'Femke Botha', `femke-${u}@e2e.example`);
  const legal = await newActor(browser, 'Lwazi Dube', `lwazi-${u}@e2e.example`);
  const bidder = await newActor(browser, 'Bea Smit', `bea-${u}@e2e.example`);
  let ws = '';
  const page = admin.page;

  await test.step('room creator signs in', async () => {
    await signIn(admin);
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.locator('.side .nav')).toContainText('Create a room');
    await expect(page.getByText('Your access has ended')).toHaveCount(0);
  });

  await test.step('create an empty room', async () => {
    await page.locator('.side .nav').getByRole('link', { name: /Create a room/ }).click();
    await expect(page.getByRole('heading', { name: 'Create a room', level: 1 })).toBeVisible();
    await pageHydrated(page);
    await expect(page.locator('#f-tz')).not.toHaveValue('');
    await page.locator('#f-name').fill(room);
    await page.getByRole('radio', { name: /Empty room/ }).click();
    await expect(page.locator('.cbar')).toContainText('is created with no folders.');
    await page.getByRole('button', { name: 'Create room' }).click();
    await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}\/dashboard$/, { timeout: 30_000 });
    ws = /\/rooms\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
    await pageHydrated(page);
    await expect(page.locator('[data-dashboard="new-room"] h1')).toHaveText(`Get ${room} ready`);
    await expect(page.locator('.side .room')).toContainText('Preparing · no bidders yet');
  });

  await test.step('room settings', async () => {
    await go(page, `/rooms/${ws}/settings`);
    await page.getByTestId('logo-file').setInputFiles({ name: 'ibis.png', mimeType: 'image/png', buffer: PNG });
    await expect(bar(page)).toContainText('Room logo');
    await saveSettings(page);

    await go(page, `/rooms/${ws}/settings?tab=nda`);
    await page.getByRole('button', { name: 'Publish the first version' }).click();
    const dlg = page.getByRole('dialog', { name: 'Publish NDA version 1' });
    await dlg.getByLabel('Name').fill(`Ibis NDA ${u}`);
    await dlg.getByLabel('Text of the agreement').fill(`Confidentiality undertaking for ${room}. The recipient keeps every document confidential.`);
    await dlg.getByRole('button', { name: 'Publish version 1' }).click();
    await expect(page.locator('.toast')).toContainText('NDA version 1 published');
    const ask = page.getByRole('switch', { name: /Ask for the NDA/ });
    await expect(ask).toBeChecked();
    await expect(bar(page)).toHaveCount(0);

    await go(page, `/rooms/${ws}/settings?tab=wm`);
    await page.getByRole('switch', { name: 'IP address' }).click();
    await saveSettings(page);
    await expect(page.getByRole('switch', { name: 'IP address' })).toBeChecked();

    await go(page, `/rooms/${ws}/settings?tab=notif`);
    const row = page.locator('.nrow', { hasText: 'New documents' }).first();
    await row.getByRole('combobox').selectOption('digest');
    await saveSettings(page);
    await page.reload();
    await expect(page.locator('.nrow', { hasText: 'New documents' }).first().getByRole('combobox')).toHaveValue('digest');
  });

  await test.step('bulk import a folder tree', async () => {
    const root = writeTree(DIR, `Ibis_DD_${u}`, {
      '01 Corporate/01 Articles/Articles of association.pdf': pdf(`Articles ${u}`),
      '01 Corporate/02 Share register/Share register.pdf': pdf(`Share register ${u}`),
      '02 Finance/01 Audited accounts/Audited financial statements FY2025.pdf': pdf(`AFS ${u}`),
      '02 Finance/02 Management accounts/Management accounts Q3.pdf': pdf(`MA ${u}`),
      '03 Legal/01 Material contracts/Supply agreement.pdf': pdf(`Supply ${u}`),
    });
    await go(page, `/rooms/${ws}/import`);
    await page.getByTestId('d1-folder').setInputFiles(root);
    await expect(page.getByRole('heading', { name: 'Check the index before you upload' })).toBeVisible();
    const row = (f: string) => page.locator(`.trow2[data-folder="${f}"]`);
    await expect(row('01 Corporate').locator('input')).toHaveValue('1');
    await expect(row('01 Corporate/01 Articles')).toContainText('1.');
    await expect(page.getByLabel('Index number for Articles')).toHaveValue('1');
    await expect(row('01 Corporate/01 Articles')).toContainText('from 01 Articles');
    await expect(page.getByLabel('Index number for Share register')).toHaveValue('2');
    await expect(row('02 Finance').locator('input')).toHaveValue('2');
    await expect(row('03 Legal').locator('input')).toHaveValue('3');
    await page.getByRole('button', { name: 'Upload 5 files as drafts' }).click();
    await expect(page.getByRole('heading', { name: '5 files uploaded as drafts' })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.head .sub')).toContainText('5 ready, 0 still processing', { timeout: 60_000 });
    const top = await nodes(adminId, ws);
    expect(top.map((n) => `${n.indexNumber} ${n.name}`)).toEqual(['1 Corporate', '2 Finance', '3 Legal']);
  });

  await test.step('renumber in edit mode', async () => {
    await go(page, `/rooms/${ws}/documents`);
    await page.getByRole('link', { name: /^1 Corporate/ }).click();
    await expect(page.locator('.content h1')).toHaveText('1Corporate');
    await page.locator('.content').getByRole('link', { name: /^1\.1 Articles/ }).click();
    await expect(page.locator('.content h1')).toHaveText('1.1Articles');
    await pageHydrated(page);
    await page.getByRole('button', { name: 'Edit index' }).click();
    await page.locator('.stree .sf').filter({ has: page.locator('.ix', { hasText: /^3$/ }) }).click();
    await page.getByLabel('Index number for Legal').fill('2');
    await page.getByRole('button', { name: 'Save 3' }).click();
    await expect(page.locator('.stree .sf').filter({ has: page.locator('.ix', { hasText: /^2$/ }) })).toContainText('Legal');
    await expect(page.locator('.stree .sf').filter({ has: page.locator('.ix', { hasText: /^3$/ }) })).toContainText('Finance');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Done' }).click();
    const top = await nodes(adminId, ws);
    expect(top.map((n) => `${n.indexNumber} ${n.name}`)).toEqual(['1 Corporate', '2 Legal', '3 Finance']);
  });

  await test.step('create seller groups', async () => {
    await go(page, `/rooms/${ws}/people`);
    for (const name of ['Finance team', 'Legal team']) {
      await page.getByRole('button', { name: 'New group' }).click();
      const dlg = page.getByRole('dialog');
      await dlg.locator('#ng-name').fill(name);
      await dlg.getByText('Seller team', { exact: true }).click();
      await dlg.locator('#ng-org').fill('Wendlow Holdings');
      await dlg.getByRole('button', { name: 'Next: access' }).click();
      await dlg.getByRole('button', { name: 'Next: people' }).click();
      await dlg.getByRole('button', { name: 'Create group' }).click();
      await expect(dlg.getByRole('heading', { name: 'Group created' })).toBeVisible();
      await dlg.getByRole('button', { name: 'Close' }).last().click();
      await expect(dlg).toHaveCount(0);
    }
    await page.getByRole('tablist', { name: 'Whose groups' }).getByRole('tab', { name: /Seller team/ }).click();
    await expect(page.locator('.grp[data-group="Finance team"]')).toBeVisible();
    await expect(page.locator('.grp[data-group="Legal team"]')).toBeVisible();
  });

  await test.step('set folder permissions', async () => {
    await go(page, `/rooms/${ws}/permissions`);
    await page.getByRole('tab', { name: /Seller team/ }).click();
    const set = async (group: string, folder: string, upload: boolean) => {
      await cellOf(page, group, folder).click();
      const pop = page.getByRole('dialog');
      await pop.getByRole('radio', { name: /^View/ }).check();
      if (upload) await pop.getByRole('switch', { name: /May add files/ }).click();
      await pop.getByRole('button', { name: 'Apply' }).click();
      await expect(pop).toHaveCount(0);
    };
    await set('Finance team', '3', true);
    await set('Finance team', '1', false);
    await set('Legal team', '1', true);
    await set('Legal team', '2', true);
    await page.getByRole('button', { name: 'Review and save' }).click();
    const review = page.getByRole('dialog', { name: /4 changes take effect together when you save/ });
    await review.getByRole('button', { name: 'Save 4 changes' }).click();
    await expect(page.getByRole('status')).toContainText('4 changes saved');
    await expect(cellOf(page, 'Finance team', '3').locator('.pill')).toHaveText('U');
    await expect(cellOf(page, 'Finance team', '2')).toContainText('None');
    await expect(cellOf(page, 'Legal team', '3')).toContainText('None');
  });

  await test.step('invite contributors', async () => {
    await go(page, `/rooms/${ws}/people`);
    for (const [who, group] of [[finance, 'Finance team'], [legal, 'Legal team']] as const) {
      const since = Date.now() - 1000;
      await page.getByRole('button', { name: 'Invite people', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Invite people' });
      await dlg.locator('#iv-group').selectOption({ label: group });
      await dlg.getByRole('tab', { name: /Team members/ }).click();
      await dlg.locator('#iv-mails').fill(who.email);
      await dlg.getByRole('button', { name: 'Send 1 invitation' }).click();
      await expect(page.locator('.toast')).toContainText('1 invitation sent');
      const link = linkIn(await mailTo(who.email, since, /./), /\/invite\//);
      const [given, family] = who.name.split(' ') as [string, string];
      await acceptInvitation(who, link, { given, family, company: 'Wendlow Holdings' });
      await expect(who.page).toHaveURL(new RegExp(`/rooms/${ws}/dashboard$`), { timeout: 30_000 });
      await pageHydrated(who.page);
      for (const s of ['People', 'Permissions', 'Settings']) await expect(who.page.locator('.side .nav')).not.toContainText(s);
    }
  });

  let financeDraft = '';
  let legalDraft = '';
  await test.step('contributors upload drafts into their folders', async () => {
    const addFile = async (who: typeof finance, folderIx: string, name: string) => {
      const f = await folderByNumber(adminId, ws, folderIx);
      await go(who, `/rooms/${ws}/documents/${f.id}`);
      await who.page.getByRole('button', { name: 'Choose files' }).click();
      const dlg = who.page.getByRole('dialog');
      const chooser = who.page.waitForEvent('filechooser');
      await dlg.getByRole('button', { name: 'Browse your computer' }).click();
      await (await chooser).setFiles([{ name, mimeType: 'application/pdf', buffer: pdf(`${name} ${u}`) }]);
      await dlg.getByRole('button', { name: 'Add 1 file as a draft' }).click();
      await expect(dlg.locator('.okbox')).toContainText(`1 file is in ${folderIx}`);
      await dlg.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
      const row = who.page.locator('.dr', { hasText: name.replace(/\.pdf$/, '') });
      await expect(row.locator('.badge')).toContainText('Draft');
      return (await row.getAttribute('data-doc'))!;
    };
    financeDraft = await addFile(finance, '3.1', 'Audit management letter.pdf');
    legalDraft = await addFile(legal, '1.2', 'Shareholder agreement.pdf');

    const legalFolder = await folderByNumber(adminId, ws, '2');
    await go(finance, `/rooms/${ws}/documents/${legalFolder.id}`);
    await expectNotAvailable(finance.page);
    const financeFolder = await folderByNumber(adminId, ws, '3');
    await go(legal, `/rooms/${ws}/documents`);
    await expect(legal.page.locator('.side')).not.toContainText('Finance');
    await go(legal, `/rooms/${ws}/view/${financeDraft}`);
    await expectNotAvailable(legal.page);
    await go(legal, `/rooms/${ws}/documents/${financeFolder.id}`);
    await expectNotAvailable(legal.page);
    // drafts are visible only where you can add files, publish or manage
    await go(finance, `/rooms/${ws}/view/${legalDraft}`);
    await expectNotAvailable(finance.page);
  });

  await test.step('bidders see nothing before publishing', async () => {
    const group = await bidderGroup(adminId, ws, 'Bidder A', 'Orrinby Capital');
    const top = await nodes(adminId, ws);
    await grant(adminId, ws, group, top.map((n) => ({ nodeId: n.id, level: 20 })));
    await go(page, `/rooms/${ws}/settings`);
    await page.getByRole('radio', { name: /^Open/ }).click();
    await saveSettings(page);
    const link = await inviteLink(adminId, ws, group, bidder.email);
    await acceptInvitation(bidder, link, { given: 'Bea', family: 'Smit', company: 'Orrinby Capital' });
    await expect(bidder.page.locator('.nda')).toContainText(`Confidentiality undertaking for ${room}.`);
    await acceptNda(bidder, room);
    await expect(bidder.page).toHaveURL(new RegExp(`/rooms/${ws}/dashboard$`), { timeout: 30_000 });
    await go(bidder, `/rooms/${ws}/documents`);
    for (const name of ['Articles of association', 'Shareholder agreement', 'Audit management letter', 'Supply agreement', 'Share register']) {
      await expect(bidder.page.locator('body')).not.toContainText(name);
    }
    await go(bidder, `/rooms/${ws}/view/${financeDraft}`);
    await expectNotAvailable(bidder.page);
    await go(bidder, `/rooms/${ws}/view/${legalDraft}`);
    await expectNotAvailable(bidder.page);
  });

  await test.step('publish a selection', async () => {
    await go(page, `/rooms/${ws}/release`);
    const folder = (ix: string) => page.locator('.fgrp').filter({ has: page.locator('.ft2 .n', { hasText: new RegExp(`^${ix.replace(/\./g, '\\.')}$`) }) });
    for (const ix of ['1.1', '1.2']) {
      const all = folder(ix).getByRole('checkbox', { name: /^Select all \d+ drafts? that can be published in/ });
      await expect(all).toBeEnabled({ timeout: 60_000 });
      await all.check();
    }
    const sel = page.getByRole('region', { name: 'Selection' });
    await sel.getByRole('button', { name: 'Publish 3 drafts' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish 3 drafts?' });
    await expect(dialog.locator('.wl > div').filter({ hasText: 'Bidder A' }).first()).toContainText('3 at View');
    await dialog.getByRole('button', { name: 'Publish 3 drafts' }).click();
    await expect(page.locator('.toast')).toContainText('3 drafts published');

    const register = await folderByNumber(adminId, ws, '1.2');
    await go(bidder, `/rooms/${ws}/documents/${register.id}`);
    await expect(bidder.page.locator('.dr', { hasText: 'Shareholder agreement' })).toBeVisible();
    await expect(bidder.page.locator('.dr', { hasText: 'Share register' })).toBeVisible();
    await go(bidder, `/rooms/${ws}/view/${legalDraft}`);
    await expect(bidder.page.locator('.doct h1')).toHaveText('Shareholder agreement');
    await go(bidder, `/rooms/${ws}/view/${financeDraft}`);
    await expectNotAvailable(bidder.page);
    await go(bidder, `/rooms/${ws}/documents`);
    for (const name of ['Audit management letter', 'Supply agreement', 'Audited financial statements']) {
      await expect(bidder.page.locator('body')).not.toContainText(name);
    }
    await go(finance, `/rooms/${ws}/documents/${register.id}`);
    await expect(finance.page.locator('.dr', { hasText: 'Shareholder agreement' })).toBeVisible();
    await expect(finance.page.getByRole('button', { name: 'Choose files' })).toHaveCount(0);
  });

  await test.step('activity log verifies', async () => {
    await go(page, `/rooms/${ws}/activity`);
    await expect(page.locator('.chain')).toContainText(/Log intact · checked \d\d:\d\d/);
    await expect(page.locator('.ev').first()).toBeVisible();
    for (const who of ['Femke Botha', 'Lwazi Dube']) await expect(page.locator('.ev', { hasText: who }).first()).toBeVisible();
  });
});
