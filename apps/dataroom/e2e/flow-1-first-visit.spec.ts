// SPDX-License-Identifier: AGPL-3.0-only
import { expect, pageHydrated, test } from './fixtures';
import {
  acceptInvitation, acceptNda, as, bidderGroup, expectNotAvailable, folderByNumber, go, grant, inviteLink, linkIn, mailTo,
  newActor, newRoomCreator, publish, requireNda, roomFor, signIn, signOut, unique, uploadPdf,
} from './flow-helpers';

// WebKit is much slower on dev bundles
test.describe.configure({ timeout: 900_000 });

test('bidder first visit from invitation to dashboard', async ({ browser }) => {
  const u = unique();
  const room1 = `Project Kite ${u}`;
  const room2 = `Project Lark ${u}`;
  const admin = await newActor(browser, 'Rosa Pretorius', `rosa-${u}@e2e.example`);
  const adminId = await newRoomCreator('Rosa Pretorius', admin.email);
  const bidder = await newActor(browser, 'Sanne Visser', `sanne-${u}@e2e.example`);

  // the group may view folder 1 but not folder 2
  const ws1 = await roomFor(adminId, room1);
  await requireNda(adminId, ws1, `Confidentiality undertaking for ${room1}. Keep every document confidential.`);
  const groupA = await bidderGroup(adminId, ws1, 'Bidder A', 'Orrinby Capital');
  const corporate = await folderByNumber(adminId, ws1, '1');
  await grant(adminId, ws1, groupA, [{ nodeId: corporate.id, level: 20 }]);
  const seen = await uploadPdf(adminId, ws1, (await folderByNumber(adminId, ws1, '1.1')).id, 'Articles of association.pdf', `Articles ${u}`);
  const hidden = await uploadPdf(adminId, ws1, (await folderByNumber(adminId, ws1, '2.1')).id, 'Litigation register.pdf', `Litigation ${u}`);
  await publish(adminId, ws1, [seen.nodeId, hidden.nodeId]);

  let link = '';
  await test.step('admin invites the bidder lead', async () => {
    await signIn(admin);
    await expect(admin.page).toHaveURL(new RegExp(`/rooms/${ws1}/dashboard$`));
    await go(admin, `/rooms/${ws1}/people`);
    const since = Date.now() - 1000;
    await admin.page.getByRole('button', { name: 'Invite people', exact: true }).click();
    const dlg = admin.page.getByRole('dialog', { name: 'Invite people' });
    await dlg.locator('#iv-group').selectOption({ label: 'Bidder A' });
    await dlg.getByRole('tab', { name: /Leads/ }).click();
    await dlg.locator('#iv-lead').fill(bidder.email);
    await dlg.getByRole('button', { name: 'Send 1 invitation' }).click();
    await expect(admin.page.locator('.toast')).toContainText('1 invitation sent');
    const mail = await mailTo(bidder.email, since);
    expect(mail.subject).toContain(room1);
    expect(mail.text).toContain('You are invited as a lead for Bidder A.');
    link = linkIn(mail, /\/invite\//);
  });

  await test.step('accept the invitation', async () => {
    await go(bidder, link);
    await expect(bidder.page.getByRole('heading', { name: `Welcome to ${room1}` })).toBeVisible();
    await expect(bidder.page.locator('.inv')).toContainText('Rosa Pretorius');
    await expect(bidder.page.locator('.inv')).toContainText('Bidder A');
    await expect(bidder.page.locator('.steps li')).toHaveText(['Your details', 'Two-factor', 'NDA']);
    await expect(bidder.page.locator('.tin[readonly]')).toHaveValue(bidder.email);
    await acceptInvitation(bidder, link, { given: 'Sanne', family: 'Visser', company: 'Orrinby Capital', role: 'Partner' });
  });

  await test.step('NDA blocks the room until accepted', async () => {
    await expect(bidder.page.getByRole('heading', { name: `Before you enter ${room1}` })).toBeVisible({ timeout: 30_000 });
    await expect(bidder.page.locator('.nda')).toContainText(`Confidentiality undertaking for ${room1}.`);
    await expect(bidder.page.locator('.nda-meta')).toContainText('Version 1');
    await go(bidder, `/rooms/${ws1}/view/${seen.nodeId}`);
    await expect(bidder.page).toHaveURL(new RegExp(`/rooms/${ws1}/nda`));
    expect((await bidder.page.request.get(`/v1/workspaces/${ws1}/nodes/${seen.nodeId}`)).status()).toBe(404);
    await bidder.page.getByRole('button', { name: 'Leave without accepting' }).click();
    await expect(bidder.page.getByRole('heading', { name: 'You have not entered the room' })).toBeVisible();
    await expect.poll(async () => (await bidder.page.request.get('/v1/me')).status()).toBe(401);
    await go(bidder, `/rooms/${ws1}/dashboard`);
    await expect(bidder.page).toHaveURL(/\/sign-in\?next=/);
  });

  await test.step('sign in again and accept the NDA', async () => {
    await signIn(bidder, `/rooms/${ws1}/dashboard`);
    await acceptNda(bidder, room1);
    await expect(bidder.page).toHaveURL(new RegExp(`/rooms/${ws1}/dashboard$`), { timeout: 30_000 });
    await pageHydrated(bidder.page);
    await expect(bidder.page.locator('.side .room')).toContainText(room1);
    await expect(bidder.page.locator('.user')).toContainText('Sanne Visser');
    await expect(bidder.page.locator('.side .room')).toContainText('Run by Quillmont Advisory');
    await expect(bidder.page.locator('body')).not.toContainText('bidder groups');
    await go(bidder, `/rooms/${ws1}/view/${seen.nodeId}`);
    await expect(bidder.page.locator('.doct h1')).toHaveText('Articles of association');
    // wait for a page image so document.opened is committed before we leave
    await expect(bidder.page.locator('#p1 img')).toBeVisible({ timeout: 30_000 });
    await go(bidder, `/rooms/${ws1}/view/${hidden.nodeId}`);
    await expectNotAvailable(bidder.page);
    await go(bidder, `/rooms/${ws1}/documents`);
    await expect(bidder.page.locator('body')).not.toContainText('Legal');
  });

  await test.step('no NDA on the next visit', async () => {
    await signOut(bidder);
    await signIn(bidder);
    await expect(bidder.page).toHaveURL(new RegExp(`/rooms/${ws1}/dashboard$`), { timeout: 30_000 });
  });

  let ws2 = '';
  await test.step('second room starts from My rooms', async () => {
    ws2 = await roomFor(adminId, room2);
    await requireNda(adminId, ws2, `Confidentiality undertaking for ${room2}. A different deal.`);
    const groupB = await bidderGroup(adminId, ws2, 'Bidder A', 'Orrinby Capital');
    const second = await inviteLink(adminId, ws2, groupB, bidder.email, 'lead');
    await go(bidder, second);
    await expect(bidder.page.getByRole('heading', { name: `Welcome to ${room2}` })).toBeVisible();
    const p = bidder.page;
    await expect(p.locator('#f-fn')).toHaveValue('Sanne');
    await expect(p.locator('#f-co')).toHaveValue('Orrinby Capital');
    await p.getByRole('button', { name: 'Continue' }).click();
    await expect(p.getByRole('heading', { name: `Before you enter ${room2}` })).toBeVisible({ timeout: 30_000 });
    await expect(p.getByRole('heading', { name: 'Set up two-factor sign-in' })).toHaveCount(0);
    await signOut(bidder).catch(async () => { await go(bidder, '/sign-in'); });
    await bidder.context.clearCookies({ name: 'vdrkit.session_token' });
    await signIn(bidder);
    await expect(p).toHaveURL(/\/rooms$/);
    const cards = p.getByRole('region', { name: 'Your rooms' }).locator('.rc');
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: room1 })).toContainText('You are Bidder A · Lead');
    await expect(cards.filter({ hasText: room2 })).toContainText('You are Bidder A · Lead');
    await expect(p.locator('.side .nav')).not.toContainText('Create a room');
    await cards.filter({ hasText: room2 }).getByRole('link', { name: /Open room/ }).click();
    await expect(p).toHaveURL(new RegExp(`/rooms/${ws2}/nda\\?next=`), { timeout: 30_000 });
    await expect(p.locator('.nda')).toContainText(`Confidentiality undertaking for ${room2}.`, { timeout: 30_000 });
    await acceptNda(bidder, room2);
    await expect(p).toHaveURL(new RegExp(`/rooms/${ws2}/dashboard$`), { timeout: 30_000 });
    await expect(p.locator('.side .room')).toContainText(room2);
    await go(bidder, `/rooms/${ws1}/dashboard`);
    await expect(p).toHaveURL(new RegExp(`/rooms/${ws1}/dashboard$`));
  });

  await test.step('admin sees the acceptance in Activity', async () => {
    await go(admin, `/rooms/${ws1}/activity`);
    await expect(admin.page.locator('.chain')).toContainText(/Log intact · checked \d\d:\d\d/);
    await expect(admin.page.locator('.ev', { hasText: 'Sanne Visser' }).first()).toBeVisible();
    const actions = (await as<{ items: { action: string }[] }>(adminId, 'GET', `/v1/workspaces/${ws1}/events?limit=100`)).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['invitation.sent', 'invitation.accepted', 'agreement.accepted', 'document.opened', 'auth.signed_in']));
    expect(actions).toContain('access.blocked');
    await expect(admin.page.locator('.ev', { hasText: 'Sanne Visser' }).filter({ hasText: 'Blocked link' }).first()).toBeVisible();
  });
});
