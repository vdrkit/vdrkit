// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { cspViolations, pageHydrated } from '../e2e/fixtures';
import { DEV_ROOM_ID } from '../src/dev-tools/personas';

test('shows Try VDRkit to visitors without a session', async ({ page }) => {
  const violations = cspViolations(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/try$/);
  await pageHydrated(page);
  await expect(page.getByRole('heading', { name: 'Try VDRkit' })).toBeVisible();
  await expect(page.getByText('wiped every day at 03:00 UTC')).toBeVisible();
  for (const g of ['Runs the room', 'Seller team', 'Bidders', 'Financier']) await expect(page.getByRole('heading', { name: g })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter the sandbox as Anika Pillay' })).toBeVisible();
  const bar = page.getByRole('region', { name: 'Sandbox' });
  await expect(bar).toContainText('wiped daily at 03:00 UTC');
  await expect(bar.getByRole('link', { name: 'Switch person' })).toHaveAttribute('href', '/try');
  await page.goto('/sign-in');
  await expect(page).toHaveURL(/\/try$/);
  expect(violations).toEqual([]);
});

test('enters as a bidder, then switches to the room admin', async ({ page }) => {
  const violations = cspViolations(page);
  await page.goto('/try');
  await pageHydrated(page);
  await page.getByRole('button', { name: 'Enter the sandbox as Jan de Vries' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${DEV_ROOM_ID}/dashboard$`));
  await expect(page.locator('.side .who b').first()).toHaveText('Jan de Vries');
  const bar = page.getByRole('region', { name: 'Sandbox' });
  await expect(bar).toBeVisible();

  await bar.getByRole('link', { name: 'Switch person' }).click();
  await expect(page).toHaveURL(/\/try$/);
  await pageHydrated(page);
  await page.getByRole('button', { name: 'Enter the sandbox as Anika Pillay' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${DEV_ROOM_ID}/dashboard$`));
  await expect(page.locator('.side .who b').first()).toHaveText('Anika Pillay');
  await expect(page.getByRole('region', { name: 'Sandbox' })).toBeVisible();
  expect(violations).toEqual([]);
});

test('refuses site settings with a reason', async ({ page }) => {
  await page.goto('/try');
  await pageHydrated(page);
  await page.getByRole('button', { name: 'Enter the sandbox as Anika Pillay' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${DEV_ROOM_ID}/dashboard$`));
  const res = await page.request.patch('/v1/site/settings', { data: { organisationName: 'Taken over' }, headers: { origin: new URL(page.url()).origin } });
  expect(res.status()).toBe(403);
  expect((await res.json()).detail).toContain('Site settings stay as they are in the sandbox');
});

async function enter(page: Page, name: string): Promise<void> {
  await page.goto('/try');
  await pageHydrated(page);
  await page.getByRole('button', { name: `Enter the sandbox as ${name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${DEV_ROOM_ID}/dashboard$`));
}

interface Item { id: string; kind: 'folder' | 'document'; name: string; indexNumber: string | null; version: { pageCount: number | null } | null }

test('bidder can open documents across the room', async ({ page }) => {
  test.setTimeout(180_000);
  await enter(page, 'Jan de Vries');
  const docs: Item[] = [];
  const folders: (string | null)[] = [null];
  while (folders.length) {
    const parent = folders.shift();
    const res = await page.request.get(`/v1/workspaces/${DEV_ROOM_ID}/nodes${parent ? `?parent=${parent}` : ''}`);
    expect(res.status()).toBe(200);
    for (const n of (await res.json()).items as Item[]) {
      if (n.kind === 'folder') folders.push(n.id);
      else docs.push(n);
    }
  }
  expect(docs.length).toBeGreaterThan(280);
  expect(docs.filter((d) => !d.version?.pageCount)).toEqual([]);
  // six at random each run
  const picked = [...docs].sort(() => Math.random() - 0.5).slice(0, 6);
  for (const d of picked) {
    await test.step(`${d.indexNumber} ${d.name}`, async () => {
      await page.goto(`/rooms/${DEV_ROOM_ID}/view/${d.id}`);
      await expect(page.locator('.doct h1')).toHaveText(d.name.replace(/\.(pdf|docx|xlsx|pptx)$/, ''));
      const img = page.locator('#p1 img');
      await expect(img).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(100);
    });
  }
});

test('search finds a phrase in a generated document', async ({ page }) => {
  await enter(page, 'Jan de Vries');
  await page.goto(`/rooms/${DEV_ROOM_ID}/search?q=${encodeURIComponent('"consents tracker for the sale"')}`);
  const hit = page.locator('.hit', { hasText: 'Facility agreement Umbila Bank 2025' });
  await expect(hit).toBeVisible({ timeout: 30_000 });
  await expect(hit.locator('.t .n')).toHaveText('3.5.2');
  await expect(hit.locator('.snip mark').first()).toContainText(/consents/i);
});

// same as stableId() in apps/server/src/demo/seed-demo.ts
function roomId(key: string): string {
  const h = createHash('sha256').update(`vdrkit-demo:de300000-0000-4000-8000-000000000001:workspace:${key}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

test('opens documents in the other demo rooms', async ({ page }) => {
  test.setTimeout(180_000);
  for (const [person, rooms] of [['Anika Pillay', ['osprey', 'falcon']], ['Jan de Vries', ['weaver']]] as const) {
    await enter(page, person);
    for (const key of rooms) {
      const ws = roomId(key);
      const top = (await (await page.request.get(`/v1/workspaces/${ws}/nodes`)).json()).items as Item[];
      const docs = (await (await page.request.get(`/v1/workspaces/${ws}/nodes?parent=${top[0]!.id}`)).json()).items as Item[];
      expect(docs.length, key).toBeGreaterThan(0);
      expect(docs.filter((d) => !d.version?.pageCount), key).toEqual([]);
      const d = docs[Math.floor(Math.random() * docs.length)]!;
      await test.step(`${key}: ${d.indexNumber} ${d.name}`, async () => {
        await page.goto(`/rooms/${ws}/view/${d.id}`);
        const img = page.locator('#p1 img');
        await expect(img).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(100);
      });
    }
  }
});
