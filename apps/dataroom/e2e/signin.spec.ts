// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, pageHydrated, test } from './fixtures';
import { as, bidderGroup, folderByNumber, grant, inviteLink, join, newRoomCreator, publish, roomFor, unique, uploadPdf } from './flow-helpers';
import { asAdmin, DASHBOARD, freshTotp, nextEmail, onboard, ROOM, signInParts, signInWithCode, typeCode } from './signin-helpers';

async function signOut(page: Page) {
  const item = page.getByRole('menuitem', { name: /Sign out/ });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole('button', { name: 'Account menu: profile, notification settings, about, sign out' }).click();
    await expect(item).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await item.click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

test.describe.configure({ timeout: 150_000 });

test('first sign-in: invitation, two-factor set-up, NDA, then the room', async ({ page }) => {
  await onboard(page, 'first');
  await expect(page.locator('.user')).toContainText('Sanne Visser');
  await expect(page.locator('.proto')).toHaveCount(0);
  expect((await page.context().cookies()).some((c) => c.name === 'vdrkit.session_token')).toBe(true);
});

test('returning sign-in trusts the browser after one authenticator code', async ({ page }) => {
  const who = await onboard(page, 'returning');
  await signOut(page);

  await signInWithCode(page, who.email);
  await expect(page.getByRole('heading', { name: 'Enter the code from your authenticator app' })).toBeVisible();
  await expect(page.locator('.chk')).toContainText('Trust this browser for 30 days');
  await expect(page.locator('#f-trust')).toBeChecked();
  await expect(page.locator('.note.info')).toContainText('Ask the room admin to reset your two-factor sign-in');

  const right = await freshTotp(who.secret, who.used);
  await typeCode(page, right === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.hint.err')).toContainText('This code is not right');
  await typeCode(page, right);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(DASHBOARD, { timeout: 30_000 });

  await signOut(page);
  await signInWithCode(page, who.email);
  await expect(page).toHaveURL(DASHBOARD, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Enter the code from your authenticator app' })).toHaveCount(0);
});

test('refuses a wrong code without revealing which addresses exist', async ({ page }) => {
  await page.goto('/sign-in');
  await page.locator('#f-email').fill('nobody-here@seller.example.com');
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.locator('.card .lead')).toHaveText('If this address has access to a data room, the email arrives within a minute.');

  await page.getByRole('button', { name: 'Use a different email address' }).click();
  await page.locator('#f-email').fill('mei@bidder-b.example.com');
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  const { code } = signInParts(await nextEmail('mei@bidder-b.example.com', since));
  await typeCode(page, code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.hint.err')).toHaveText('This code is not right. Check the email and type the six digits again.');
  await expect(page.locator('.code.bad')).toHaveCount(1);
  await typeCode(page, '12');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.hint.err')).toHaveText('Type all six digits from the email.');
});

test('shows an error when the email cannot be sent', async ({ page }) => {
  // mocked
  await page.route('**/v1/auth/sign-in/magic-link', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ code: 'EMAIL_NOT_SENT', message: 'We could not send the email right now. Try again in a few minutes.' }),
  }));
  await page.goto('/sign-in');
  await page.locator('#f-email').fill('nobody-here@seller.example.com');
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  await expect(page.locator('.hint.err')).toHaveText('We could not send the email right now. Try again in a few minutes.');
  await expect(page.getByRole('heading', { name: 'Sign in to your data room' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
});

test('sign-in links work only once', async ({ page, browser }) => {
  const email = 'sipho@bidder-c.example.com';
  await page.goto('/sign-in');
  await page.locator('#f-email').fill(email);
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  const { link } = signInParts(await nextEmail(email, since));

  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();

  const other = await browser.newContext();
  const again = await other.newPage();
  await again.goto(link);
  await expect(again.getByRole('heading', { name: 'This sign-in link has expired' })).toBeVisible();
  await expect(again.getByRole('link', { name: 'Get a new sign-in email' })).toHaveAttribute('href', '/sign-in');
  await again.goto('/sign-in/link?token=madeUpTokenThatNeverExisted');
  await expect(again.getByRole('heading', { name: 'This sign-in link has expired' })).toBeVisible();
  await other.close();
});

test('Enter twice on the email code checks it once', async ({ page }) => {
  await page.goto('/sign-in');
  await pageHydrated(page);
  await page.locator('#f-email').fill('nobody-twice@seller.example.com');
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  let posts = 0;
  await page.route('**/v1/auth/sign-in/email-otp', async (r) => {
    posts++;
    await new Promise((done) => setTimeout(done, 500));
    return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'INVALID_OTP', message: 'Invalid OTP' }) });
  });
  await typeCode(page, '123456');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.locator('.hint.err')).toHaveText('This code is not right. Check the email and type the six digits again.');
  expect(posts).toBe(1);
});

test('signs out after idle time, with a warning first', async ({ page }) => {
  const u = unique();
  const room = `Project Wren ${u}`;
  const adminId = await newRoomCreator('Rosa Pretorius', `rosa-${u}@e2e.example`);
  const ws = await roomFor(adminId, room);
  await as(adminId, 'PATCH', `/v1/workspaces/${ws}/settings`, { idleSignOutMinutes: 30 });
  const group = await bidderGroup(adminId, ws, 'Bidder A', 'Orrinby Capital');
  const who = { name: 'Sanne Visser', email: `idle-${u}@e2e.example`, page, context: page.context() };
  await join(who, await inviteLink(adminId, ws, group, who.email), { given: 'Sanne', family: 'Visser', company: 'Orrinby Capital' }, room, ws, false);

  await page.clock.install();
  await page.goto(`/rooms/${ws}/search`);
  await expect(page.locator('.side .room')).toContainText(room);
  await page.waitForTimeout(500);

  await page.clock.fastForward('28:05');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Are you still there?' })).toBeVisible();
  await expect(dialog).toContainText(`You have not used ${room} for almost 30 minutes`);
  await expect(dialog.locator('#still')).toHaveText(/^1:\d\d$/);
  await dialog.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/rooms/${ws}/search$`));
  await expect(page.locator('.toast')).toContainText('The 30 minutes start again from now.');

  await page.clock.fastForward('28:05');
  await expect(page.getByRole('heading', { name: 'Are you still there?' })).toBeVisible();
  await page.clock.fastForward('02:05');
  await expect(page).toHaveURL(/\/signed-out\?/);
  await expect(page.getByRole('heading', { name: 'You have been signed out' })).toBeVisible();
  await expect(page.locator('.card .lead')).toContainText(`${room} signs people out after 30 minutes without activity.`);
  await page.goto(`/rooms/${ws}/dashboard`);
  await expect(page).toHaveURL(/\/sign-in\?next=/);
});

test('viewer signs out after idle time; reading counts as activity', async ({ page }) => {
  const u = unique();
  const room = `Project Ibis ${u}`;
  const adminId = await newRoomCreator('Rosa Pretorius', `rosa-${u}@e2e.example`);
  const ws = await roomFor(adminId, room);
  await as(adminId, 'PATCH', `/v1/workspaces/${ws}/settings`, { idleSignOutMinutes: 30 });
  const folder = await folderByNumber(adminId, ws, '3.2');
  const doc = await uploadPdf(adminId, ws, folder.id, 'Audited financial statements FY2025.pdf', `AFS ${u}`);
  await publish(adminId, ws, [doc.nodeId]);
  const group = await bidderGroup(adminId, ws, 'Bidder A', 'Orrinby Capital');
  await grant(adminId, ws, group, [{ nodeId: folder.id, level: 20 }]);
  const who = { name: 'Sanne Visser', email: `idle-view-${u}@e2e.example`, page, context: page.context() };
  await join(who, await inviteLink(adminId, ws, group, who.email), { given: 'Sanne', family: 'Visser', company: 'Orrinby Capital' }, room, ws, false);

  await page.clock.install();
  await page.goto(`/rooms/${ws}/view/${doc.nodeId}`);
  await expect(page.locator('#p1 img')).toBeVisible({ timeout: 30_000 });
  // the guard counts nothing until it has the room's limit
  await expect.poll(() => page.locator('#canvas').evaluate(async (c) => {
    const was = localStorage.getItem('vdrkit-last-activity');
    await new Promise<void>((done) => {
      c.addEventListener('scroll', () => done(), { once: true });
      c.scrollTop = c.scrollTop === 0 ? 100 : 0;
    });
    return localStorage.getItem('vdrkit-last-activity') !== was;
  }), { timeout: 30_000 }).toBe(true);

  await page.clock.fastForward('20:00');
  // a scroll in the pages, not on the window; wait for the event before the clock moves on
  await page.locator('#canvas').evaluate((c) => new Promise<void>((done) => {
    c.addEventListener('scroll', () => done(), { once: true });
    c.scrollTop = 200;
  }));
  await page.clock.fastForward('20:00');
  await expect(page.getByRole('heading', { name: 'Are you still there?' })).toHaveCount(0);
  await page.clock.fastForward('08:05');
  await expect(page.getByRole('heading', { name: 'Are you still there?' })).toBeVisible();
  await page.clock.fastForward('02:05');
  await expect(page).toHaveURL(/\/signed-out\?/);
  await expect(page.locator('.card .lead')).toContainText(`${room} signs people out after 30 minutes without activity.`);
});

test('Being updated page returns once the API answers', async ({ page }) => {
  await page.goto('/updating?next=%2Fdemo%2Fshell');
  await expect(page.getByRole('heading', { name: 'VDRkit is being updated' })).toBeVisible();
  await expect(page.locator('#chk')).toContainText('This page checks again in');
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page).toHaveURL(/\/demo\/shell$/);
});

test('not available page for members, others and visitors', async ({ page, browser }) => {
  await onboard(page, 'notfound');

  const res = await page.goto(`/rooms/${ROOM}/view/${randomUUID()}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Project Heron' })).toHaveAttribute('href', `/rooms/${ROOM}/dashboard`);
  await expect(page.getByRole('link', { name: 'Search Project Heron' })).toBeVisible();

  await page.goto(`/rooms/${randomUUID()}/dashboard`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to my rooms' })).toBeVisible();
  await expect(page.locator('.card')).not.toContainText('Project Heron');

  for (const path of [`/rooms/not-a-uuid/dashboard`, `/rooms/${ROOM}/view/not-a-uuid`, `/rooms/${ROOM}/documents/not-a-uuid`]) {
    const r = await page.goto(path);
    expect(r?.status(), path).toBe(404);
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  }

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/rooms/${ROOM}/view/${randomUUID()}`);
  await expect(visitor).toHaveURL(/\/sign-in\?next=%2Frooms%2F/);
  await expect(visitor.getByRole('heading', { name: 'Sign in to your data room' })).toBeVisible();
  await visitor.context().close();
});

test('not available page hides the room name after revocation', async ({ page }) => {
  const { email } = await onboard(page, 'outsider');
  const people = await asAdmin<{ parties: { groups: { members: { membershipId: string; email: string }[] }[] }[] }>('GET', `/v1/workspaces/${ROOM}/people`);
  const m = people.parties.flatMap((p) => p.groups).flatMap((g) => g.members).find((x) => x.email === email);
  if (!m) throw new Error('No membership');
  await asAdmin('POST', `/v1/workspaces/${ROOM}/memberships/${m.membershipId}/revoke`, {});

  for (const path of [`/rooms/${ROOM}/dashboard`, `/rooms/${ROOM}/view/${randomUUID()}`]) {
    await page.goto(path);
    if (/\/sign-in/.test(page.url())) break;
    await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    await expect(page.locator('.card')).not.toContainText('Project Heron');
    await expect(page.getByRole('link', { name: /Go to Project Heron|Search Project Heron/ })).toHaveCount(0);
  }
});

test('never follows an outside link in ?next', async ({ page }) => {
  await page.goto('/updating?next=%2F%09%2Fexample.com');
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/(sign-in.*)?$/);
});
