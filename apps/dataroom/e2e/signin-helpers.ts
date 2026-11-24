// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { DEV_ROOM_ID, DEV_TENANT_ID, PERSONAS } from '../src/dev-tools/personas';
import { pageHydrated } from './fixtures';

export const API = `http://127.0.0.1:${process.env.API_PORT ?? '3101'}`;
export const ROOM = DEV_ROOM_ID;
const ANIKA = PERSONAS.find((p) => p.key === 'anika')!.id;

export async function asAdmin<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': ANIKA, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface Mail { to: string; subject: string; text: string; html: string; sentAt: string }

export async function nextEmail(to: string, since: number): Promise<Mail> {
  for (let i = 0; i < 50; i++) {
    const { messages } = await asAdmin<{ messages: Mail[] }>('GET', `/v1/dev/mailbox?to=${encodeURIComponent(to)}`);
    const m = messages.find((x) => new Date(x.sentAt).getTime() >= since);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No email to ${to}`);
}

export function signInParts(m: Mail): { code: string; link: string } {
  const code = /(\d{3}) ?(\d{3})/.exec(m.subject);
  const link = /https?:\/\/\S+\/sign-in\/link\?\S+/.exec(m.text);
  if (!code || !link) throw new Error(`Not a sign-in email: ${m.subject}`);
  return { code: `${code[1]}${code[2]}`, link: link[0] };
}

export async function invite(prefix: string): Promise<{ email: string; link: string }> {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.example`;
  const people = await asAdmin<{ parties: { groups: { id: string; name: string; parentGroupId: string | null }[] }[] }>('GET', `/v1/workspaces/${ROOM}/people`);
  const group = people.parties.flatMap((p) => p.groups).find((g) => g.name === 'Bidder A' && !g.parentGroupId);
  if (!group) throw new Error('No Bidder A group');
  const since = Date.now() - 1000;
  const until = new Date(Date.now() + 75 * 86_400_000).toISOString();
  await asAdmin('POST', `/v1/workspaces/${ROOM}/invitations`, { groupId: group.id, people: [{ email }], role: 'member', accessExpiresAt: until });
  const m = await nextEmail(email, since);
  const link = /https?:\/\/\S+\/invite\/\S+/.exec(m.text);
  if (!link) throw new Error('No invitation link');
  return { email, link: link[0] };
}

// RFC 6238
export function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

export async function freshTotp(secret: string, used?: string): Promise<string> {
  let code = totp(secret);
  while (code === used) {
    await new Promise((r) => setTimeout(r, 1000));
    code = totp(secret);
  }
  return code;
}

export async function typeCode(page: Page, code: string) {
  const boxes = page.locator('.card .code input');
  await expect(boxes).toHaveCount(6);
  await boxes.first().click();
  await page.keyboard.type(code);
}

export async function signInWithCode(page: Page, email: string, next = '/') {
  await page.goto(next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  await pageHydrated(page);
  await page.locator('#f-email').fill(email);
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const { code } = signInParts(await nextEmail(email, since));
  await typeCode(page, code);
  await page.getByRole('button', { name: 'Continue' }).click();
}

export const DASHBOARD = new RegExp(`/rooms/${ROOM}/dashboard$`);

export async function onboard(page: Page, prefix: string, o: { here?: boolean } = {}): Promise<{ email: string; secret: string; used: string }> {
  const { email, link } = await invite(prefix);
  // `here`: same app, not PUBLIC_URL
  await page.goto(o.here ? `${new URL(link).pathname}${new URL(link).search}` : link);
  await expect(page.getByRole('heading', { name: 'Welcome to Project Heron' })).toBeVisible();
  await expect(page.locator('.inv')).toContainText('Anika Pillay of Quillmont Advisory invited you to Bidder A, on behalf of Drosvelt Holdings');
  await expect(page.locator('.steps li')).toHaveText(['Your details', 'Two-factor', 'NDA']);
  await expect(page.locator('.steps li.on')).toHaveText('Your details');
  await expect(page.locator('.tin[readonly]')).toHaveValue(email);
  await expect(page.locator('#f-fn')).toBeFocused();

  await page.locator('#f-fn').fill('Sanne');
  await page.locator('#f-ln').fill('Visser');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.hint.err')).toHaveText('Enter your first name, last name and company. Your team and the room admin see them.');
  await page.locator('#f-co').fill('Orrinby Capital');
  await page.locator('#f-ro').fill('Partner');
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.locator('.steps li.on')).toHaveText('Your details');
  const { code } = signInParts(await nextEmail(email, since));
  await typeCode(page, code);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();
  await expect(page.locator('.steps li.on')).toHaveText('Two-factor');
  await expect(page.locator('svg.qr path')).toHaveCount(1);
  const key = (await page.getByTestId('manual-key').textContent())!.replace(/\s/g, '');
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  const first = totp(key);
  await typeCode(page, first);
  await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();

  await expect(page.getByRole('heading', { name: 'Before you enter Project Heron' })).toBeVisible();
  await expect(page.locator('.steps li.on')).toHaveText('NDA');
  await expect(page.locator('.nda')).toContainText('Confidentiality undertaking for Project Heron');
  const accept = page.getByRole('button', { name: 'Accept and enter the room' });
  await expect(accept).toBeDisabled();
  await expect(page).toHaveURL(/\/nda/, { timeout: 30_000 });
  await pageHydrated(page);
  // a newer NDA can land before Accept; the page then asks to reload
  await expect(async () => {
    // a slow redirect after an accepted click
    if (DASHBOARD.test(page.url())) return;
    const { versionNo } = await asAdmin<{ versionNo: number }>('GET', `/v1/workspaces/${ROOM}/nda`);
    const shows = async () => (await page.locator('.nda-meta').innerText()).startsWith(`Version ${versionNo}`);
    if (!(await shows())) {
      await page.reload();
      await pageHydrated(page);
    }
    expect(await page.locator('.nda-meta').innerText()).toMatch(new RegExp(`^Version ${versionNo}[ ,]`));
    await page.locator('#f-accept').check();
    await accept.click();
    await expect(page).toHaveURL(DASHBOARD, { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.locator('.side .room')).toContainText('Project Heron');
  return { email, secret: key, used: first };
}
