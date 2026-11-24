// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, pageHydrated, test } from './fixtures';
import {
  addFiles, as, bidderGroup, expectNotAvailable, folderByNumber, go, grant, inviteLink, join, newActor, newRoomCreator, pdf, roomFor,
  sellerGroup, signIn, unique,
} from './flow-helpers';
import { API } from './signin-helpers';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';

// WebKit dev bundles are slow
test.describe.configure({ timeout: 900_000 });

test('document lifecycle from upload to withdrawal', async ({ browser }) => {
  const u = unique();
  const room = `Project Ibis-${u}`;
  const admin = await newActor(browser, 'Rosa Pretorius', `rosa-${u}@e2e.example`);
  const adminId = await newRoomCreator('Rosa Pretorius', admin.email);
  const contributor = await newActor(browser, 'Femke Botha', `femke-${u}@e2e.example`);
  const bidder = await newActor(browser, 'Bea Smit', `bea-${u}@e2e.example`);
  const name = 'Audit management letter';

  const ws = await roomFor(adminId, room);
  const finance = await folderByNumber(adminId, ws, '3');
  const audited = await folderByNumber(adminId, ws, '3.1');
  const team = await sellerGroup(adminId, ws, 'Finance team');
  await grant(adminId, ws, team, [{ nodeId: finance.id, level: 20, canUpload: true }]);
  const groupA = await bidderGroup(adminId, ws, 'Bidder A', 'Orrinby Capital');
  await grant(adminId, ws, groupA, [{ nodeId: finance.id, level: 50 }]);
  await join(contributor, await inviteLink(adminId, ws, team, contributor.email), { given: 'Femke', family: 'Botha', company: 'Wendlow Holdings' }, room, ws, false);
  await join(bidder, await inviteLink(adminId, ws, groupA, bidder.email), { given: 'Bea', family: 'Smit', company: 'Orrinby Capital' }, room, ws, false);
  await signIn(admin);

  let doc = '';
  const details = (who: typeof admin) => go(who, `/rooms/${ws}/details/${doc}`);
  const versionRow = (who: typeof admin, n: number) => who.page.locator('.vrow').filter({ hasText: `Version ${n}` }).first();
  const bidderVersion = async () => {
    const r = await bidder.page.request.get(`/v1/workspaces/${ws}/nodes/${doc}`);
    return r.ok() ? ((await r.json()) as { version: { number: number } | null }).version?.number ?? null : r.status();
  };

  await test.step('upload', async () => {
    doc = (await addFiles(contributor, ws, audited.id, [{ name: `${name}.pdf`, text: `${name} v1 ${u}` }]))[0]!;
    await expect(async () => {
      await details(contributor);
      await expect(versionRow(contributor, 1).locator('.badge')).toHaveText('Draft', { timeout: 2000 });
      await expect(contributor.page.locator('.step.wait')).toHaveCount(0, { timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    await expect(versionRow(contributor, 1)).toContainText('Bidders see nothing until it is published.');
    await expect(contributor.page.getByRole('button', { name: /^Release/ })).toHaveCount(0);
  });

  await test.step('draft hidden from bidders', async () => {
    await go(bidder, `/rooms/${ws}/documents/${audited.id}`);
    await expect(bidder.page.locator('.dr', { hasText: name })).toHaveCount(0);
    await go(bidder, `/rooms/${ws}/view/${doc}`);
    await expectNotAvailable(bidder.page);
    expect((await bidder.page.request.get(`/v1/workspaces/${ws}/nodes/${doc}`)).status()).toBe(404);
  });

  await test.step('publish', async () => {
    await details(admin);
    await expect(versionRow(admin, 1)).toContainText('Uploaded');
    await expect(versionRow(admin, 1)).toContainText('Femke Botha');
    await versionRow(admin, 1).getByRole('button', { name: /^Release/ }).first().click();
    await expect(admin.page.locator('.toast')).toContainText('released');
    await admin.page.reload();
    await expect(versionRow(admin, 1).locator('.badge')).toHaveText('Bidders see this');
    await go(bidder, `/rooms/${ws}/documents/${audited.id}`);
    await expect(bidder.page.locator('.dr', { hasText: name })).toBeVisible();
    await go(bidder, `/rooms/${ws}/view/${doc}`);
    await expect(bidder.page.locator('.doct h1')).toHaveText(name);
    await expect(bidder.page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    expect(await bidderVersion()).toBe(1);
    await expect(bidder.page.locator('#dl-btn')).toBeVisible();
  });

  await test.step('new version', async () => {
    await details(contributor);
    await contributor.page.getByTestId('d2-file').setInputFiles({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer: pdf(`${name} v2 ${u}`) });
    await contributor.page.getByRole('dialog').getByRole('button', { name: 'Upload as version 2' }).click();
    await expect(contributor.page.locator('.toast')).toContainText('New version uploaded');
    await expect(versionRow(contributor, 2)).toContainText('Bidders still see version 1 until this one is published.');
    await go(bidder, `/rooms/${ws}/view/${doc}`);
    await expect(bidder.page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    expect(await bidderVersion()).toBe(1);
    await expect(bidder.page.locator('.vroot')).not.toContainText('Version 2');
    await expect(async () => {
      await details(admin);
      await expect(versionRow(admin, 2).getByRole('button', { name: /^Release/ }).first()).toBeEnabled({ timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    await versionRow(admin, 2).getByRole('button', { name: /^Release/ }).first().click();
    await expect(admin.page.locator('.toast')).toContainText('released');
    expect(await bidderVersion()).toBe(2);
  });

  await test.step('withdraw', async () => {
    await details(admin);
    await versionRow(admin, 2).getByRole('button', { name: 'Withdraw' }).click();
    let dlg = admin.page.getByRole('dialog');
    await expect(dlg).toContainText('go back to version 1');
    await dlg.locator('textarea').fill('Sent in error: the draft letter');
    await dlg.getByRole('button', { name: 'Withdraw from bidders' }).click();
    await expect(admin.page.locator('.toast')).toContainText('Withdrawn from bidders');
    expect(await bidderVersion()).toBe(1);

    await details(admin);
    await versionRow(admin, 1).getByRole('button', { name: 'Withdraw' }).click();
    dlg = admin.page.getByRole('dialog');
    await expect(dlg).toContainText(`stop seeing ${name}`);
    await dlg.getByRole('button', { name: 'Withdraw from bidders' }).click();
    await expect(admin.page.locator('.toast')).toContainText('Nobody outside the seller team sees it now.');
    await bidder.page.reload();
    await pageHydrated(bidder.page);
    await expectNotAvailable(bidder.page);
    await go(bidder, `/rooms/${ws}/documents/${audited.id}`);
    await expect(bidder.page.locator('.dr', { hasText: name })).toHaveCount(0);
    await details(admin);
    await expect(admin.page.locator('.vrow')).toHaveCount(2);
    for (const n of [1, 2]) await expect(versionRow(admin, n).locator('.badge')).toHaveText('Withdrawn');
  });

  await test.step('activity log', async () => {
    const events = (await as<{ items: { action: string; actor?: { name?: string } }[] }>(adminId, 'GET', `/v1/workspaces/${ws}/events?limit=200`)).items;
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['document.opened', 'access.blocked']));
    await go(admin, `/rooms/${ws}/activity`);
    await expect(admin.page.locator('.chain')).toContainText(/Log intact · checked \d\d:\d\d/);
    const viewed = admin.page.locator('.ev', { hasText: 'Bea Smit' }).filter({ hasText: name });
    await expect(viewed.first()).toBeVisible();
    await expect(admin.page.locator('.ev', { hasText: 'Bea Smit' }).filter({ hasText: 'Blocked link' }).first()).toBeVisible();
    await expect(admin.page.locator('.ev', { hasText: 'Femke Botha' }).first()).toBeVisible();
  });

  await test.step('failed processing', async () => {
    // damaged PDF
    const contributorId = (await as<{ parties: { groups: { members: { email: string; personId: string }[] }[] }[] }>(adminId, 'GET', `/v1/workspaces/${ws}/people`))
      .parties.flatMap((p) => p.groups).flatMap((g) => g.members).find((m) => m.email === contributor.email)!.personId;
    const bytes = Buffer.from(`%PDF-1.7\n${'garbage '.repeat(100)}${u}`);
    const s = await as<{ id: string; uploadUrl: string }>(contributorId, 'POST', `/v1/workspaces/${ws}/upload-sessions`, {
      targetFolderId: audited.id, path: 'Damaged report.pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'application/pdf' });
    await fetch(`${API}${s.uploadUrl}`, { method: 'PUT', body: bytes, headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': contributorId, 'content-type': 'application/octet-stream' } });
    const done = await as<{ nodeId: string }>(contributorId, 'POST', `/v1/workspaces/${ws}/upload-sessions/${s.id}/complete`, {});
    await expect(async () => {
      await go(contributor, `/rooms/${ws}/details/${done.nodeId}`);
      await expect(contributor.page.locator('.head .badge')).toHaveText('Not ready: processing failed', { timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    await expect(contributor.page.locator('.step.bad')).toHaveCount(1);
    await contributor.page.getByTestId('d2-file').setInputFiles({ name: 'Damaged report.pdf', mimeType: 'application/pdf', buffer: pdf(`Repaired report ${u}`) });
    await contributor.page.getByRole('dialog').getByRole('button', { name: /^Upload as version \d+$/ }).click();
    await expect(contributor.page.locator('.toast')).toContainText('New version uploaded');
    await expect(async () => {
      await go(contributor, `/rooms/${ws}/details/${done.nodeId}`);
      await expect(contributor.page.locator('.vrow').first().locator('.badge')).toHaveText('Draft', { timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    await go(bidder, `/rooms/${ws}/view/${done.nodeId}`);
    await expectNotAvailable(bidder.page);
  });
});
