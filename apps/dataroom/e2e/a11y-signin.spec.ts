// SPDX-License-Identifier: AGPL-3.0-only
// Runs against the sign-in server (SIGNIN_PORT) from the chromium project.
import type { Page } from '@playwright/test';
import { expect, pageHydrated, test } from './fixtures';
import { expectNoAxeViolations, expectVisibleFocus, focusedDescription } from './a11y-helpers';
import { asAdmin, invite, nextEmail, ROOM, signInParts, totp } from './signin-helpers';

test.skip(process.env.E2E_PROD === '1', 'Sign-in runs against next dev with the API');
test.describe.configure({ timeout: 180_000 });

const PORT = Number(process.env.PORT ?? '3100');
const SIGNIN = `http://127.0.0.1:${process.env.SIGNIN_PORT ?? String(PORT + 2)}`;

async function axeBoth(page: Page, where: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoAxeViolations(page, `${where} in ${scheme} mode`);
  }
}

async function revoke(email: string) {
  const people = await asAdmin<{ parties: { groups: { members: { membershipId: string; email: string }[] }[] }[] }>('GET', `/v1/workspaces/${ROOM}/people`);
  const m = people.parties.flatMap((p) => p.groups).flatMap((g) => g.members).find((x) => x.email === email);
  if (m) await asAdmin('POST', `/v1/workspaces/${ROOM}/memberships/${m.membershipId}/revoke`, {});
}

async function tabTo(page: Page, target: ReturnType<Page['locator']>) {
  const went: string[] = [];
  for (let i = 0; i < 30; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
    went.push(await focusedDescription(page));
  }
  throw new Error(`Tab did not reach the element. Focus went to: ${[...new Set(went)].join(', ')}`);
}

async function paste(page: Page, selector: string, text: string) {
  await page.locator(selector).evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text', t);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    // Firefox ignores clipboardData passed to the constructor
    if (ev.clipboardData?.getData('text') !== t) Object.defineProperty(ev, 'clipboardData', { value: dt });
    el.dispatchEvent(ev);
  }, text);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('sign in with an email code', async ({ page }) => {
      await page.goto(`${SIGNIN}/sign-in`);
      await expect(page.getByRole('heading', { name: 'Sign in to your data room' })).toBeVisible();
      await expect(page).toHaveTitle('VDRkit Sign in');
      await expectNoAxeViolations(page, 'A1 email step');
      await expect(page.locator('#f-email')).toHaveAttribute('autocomplete', 'email');

      await page.locator('#f-email').fill('not-an-address');
      await page.getByRole('button', { name: 'Email me a link and a code' }).click();
      const err = page.locator('#f-err');
      await expect(err).toBeVisible();
      await expect(page.locator('#f-email')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#f-email')).toHaveAttribute('aria-describedby', 'f-err');
      await expectNoAxeViolations(page, 'A1 email step with an error');

      await page.locator('#f-email').fill('mei@bidder-b.example.com');
      const since = Date.now() - 1000;
      await page.getByRole('button', { name: 'Email me a link and a code' }).click();
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
      await expect(page.locator('.mailbox b')).toHaveText('mei@bidder-b.example.com');
      await expectNoAxeViolations(page, 'A1 code step');
      const boxes = page.getByRole('group', { name: 'Code from the email' }).locator('input');
      await expect(boxes).toHaveCount(6);
      await expect(boxes.first()).toBeFocused();
      await expect(boxes.first()).toHaveAttribute('autocomplete', 'one-time-code');

      const { code } = signInParts(await nextEmail('mei@bidder-b.example.com', since));
      const wrong = code === '000000' ? '111111' : '000000';
      await paste(page, '.code input[data-d="3"]', wrong.replace(/(\d{3})/, '$1 '));
      for (let i = 0; i < 6; i++) await expect(boxes.nth(i)).toHaveValue(wrong[i]!);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(err).toHaveText('This code is not right. Check the email and type the six digits again.');
      await expect(boxes.first()).toHaveAttribute('aria-invalid', 'true');
      await expect(boxes.first()).toHaveAttribute('aria-describedby', 'f-err');
      await expectNoAxeViolations(page, 'A1 code step with a wrong code');

      await paste(page, '.code input[data-d="1"]', ` ${wrong.slice(0, 3)}-${wrong.slice(3)} `);
      for (let i = 0; i < 6; i++) await expect(boxes.nth(i)).toHaveValue(wrong[i]!);
      await paste(page, '.code input[data-d="1"]', `Your sign-in code: ${code}`);
      for (let i = 0; i < 6; i++) await expect(boxes.nth(i)).toHaveValue(code[i]!);

      await boxes.first().fill(code);
      for (let i = 0; i < 6; i++) await expect(boxes.nth(i)).toHaveValue(code[i]!);
    });
  });
}

test('accept invitation, two-factor set-up and NDA by keyboard', async ({ page }) => {
  const { email, link } = await invite('a11y');
  try {
    await page.goto(link.replace(/^https?:\/\/[^/]+/, SIGNIN));
    await expect(page.getByRole('heading', { name: 'Welcome to Project Heron' })).toBeVisible();
    await axeBoth(page, 'A2 Your details');
    await expect(page.locator('.tin[readonly]')).toHaveValue(email);
    await expect(page.locator('#f-fn')).toHaveAttribute('autocomplete', 'given-name');

    await page.locator('#f-fn').fill('Ada');
    await page.locator('#f-ln').fill('Keyboard');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('#f-err')).toBeVisible();
    await expect(page.locator('#f-fn')).toHaveAttribute('aria-describedby', 'f-err');
    await axeBoth(page, 'A2 with an error');
    await page.locator('#f-co').fill('Penravel Partners');
    const since = Date.now() - 1000;
    await tabTo(page, page.getByRole('button', { name: 'Continue' }));
    await expectVisibleFocus(page);
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await axeBoth(page, 'A2 code step');
    const { code } = signInParts(await nextEmail(email, since));
    await paste(page, '.code input[data-d="1"]', code);
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();
    await axeBoth(page, 'two-factor set-up');
    const key = (await page.getByTestId('manual-key').textContent())!.replace(/\s/g, '');
    expect(key).toMatch(/^[A-Z2-7]{16,}$/);
    await paste(page, '.code input[data-d="1"]', totp(key));
    await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();

    await expect(page.getByRole('heading', { name: 'Before you enter Project Heron' })).toBeVisible();
    // full page load; keys before hydration are lost
    await pageHydrated(page);
    await axeBoth(page, 'A3 NDA');
    await tabTo(page, page.locator('.nda'));
    await expectVisibleFocus(page);
    await page.keyboard.press('PageDown');
    await tabTo(page, page.locator('#f-accept'));
    await expectVisibleFocus(page);
    await page.keyboard.press('Space');
    await expect(page.locator('#f-accept')).toBeChecked();
    await tabTo(page, page.getByRole('button', { name: 'Accept and enter the room' }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
    await axeBoth(page, 'the dashboard after the first sign-in');
  } finally {
    await revoke(email);
  }
});

test('expired and unknown links', async ({ page }) => {
  for (const url of ['/sign-in/expired', '/sign-in/link?token=not-a-real-token']) {
    await page.goto(`${SIGNIN}${url}`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle(/^VDRkit \S/);
    await expectNoAxeViolations(page, url);
  }
});
