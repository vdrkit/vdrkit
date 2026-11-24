// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { DEV_TENANT_ID, PERSONAS } from '../src/dev-tools/personas';
import { pdf } from './import-files';
import { pageHydrated } from './fixtures';
import { API, freshTotp, signInParts, totp, typeCode, type Mail } from './signin-helpers';

export { pdf };
const THABO = PERSONAS.find((p) => p.key === 'thabo')!.id;

export const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function as<T = unknown>(personId: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': personId, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function statusAs(personId: string, method: string, path: string, body?: unknown): Promise<number> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': personId, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await res.arrayBuffer();
  return res.status;
}

export async function mailsTo(to: string, since: number): Promise<Mail[]> {
  const { messages } = await as<{ messages: Mail[] }>(THABO, 'GET', `/v1/dev/mailbox?to=${encodeURIComponent(to)}`);
  return messages.filter((m) => new Date(m.sentAt).getTime() >= since).reverse();
}

export async function mailTo(to: string, since: number, subject: RegExp = /./): Promise<Mail> {
  for (let i = 0; i < 100; i++) {
    const m = (await mailsTo(to, since)).reverse().find((x) => subject.test(x.subject));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No email to ${to} matching ${subject}`);
}

export function linkIn(m: Mail, path: RegExp): string {
  const found = new RegExp(`https?://\\S+${path.source}\\S*`).exec(m.text);
  if (!found) throw new Error(`No link ${path} in "${m.subject}"`);
  return found[0];
}

export interface Actor {
  name: string;
  email: string;
  page: Page;
  context: BrowserContext;
  secret?: string;
  used?: string;
  personId?: string;
}

export async function newActor(browser: Browser, name: string, email: string): Promise<Actor> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { name, email, page, context };
}

export async function go(a: Actor | Page, path: string) {
  const page = 'page' in a ? a.page : a;
  const res = await page.goto(path);
  await pageHydrated(page);
  return res;
}

export async function newRoomCreator(name: string, email: string): Promise<string> {
  const r = await as<{ personId: string }>(THABO, 'POST', '/v1/site/room-creators', { email, name });
  return r.personId;
}

async function setUpTwoFactor(a: Actor) {
  const page = a.page;
  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();
  await expect(page.getByTestId('manual-key')).toHaveText(/^[A-Z2-7 ]{16,}$/);
  const key = (await page.getByTestId('manual-key').textContent())!.replace(/\s/g, '');
  a.secret = key;
  a.used = totp(key);
  await typeCode(page, a.used);
  await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
}

export async function signIn(a: Actor, next = '/') {
  const page = a.page;
  await go(page, next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  await page.locator('#f-email').fill(a.email);
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const { code } = signInParts(await mailTo(a.email, since, /\d{3} ?\d{3}/));
  await typeCode(page, code);
  await page.getByRole('button', { name: 'Continue' }).click();
  const setUp = page.getByRole('heading', { name: 'Set up two-factor sign-in' });
  const ask = page.getByRole('heading', { name: 'Enter the code from your authenticator app' });
  await expect(async () => {
    const onCard = (await setUp.isVisible()) || (await ask.isVisible());
    expect(onCard || !/\/sign-in/.test(new URL(page.url()).pathname)).toBe(true);
  }).toPass({ timeout: 30_000 });
  if (await setUp.isVisible()) await setUpTwoFactor(a);
  else if (await ask.isVisible()) {
    if (!a.secret) throw new Error(`${a.name} has no authenticator secret`);
    a.used = await freshTotp(a.secret, a.used);
    await typeCode(page, a.used);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 30_000 });
}

export interface Details { given: string; family: string; company: string; role?: string }

export async function acceptInvitation(a: Actor, link: string, d: Details) {
  const page = a.page;
  await go(page, link);
  await expect(page.locator('.steps li.on')).toHaveText('Your details');
  await expect(page.locator('.tin[readonly]')).toHaveValue(a.email);
  await page.locator('#f-fn').fill(d.given);
  await page.locator('#f-ln').fill(d.family);
  await page.locator('#f-co').fill(d.company);
  if (d.role) await page.locator('#f-ro').fill(d.role);
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const { code } = signInParts(await mailTo(a.email, since, /\d{3} ?\d{3}/));
  await typeCode(page, code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await setUpTwoFactor(a);
}

export async function acceptNda(a: Actor, room: string) {
  const page = a.page;
  await expect(page.getByRole('heading', { name: `Before you enter ${room}` })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/nda/, { timeout: 30_000 });
  await pageHydrated(page);
  await page.locator('#f-accept').check();
  await page.getByRole('button', { name: 'Accept and enter the room' }).click();
}

export async function signOut(a: Actor) {
  const page = a.page;
  const item = page.getByRole('menuitem', { name: /Sign out/ });
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByRole('button', { name: 'Account menu: profile, notification settings, about, sign out' }).click();
    await expect(item).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await item.click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

export async function expectNotAvailable(page: Page) {
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
}

interface Group { id: string; name: string; parentGroupId: string | null; members: { membershipId: string; email: string; status: string }[] }
interface Party { id: string; kind: string; name: string; groups: Group[] }

export async function people(admin: string, ws: string): Promise<Party[]> {
  return (await as<{ parties: Party[] }>(admin, 'GET', `/v1/workspaces/${ws}/people`)).parties;
}

export async function groupId(admin: string, ws: string, name: string): Promise<string> {
  const g = (await people(admin, ws)).flatMap((p) => p.groups).find((x) => x.name === name);
  if (!g) throw new Error(`No group ${name}`);
  return g.id;
}

export interface Node { id: string; indexNumber: string | null; name: string; kind: string; state: string }

export async function nodes(personId: string, ws: string, parent?: string): Promise<Node[]> {
  return (await as<{ items: Node[] }>(personId, 'GET', `/v1/workspaces/${ws}/nodes${parent ? `?parent=${parent}` : ''}`)).items;
}

export async function folderByNumber(personId: string, ws: string, ix: string): Promise<Node> {
  const parts = ix.split('.');
  let parent: string | undefined;
  let found: Node | undefined;
  for (let i = 1; i <= parts.length; i++) {
    const want = parts.slice(0, i).join('.');
    found = (await nodes(personId, ws, parent)).find((n) => n.indexNumber === want);
    if (!found) throw new Error(`No ${want}`);
    parent = found.id;
  }
  return found!;
}

export async function roomFor(creator: string, name: string, open = true): Promise<string> {
  const { id } = await as<{ id: string }>(creator, 'POST', '/v1/workspaces', { name, timeZone: 'Africa/Johannesburg', start: 'standard' });
  if (open) await as(creator, 'PATCH', `/v1/workspaces/${id}/settings`, { state: 'open' });
  return id;
}

export async function bidderGroup(admin: string, ws: string, name: string, organisation: string): Promise<string> {
  const r = await as<{ id: string }>(admin, 'POST', `/v1/workspaces/${ws}/groups`, { name, newParty: { name, kind: 'bidder' }, organisation });
  return r.id;
}

// level: 20 view, 50 download PDF, 60 original
export async function grant(admin: string, ws: string, group: string, cells: { nodeId: string; level: number; canUpload?: boolean; canPublish?: boolean }[]) {
  await as(admin, 'PUT', `/v1/workspaces/${ws}/grants`, {
    changes: cells.map((c) => ({ nodeId: c.nodeId, groupId: group, effect: 'allow', level: c.level, canUpload: c.canUpload ?? false, canPublish: c.canPublish ?? false })),
  });
}

export async function inviteLink(admin: string, ws: string, group: string, email: string, role: 'member' | 'lead' = 'member'): Promise<string> {
  const since = Date.now() - 1000;
  await as(admin, 'POST', `/v1/workspaces/${ws}/invitations`, { groupId: group, people: [{ email }], role });
  return linkIn(await mailTo(email, since, /./), /\/invite\//);
}

export async function uploadPdf(personId: string, ws: string, folderId: string, name: string, text = name): Promise<{ nodeId: string; indexNumber: string }> {
  const buf = pdf(text);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const s = await as<{ id: string; uploadUrl: string }>(personId, 'POST', `/v1/workspaces/${ws}/upload-sessions`,
    { targetFolderId: folderId, path: name, size: buf.length, sha256, mime: 'application/pdf' });
  const put = await fetch(`${API}${s.uploadUrl.startsWith('/v1/') ? s.uploadUrl : `/v1/${s.uploadUrl.replace(/^\//, '')}`}`, {
    method: 'PUT', body: buf,
    headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': personId, 'content-type': 'application/octet-stream' },
  });
  if (!put.ok) throw new Error(`upload: ${put.status} ${await put.text()}`);
  const done = await as<{ nodeId: string; indexNumber: string }>(personId, 'POST', `/v1/workspaces/${ws}/upload-sessions/${s.id}/complete`, {});
  return done;
}

export async function requireNda(admin: string, ws: string, text: string) {
  await as(admin, 'PUT', `/v1/workspaces/${ws}/nda`, { body: text, name: 'NDA' });
  await as(admin, 'PATCH', `/v1/workspaces/${ws}/settings`, { requiresNda: true });
}

export async function publish(admin: string, ws: string, nodeIds: string[], quiet = true) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${API}/v1/workspaces/${ws}/publish`, {
      method: 'POST',
      headers: { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': admin, 'content-type': 'application/json' },
      body: JSON.stringify({ nodeIds, quiet }),
    });
    if (res.ok) return;
    const text = await res.text();
    if (i > 60) throw new Error(`publish: ${res.status} ${text}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function sellerGroup(admin: string, ws: string, name: string, roleTemplate: 'member' | 'observer' = 'member'): Promise<string> {
  const seller = (await people(admin, ws)).find((p) => p.kind === 'seller');
  if (!seller) throw new Error('No seller party');
  const r = await as<{ id: string }>(admin, 'POST', `/v1/workspaces/${ws}/groups`, { name, partyId: seller.id, roleTemplate, organisation: 'Drosvelt Holdings' });
  return r.id;
}

export async function join(a: Actor, link: string, d: Details, room: string, ws: string, nda: boolean) {
  await acceptInvitation(a, link, d);
  if (nda) await acceptNda(a, room);
  await expect(a.page).toHaveURL(new RegExp(`/rooms/${ws}/dashboard$`), { timeout: 30_000 });
  await pageHydrated(a.page);
}

export async function addFiles(a: Actor, ws: string, folderId: string, files: { name: string; text: string }[]): Promise<string[]> {
  const page = a.page;
  await go(page, `/rooms/${ws}/documents/${folderId}`);
  await page.getByRole('button', { name: /^(Choose files|Upload files)$/ }).first().click();
  const dlg = page.getByRole('dialog');
  const chooser = page.waitForEvent('filechooser');
  await dlg.getByRole('button', { name: 'Browse your computer' }).click();
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: 'application/pdf', buffer: pdf(f.text) })));
  const n = files.length;
  await dlg.getByRole('button', { name: n === 1 ? 'Add 1 file as a draft' : `Add ${n} files as drafts` }).click();
  await expect(dlg.locator('.okbox')).toContainText(n === 1 ? '1 file is in' : `${n} files are in`);
  await dlg.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
  const ids: string[] = [];
  for (const f of files) {
    const row = page.locator('.dr', { hasText: f.name.replace(/\.pdf$/, '') });
    await expect(row.locator('.badge')).toContainText('Draft');
    ids.push((await row.getAttribute('data-doc'))!);
  }
  return ids;
}
