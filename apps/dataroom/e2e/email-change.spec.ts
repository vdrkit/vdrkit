// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expect, ROOM_ID, roomPath, test } from './fixtures';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';
import { deadLink } from '../src/api/links';
import { API, asAdmin, invite, nextEmail, onboard, type Mail } from './signin-helpers';

test.skip(process.env.E2E_PROD === '1', 'Reads the dev mailbox');

test('link pages tell a dead link from a server error', () => {
  for (const s of [400, 404, 410]) expect(deadLink(s), String(s)).toBe(true);
  for (const s of [429, 500, 502, 503, 504]) expect(deadLink(s), String(s)).toBe(false);
});

const person = (page: Page, email: string) => page.locator(`.mr[data-person="${email}"]`);

function parts(m: Mail): { link: string; code: string } {
  const code = /(\d{3}) ?(\d{3})/.exec(m.subject);
  const link = /https?:\/\/\S+\/email-change\/\S+/.exec(m.text);
  if (!code || !link) throw new Error(`Not an email-change email: ${m.subject}`);
  return { code: `${code[1]}${code[2]}`, link: link[0] };
}

async function typeCode(page: Page, code: string) {
  await page.getByRole('group', { name: 'Code from the email' }).locator('input').first().click();
  await page.keyboard.type(code);
}

async function offboard(email: string) {
  const people = await asAdmin<{ parties: { groups: { members: { membershipId: string; email: string; status: string }[] }[] }[] }>(
    'GET', `/v1/workspaces/${ROOM_ID}/people`);
  const m = people.parties.flatMap((p) => p.groups).flatMap((g) => g.members).find((x) => x.email === email && x.status !== 'revoked');
  if (m) await asAdmin('POST', `/v1/workspaces/${ROOM_ID}/memberships/${m.membershipId}/revoke`);
}

test('room admin and site admin can change a sign-in email', async ({ page, persona }) => {
  test.setTimeout(120_000);
  const { email: oldEmail } = await invite('ec');
  const newEmail = oldEmail.replace('@e2e.example', '@new.e2e.example');
  const third = oldEmail.replace('@e2e.example', '@third.e2e.example');
  let current = oldEmail;
  try {
    await persona('anika');
    await page.goto(roomPath('people'));
    const g = page.locator('.grp[data-group="Bidder A"]');
    if ((await g.locator('.gh .tg').getAttribute('aria-expanded')) !== 'true') await g.locator('.gh .tg').click();
    await person(page, oldEmail).getByRole('button', { name: /Actions for/ }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Change email' }).click();

    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText(`Change the sign-in email of ${oldEmail}`);
    await expect(dlg).toContainText('We send a code to the new address. The change takes effect once');
    await expect(dlg).toContainText(`signs in with ${oldEmail}.`);
    await expect(dlg).toContainText('The old address gets a notice. Logged in Activity, with both addresses.');
    await dlg.locator('#ce-email').fill('thabo@seller.example.com');
    await dlg.getByRole('button', { name: 'Send the code' }).click();
    await expect(dlg).toContainText('This address is already used by another account on this site.');
    const since = Date.now() - 1000;
    await dlg.locator('#ce-email').fill(newEmail);
    await dlg.getByRole('button', { name: 'Send the code' }).click();
    await expect(page.locator('.toast')).toContainText(`Code sent to ${newEmail}`);
    await expect(person(page, oldEmail)).toBeVisible();

    const { link, code } = parts(await nextEmail(newEmail, since));
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Confirm your new sign-in address' })).toBeVisible();
    await expect(page.locator('.mailbox')).toContainText(newEmail);
    await typeCode(page, code);
    await page.getByRole('button', { name: 'Confirm the new address' }).click();
    await expect(page.getByRole('heading', { name: 'Your sign-in address has changed' })).toBeVisible();
    current = newEmail;
    const notice = await nextEmail(oldEmail, since);
    expect(notice.subject).toBe('Your sign-in address has changed');
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();

    await page.goto(roomPath('people'));
    if ((await g.locator('.gh .tg').getAttribute('aria-expanded')) !== 'true') await g.locator('.gh .tg').click();
    await expect(person(page, newEmail)).toBeVisible();
    await page.goto(roomPath('activity'));
    await expect(page.getByText(`${oldEmail} → ${newEmail}`).first()).toBeVisible();

    // site admin, wrong code first
    await page.goto('/site/settings/accounts');
    await page.getByRole('button', { name: 'Everyone' }).click();
    await page.locator('#aq').fill(newEmail);
    const row = page.locator(`[data-account="${newEmail}"]`);
    await row.getByRole('button', { name: /^Change .*email$/ }).click();
    const sd = page.getByRole('dialog');
    await expect(sd).toContainText(`Current email: ${newEmail}`);
    await expect(sd).toContainText('This changes their sign-in everywhere.');
    const since2 = Date.now() - 1000;
    await sd.locator('#ce-email').fill(third);
    await sd.getByRole('button', { name: 'Send the code' }).click();
    await expect(page.locator('.toast')).toContainText(`Code sent to ${third}`);
    const second = parts(await nextEmail(third, since2));
    await page.goto(second.link);
    await typeCode(page, second.code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Confirm the new address' }).click();
    await expect(page.locator('#f-err')).toHaveText('That code is not right. You have 4 more tries.');
    await typeCode(page, second.code);
    await page.getByRole('button', { name: 'Confirm the new address' }).click();
    await expect(page.getByRole('heading', { name: 'Your sign-in address has changed' })).toBeVisible();
    current = third;
    const changed = await asAdmin<{ items: { detail: string }[] }>('GET', `/v1/workspaces/${ROOM_ID}/events?action=person.email_changed&limit=5`);
    expect(changed.items.map((i) => i.detail)).toContain(`${newEmail} → ${third}`);
  } finally {
    await offboard(current);
  }
});

const SIGNIN = `http://127.0.0.1:${process.env.SIGNIN_PORT ?? String(Number(process.env.PORT ?? '3100') + 2)}`;

type People = { parties: { groups: { id: string; name: string; parentGroupId: string | null; members: { personId: string; email: string }[] }[] }[] };
const groupsOf = async () => (await asAdmin<People>('GET', `/v1/workspaces/${ROOM_ID}/people`)).parties.flatMap((p) => p.groups);
const personIdOf = async (email: string) => (await groupsOf()).flatMap((g) => g.members).find((m) => m.email === email)!.personId;

// Anika is a site admin too and never needs agreement
async function plainRoomAdmin(): Promise<{ email: string; personId: string }> {
  const email = `eca-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.example`;
  const group = (await groupsOf()).find((g) => g.name === 'Room admins' && !g.parentGroupId)!;
  const since = Date.now() - 1000;
  await asAdmin('POST', `/v1/workspaces/${ROOM_ID}/invitations`, { groupId: group.id, people: [{ email }], role: 'member' });
  const token = decodeURIComponent(/\/invite\/(\S+)/.exec((await nextEmail(email, since)).text)![1]!);
  const res = await fetch(`${API}/v1/public/invitations/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, givenName: 'Nomsa', familyName: 'Dube', company: 'Quillmont Advisory' }),
  });
  if (!res.ok) throw new Error(`accept: ${res.status} ${await res.text()}`);
  return { email, personId: ((await res.json()) as { personId: string }).personId };
}

function approvalLink(m: Mail): string {
  const link = /https?:\/\/\S+\/email-change\/approve\/\S+/.exec(m.text);
  if (!link) throw new Error(`Not an approval email: ${m.subject}`);
  return link[0];
}

test('asks a signed-in person to agree to the new email', async ({ page, persona, browser }) => {
  test.setTimeout(180_000);
  // a real sign-in binds the login
  const own = await browser.newContext({ baseURL: SIGNIN });
  const { email: oldEmail } = await onboard(await own.newPage(), 'eca');
  await own.close();
  const newEmail = oldEmail.replace('@e2e.example', '@new.e2e.example');
  const admin = await plainRoomAdmin();
  const ask = async () => {
    const since = Date.now() - 1000;
    const res = await fetch(`${API}/v1/workspaces/${ROOM_ID}/people/${await personIdOf(oldEmail)}/email-change`, {
      method: 'POST', headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': admin.personId, 'content-type': 'application/json' },
      body: JSON.stringify({ email: newEmail }),
    });
    expect(await res.json()).toMatchObject({ needsApproval: true, emailStatus: 'accepted' });
    return nextEmail(oldEmail, since);
  };
  try {
    // the dialog's wording, as the plain room admin would see it
    await persona('anika');
    await page.route('**/v1/workspaces/*/people/*/email-change', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const r = await route.fetch();
      await route.fulfill({ response: r, json: { ...(await r.json()), needsApproval: true } });
    });
    await page.goto(roomPath('people'));
    const g = page.locator('.grp[data-group="Bidder A"]');
    if ((await g.locator('.gh .tg').getAttribute('aria-expanded')) !== 'true') await g.locator('.gh .tg').click();
    await person(page, oldEmail).getByRole('button', { name: /Actions for/ }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Change email' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText(`We first email Sanne at ${oldEmail}, and nothing happens unless Sanne agrees there.`);
    await expect(dlg).toContainText('Then we send a code to the new address. The change takes effect once Sanne enters it.');
    await expect(dlg.getByRole('button', { name: 'Ask Sanne to agree' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await page.unrouteAll();

    const first = await ask();
    expect(first.subject).toBe('Change your sign-in address?');
    expect(first.text).toContain(`Nomsa Dube asked to change the address you sign in with from ${oldEmail} to ${newEmail}.`);
    await page.goto(approvalLink(first));
    await expect(page.getByRole('heading', { name: 'Change your sign-in address?' })).toBeVisible();
    await expect(page.locator('.lead')).toHaveText('Nomsa Dube asked to change the address you sign in with. Nothing changes unless you agree.');
    await expect(page.locator('.mailbox')).toContainText(newEmail);
    await page.getByRole('button', { name: `No, keep ${oldEmail}` }).click();
    await expect(page.getByRole('heading', { name: 'Nothing changed' })).toBeVisible();
    await expect(page.locator('.lead')).toContainText(`You still sign in with ${oldEmail}.`);
    await page.goto(approvalLink(first));
    await expect(page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();

    const second = await ask();
    const since = Date.now() - 1000;
    await page.goto(approvalLink(second));
    await page.getByRole('button', { name: 'Yes, change my sign-in address' }).click();
    await expect(page.getByRole('heading', { name: `A code is on its way to ${newEmail}` })).toBeVisible();
    const { link, code } = parts(await nextEmail(newEmail, since));
    await page.goto(link);
    await typeCode(page, code);
    await page.getByRole('button', { name: 'Confirm the new address' }).click();
    await expect(page.getByRole('heading', { name: 'Your sign-in address has changed' })).toBeVisible();
  } finally {
    await offboard(oldEmail);
    await offboard(newEmail);
    await offboard(admin.email);
  }
});
