// SPDX-License-Identifier: AGPL-3.0-only
import type { Locator, Page } from '@playwright/test';
import {
  applyTextSpacing, clippedText, expectNoAxeViolations, expectVisibleFocus, focusedDescription, horizontalOverflow, targetsTooSmall,
} from './a11y-helpers';
import { expect, NODE, roomPath, test, type PersonaKey } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'The screens run against next dev with the API');
test.describe.configure({ timeout: 300_000 });

const DOC_242 = '27087787-3869-4ad1-bf60-086b3e78fc98';

async function open(page: Page, url: string) {
  // a pending client-side navigation can abort the first try
  await page.goto(url).catch(async (e: Error) => { if (!/ERR_ABORTED|interrupted/.test(e.message)) throw e; await page.goto(url); });
  await page.waitForLoadState('networkidle');
  if (await page.locator('.top .qs-in').count()) await expect(page.locator('.top .qs-in[data-ready]')).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}

const focusKey = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  const path: string[] = [];
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) path.unshift(`${n.tagName}:${[...(n.parentElement?.children ?? [])].indexOf(n)}`);
  return path.join('/');
});

const isLastStop = (page: Page) => page.evaluate(() => {
  const at = document.activeElement;
  if (!at) return true;
  const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return ![...document.querySelectorAll<HTMLElement>(sel)].some((el) => (at.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    && !at.contains(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[inert]'));
});

// Tabs through the page and returns the number of stops.
async function tabWalk(page: Page, where: string, max = 400): Promise<number> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const key = await focusKey(page);
    if (key === 'body' || seen[0] === key) return seen.length;
    // Firefox keeps focus on the last stop when Tab leaves the page
    if (seen.at(-1) === key && await isLastStop(page)) return seen.length;
    expect(seen.at(-1), `${where}: focus stuck on ${await focusedDescription(page)} (2.1.2)`).not.toBe(key);
    if (seen.includes(key)) return seen.length;
    seen.push(key);
    const hidden = await page.evaluate(() => { const r = document.activeElement!.getBoundingClientRect(); return r.right <= 0 || r.left >= innerWidth; });
    expect(hidden, `${where}: focus went to ${await focusedDescription(page)}, which is off screen`).toBe(false);
    await expectVisibleFocus(page);
  }
  throw new Error(`${where}: more than ${max} tab stops; the walk did not come round`);
}

test.describe('keyboard', () => {
  const screens: [PersonaKey, string][] = [
    ['anika', roomPath('dashboard')], ['anika', roomPath('documents', NODE['2.4'])], ['anika', roomPath('people')], ['anika', roomPath('permissions')],
    ['anika', `${roomPath('settings')}?tab=general`], ['anika', roomPath('timeline')], ['anika', roomPath('activity')], ['anika', roomPath('release')],
    ['anika', roomPath('details', DOC_242)], ['anika', roomPath('import')], ['anika', `${roomPath('search')}?q=supply`], ['anika', '/rooms/new'],
    ['jan', roomPath('dashboard')], ['jan', roomPath('team')], ['jan', roomPath('view', DOC_242)], ['jan', `${roomPath('profile')}?tab=notifications`],
    ['thabo', '/site/settings'], ['thabo', '/site/settings/accounts'], ['jan', '/rooms'],
  ];
  for (const [who, url] of screens) {
    test(`${who} ${url.replace(/\/rooms\/[0-9a-f-]{36}/, '')}`, async ({ page, persona }) => {
      await persona(who);
      await open(page, url);
      const stops = await tabWalk(page, url);
      expect(stops).toBeGreaterThan(3);
    });
  }

  test('first Tab reaches the skip link', async ({ page, persona, browserName }) => {
    await persona('anika');
    await open(page, roomPath('documents', NODE['2.4']));
    // WebKit skips links on Tab
    if (browserName === 'webkit') await page.getByRole('link', { name: 'Skip to the page' }).focus();
    else await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the page' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#content'))).toBe(true);
  });

  test('phone room menu traps focus only while open', async ({ page, persona }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await persona('anika');
    await open(page, roomPath('documents', NODE['2.4']));
    await tabWalk(page, 'C2 at 390 px');
    const btn = page.locator('.mm-btn');
    await btn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.app')).toHaveClass(/mm-open/);
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.side')), `Tab left the open room menu for ${await focusedDescription(page)}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.app')).not.toHaveClass(/mm-open/);
    await expect(btn).toBeFocused();
  });

  test('pages outside a room', async ({ page }) => {
    for (const url of ['/sign-in', '/signed-out', '/no-such-page']) {
      await open(page, url);
      await tabWalk(page, url);
    }
  });
});

interface Opener { name: string; who: PersonaKey; url: string; opener: (p: Page) => Locator; surface: (p: Page) => Locator; before?: (p: Page) => Promise<void> }

const DIALOGS: Opener[] = [
  { name: 'Add files', who: 'anika', url: roomPath('documents', NODE['2.4']), opener: (p) => p.getByRole('button', { name: 'Choose files' }), surface: (p) => p.getByRole('dialog') },
  { name: 'Invite people', who: 'anika', url: roomPath('people'), opener: (p) => p.getByRole('button', { name: 'Invite people', exact: true }), surface: (p) => p.getByRole('dialog') },
  { name: 'New group', who: 'anika', url: roomPath('people'), opener: (p) => p.getByRole('button', { name: 'New group' }).first(), surface: (p) => p.getByRole('dialog') },
  { name: 'Publish a new NDA version', who: 'anika', url: `${roomPath('settings')}?tab=nda`, opener: (p) => p.getByRole('button', { name: 'Publish a new version' }), surface: (p) => p.getByRole('dialog') },
  { name: 'Add a phase', who: 'anika', url: roomPath('timeline'), opener: (p) => p.getByRole('button', { name: 'Add a phase' }), surface: (p) => p.getByRole('dialog') },
  {
    name: 'Publish drafts', who: 'anika', url: roomPath('release'),
    // Firefox shows no focus ring after a mouse click
    before: async (p) => { const cb = p.locator('.rr input.cb:not(:disabled)').first(); await cb.focus(); await p.keyboard.press('Space'); await expect(cb).toBeChecked(); },
    opener: (p) => p.getByRole('region', { name: 'Selection' }).getByRole('button', { name: /^Publish / }), surface: (p) => p.getByRole('dialog'),
  },
  { name: 'Request to add a colleague', who: 'jan', url: roomPath('team'), opener: (p) => p.getByRole('button', { name: 'Request to add a colleague' }), surface: (p) => p.getByRole('dialog') },
  { name: 'Add a site admin', who: 'thabo', url: '/site/settings/accounts', opener: (p) => p.getByRole('button', { name: 'Add a site admin' }), surface: (p) => p.getByRole('dialog') },
  { name: 'the viewer room menu', who: 'jan', url: roomPath('view', DOC_242), opener: (p) => p.locator('#menu-btn'), surface: (p) => p.getByRole('dialog', { name: 'Room menu' }) },
];

test.describe('dialogs', () => {
  for (const d of DIALOGS) {
    test(d.name, async ({ page, persona }) => {
      await persona(d.who);
      await open(page, d.url);
      await d.before?.(page);
      const btn = d.opener(page);
      await btn.focus();
      await page.keyboard.press('Enter');
      const box = d.surface(page);
      await expect(box).toBeVisible();
      await expect.poll(() => box.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await expectVisibleFocus(page);
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
        expect(await box.evaluate((el) => el.contains(document.activeElement)), `Tab left the ${d.name} dialog for ${await focusedDescription(page)}`).toBe(true);
        await expectVisibleFocus(page);
      }
      await page.keyboard.press('Escape');
      await expect(box).toBeHidden();
      await expect(btn).toBeFocused();
    });
  }
});

test.describe('menus', () => {
  const menus: [string, PersonaKey, string, (p: Page) => Locator][] = [
    ['account menu', 'anika', roomPath('dashboard'), (p) => p.getByRole('button', { name: /^Account menu/ })],
    ['document menu', 'anika', roomPath('documents', NODE['2.4']), (p) => p.getByRole('button', { name: /^Actions for 2\.4\.2 / })],
    ['group menu', 'anika', roomPath('people'), (p) => p.getByRole('button', { name: 'Actions for Bidder A', exact: true })],
    ['see-as menu', 'anika', roomPath('dashboard'), (p) => p.getByTestId('see-as-picker')],
  ];
  for (const [name, who, url, opener] of menus) {
    test(name, async ({ page, persona }) => {
      await persona(who);
      await open(page, url);
      const btn = opener(page);
      await btn.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const items = menu.getByRole('menuitem');
      await expect(items.first()).toBeFocused();
      if (await items.count() > 1) {
        await page.keyboard.press('ArrowDown');
        await expect(items.nth(1)).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(items.first()).toBeFocused();
      }
      await expectVisibleFocus(page);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(btn).toBeFocused();
    });
  }

  test('quick search works as a combobox', async ({ page, persona }) => {
    await persona('anika');
    await open(page, roomPath('dashboard'));
    const box = page.getByRole('combobox', { name: 'Search documents' });
    await box.focus();
    await page.keyboard.type('tarnley');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    const active = await box.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
  });

  test('arrow keys move between tabs', async ({ page, persona }) => {
    await persona('anika');
    for (const [url, list] of [[`${roomPath('settings')}?tab=general`, 'Settings areas'], [roomPath('people'), 'Whose groups'], [roomPath('permissions'), 'Whose permissions']] as const) {
      await open(page, url);
      const tabs = page.getByRole('tablist', { name: list }).getByRole('tab');
      await tabs.first().focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      const panel = await tabs.nth(1).getAttribute('aria-controls');
      expect(panel, `${list}: the tab names its panel`).toBeTruthy();
      await expect(page.locator(`[id="${panel}"]`)).toHaveAttribute('role', 'tabpanel');
    }
  });
});

test.describe('layout', () => {
  const screens: [PersonaKey, string][] = [
    ['anika', roomPath('dashboard')], ['anika', roomPath('documents', NODE['2.4'])], ['anika', roomPath('people')], ['anika', roomPath('permissions')],
    ['anika', `${roomPath('settings')}?tab=general`], ['anika', roomPath('timeline')], ['anika', roomPath('activity')], ['anika', roomPath('release')],
    ['anika', roomPath('details', DOC_242)], ['anika', `${roomPath('search')}?q=supply`], ['jan', roomPath('team')], ['jan', roomPath('view', DOC_242)],
    ['jan', '/rooms'], ['anika', '/rooms/new'], ['thabo', '/site/settings'], ['anika', roomPath('profile')],
  ];

  test('should have targets of at least 24px', async ({ page, persona }) => {
    for (const [who, url] of [...screens, ['jan', '/sign-in'] as [PersonaKey, string]]) {
      await test.step(`${who} ${url}`, async () => {
        await persona(who);
        await open(page, url);
        expect(await targetsTooSmall(page.locator('body'))).toEqual([]);
      });
    }
  });

  test('reflows at 320px', async ({ page, persona }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const [who, url] of [...screens, ['jan', '/sign-in'] as [PersonaKey, string], ['jan', '/signed-out'] as [PersonaKey, string]]) {
      await test.step(`${who} ${url}`, async () => {
        await persona(who);
        await open(page, url);
        expect(await horizontalOverflow(page)).toEqual([]);
      });
    }
  });

  test('works at 200% zoom', async ({ page, persona }) => {
    await page.setViewportSize({ width: 640, height: 430 });
    for (const [who, url] of screens) {
      await test.step(`${who} ${url}`, async () => {
        await persona(who);
        await open(page, url);
        expect(await horizontalOverflow(page)).toEqual([]);
        await expect(page.locator('h1').first()).toBeVisible();
      });
    }
  });

  test('should not clip text with wider spacing', async ({ page, persona }) => {
    for (const [who, url] of screens) {
      await test.step(`${who} ${url}`, async () => {
        await persona(who);
        await open(page, url);
        await applyTextSpacing(page);
        expect(await clippedText(page, 'body')).toEqual([]);
        expect(await horizontalOverflow(page)).toEqual([]);
      });
    }
  });
});

function ratio(a: string, b: string): number {
  const lum = (c: string) => {
    const m = c.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test.describe('non-text contrast', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(scheme, async ({ page, persona }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await persona('anika');
      const checks: [string, string][] = [
        [`${roomPath('settings')}?tab=general`, '.f3 .tin'], ['/rooms/new', '.b2 .tin'], [roomPath('activity'), '.f1 .sel'], [roomPath('permissions'), '.e3 .sel'],
      ];
      for (const [url, sel] of checks) {
        await open(page, url);
        const el = page.locator(sel).first();
        const [border, ground] = await el.evaluate((e) => {
          let bg = 'rgba(0, 0, 0, 0)';
          for (let n: Element | null = e.parentElement; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!c.endsWith(', 0)') && c !== 'transparent') { bg = c; break; } }
          return [getComputedStyle(e).borderTopColor, bg];
        });
        expect(ratio(border, ground), `${sel} border ${border} on ${ground}`).toBeGreaterThanOrEqual(3);
        await el.focus();
        const ring = await el.evaluate((e) => getComputedStyle(e).outlineColor);
        expect(ratio(ring, ground), `focus ring ${ring} on ${ground}`).toBeGreaterThanOrEqual(3);
      }
      await open(page, roomPath('documents', NODE['2.4']));
      const icon = await page.locator('.top .icon-btn').first().evaluate((e) => {
        const svg = e.querySelector('svg');
        let bg = 'rgb(255, 255, 255)';
        for (let n: Element | null = e; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!c.endsWith(', 0)') && c !== 'transparent') { bg = c; break; } }
        return [getComputedStyle(svg ?? e).stroke !== 'none' ? getComputedStyle(svg ?? e).stroke : getComputedStyle(e).color, bg];
      });
      expect(ratio(icon[0]!, icon[1]!), `top bar icon ${icon[0]} on ${icon[1]}`).toBeGreaterThanOrEqual(3);
    });
  }
});

test.describe('dragging alternatives', () => {
  test('documents can be added and reordered without dragging', async ({ page, persona }) => {
    await persona('anika');
    await open(page, roomPath('documents', NODE['2.4']));
    await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
    await page.getByRole('button', { name: /^Actions for 2\.4\.2 / }).click();
    await expect(page.getByRole('menuitem', { name: /new version/i }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Edit index' }).click();
    const rows = page.locator('.dr');
    const n = await rows.count();
    for (let i = 0; i < n; i++) await expect(rows.nth(i).locator('input.ixe, button.ixl')).toHaveCount(1);
    await page.locator('.stree .sf').first().click();
    await expect(page.locator('.stree .sf-edit input').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Done' }).click();
  });

  test('bulk import has buttons as well as a drop zone', async ({ page, persona }) => {
    await persona('anika');
    await open(page, roomPath('import'));
    await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose a folder' })).toBeVisible();
  });
});

test.describe('structure', () => {
  test('room screens have one h1, landmarks and labelled fields', async ({ page, persona }) => {
    await persona('anika');
    for (const url of [roomPath('dashboard'), roomPath('documents', NODE['2.4']), roomPath('people'), roomPath('permissions'), `${roomPath('settings')}?tab=general`,
      roomPath('timeline'), roomPath('activity'), roomPath('release'), roomPath('details', DOC_242), roomPath('import'), roomPath('profile')]) {
      await test.step(url, async () => {
        await open(page, url);
        await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.getByRole('navigation').first()).toBeAttached();
        await expect(page.locator('main h1')).toHaveCount(1);
        const levels = await page.locator('main :is(h1, h2, h3, h4)').evaluateAll((hs) => hs.filter((h) => (h as HTMLElement).offsetParent).map((h) => Number(h.tagName[1])));
        for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!, `${url}: headings ${levels.join(' ')}`).toBeLessThanOrEqual(1);
      });
    }
  });

  test('should announce toasts and progress', async ({ page, persona }) => {
    await persona('anika');
    await open(page, roomPath('import'));
    expect(await page.locator('[aria-live]').count()).toBeGreaterThan(0);
    await open(page, roomPath('people'));
    await expect(page.locator('[aria-live="polite"]').first()).toBeAttached();
  });

  test('links field errors to their fields', async ({ page, persona }) => {
    await persona('anika');
    await open(page, '/rooms/new');
    const name = page.getByLabel('Room name', { exact: false }).first();
    await name.fill('');
    await page.getByRole('button', { name: 'Create room' }).click();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    const described = await name.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    await expect(page.locator(`[id="${described!.split(' ')[0]}"]`)).not.toBeEmpty();
  });

  test('respects reduced motion', async ({ page, persona }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await persona('anika');
    await open(page, roomPath('dashboard'));
    const t = await page.locator('.side').evaluate((e) => getComputedStyle(e).transitionDuration);
    expect(t.split(',').every((x) => parseFloat(x) < 0.05)).toBe(true);
  });
});

test.describe('the document viewer', () => {
  test('keyboard', async ({ page, persona }) => {
    await persona('jan');
    await open(page, roomPath('view', DOC_242));
    await expect(page.locator('#p1 img')).toBeVisible({ timeout: 30_000 });
    const canvas = page.getByRole('main', { name: /pages$/ });
    await expect(canvas).toBeFocused();
    const before = await canvas.evaluate((e) => e.scrollTop);
    await page.keyboard.press('PageDown');
    await expect.poll(() => canvas.evaluate((e) => e.scrollTop)).toBeGreaterThan(before);
    await page.locator('#pg').fill('3');
    await page.locator('#pg').press('Enter');
    await expect(page.locator('#p3 img')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: 'Go to page 2' })).toBeVisible();
    const zv = page.locator('#zv');
    const z0 = await zv.textContent();
    // WebKit does not focus a button on click
    await page.getByRole('button', { name: 'Zoom in' }).focus();
    await page.keyboard.press('Enter');
    await expect(zv).not.toHaveText(z0!);
    await expect(zv).toHaveAttribute('aria-live', 'polite');
    // J only works from the pages (2.1.4)
    const url = page.url();
    await page.keyboard.press('j');
    await page.waitForTimeout(500);
    expect(page.url()).toBe(url);
    await canvas.focus();
    await page.keyboard.press('j');
    await expect(page).not.toHaveURL(url);
  });

  test('names the title, pages and images', async ({ page, persona }) => {
    await persona('jan');
    await open(page, roomPath('view', DOC_242));
    await expect(page.locator('#p1 img')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('h1')).toHaveText('Tarnley Logistics supply agreement');
    await expect(page.getByRole('region', { name: /^Page 1 of \d+$/ })).toBeVisible();
    await expect(page.locator('#p1 img')).toHaveAttribute('alt', /^Page 1 of \d+$/);
    await expectNoAxeViolations(page, 'the viewer');
  });
});
