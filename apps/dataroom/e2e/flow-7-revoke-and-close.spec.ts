// SPDX-License-Identifier: AGPL-3.0-only
import { clickAndRefresh, expect, pageHydrated, test } from './fixtures';
import {
  as, bidderGroup, expectNotAvailable, folderByNumber, go, grant, inviteLink, join, newActor, newRoomCreator, publish,
  roomFor, sellerGroup, signIn, unique, uploadPdf, type Actor,
} from './flow-helpers';

// WebKit dev bundles are slow
test.describe.configure({ timeout: 900_000 });

test('revoke a bidder, then freeze and close the room', async ({ browser }) => {
  const u = unique();
  const room = `Project Tern ${u}`;
  const admin = await newActor(browser, 'Rosa Pretorius', `rosa-${u}@e2e.example`);
  const adminId = await newRoomCreator('Rosa Pretorius', admin.email);
  const leadA = await newActor(browser, 'Jana Venter', `jana-${u}@e2e.example`);
  const leadB = await newActor(browser, 'Mei Chen', `mei-${u}@e2e.example`);
  const finB = await newActor(browser, 'Ola Berg', `ola-${u}@e2e.example`);
  const contributor = await newActor(browser, 'Femke Botha', `femke-${u}@e2e.example`);
  const page = admin.page;

  const ws = await roomFor(adminId, room);
  const corporate = await folderByNumber(adminId, ws, '1');
  const finance = await folderByNumber(adminId, ws, '3');
  const doc = await uploadPdf(adminId, ws, (await folderByNumber(adminId, ws, '1.1')).id, 'Articles of association.pdf', `Articles ${u}`);
  await publish(adminId, ws, [doc.nodeId]);
  const draft = await uploadPdf(adminId, ws, (await folderByNumber(adminId, ws, '1.2')).id, 'Share register.pdf', `Register ${u}`);
  const groupA = await bidderGroup(adminId, ws, 'Bidder A', 'Orrinby Capital');
  const groupB = await bidderGroup(adminId, ws, 'Bidder B', 'Quorvane Partners');
  const subB = (await as<{ id: string }>(adminId, 'POST', `/v1/workspaces/${ws}/groups`, { name: 'Bidder B financier', parentGroupId: groupB, organisation: 'Nordhavik Bank' })).id;
  for (const g of [groupA, groupB, subB]) await grant(adminId, ws, g, [{ nodeId: corporate.id, level: 20 }]);
  const team = await sellerGroup(adminId, ws, 'Finance team');
  await grant(adminId, ws, team, [{ nodeId: finance.id, level: 20, canUpload: true }]);
  const enter = async (who: Actor, group: string, given: string, family: string, company: string, role: 'lead' | 'member' = 'member') =>
    join(who, await inviteLink(adminId, ws, group, who.email, role), { given, family, company }, room, ws, false);
  await enter(leadA, groupA, 'Jana', 'Venter', 'Orrinby Capital', 'lead');
  await enter(leadB, groupB, 'Mei', 'Chen', 'Quorvane Partners', 'lead');
  await enter(finB, subB, 'Ola', 'Berg', 'Nordhavik Bank');
  await enter(contributor, team, 'Femke', 'Botha', 'Drosvelt Holdings');
  for (const who of [leadB, finB]) {
    await go(who, `/rooms/${ws}/view/${doc.nodeId}`);
    await expect(who.page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  }

  await test.step('revoke Bidder B', async () => {
    await signIn(admin);
    await go(admin, `/rooms/${ws}/people`);
    const b = page.locator('.grp[data-group="Bidder B"]');
    await b.getByRole('button', { name: 'Actions for Bidder B', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Revoke access' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('heading', { name: 'Revoke access for Bidder B?' })).toBeVisible();
    await dlg.locator('#rv-why').fill('withdrew from the process');
    await dlg.getByRole('button', { name: 'Revoke access for Bidder B' }).click();
    await expect(b).toHaveClass(/revoked/);
    await expect(b.locator('.gn small')).toContainText('by Rosa Pretorius, withdrew from the process');
    await expect(page.locator('.grp[data-group="Bidder B financier"]')).toHaveClass(/revoked/);

    for (const who of [leadB, finB]) {
      await who.page.reload();
      await pageHydrated(who.page);
      if (!/\/sign-in/.test(who.page.url())) await expectNotAvailable(who.page);
      await expect(who.page.locator('.doct h1')).toHaveCount(0);
      expect((await who.page.request.get(`/v1/workspaces/${ws}/nodes/${doc.nodeId}`)).ok()).toBe(false);
      expect((await who.page.request.get(`/v1/workspaces/${ws}/nodes/${doc.nodeId}/pages/1`)).ok()).toBe(false);
    }
    await leadB.context.clearCookies();
    await signIn(leadB);
    await expect(leadB.page.getByText('Your access has ended')).toBeVisible();
    await go(leadA, `/rooms/${ws}/view/${doc.nodeId}`);
    await expect(leadA.page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
  });

  await test.step('history stays', async () => {
    await go(admin, `/rooms/${ws}/activity`);
    await expect(page.locator('.ev', { hasText: 'Mei Chen' }).filter({ hasText: 'Articles of association' }).first()).toBeVisible();
    await expect(page.locator('.ev', { hasText: 'Ola Berg' }).filter({ hasText: 'Articles of association' }).first()).toBeVisible();
    const revoked = page.locator('.ev', { hasText: 'Closed group Bidder B' });
    await expect(revoked).toHaveCount(1);
    await expect(revoked).toContainText('Rosa Pretorius');
    await expect(revoked).toContainText('Everyone in it lost access');
    await expect(page.locator('.day').first()).toContainText(/^Today, /i);
    await expect(page.locator('.chain')).toContainText(/Log intact · checked \d\d:\d\d/);
  });

  await test.step('freeze', async () => {
    await go(admin, `/rooms/${ws}/settings`);
    await page.getByRole('radio', { name: /^Frozen/ }).click();
    await expect(page.locator('.note.warn')).toContainText('When you save, the room becomes frozen.');
    await clickAndRefresh(page, page.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save changes' }));
    await expect(page.locator('.toast')).toContainText(/saved/);
    const audited = await folderByNumber(adminId, ws, '3.1');
    await go(contributor, `/rooms/${ws}/documents/${audited.id}`);
    await expect(contributor.page.getByRole('button', { name: /^(Choose files|Upload files)$/ })).toHaveCount(0);
    // needs an Origin
    const origin = { origin: new URL(page.url()).origin };
    const res = await contributor.page.request.post(`/v1/workspaces/${ws}/upload-sessions`, { headers: origin,
      data: { targetFolderId: audited.id, path: 'Late file.pdf', size: 10, sha256: '0'.repeat(64), mime: 'application/pdf' } });
    expect(res.ok()).toBe(false);
    expect(((await res.json()) as { reason?: string }).reason).not.toBe('cross_site_request');
    await go(admin, `/rooms/${ws}/release`);
    await expect(page.locator('.note.warn')).toContainText('The room is frozen. Nobody can publish');
    const refused = await page.request.post(`/v1/workspaces/${ws}/publish`, { headers: origin, data: { nodeIds: [draft.nodeId] } });
    expect(refused.ok()).toBe(false);
    expect(((await refused.json()) as { reason?: string }).reason).toBe('room_frozen');
    await go(leadA, `/rooms/${ws}/view/${doc.nodeId}`);
    await expect(leadA.page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    await go(contributor, `/rooms/${ws}/documents/${audited.id}`);
    await expect(contributor.page.locator('.content h1')).toContainText('Management accounts');
  });

  await test.step('withdraw while frozen', async () => {
    await go(admin, `/rooms/${ws}/details/${doc.nodeId}`);
    await page.locator('.vrow').first().getByRole('button', { name: 'Withdraw' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Withdraw from bidders' }).click();
    await expect(page.locator('.toast')).toContainText('Withdrawn from bidders');
    await go(leadA, `/rooms/${ws}/view/${doc.nodeId}`);
    await expectNotAvailable(leadA.page);
  });

  await test.step('close', async () => {
    await go(admin, `/rooms/${ws}/settings`);
    await page.getByRole('radio', { name: /^Closed/ }).click();
    await expect(page.locator('.note.warn')).toContainText('Everyone except room admins is signed out and loses access.');
    await clickAndRefresh(page, page.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save changes' }));
    await expect(page.locator('.toast')).toContainText(/saved/);
    for (const who of [leadA, contributor]) {
      await go(who, `/rooms/${ws}/dashboard`);
      if (!/\/sign-in/.test(who.page.url())) await expect(who.page.getByRole('heading', { name: `${room} is closed` })).toBeVisible();
      // unseen folders list as empty
      const listed = await who.page.request.get(`/v1/workspaces/${ws}/nodes?parent=${corporate.id}`);
      if (listed.ok()) expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(0);
      expect((await who.page.request.get(`/v1/workspaces/${ws}/nodes/${draft.nodeId}`)).ok()).toBe(false);
    }
    await go(admin, `/rooms/${ws}/activity`);
    await expect(page.locator('.chain')).toContainText(/Log intact · checked \d\d:\d\d/);
    const actions = (await as<{ items: { action: string }[] }>(adminId, 'GET', `/v1/workspaces/${ws}/events?limit=200`)).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['group.revoked', 'workspace.state_changed']));
    await expect(page.getByRole('button', { name: /archive/i })).toHaveCount(0);
  });
});
