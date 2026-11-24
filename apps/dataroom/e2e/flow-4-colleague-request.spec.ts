// SPDX-License-Identifier: AGPL-3.0-only
import { expect, pageHydrated, test } from './fixtures';
import {
  acceptInvitation, acceptNda, as, bidderGroup, expectNotAvailable, folderByNumber, go, grant, inviteLink, linkIn, mailsTo, mailTo,
  newActor, newRoomCreator, publish, requireNda, roomFor, signIn, unique, uploadPdf, type Actor,
} from './flow-helpers';

test.describe.configure({ timeout: 900_000 });

test('lead requests colleagues; admin declines one and approves the other', async ({ browser }) => {
  const u = unique();
  const room = `Project Heron-${u}`;
  const admin = await newActor(browser, 'Rosa Pretorius', `rosa-${u}@e2e.example`);
  const adminId = await newRoomCreator('Rosa Pretorius', admin.email);
  const lead = await newActor(browser, 'Jana Venter', `jana-${u}@e2e.example`);
  const member = await newActor(browser, 'Piet Nel', `piet-${u}@e2e.example`);
  const colleague = await newActor(browser, 'Thandi Mokoena', `thandi-${u}@e2e.example`);
  const declined = `peter-${u}@e2e.example`;

  const ws = await roomFor(adminId, room);
  await requireNda(adminId, ws, `Confidentiality undertaking for ${room}. Keep every document confidential.`);
  const groupA = await bidderGroup(adminId, ws, 'Bidder A', 'Orrinby Capital');
  await bidderGroup(adminId, ws, 'Bidder B', 'Quorvane Partners');
  await grant(adminId, ws, groupA, [{ nodeId: (await folderByNumber(adminId, ws, '1')).id, level: 20 }]);
  const seen = await uploadPdf(adminId, ws, (await folderByNumber(adminId, ws, '1.1')).id, 'Articles of association.pdf', `Articles ${u}`);
  const hidden = await uploadPdf(adminId, ws, (await folderByNumber(adminId, ws, '2.1')).id, 'Litigation register.pdf', `Litigation ${u}`);
  await publish(adminId, ws, [seen.nodeId, hidden.nodeId]);
  const enter = async (who: Actor, role: 'lead' | 'member', given: string, family: string) => {
    await acceptInvitation(who, await inviteLink(adminId, ws, groupA, who.email, role), { given, family, company: 'Orrinby Capital' });
    await acceptNda(who, room);
    await expect(who.page).toHaveURL(new RegExp(`/rooms/${ws}/dashboard$`), { timeout: 30_000 });
  };
  await enter(lead, 'lead', 'Jana', 'Venter');
  await enter(member, 'member', 'Piet', 'Nel');

  const dlg = lead.page.getByRole('dialog', { name: 'Request to add a colleague' });
  const requests = lead.page.getByRole('region', { name: 'Requests to add colleagues' });

  await test.step('member cannot ask', async () => {
    await go(member, `/rooms/${ws}/team`);
    await expect(member.page.getByRole('button', { name: 'Request to add a colleague' })).toHaveCount(0);
    await expect(member.page.locator('.content')).toContainText('Jana Venter');
    const memberId = (await as<{ parties: { groups: { members: { email: string; personId: string }[] }[] }[] }>(adminId, 'GET', `/v1/workspaces/${ws}/people`))
      .parties.flatMap((p) => p.groups).flatMap((g) => g.members).find((m) => m.email === member.email)!.personId;
    const res = await fetch(`http://127.0.0.1:${process.env.API_PORT ?? '3101'}/v1/workspaces/${ws}/team-requests`, {
      method: 'POST',
      headers: { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001', 'x-dev-person': memberId, 'content-type': 'application/json' },
      body: JSON.stringify({ givenName: 'Sly', familyName: 'Fox', email: `sly-${u}@e2e.example`, company: 'Orrinby Capital' }),
    });
    expect(res.ok).toBe(false);
  });

  let since = 0;
  await test.step('lead asks for two colleagues', async () => {
    await go(lead, `/rooms/${ws}/team`);
    since = Date.now() - 1000;
    for (const [given, family, email, why] of [
      ['Thandi', 'Mokoena', colleague.email, 'Reviews the corporate documents for our offer'],
      ['Peter', 'Lane', declined, 'Personal adviser'],
    ] as const) {
      await lead.page.getByRole('button', { name: 'Request to add a colleague' }).click();
      await expect(dlg).toContainText('To Bidder A. The room admin, Rosa Pretorius, decides.');
      await dlg.locator('#c-fn').fill(given);
      await dlg.locator('#c-ln').fill(family);
      await dlg.locator('#c-co').fill('Orrinby Capital');
      await dlg.locator('#c-e').fill(email);
      await dlg.locator('#c-why').fill(why);
      await dlg.getByRole('button', { name: 'Send request' }).click();
      await expect(dlg).toHaveCount(0);
      await expect(lead.page.locator('.toast')).toContainText('Request sent');
      await expect(requests.locator(`[data-request="${given} ${family}"] .badge`)).toHaveText('Waiting', { timeout: 20_000 });
    }
  });

  await test.step('email to the admin', async () => {
    await mailTo(admin.email, since, /asks to add a colleague to Bidder A/);
    await expect.poll(async () => (await mailsTo(admin.email, since)).filter((m) => /asks to add a colleague/.test(m.subject)).length).toBe(2);
    const mails = (await mailsTo(admin.email, since)).filter((m) => /asks to add a colleague/.test(m.subject));
    expect(mails.map((m) => m.subject)).toEqual(['Jana Venter asks to add a colleague to Bidder A', 'Jana Venter asks to add a colleague to Bidder A']);
    expect(mails.map((m) => /Name: (.+)/.exec(m.text)?.[1]?.trim())).toEqual(['Thandi Mokoena', 'Peter Lane']);
    for (const m of mails) {
      expect(m.text).toContain(`/rooms/${ws}/people`);
      expect(m.text).not.toMatch(/approve\?|decide\?|token=/i);
    }
    expect(await mailsTo(colleague.email, since)).toHaveLength(0);
  });

  await test.step('decline', async () => {
    await signIn(admin);
    await go(admin, `/rooms/${ws}/people`);
    const req = admin.page.getByRole('region', { name: 'Access requests' });
    const rows = req.locator('.rq');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Thandi Mokoena');
    await expect(rows.nth(1)).toContainText('Peter Lane');
    await expect(rows.nth(0)).toContainText('for Bidder A, requested by Jana Venter');
    await expect(rows.nth(0)).toContainText('Reviews the corporate documents for our offer');
    const decideAt = Date.now() - 1000;
    await rows.filter({ hasText: 'Peter Lane' }).getByRole('button', { name: 'Decline' }).click();
    const d = admin.page.getByRole('dialog');
    await d.locator('#dc-why').fill('Personal advisers join through the firm that employs them.');
    await d.getByRole('button', { name: 'Decline and tell Jana' }).click();
    await expect(admin.page.locator('.toast')).toContainText('Request declined');
    const told = await mailTo(lead.email, decideAt, /Your request for Peter Lane was declined/);
    expect(told.text).toContain('Reason from the room admin: Personal advisers join through the firm that employs them.');
    expect(await mailsTo(declined, since)).toHaveLength(0);
  });

  let link = '';
  await test.step('approve', async () => {
    const decideAt = Date.now() - 1000;
    const req = admin.page.getByRole('region', { name: 'Access requests' });
    await req.locator('.rq', { hasText: 'Thandi Mokoena' }).getByRole('button', { name: 'Approve and invite' }).click();
    await expect(admin.page.locator('.toast')).toContainText('Thandi Mokoena invited to Bidder A');
    await expect(req.locator('.rq')).toHaveCount(0);
    await mailTo(lead.email, decideAt, /Thandi Mokoena is invited to Bidder A/);
    link = linkIn(await mailTo(colleague.email, decideAt, /./), /\/invite\//);
  });

  await test.step('My team', async () => {
    await lead.page.reload();
    await pageHydrated(lead.page);
    await expect(requests.locator('[data-request="Peter Lane"] .badge')).toHaveText('Declined');
    await expect(requests.locator('[data-request="Peter Lane"]')).toContainText('Personal advisers join through the firm that employs them.');
    await expect(lead.page.locator('.content')).toContainText('Thandi Mokoena');
  });

  await test.step('new member joins', async () => {
    await go(colleague, link);
    await expect(colleague.page.locator('#f-fn')).toHaveValue('Thandi');
    await acceptInvitation(colleague, link, { given: 'Thandi', family: 'Mokoena', company: 'Orrinby Capital' });
    await acceptNda(colleague, room);
    await expect(colleague.page).toHaveURL(new RegExp(`/rooms/${ws}/dashboard$`), { timeout: 30_000 });
    await pageHydrated(colleague.page);
    await expect(colleague.page.locator('.user')).toContainText('Bidder A');
    await go(colleague, `/rooms/${ws}/view/${seen.nodeId}`);
    await expect(colleague.page.locator('.doct h1')).toHaveText('Articles of association');
    await expect(colleague.page.locator('#dl-btn')).toHaveCount(0);
    await go(colleague, `/rooms/${ws}/view/${hidden.nodeId}`);
    await expectNotAvailable(colleague.page);
    await go(colleague, `/rooms/${ws}/team`);
    await expect(colleague.page.getByRole('button', { name: 'Request to add a colleague' })).toHaveCount(0);
    await expect(colleague.page.locator('.app')).not.toContainText('Bidder B');
  });

  await test.step('activity log', async () => {
    const actions = (await as<{ items: { action: string }[] }>(adminId, 'GET', `/v1/workspaces/${ws}/events?limit=100`)).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['team_request.created', 'team_request.declined', 'team_request.approved']));
    await go(admin, `/rooms/${ws}/activity`);
    await expect(admin.page.locator('.chain')).toContainText(/Log intact · checked \d\d:\d\d/);
  });
});
