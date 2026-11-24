// SPDX-License-Identifier: AGPL-3.0-only
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoAxeViolations } from './a11y-helpers';
import { API_URL, expect, NODE, roomPath, test, type PersonaKey } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'The screens run against next dev with the API');
test.describe.configure({ timeout: 300_000 });

const DOC_242 = '27087787-3869-4ad1-bf60-086b3e78fc98';

async function open(page: Page, url: string) {
  // a pending client-side navigation can abort the first try
  await page.goto(url).catch(async (e: Error) => { if (!/ERR_ABORTED|interrupted/.test(e.message)) throw e; await page.goto(url); });
  await page.waitForLoadState('networkidle');
  if (await page.locator('.top .qs-in').count()) await expect(page.locator('.top .qs-in[data-ready]')).toBeAttached();
}

async function scanPages(page: Page, who: string, urls: string[]) {
  for (const url of urls) {
    await test.step(url, async () => {
      await open(page, url);
      await expect(page).toHaveTitle(/^VDRkit \S/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
      await expectNoAxeViolations(page, `${who}: ${url}`);
    });
  }
}

const SELLER_SCREENS = [
  roomPath('dashboard'), roomPath('documents'), roomPath('documents', NODE['2.4']), roomPath('documents', NODE['3']), roomPath('view', DOC_242),
  `${roomPath('search')}?q=supply`, `${roomPath('search')}?q=zzzznothing`, roomPath('details', DOC_242), roomPath('timeline'), roomPath('people'),
  roomPath('permissions'), roomPath('activity'), roomPath('release'), roomPath('import'), roomPath('profile'),
  `${roomPath('profile')}?tab=notifications`, `${roomPath('profile')}?tab=sign-in`,
  ...['general', 'nda', 'signin', 'wm', 'pub', 'notif', 'invite'].map((t) => `${roomPath('settings')}?tab=${t}`),
  '/rooms', '/rooms/new', roomPath('does-not-exist'), '/no-such-page',
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('seller admin screens', async ({ page, persona }) => {
      await persona('anika');
      await scanPages(page, 'Anika', SELLER_SCREENS);
    });

    test('seller admin menus and dialogs', async ({ page, persona }) => {
      await persona('anika');
      await open(page, roomPath('documents', NODE['2.4']));

      await test.step('account menu', async () => {
        await page.getByRole('button', { name: /^Account menu/ }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await expectNoAxeViolations(page, 'the account menu');
        await page.keyboard.press('Escape');
      });
      await test.step('about and source code', async () => {
        await page.getByRole('button', { name: /^Account menu/ }).click();
        await page.getByRole('menuitem', { name: /^About and source code/ }).click();
        const about = page.getByRole('dialog', { name: 'About and source code' });
        await expect(about.getByRole('link', { name: /source|github/i })).toBeVisible();
        await expectNoAxeViolations(page, 'About and source code');
        await page.keyboard.press('Escape');
        await expect(about).toHaveCount(0);
      });
      await test.step('quick search with matches', async () => {
        await page.locator('.qs-in').fill('tarnley');
        await expect(page.getByRole('option').first()).toBeVisible();
        await page.keyboard.press('ArrowDown');
        await expectNoAxeViolations(page, 'the quick search');
        await page.keyboard.press('Escape');
      });
      await test.step('a document menu', async () => {
        await page.getByRole('button', { name: /^Actions for 2\.4\.2 / }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await expectNoAxeViolations(page, 'a document menu');
        await page.keyboard.press('Escape');
      });
      await test.step('add files', async () => {
        await page.getByRole('button', { name: 'Choose files' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectNoAxeViolations(page, 'the Add files dialog');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      });
      await test.step('edit index and a new folder', async () => {
        await page.getByRole('button', { name: 'Edit index' }).click();
        await expect(page.locator('input.ixe').first()).toBeVisible();
        await expectNoAxeViolations(page, 'C2 in edit mode');
        await page.locator('.stree').getByRole('button', { name: 'New folder' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectNoAxeViolations(page, 'the New folder dialog');
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('button', { name: 'Done' }).click();
      });
      await test.step('the room menu as a drawer on a narrow screen', async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('.mm-btn').click();
        await expect(page.locator('.app')).toHaveClass(/mm-open/);
        await expectNoAxeViolations(page, 'the room menu drawer');
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1280, height: 860 });
      });
    });

    test('seller admin, admin screens in their states', async ({ page, persona }) => {
      await persona('anika');
      await test.step('People', async () => {
        await open(page, roomPath('people'));
        await page.getByRole('button', { name: 'Show the people in Bidder A' }).click();
        await expect(page.getByRole('table', { name: 'People in Bidder A' })).toBeVisible();
        await expectNoAxeViolations(page, 'E1 with a group open');
        await page.getByRole('button', { name: 'Actions for Bidder A', exact: true }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await expectNoAxeViolations(page, 'the group menu');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Invite people', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectNoAxeViolations(page, 'the Invite people dialog');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'New group' }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectNoAxeViolations(page, 'the New group dialog');
        await page.keyboard.press('Escape');
        await page.getByRole('tab', { name: /Seller team/ }).click();
        await expectNoAxeViolations(page, 'E1 Seller team tab');
      });
      await test.step('Permissions', async () => {
        await open(page, roomPath('permissions'));
        await page.getByRole('button', { name: 'Open Finance' }).click();
        await page.locator('button.cell[aria-label^="Bidder B, 3 "]').click();
        await expect(page.locator('.pop')).toBeVisible();
        await expectNoAxeViolations(page, 'the permission cell panel');
        await page.keyboard.press('Escape');
        await page.getByRole('tab', { name: /Seller team/ }).click();
        await expectNoAxeViolations(page, 'E3 Seller team tab');
      });
      await test.step('Settings NDA dialog', async () => {
        await open(page, `${roomPath('settings')}?tab=nda`);
        await page.getByRole('button', { name: 'Publish a new version' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectNoAxeViolations(page, 'the NDA dialog');
        await page.keyboard.press('Escape');
      });
      await test.step('Timeline', async () => {
        await open(page, roomPath('timeline'));
        await page.getByRole('button', { name: 'Add a phase' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectNoAxeViolations(page, 'the timeline dialog');
        await page.keyboard.press('Escape');
      });
      await test.step('Release review', async () => {
        await open(page, roomPath('release'));
        await page.locator('.rr input.cb:not(:disabled)').first().check();
        await expect(page.getByRole('region', { name: 'Selection' })).toBeVisible();
        await expectNoAxeViolations(page, 'D3 with a selection');
        await page.getByRole('region', { name: 'Selection' }).getByRole('button', { name: /^Publish / }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectNoAxeViolations(page, 'the publish dialog');
        await page.keyboard.press('Escape');
      });
      await test.step('Activity', async () => {
        await open(page, roomPath('activity'));
        await page.locator('.erow').first().locator('.rowbtn').click();
        await expect(page.getByRole('region', { name: /^People in / })).toBeVisible();
        await expectNoAxeViolations(page, 'F1 with a bidder picked');
      });
      await test.step('See as Bidder A', async () => {
        await open(page, roomPath('dashboard'));
        await page.getByTestId('see-as-picker').click();
        await expect(page.getByRole('menu')).toBeVisible();
        await expectNoAxeViolations(page, 'the see-as menu');
        await page.getByRole('menu').getByRole('menuitem', { name: /^Bidder A/ }).first().click();
        await expect(page.getByTestId('see-as-bar')).toBeVisible();
        await expectNoAxeViolations(page, 'the dashboard seen as Bidder A');
        await page.getByTestId('see-as-bar').getByRole('link', { name: /^Stop seeing as/ }).click();
        await expect(page.getByTestId('see-as-bar')).toHaveCount(0);
      });
    });

    test('document viewer', async ({ page, persona }) => {
      await persona('anika');
      await open(page, roomPath('view', DOC_242));
      await expect(page.locator('#p1 img')).toBeVisible({ timeout: 30_000 });
      await expectNoAxeViolations(page, 'C3 for a room admin');
      await page.locator('#menu-btn').click();
      await expect(page.getByRole('dialog', { name: 'Room menu' })).toBeVisible();
      await expectNoAxeViolations(page, 'the viewer room menu');
      await page.keyboard.press('Escape');
      await page.locator('#dl-btn').click();
      await expect(page.getByRole('dialog', { name: 'Download' })).toBeVisible();
      await expectNoAxeViolations(page, 'the download choice');
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 700, height: 900 });
      await open(page, roomPath('view', DOC_242));
      await page.locator('#info-btn').click();
      await expect(page.getByRole('dialog', { name: 'Document details' })).toBeVisible();
      await expectNoAxeViolations(page, 'the details panel over the pages');
    });

    test('other seller roles', async ({ page, persona }) => {
      for (const [who, urls] of [
        ['maria', [roomPath('dashboard'), roomPath('documents'), roomPath('documents', NODE['3']), roomPath('view', DOC_242), roomPath('profile')]],
        ['johan', [roomPath('dashboard'), roomPath('documents', NODE['3']), roomPath('release')]],
        ['liesl', [roomPath('dashboard'), roomPath('documents'), roomPath('documents', NODE['2.4']), roomPath('view', DOC_242), roomPath('activity'), `${roomPath('search')}?q=supply`]],
      ] as [PersonaKey, string[]][]) {
        await test.step(who, async () => {
          await persona(who);
          await scanPages(page, who, urls);
        });
      }
    });

    test('bidders and financier', async ({ page, persona }) => {
      for (const [who, urls] of [
        ['jan', [roomPath('dashboard'), roomPath('documents'), roomPath('documents', NODE['2.4']), roomPath('view', DOC_242), `${roomPath('search')}?q=supply`,
          roomPath('team'), roomPath('profile'), `${roomPath('profile')}?tab=notifications`, '/rooms', roomPath('people')]],
        ['pieter', [roomPath('dashboard'), roomPath('team'), roomPath('view', DOC_242)]],
        ['lars', [roomPath('dashboard'), roomPath('documents')]],
      ] as [PersonaKey, string[]][]) {
        await test.step(who, async () => {
          await persona(who);
          await scanPages(page, who, urls);
        });
      }
      await test.step('bidder lead dialogs', async () => {
        await persona('jan');
        await open(page, roomPath('team'));
        await page.getByRole('button', { name: 'Request to add a colleague' }).click();
        await expect(page.getByRole('dialog', { name: 'Request to add a colleague' })).toBeVisible();
        await expectNoAxeViolations(page, 'the request dialog');
        await page.keyboard.press('Escape');
        await open(page, roomPath('view', DOC_242));
        await page.locator('#menu-btn').click();
        await expectNoAxeViolations(page, 'the viewer room menu for a bidder');
      });
    });

    test('site admin screens', async ({ page, persona }) => {
      await persona('thabo');
      await scanPages(page, 'Thabo', ['/site/settings', '/site/settings/email', '/site/settings/rooms', '/site/settings/accounts', '/site/settings/health', '/rooms']);
      await page.getByRole('button', { name: 'Add a site admin' }).click().catch(async () => {
        await open(page, '/site/settings/accounts');
        await page.getByRole('button', { name: 'Add a site admin' }).click();
      });
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoAxeViolations(page, 'the Add a site admin dialog');
      await page.keyboard.press('Escape');
    });

    test('pages outside a room', async ({ page }) => {
      await scanPages(page, 'a visitor', ['/sign-in', '/sign-in/expired', '/signed-out', '/privacy', '/updating', '/invite/not-a-real-token']);
    });

    test('empty room', async ({ page, persona, request }) => {
      const room = await emptyRoom(request);
      await persona('anika');
      const r = (s: string) => `/rooms/${room}/${s}`;
      await scanPages(page, 'Anika, empty room', [r('dashboard'), r('documents'), r('people'), r('permissions'), r('timeline'), r('release'), r('activity'), `${r('search')}?q=anything`]);
    });
  });
}

async function emptyRoom(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/v1/workspaces`, {
    headers: { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001', 'x-dev-person': 'a369f772-bdd8-4e7f-a614-11dc069feb12' },
    data: { name: `A11y empty ${Date.now()}${Math.floor(Math.random() * 1000)}`, timeZone: 'Africa/Johannesburg', start: 'empty' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}
