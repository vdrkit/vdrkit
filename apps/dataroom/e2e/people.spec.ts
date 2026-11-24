// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';
import { expect, PERSONAS, ROOM_ID, roomPath, test, type PersonaKey } from './fixtures';
import { API, asAdmin, nextEmail } from './signin-helpers';
import { dayWithYear, demoDay, demoIso, re, SAST } from './demo-dates';

const until = (day: string) => dayWithYear(`${day}T12:00:00Z`, SAST);

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const made: string[] = [];
const own = (name: string) => { made.push(name); return name; };

async function asPerson<T = unknown>(key: PersonaKey, method: string, path: string, body?: unknown): Promise<T> {
  const id = PERSONAS.find((p) => p.key === key)!.id;
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': id, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// seller side, because other specs count bidder groups
async function ownGroup(name: string, until: string | null = null): Promise<string> {
  const people = await asAdmin<{ parties: { id: string; kind: string }[] }>('GET', `/v1/workspaces/${ROOM_ID}/people`);
  const r = await asAdmin<{ id: string }>('POST', `/v1/workspaces/${ROOM_ID}/groups`, {
    name, partyId: people.parties.find((p) => p.kind === 'seller')!.id, organisation: `${name} Capital`, accessEndsAt: until });
  return r.id;
}

async function revokeInvited(email: string) {
  const people = await asAdmin<{ parties: { groups: { members: { membershipId: string; email: string; status: string }[] }[] }[] }>(
    'GET', `/v1/workspaces/${ROOM_ID}/people`);
  for (const m of people.parties.flatMap((p) => p.groups).flatMap((g) => g.members).filter((x) => x.email === email && x.status !== 'revoked')) {
    await asAdmin('POST', `/v1/workspaces/${ROOM_ID}/memberships/${m.membershipId}/revoke`, {});
  }
}

const sellerTab = (page: Page) => page.getByRole('tablist', { name: 'Whose groups' }).getByRole('tab', { name: /Seller team/ }).click();

const group = (page: Page, name: string) => page.locator(`.grp[data-group="${name}"]`);
const person = (page: Page, email: string) => page.locator(`.mr[data-person="${email}"]`);

async function openGroup(page: Page, name: string) {
  const g = group(page, name);
  if ((await g.locator('.gh .tg').getAttribute('aria-expanded')) !== 'true') await g.locator('.gh .tg').click();
  await expect(g.locator('.mt')).toBeVisible();
}

async function personMenu(page: Page, email: string, item: string | RegExp) {
  await person(page, email).getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
}

test.describe('room admin', () => {
  test.beforeEach(async ({ persona }) => { await persona('anika'); });
  // settle requests a failed run may have left
  test.afterEach(async () => {
    const names = made.splice(0);
    if (!names.length) return;
    const people = await asAdmin<{ parties: { groups: { id: string; name: string; revoked: boolean; parentGroupId: string | null }[] }[] }>('GET', `/v1/workspaces/${ROOM_ID}/people`);
    for (const g of people.parties.flatMap((p) => p.groups).filter((x) => names.includes(x.name) && !x.revoked && !x.parentGroupId)) {
      await asAdmin('POST', `/v1/workspaces/${ROOM_ID}/groups/${g.id}/revoke`, {}).catch(() => undefined);
    }
  });
  test.afterAll(async () => {
    const { items } = await asAdmin<{ items: { id: string; email: string }[] }>('GET', `/v1/workspaces/${ROOM_ID}/team-requests?status=pending`);
    for (const r of items.filter((x) => x.email.endsWith('@e2e.example'))) {
      // another worker may settle it first
      await asAdmin('POST', `/v1/workspaces/${ROOM_ID}/team-requests/${r.id}/decide`, { decision: 'decline' }).catch(() => undefined);
    }
  });

  test('lists groups in tabs', async ({ page }) => {
    await page.goto(roomPath('people'));
    await expect(page.locator('.content h1')).toHaveText('People');
    await expect(page.locator('.content .head .sub')).toHaveText('Who is in the room, in which group, and until when. What each group can see is set in Permissions.');
    await expect(page.getByRole('button', { name: 'Invite people', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New group' })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Whose groups' });
    await expect(tabs.getByRole('tab', { name: /Bidders/ })).toHaveAttribute('aria-selected', 'true');
    await expect(group(page, 'Bidder A').locator('.gn small')).toHaveText('Orrinby Capital');
    await expect(group(page, 'Bidder C financiers').locator('.gn small')).toContainText('subgroup of Bidder C, never more than its rights');
    await openGroup(page, 'Bidder A');
    await expect(person(page, 'jan@bidder-a.example.com')).toContainText('Jan de Vries');
    await expect(person(page, 'jan@bidder-a.example.com').locator('.role')).toHaveText('Lead');
    await expect(person(page, 'pieter@bidder-a.example.com').locator('.role')).toHaveText('Member');
    await expect(group(page, 'Bidder A').getByRole('link', { name: 'What Bidder A can access' })).toHaveAttribute('href', /\/permissions\?group=/);

    await tabs.getByRole('tab', { name: /Seller team/ }).click();
    await expect(group(page, 'Room admins').locator('.gn small')).toHaveText('Quillmont Advisory · See and manage everything');
    await expect(group(page, 'Drosvelt Holdings finance').locator('.gn small')).toContainText('Contributors · add files to 3 Finance');
    await expect(group(page, 'Heron management').locator('.gn small')).toContainText('Observers · read only');
    await expect(group(page, 'Bidder A')).toHaveCount(0);
  });

  test('creates a seller group', async ({ page }) => {
    const name = own(`E2E Team ${unique()}`);
    const lead = `lead-${unique()}@e2e.example`;
    const member = `member-${unique()}@e2e.example`;
    const since = Date.now() - 1000;
    await page.goto(roomPath('people'));
    await page.getByRole('button', { name: 'New group' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('heading', { name: 'New group' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Next: access' })).toBeDisabled();
    await dlg.locator('#ng-name').fill(name);
    await expect(dlg.locator('#ng-parent')).toBeVisible();
    await dlg.getByText('Seller team', { exact: true }).click();
    await expect(dlg.getByText('Seller groups can be given the right to add files and to publish them, folder by folder.')).toBeVisible();
    await dlg.locator('#ng-org').fill('Drosvelt Holdings');
    await dlg.locator('#ng-until').fill(demoDay('2027-03-31'));
    await dlg.getByRole('button', { name: 'Next: access' }).click();
    await expect(dlg.locator('.steps li.on')).toHaveText('2Access');
    await dlg.getByLabel('Level in 3 Finance').selectOption({ label: 'Download PDF' });
    await dlg.getByLabel('Level in 1 Corporate').selectOption({ label: 'View' });
    await dlg.getByRole('button', { name: 'May add files as drafts in 3 Finance' }).click();
    await expect(dlg.getByRole('button', { name: 'May add files as drafts in 3 Finance' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dlg.locator('.dlg-f .grow')).toHaveText('2 of 11 folders visible');
    await dlg.getByRole('button', { name: 'Next: people' }).click();
    await expect(dlg.getByRole('tab', { name: /Leads/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dlg.locator('.auto')).toContainText(`You are invited as a lead for ${name}.`);
    await dlg.locator('#iv-lead').fill(lead);
    await dlg.getByRole('tab', { name: /Team members/ }).click();
    await dlg.locator('#iv-mails').fill(member);
    await expect(dlg.locator('#iv-msg')).toHaveValue(new RegExp(`Your access runs until ${re(until('2027-03-31'))}\\.`));
    await dlg.getByRole('button', { name: 'Create and invite 2' }).click();
    await expect(dlg.getByRole('heading', { name: 'Group created' })).toBeVisible();
    await expect(dlg.locator('.okbox')).toContainText(`${name} is created`);
    await expect(dlg.locator('.okbox')).toContainText('It can see 2 of 11 main folders. 2 invitations are on their way.');
    await expect(dlg.getByRole('link', { name: 'Open in Permissions' })).toHaveAttribute('href', /\/permissions\?group=/);
    await dlg.getByRole('button', { name: 'Close' }).last().click();

    const leadMail = await nextEmail(lead, since);
    expect(leadMail.text).toContain(`You are invited as a lead for ${name}.`);
    const memberMail = await nextEmail(member, since);
    expect(memberMail.text).not.toContain('as a lead');

    await sellerTab(page);
    await expect(group(page, name).locator('.gn small')).toHaveText('Drosvelt Holdings · Contributors · add files to 3 Finance');
    await openGroup(page, name);
    await expect(group(page, name).locator('.until')).toHaveText(`Access until ${until('2027-03-31')}`);
    await expect(person(page, lead).locator('.role')).toHaveText('Lead');
    await expect(person(page, member).locator('.st').first()).toContainText('not signed in');
    await expect(group(page, name).locator('.cnts')).toHaveText('2 people · 2 waiting');
  });

  test('sends a reminder and expires the old link', async ({ page }) => {
    const name = own(`E2E Team ${unique()}`);
    const id = await ownGroup(name);
    const email = `remind-${unique()}@e2e.example`;
    const since = Date.now() - 1000;
    await asAdmin('POST', `/v1/workspaces/${ROOM_ID}/invitations`, { groupId: id, people: [{ email }] });
    const first = await nextEmail(email, since);
    const oldToken = /\/invite\/(\S+)/.exec(first.text)![1]!;
    await page.goto(roomPath('people'));
    await sellerTab(page);
    await openGroup(page, name);
    const later = Date.now();
    await person(page, email).getByRole('button', { name: `Remind ${email}` }).click();
    await expect(page.locator('.toast')).toContainText(`Reminder sent to ${email}`);
    const again = await nextEmail(email, later);
    expect(again.text).not.toContain(oldToken);
    expect((await fetch(`${API}/v1/public/invitations/${oldToken}`)).status).toBe(410);
  });

  test('edits and revokes a group', async ({ page }) => {
    const name = own(`E2E Team ${unique()}`);
    await ownGroup(name, demoIso('2027-01-29T21:59:00Z'));
    await page.goto(roomPath('people'));
    await sellerTab(page);
    await expect(group(page, name).locator('.until')).toHaveText(`Access until ${until('2027-01-29')}`);
    await group(page, name).getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit details and end date' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('heading', { name })).toBeVisible();
    await dlg.locator('#ed-org').fill('Strathveyn Capital');
    await dlg.locator('#ed-until').fill(demoDay('2027-02-26'));
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast')).toContainText(`${name} updated`);
    await expect(group(page, name).locator('.until')).toHaveText(`Access until ${until('2027-02-26')}`);
    await expect(group(page, name).locator('.gn small')).toHaveText('Strathveyn Capital');

    await group(page, name).getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Revoke access' }).click();
    await expect(dlg.getByRole('heading', { name: `Revoke access for ${name}?` })).toBeVisible();
    await dlg.locator('#rv-why').fill('withdrew from the process');
    await dlg.getByRole('button', { name: `Revoke access for ${name}` }).click();
    await expect(group(page, name).locator('.gn small')).toContainText('by Anika Pillay, withdrew from the process');
    await expect(group(page, name)).toHaveClass(/revoked/);
    await group(page, name).getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Invite people again' })).toBeVisible();
  });

  test('edits and revokes a person', async ({ page }) => {
    const name = own(`E2E Team ${unique()}`);
    const id = await ownGroup(name, demoIso('2027-01-29T21:59:00Z'));
    const email = `person-${unique()}@e2e.example`;
    await asAdmin('POST', `/v1/workspaces/${ROOM_ID}/invitations`, { groupId: id, people: [{ email }] });
    await page.goto(roomPath('people'));
    await sellerTab(page);
    await openGroup(page, name);
    await expect(person(page, email)).toContainText('Gives their name when accepting');

    await personMenu(page, email, `Make lead of ${name}`);
    await expect(page.locator('.toast')).toContainText(`is now a lead of ${name}`);
    await expect(person(page, email).locator('.role')).toHaveText('Lead');

    await personMenu(page, email, /Change end date for/);
    const dlg = page.getByRole('dialog');
    await dlg.locator('#me-until').fill(demoDay('2026-12-31'));
    await dlg.getByRole('button', { name: 'Save end date' }).click();
    await expect(page.locator('.toast')).toContainText(`Access until ${until('2026-12-31')}`);

    await personMenu(page, email, 'Edit name, company and role');
    await dlg.locator('#ep-given').fill('Chris');
    await dlg.locator('#ep-family').fill('Adams');
    await dlg.locator('#ep-company').fill('Brivenhall Capital');
    await dlg.getByRole('button', { name: 'Save details' }).click();
    await expect(page.locator('.toast')).toContainText('Chris Adams updated');
    await expect(person(page, email).locator('.pn b')).toHaveText('Chris Adams');

    await personMenu(page, email, 'Revoke access');
    await dlg.getByRole('button', { name: 'Revoke access for Chris' }).click();
    await expect(person(page, email).locator('.st').first()).toContainText('Access revoked');
    const events = await asAdmin<{ items: { action: string }[] }>('GET', `/v1/workspaces/${ROOM_ID}/events?limit=20`);
    expect(events.items.map((e) => e.action)).toEqual(expect.arrayContaining(['membership.revoked', 'person.details_changed', 'membership.expiry_changed', 'membership.role_changed']));
  });

  test('restores revoked access', async ({ page }) => {
    const name = own(`E2E Back ${unique()}`);
    const id = await ownGroup(name, demoIso('2027-01-29T21:59:00Z'));
    const email = `back-${unique()}@e2e.example`;
    const since = Date.now() - 1000;
    await asAdmin('POST', `/v1/workspaces/${ROOM_ID}/invitations`, { groupId: id, people: [{ email }] });
    const token = /\/invite\/([^\s"<>]+)/.exec((await nextEmail(email, since)).text)![1]!;
    const accept = await fetch(`${API}/v1/public/invitations/accept`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: decodeURIComponent(token), givenName: 'Robin', familyName: 'Back', company: 'Brivenhall Capital' }) });
    expect(accept.ok, await accept.text()).toBe(true);

    await page.goto(roomPath('people'));
    await sellerTab(page);
    await openGroup(page, name);
    await personMenu(page, email, 'Revoke access');
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('You can give the access back later with Restore access in this menu.');
    await dlg.getByRole('button', { name: 'Revoke access for Robin' }).click();
    await expect(person(page, email).locator('.st').first()).toContainText('Access revoked');

    const restoredSince = Date.now() - 1000;
    await personMenu(page, email, 'Restore access');
    await expect(dlg.getByRole('heading', { name: 'Restore access for Robin Back?' })).toBeVisible();
    await expect(dlg).toContainText(`Robin Back is back in ${name} as a member, with the same access and end date as before.`);
    await expect(dlg).toContainText('Robin gets an email that their access is back, with a sign-in button.');
    await dlg.getByRole('button', { name: 'Restore access for Robin' }).click();
    await expect(page.locator('.toast')).toContainText('Access restored for Robin Back');
    await expect(page.locator('.toast')).toContainText(`Robin is back in ${name}. Robin got an email with a sign-in button.`);
    await expect(person(page, email).locator('.st').first()).toHaveText('Active');

    const mail = await nextEmail(email, restoredSince);
    expect(mail.subject).toBe('Your access to Project Heron is back');
    expect(mail.html).toContain('>Sign in</a>');
    const events = await asAdmin<{ items: { action: string; data: Record<string, unknown> }[] }>('GET', `/v1/workspaces/${ROOM_ID}/events?limit=20`);
    expect(events.items.map((e) => e.action)).toContain('membership.restored');
    expect(events.items.some((e) => e.action === 'notification.sent' && e.data.mail_type === 'access_restored')).toBe(true);
  });

  test('approves and declines colleague requests', async ({ page }) => {
    const u = unique();
    const yes = `yes-${u}@e2e.example`;
    const no = `no-${u}@e2e.example`;
    const since = Date.now() - 1000;
    const ask = (email: string, familyName: string) => asPerson('jan', 'POST', `/v1/workspaces/${ROOM_ID}/team-requests`,
      { givenName: 'Peter', familyName, email, company: 'Thornquist Legal', jobTitle: 'Tax adviser', reason: 'Tax due diligence, mainly 3.4 Tax.' });
    await ask(yes, `Moss${u}`);
    await ask(no, `Lane${u}`);
    await page.goto(roomPath('people'));
    const req = page.getByRole('region', { name: 'Access requests' });
    const yesRow = req.locator('.rq', { hasText: `Peter Moss${u}` });
    await expect(yesRow).toContainText('for Bidder A, requested by Jan de Vries');
    await expect(yesRow).toContainText('Tax adviser, Thornquist Legal');
    await expect(yesRow).toContainText('Tax due diligence, mainly 3.4 Tax.');
    await yesRow.getByRole('button', { name: 'Approve and invite' }).click();
    await expect(page.locator('.toast')).toContainText(`Peter Moss${u} invited to Bidder A`);
    // other specs count Bidder A's members
    await revokeInvited(yes);
    expect((await nextEmail(yes, since)).text).toContain('/invite/');

    await req.locator('.rq', { hasText: `Peter Lane${u}` }).getByRole('button', { name: 'Decline' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByRole('heading', { name: `Decline the request for Peter Lane${u}?` })).toBeVisible();
    await dlg.locator('#dc-why').fill('The tax adviser can join once 3.4 Tax is open to bidders.');
    await dlg.getByRole('button', { name: 'Decline and tell Jan' }).click();
    await expect(page.locator('.toast')).toContainText('Request declined');
    await expect(page.locator('.rq', { hasText: `Peter Lane${u}` })).toHaveCount(0);
    const mails = (await asAdmin<{ messages: { subject: string; text: string; sentAt: string }[] }>('GET', '/v1/dev/mailbox?to=jan%40bidder-a.example.com'))
      .messages.filter((m) => new Date(m.sentAt).getTime() >= since);
    expect(mails.map((m) => m.subject)).toEqual(expect.arrayContaining([`Peter Moss${u} is invited to Bidder A`, `Your request for Peter Lane${u} was declined`]));
    expect(mails.find((m) => m.subject.includes('declined'))!.text).toContain('Reason from the room admin: The tax adviser can join once 3.4 Tax is open to bidders.');
    const declined = (await asAdmin<{ messages: unknown[] }>('GET', `/v1/dev/mailbox?to=${encodeURIComponent(no)}`)).messages;
    expect(declined).toHaveLength(0);
  });

  test('caps a new subgroup by its parent group', async ({ page }) => {
    await page.goto(roomPath('people'));
    await group(page, 'Bidder C').getByRole('button', { name: 'Actions for Bidder C', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add subgroup' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.locator('#ng-parent')).toHaveValue(/.+/);
    await dlg.locator('#ng-name').fill('Bidder C advisers');
    await dlg.getByRole('button', { name: 'Next: access' }).click();
    await expect(dlg.locator('.capbox')).toContainText('Capped by Bidder C.');
    await expect(dlg.getByLabel('Level in 8 Insurance')).toBeDisabled();
    const levels = await dlg.getByLabel('Level in 1 Corporate').locator('option').allTextContents();
    expect(levels).toEqual(['No access', 'View']);
    await dlg.getByRole('button', { name: 'Close' }).click();
  });

  test('subgroups have no leads', async ({ page }) => {
    await page.goto(roomPath('people'));
    await openGroup(page, 'Bidder C financiers');
    const lars = group(page, 'Bidder C financiers').locator('.mr').filter({ hasText: 'Lars Eriksen' });
    await expect(lars.locator('.role')).toHaveText('Member');
    await lars.getByRole('button', { name: /Actions for/ }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem').first()).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Make lead|Make member/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await group(page, 'Bidder C financiers').getByRole('button', { name: 'Actions for Bidder C financiers', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Invite people' }).click();
    const dlg = page.getByRole('dialog', { name: 'Invite people' });
    await expect(dlg.getByRole('tab', { name: /Leads/ })).toHaveCount(0);
    await expect(dlg).toContainText('Only main groups have leads. People in a subgroup are members.');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  async function inviteToFinanciers(page: Page) {
    await page.goto(roomPath('people'));
    await openGroup(page, 'Bidder C financiers');
    await group(page, 'Bidder C financiers').getByRole('button', { name: 'Actions for Bidder C financiers', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Invite people' }).click();
    const dlg = page.getByRole('dialog', { name: 'Invite people' });
    await dlg.locator('#iv-mails').fill(`cut-${unique()}@example.com`);
    return dlg;
  }

  test('a lost connection while inviting leaves the dialog usable', async ({ page }) => {
    const dlg = await inviteToFinanciers(page);
    await page.route('**/v1/workspaces/*/invitations', (r) => r.abort('internetdisconnected'));
    await dlg.getByRole('button', { name: 'Send 1 invitation' }).click();
    await expect(dlg).toContainText('The server could not be reached. Check your connection and try again.');
    await expect(dlg.getByRole('button', { name: 'Send 1 invitation' })).toBeEnabled();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
  });

  test('an expired session sends the browser to sign-in', async ({ page }) => {
    const dlg = await inviteToFinanciers(page);
    await page.route('**/v1/workspaces/*/invitations', (r) => r.fulfill({
      status: 401, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Sign in again', status: 401 }),
    }));
    await dlg.getByRole('button', { name: 'Send 1 invitation' }).click();
    await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(roomPath('people')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(roomPath('people'));
    await openGroup(page, 'Bidder A');
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.view);
    await page.getByRole('button', { name: 'New group' }).click();
    const box = await page.getByRole('dialog').boundingBox();
    expect(box?.width).toBe(390);
  });
});

test.describe('who sees People', () => {
  for (const key of ['maria', 'johan', 'jan', 'pieter', 'lars', 'liesl'] as const) {
    test(`${key} gets not available`, async ({ page, persona }) => {
      await persona(key);
      await page.goto(roomPath('people'));
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
      await expect(page.getByText('Project Heron').first()).toBeVisible();
      await page.goto(roomPath('dashboard'));
      await expect(page.getByRole('navigation', { name: 'Room sections' }).getByRole('link', { name: 'People' })).toHaveCount(0);
    });
  }

  test('API is room-admin only', async () => {
    for (const key of ['jan', 'maria', 'liesl'] as const) {
      const id = PERSONAS.find((p) => p.key === key)!.id;
      const res = await fetch(`${API}/v1/workspaces/${ROOM_ID}/people`, { headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': id } });
      expect(res.status).toBe(403);
      const make = await fetch(`${API}/v1/workspaces/${ROOM_ID}/groups`, { method: 'POST', headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': id, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Mine', newParty: { name: 'Mine', kind: 'bidder' } }) });
      expect(make.status).toBe(403);
    }
  });
});
