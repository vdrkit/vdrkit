// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expect, pageHydrated, test } from './fixtures';
import {
  acceptInvitation, acceptNda, bidderGroup, expectNotAvailable, folderByNumber, go, grant, inviteLink, linkIn, mailTo, newActor,
  newRoomCreator, publish, requireNda, roomFor, signIn, unique, uploadPdf,
} from './flow-helpers';

// WebKit dev bundles are slow
test.describe.configure({ timeout: 900_000 });

const cellOf = (page: Page, group: string, folder: string) => page.locator(`button.cell[aria-label^="${group}, ${folder} "]`);
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test('admin prepares a bidder group and the lead lands on the dashboard', async ({ browser }) => {
  const u = unique();
  const room = `Project Wren ${u}`;
  const admin = await newActor(browser, 'Rosa Pretorius', `rosa-${u}@e2e.example`);
  const adminId = await newRoomCreator('Rosa Pretorius', admin.email);
  const lead = await newActor(browser, 'Jana Venter', `jana-${u}@e2e.example`);
  const member = await newActor(browser, 'Piet Nel', `piet-${u}@e2e.example`);
  const other = await newActor(browser, 'Mei Chen', `mei-${u}@e2e.example`);
  const page = admin.page;

  const ws = await roomFor(adminId, room);
  await requireNda(adminId, ws, `Confidentiality undertaking for ${room}. Keep every document confidential.`);
  const docs = {
    articles: await uploadPdf(adminId, ws, (await folderByNumber(adminId, ws, '1.1')).id, 'Articles of association.pdf', `Articles ${u}`),
    litigation: await uploadPdf(adminId, ws, (await folderByNumber(adminId, ws, '2.1')).id, 'Litigation register.pdf', `Litigation ${u}`),
    afs: await uploadPdf(adminId, ws, (await folderByNumber(adminId, ws, '3.1')).id, 'Audited financial statements FY2025.pdf', `AFS ${u}`),
  };
  await publish(adminId, ws, Object.values(docs).map((d) => d.nodeId));
  const groupB = await bidderGroup(adminId, ws, 'Bidder B', 'Quorvane Partners');
  await grant(adminId, ws, groupB, [{ nodeId: (await folderByNumber(adminId, ws, '1')).id, level: 20 }]);

  await test.step('groups', async () => {
    await signIn(admin);
    await go(admin, `/rooms/${ws}/people`);
    await page.getByRole('button', { name: 'New group' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.locator('#ng-name').fill('Bidder A');
    await dlg.locator('#ng-org').fill('Orrinby Capital');
    await dlg.locator('#ng-until').fill(day(75));
    await dlg.getByRole('button', { name: 'Next: access' }).click();
    await dlg.getByRole('button', { name: 'Next: people' }).click();
    await dlg.getByRole('button', { name: 'Create group' }).click();
    await expect(dlg.getByRole('heading', { name: 'Group created' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Close' }).last().click();

    const a = page.locator('.grp[data-group="Bidder A"]');
    await a.getByRole('button', { name: 'Actions for Bidder A', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add subgroup' }).click();
    await dlg.locator('#ng-name').fill('Bidder A financier');
    await dlg.locator('#ng-org').fill('Primvale Bank');
    await dlg.getByRole('button', { name: 'Next: access' }).click();
    await dlg.getByRole('button', { name: 'Next: people' }).click();
    await dlg.getByRole('button', { name: 'Create group' }).click();
    await expect(dlg.getByRole('heading', { name: 'Group created' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Close' }).last().click();
    await expect(page.locator('.grp[data-group="Bidder A financier"] .gn small')).toContainText('subgroup of Bidder A');
  });

  await test.step('permissions', async () => {
    await go(admin, `/rooms/${ws}/permissions`);
    const set = async (group: string, folder: string, level: RegExp) => {
      await cellOf(page, group, folder).click();
      const pop = page.getByRole('dialog');
      await pop.getByRole('radio', { name: level }).check();
      await pop.getByRole('button', { name: 'Apply' }).click();
      await expect(pop).toHaveCount(0);
    };
    await set('Bidder A', '1', /^View/);
    await set('Bidder A', '3', /^Download PDF/);
    // above Bidder A's level
    await cellOf(page, 'Bidder A financier', '3').click();
    const pop = page.getByRole('dialog');
    await expect(pop.getByRole('radio', { name: /Original/ })).toBeDisabled();
    await pop.getByRole('radio', { name: /^View/ }).check();
    await pop.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Review and save' }).click();
    const review = page.getByRole('dialog', { name: /3 changes take effect together when you save/ });
    await review.getByRole('button', { name: 'Save 3 changes' }).click();
    await expect(page.getByRole('status')).toContainText('3 changes saved');
    await expect(cellOf(page, 'Bidder A', '2')).toContainText('None');
    await expect(cellOf(page, 'Bidder A financier', '1')).toContainText('None');
    await expect(cellOf(page, 'Bidder A financier', '3')).toContainText('View');
  });

  await test.step('see as Bidder A', async () => {
    await page.getByLabel('Check what a group sees').selectOption({ label: 'Bidder A' });
    await expect(page.getByTestId('view-as-note')).toContainText('Bidder A sees 2 of 11 folders');
    await go(admin, `/rooms/${ws}/dashboard`);
    await page.getByTestId('see-as-picker').click();
    await page.getByRole('menu', { name: 'See the room as' }).getByRole('menuitem', { name: /^Bidder A/ }).first().click();
    await expect(page.getByTestId('see-as-bar')).toContainText('You are seeing the room as Bidder A. Nothing you do here is recorded.');
    await page.locator('.side .nav a', { hasText: 'Documents' }).click();
    await expect(page.getByTestId('see-as-bar')).toBeVisible();
    await expect(page.locator('.content')).toContainText('Corporate');
    await expect(page.locator('.content')).toContainText('Finance');
    await expect(page.locator('.content')).not.toContainText('Legal');
    await page.getByTestId('see-as-bar').getByRole('link', { name: 'Stop seeing as Bidder A' }).click();
    await expect(page.getByTestId('see-as-bar')).toHaveCount(0);
  });

  await test.step('timeline', async () => {
    await go(admin, `/rooms/${ws}/timeline`);
    const f2 = page.locator('[data-screen="timeline"]');
    await f2.getByRole('button', { name: 'Add a phase' }).click();
    let dlg = page.getByRole('dialog', { name: 'Add a phase' });
    await dlg.getByLabel('Name').fill('First round');
    await dlg.getByLabel('Starts').fill(day(-1));
    await dlg.getByLabel('Ends with').fill('Non-binding offers due');
    await dlg.getByLabel('Deadline date').fill(day(30));
    await dlg.getByLabel(/^Time, /).fill('17:00');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Phase added');
    const phase = f2.getByRole('region', { name: 'Phase 1' });

    await phase.getByRole('button', { name: 'Add an event to first round' }).click();
    dlg = page.getByRole('dialog', { name: 'Add an event to first round' });
    await dlg.getByLabel('Event').fill('Management presentation');
    await dlg.getByLabel('Date', { exact: true }).fill(day(10));
    await dlg.getByLabel(/^Time, /).fill('10:00');
    await dlg.getByLabel('Only some bidder groups').check();
    await dlg.getByLabel('Bidder B').uncheck();
    await dlg.getByLabel('Bidder A', { exact: true }).check();
    await dlg.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Event added');
    await expect(phase.locator('[data-milestone="Management presentation"] .chip')).toHaveText('Bidder A only');

    await phase.getByRole('button', { name: 'Add an event to first round' }).click();
    dlg = page.getByRole('dialog', { name: 'Add an event to first round' });
    await dlg.getByLabel('Event').fill('Q&A cut-off');
    await dlg.getByLabel('Date', { exact: true }).fill(day(20));
    await dlg.getByLabel(/^Time, /).fill('12:00');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.toast')).toContainText('Event added');
  });

  await test.step('invite', async () => {
    await go(admin, `/rooms/${ws}/people`);
    const since = Date.now() - 1000;
    await page.getByRole('button', { name: 'Invite people', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Invite people' });
    await dlg.locator('#iv-group').selectOption({ label: 'Bidder A' });
    await expect(dlg).toContainText('the end date of the group');
    await dlg.getByRole('tab', { name: /Leads/ }).click();
    await dlg.locator('#iv-lead').fill(lead.email);
    await dlg.getByRole('tab', { name: /Team members/ }).click();
    await dlg.locator('#iv-mails').fill(member.email);
    await dlg.getByRole('button', { name: 'Send 2 invitations' }).click();
    await expect(page.locator('.toast')).toContainText('2 invitations sent');
    const leadMail = await mailTo(lead.email, since);
    expect(leadMail.text).toContain('You are invited as a lead for Bidder A.');
    const memberMail = await mailTo(member.email, since);
    expect(memberMail.text).not.toContain('as a lead');
    for (const m of [leadMail, memberMail]) expect(m.text).not.toContain('Bidder B');

    await test.step('accept invitations', async () => {
      for (const [who, mail, given, family] of [[lead, leadMail, 'Jana', 'Venter'], [member, memberMail, 'Piet', 'Nel']] as const) {
        await acceptInvitation(who, linkIn(mail, /\/invite\//), { given, family, company: 'Orrinby Capital' });
        await expect(who.page.locator('.nda')).toContainText(`Confidentiality undertaking for ${room}.`);
        await acceptNda(who, room);
        await expect(who.page).toHaveURL(new RegExp(`/rooms/${ws}/dashboard$`), { timeout: 30_000 });
      }
    });
  });

  await test.step('lead dashboard', async () => {
    const p = lead.page;
    await pageHydrated(p);
    const c1 = p.locator('[data-dashboard="lead"]');
    await expect(c1.locator('.over').first()).toHaveText(`${room} · Bidder A`);
    const timeline = c1.getByRole('region', { name: 'Current phase' });
    await expect(timeline.locator('.over')).toContainText('First round');
    await expect(timeline).toContainText('Non-binding offers due');
    await expect(timeline).toContainText(/(29|30|31)\s*days left in this phase/);
    await expect(timeline.locator('[data-milestone^="Management presentation"]')).toHaveCount(1);
    await expect(timeline).toContainText('Q&A cut-off');
    const fresh = c1.getByRole('region', { name: 'New since your last visit' });
    await expect(fresh).toContainText('Articles of association');
    await expect(fresh).toContainText('Audited financial statements FY2025');
    await expect(fresh).not.toContainText('Litigation register');
    for (const word of ['Bidder B', 'Quorvane Partners', 'All groups', 'bidder groups']) await expect(p.locator('.app')).not.toContainText(word);
    await expect(c1.getByRole('region', { name: 'Your requests' }).getByRole('link', { name: 'Request to add a colleague' })).toBeVisible();
    await go(lead, `/rooms/${ws}/view/${docs.afs.nodeId}`);
    await expect(p.locator('#dl-btn')).toBeVisible();
    await go(lead, `/rooms/${ws}/view/${docs.articles.nodeId}`);
    await expect(p.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    await expect(p.locator('#dl-btn')).toHaveCount(0);
    await go(lead, `/rooms/${ws}/view/${docs.litigation.nodeId}`);
    await expectNotAvailable(p);
  });

  await test.step('member dashboard', async () => {
    const p = member.page;
    await pageHydrated(p);
    await expect(p.locator('[data-dashboard="member"]')).toBeVisible();
    await expect(p.locator('[data-dashboard="member"]').getByRole('region', { name: 'Current phase' })).toContainText('Management presentation');
    await expect(p.locator('.app')).not.toContainText(/Your team has opened/);
  });

  await test.step('Bidder B sees none of it', async () => {
    const link = await inviteLink(adminId, ws, groupB, other.email, 'lead');
    await acceptInvitation(other, link, { given: 'Mei', family: 'Chen', company: 'Quorvane Partners' });
    await acceptNda(other, room);
    await expect(other.page).toHaveURL(new RegExp(`/rooms/${ws}/dashboard$`), { timeout: 30_000 });
    await pageHydrated(other.page);
    const timeline = other.page.getByRole('region', { name: 'Current phase' });
    await expect(timeline).toContainText('Q&A cut-off');
    await expect(timeline).not.toContainText('Management presentation');
    await go(other, `/rooms/${ws}/timeline`);
    await expect(other.page.locator('.content')).toContainText('Q&A cut-off');
    await expect(other.page.locator('.content')).not.toContainText('Management presentation');
    for (const word of ['Bidder A', 'Orrinby']) await expect(other.page.locator('.app')).not.toContainText(word);
    await go(other, `/rooms/${ws}/view/${docs.afs.nodeId}`);
    await expectNotAvailable(other.page);
  });
});
