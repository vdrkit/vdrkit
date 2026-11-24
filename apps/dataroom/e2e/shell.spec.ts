// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test.skip(process.env.E2E_PROD === '1', 'The shell demos are served by next dev only');

const SCREENS = fileURLToPath(new URL('../test-results/screens', import.meta.url));
mkdirSync(SCREENS, { recursive: true });

const SIZES = [
  { name: '1280', width: 1280, height: 860 },
  { name: '390', width: 390, height: 844 },
] as const;

const BG = { light: 'rgb(244, 247, 250)', dark: 'rgb(15, 21, 28)' };

async function settle(page: Page, route: string) {
  await page.evaluate(() => document.fonts.ready);
  if (route === '/demo/shell') await expect(page.locator('.clock b').first()).toHaveText(/\d\d:\d\d/);
}

for (const route of ['/demo/shell', '/demo/shell-outside']) {
  for (const size of SIZES) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`screenshot ${route} at ${size.name} in ${scheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(route);
        await settle(page, route);
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BG[scheme]);
        const file = `${route === '/demo/shell' ? 'shell' : 'shell-outside'}-${size.name}-${scheme}.png`;
        await page.screenshot({ path: resolve(SCREENS, file), fullPage: true });
      });
    }
  }
}

test('wide screens keep the room menu in place and show the clock', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/demo/shell');
  await expect(page.locator('.mm-btn')).toBeHidden();
  await expect(page.locator('.side')).toBeInViewport();
  await expect(page.locator('.clock')).toBeVisible();
  expect((await page.locator('.side').boundingBox())?.width).toBe(272);
  await expect(page.locator('.user .avatar')).toHaveText('AP');
  await expect(page.locator('.nav a.on')).toContainText('Documents');
  await expect(page.locator('.stree .sf.on')).toContainText('Material contracts');
});

test('outside a room the menu is 248px wide and has no search or clock', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/demo/shell-outside');
  expect((await page.locator('.side').boundingBox())?.width).toBe(248);
  await expect(page.locator('.search')).toHaveCount(0);
  await expect(page.locator('.clock')).toHaveCount(0);
  await expect(page.locator('.nav .sec')).toHaveText('Instance');
});

test('below 900px the menu is a drawer', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 900 });
  await page.goto('/demo/shell');
  const btn = page.locator('.mm-btn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', 'Open the room menu');
  await expect(page.locator('.side')).not.toBeInViewport();

  await btn.click();
  await expect(page.locator('.app')).toHaveClass(/mm-open/);
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(btn).toHaveAttribute('aria-label', 'Close the room menu');
  await expect(page.locator('.side')).toBeInViewport();
  await expect(page.locator('.side .nav a').first()).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('.app')).not.toHaveClass(/mm-open/);
  await expect(btn).toBeFocused();

  await btn.click();
  await page.locator('.mm-scrim').click({ position: { x: 800, y: 400 } });
  await expect(page.locator('.app')).not.toHaveClass(/mm-open/);
});

test('below 560px the clock is hidden', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo/shell');
  await expect(page.locator('.mm-btn')).toBeVisible();
  await expect(page.locator('.clock')).toBeHidden();
});

test('theme menu: Light, Dark and Match my computer', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/demo/shell');
  const btn = page.locator('#theme-btn');
  const attr = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const stored = () => page.evaluate(() => localStorage.getItem('vdrkit-theme'));

  const icon = async () => {
    const shown = await btn.locator('.ti').evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0 || e.querySelector('svg')!.getClientRects().length > 0).map((e) => e.className));
    expect(shown).toHaveLength(1);
    return shown[0];
  };

  await expect(btn).toHaveAttribute('aria-label', 'Theme: Match my computer');
  await expect(btn).toHaveAttribute('aria-haspopup', 'menu');
  expect(await attr()).toBeNull();
  expect(await icon()).toContain('ti-sys');

  await btn.click();
  const menu = page.getByRole('menu', { name: 'Theme' });
  await expect(menu.getByRole('menuitemradio')).toHaveText(['Light', 'Dark', 'Match my computer']);
  await expect(menu.getByRole('menuitemradio', { name: 'Match my computer' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: 'Match my computer' })).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await menu.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(menu).toHaveCount(0);
  await expect(btn).toBeFocused();
  expect(await attr()).toBe('dark');
  expect(await stored()).toBe('dark');
  await expect(btn).toHaveAttribute('aria-label', 'Theme: Dark');
  expect(await icon()).toContain('ti-moon');

  await page.reload();
  expect(await attr()).toBe('dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BG.dark);
  await expect(btn).toHaveAttribute('aria-label', 'Theme: Dark');

  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitemradio', { name: 'Light' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await attr()).toBe('light');
  expect(await stored()).toBe('light');
  await expect(btn).toHaveAttribute('aria-label', 'Theme: Light');
  expect(await icon()).toContain('ti-sun');

  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(btn).toBeFocused();
  expect(await attr()).toBe('light');

  await btn.click();
  await menu.getByRole('menuitemradio', { name: 'Match my computer' }).click();
  expect(await attr()).toBeNull();
  expect(await stored()).toBeNull();
  await expect(btn).toHaveAttribute('aria-label', 'Theme: Match my computer');
});

test('applies a stored theme without a flash', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('vdrkit-theme', 'dark');
    document.addEventListener('DOMContentLoaded', () => {
      (window as unknown as { themeAtParse: string | null }).themeAtParse = document.documentElement.getAttribute('data-theme');
    });
  });
  await page.goto('/demo/shell');
  expect(await page.evaluate(() => (window as unknown as { themeAtParse: string | null }).themeAtParse)).toBe('dark');
});

test('theme survives hydration and client navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem('vdrkit-theme', 'dark'));
  await page.goto('/demo/shell');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => (window as unknown as { next: { router: { push(h: string): void } } }).next.router.push('/demo/shell-outside'));
  await expect(page).toHaveURL(/\/demo\/shell-outside$/);
  await page.evaluate(() => (window as unknown as { next: { router: { push(h: string): void } } }).next.router.push('/demo/no-such-page'));
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(errors.filter((e) => e.includes('Encountered a script tag'))).toEqual([]);
});

test.describe('own clock', () => {
  test.use({ timezoneId: 'Europe/London' });
  test("shows the person's own time when it differs from the room", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto('/demo/shell');
    await expect(page.locator('.clock small')).toHaveText(['Room', 'You']);
    await expect(page.locator('.clock .room-t b')).toHaveText(/^\d\d:\d\d SAST$/);
    await expect(page.locator('.clock > div').nth(1).locator('b')).toHaveText(/^\d\d:\d\d (GMT|BST)$/);
  });
});

test.describe('same clock', () => {
  test.use({ timezoneId: 'Africa/Johannesburg' });
  test("shows only Room time in the room's zone", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto('/demo/shell');
    await expect(page.locator('.clock small')).toHaveText(['Room time']);
    await expect(page.locator('.clock')).toHaveAttribute('title', "The room's time zone is SAST (UTC+2), which is also yours.");
  });
});

test('quick search lists matching names and offers a full search', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/demo/shell');
  await expect(page.locator('.clock b').first()).toHaveText(/\d\d:\d\d/);
  await page.keyboard.press('Control+k');
  await expect(page.locator('.qs-in')).toBeFocused();
  await page.keyboard.type('tarnley');
  await expect(page.locator('.qs-pop .qs-opt:not(.qs-all)')).toHaveCount(1);
  await expect(page.locator('.qs-pop .qs-opt mark')).toHaveText('Tarnley');
  await expect(page.locator('.qs-all')).toContainText('Search inside all documents for “tarnley”');
  await page.keyboard.press('Escape');
  await expect(page.locator('.qs-pop')).toBeHidden();
});

test('the folder index folds open and closed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/demo/shell');
  const legal = page.locator('.stree .sf:not(.l1)', { hasText: 'Legal' });
  await expect(page.locator('.stree .sf.l1', { hasText: 'Litigation' })).toBeVisible();
  await legal.click(); // selects it, stays open
  await legal.click(); // already selected: folds
  await expect(page.locator('.stree .sf.l1', { hasText: 'Litigation' })).toHaveCount(0);
  await expect(legal).toHaveAttribute('aria-expanded', 'false');
});

test('the account menu opens and closes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/demo/shell');
  const btn = page.getByRole('button', { name: 'Account menu: profile, notification settings, about, sign out' });
  await btn.click();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});
