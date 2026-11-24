// SPDX-License-Identifier: AGPL-3.0-only
import { deflateRawSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';
import { expectNoAxeViolations } from './a11y-helpers';
import { API_URL, expect, hydrated, PERSONAS, ROOM_ID, roomPath, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const AUDITED = 'ce7385c5-8612-47d2-9896-ea1d7556ae85'; // 3.2 Audited financials
const SHOTS = 'test-results/no-preview';
const W = `${API_URL}/v1/workspaces/${ROOM_ID}`;
const headers = { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': PERSONAS.find((p) => p.key === 'anika')!.id };
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAMAAADlRUG7AAAA/1BMVEUiqmb6qjSdqknOqj4jqmZCql7Nqj7/qjPvqjb8qjNEql5gqlfwqjdMql' +
  'zEqkBKql3uqjfiqjopqmVBql/Xqjyiqkmlqkj9qjR6qlJRqlv3qjUqqmT2qjXnqjjOqj9WqlooqmRVqlqgqknoqjmfqklMql3Vqj3lqjn1qjVP' +
  'qlujqkjkqjlFql5SqlvHqkCcqkpAql97qlJkqlf7qjTQqj7GqkB8qlHSqj75qjXvqjdhqliaqkrMqj/VqjxmqlekqkhgqljFqkFTqluhqkhJql' +
  '1iqlfhqjpOqlxlqlZNqlzxqjZLqlziqjl6qlGbqkrjqjqaqkvUqj3fqjvTqj3gqjppIa4eAAAACXBIWXMAAAsTAAALEwEAmpwYAAABpUlEQVRo' +
  'ge3YV3LCMBCA4cWUNWBq6C2EEkIPNaGk917vf5ZMHvLAxMbemRWaZPRf4BvZliwJQKVSqVSq/1FnmprEjNHIuJ6cDAKbUutaFVcq9h/Eq55bN5' +
  'pUGnrEutkDtGjcFMjmL9JWLmK6EhflBhK4tiOvGLc7W+8iGtsi3HnOzkUsBPnd8z17FzHHPubAvRMXUWd+z/FdZy5iIs8KJ526iDVOt+l3Dqez' +
  'fK7Hcr0yy823eh5TXMQ5G+ymwT4uN0RzESNMsEaFF0xwlQo3eNwO1UXcYoGndPiJBU7R4SQL3KPDYRb4hQ7HWGCdDkdZYBcdPvzbsC7rUT/K+r' +
  'h6sqZTStYCMqDDGRY4IOsnAUWq2+ZxoU+FX5nguqytD5Ro7pLLhSEN5jsyesZSdrcAcEM4wvhDjDBUnMMapwvlN0nHVPA6/DnO9nldgK6zq4gd' +
  'bhcgWLB3C6f8LkA2aucaAsb7ndfmIuSD/f3+FK+tmc9+rQziurM8o/tY1w2Trnxm7FLAld6vIs+NVbW9uIQN5c20zj51l0t/D7cyTPsclUqlUq' +
  'mk9wVujk4jBduvaQAAAABJRU5ErkJggg==',
  'base64');
const JPEG = Buffer.from(
  '/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREy' +
  'YVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCABQAHgDASIAAhEBAxEB/8QAGAAB' +
  'AAMBAAAAAAAAAAAAAAAAAAMEBQb/xAAmEAACAgEDAgcBAQAAAAAAAAAAAQIDEQQFcTHBExQiM0FRUpES/8QAGgEBAAMBAQEAAAAAAAAAAAAAAA' +
  'MFBgECBP/EACMRAAICAgAGAwEAAAAAAAAAAAABAgMEEQUSEyFRgRRBweH/2gAMAwEAAhEDEQA/AIwAQmcAAAAAAAJK6bbfbrlLhEvkNVjPhP8A' +
  'qPDshHs2iWFFs1uMW/TKwJLKbavchKPKIz0mn3RHKLi9SWgADpwAAAAAAAAAAAAGpo9vSSs1Cy30j9ckO2UKy52SWYw6cmuV2ZkuL5I+y+4VgR' +
  'nHrWLfhfoSSWEkkvhAArDRBpNYayn8MztZt6admnWGusfvg0QSVWyre4kGRjV5EeWa/hzQL250Ku5WRXpn15KJeV2KyKkjF5FMqLHXL6AAJCIA' +
  'AAAAAAAA2tsj/nRp/pt9uxbKm2SUtGl+W13LZQX76st+Tb4WvjQ14QABEfUAAAVNzipaNv8ALT7GKbW5yUdG1+ml3MUt8HfS9mU41r5K14X6AA' +
  'faVIAAAAAAAABe2y9V3OuTxGfTk1zmjU0e4LCr1Dw10l98ldmYzk+ePsvuFZ8YR6Nj14f4aICaaymmn8oFYaIANpLLaSXyzO1m4JJ16d5b6z+u' +
  'CSqqVj1EgyMmvHjzTf8ASHc71Zcq4v0w68lEAvK61XFRRi8i6V9jsl9gAEhEAAAAAAAAAAAASV3W1e3OUeGS+e1WMeK/4isDw64S7tIlhfbBaj' +
  'Jr2ySy6y33JylyyMA9JJdkRyk5PcnsAA6cAAAAAAP/2Q==',
  'base64');

function crc32(b: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of b) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function threeMf(): Buffer {
  const entries: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['3D/3dmodel.model', '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc32(data), 14);
    l.writeUInt32LE(packed.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    locals.push(l, n, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, n);
    offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function addThree(page: Page, id: string) {
  const names = { png: `Site photo ${id}.png`, jpg: `Plant photo ${id}.jpg`, model: `Bracket ${id}.3mf` };
  await page.goto(roomPath('documents', AUDITED));
  await hydrated(page);
  await page.getByRole('button', { name: 'Choose files' }).click();
  const dialog = page.getByRole('dialog');
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Browse your computer' }).click();
  await (await chooser).setFiles([
    { name: names.png, mimeType: 'image/png', buffer: PNG },
    { name: names.jpg, mimeType: 'image/jpeg', buffer: JPEG },
    { name: names.model, mimeType: 'application/octet-stream', buffer: threeMf() },
  ]);
  await dialog.getByRole('button', { name: 'Add 3 files as drafts' }).click();
  await expect(dialog.locator('.okbox')).toBeVisible({ timeout: 30_000 });
  await dialog.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
  return names;
}

const row = (page: Page, name: string) => page.locator('.dr', { hasText: name.replace(/\.[^.]+$/, '') });
const idOf = async (page: Page, name: string) => (await row(page, name).locator('a.nm').getAttribute('href'))!.split('/').pop()!;

async function settled(page: Page, names: string[]) {
  await expect(async () => {
    await page.reload();
    for (const n of names) await expect(row(page, n).locator('.st')).not.toContainText('Processing', { timeout: 1000 });
  }).toPass({ timeout: 90_000, intervals: [2_000, 3_000, 5_000] });
}

test('files without a preview still publish and open', async ({ page, persona, request }) => {
  test.setTimeout(180_000);
  await persona('anika');
  const id = unique();
  const names = await addThree(page, id);
  await settled(page, [names.png, names.jpg, names.model]);

  await expect(row(page, names.png).locator('.st .badge')).toHaveText(['Draft']);
  await expect(row(page, names.png).locator('.r').first()).toHaveText('1');
  await expect(row(page, names.jpg).locator('.r').first()).toHaveText('1');
  await expect(row(page, names.model).locator('.st .badge')).toHaveText(['Draft', 'No preview']);
  await expect(row(page, names.model).locator('.r').first()).toHaveText('–');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await row(page, names.model).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/c2-no-preview-tag-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const modelId = await idOf(page, names.model);
  const pngId = await idOf(page, names.png);

  await page.goto(roomPath('details', modelId));
  await expect(page.locator('.vrow.cur .vh')).toContainText('No preview');
  await expect(page.locator('.vrow.cur .step[data-step="pages"]')).toHaveAttribute('data-state', 'skipped');

  await page.goto(roomPath('release'));
  // over five rows the folder starts closed
  const audited = page.getByRole('region', { name: '3.2 Audited financials' });
  const toggle = audited.locator('.fh2 .tg');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  const more = audited.getByRole('button', { name: /^Show all/ });
  if (await more.isVisible()) await more.click();
  for (const n of Object.values(names)) {
    const r = page.locator('.rr', { hasText: n.replace(/\.[^.]+$/, '') });
    await expect(r).not.toContainText('Being prepared');
    await r.getByRole('checkbox').check();
  }
  await expect(page.locator('.rr', { hasText: `Bracket ${id}` }).locator('.badge.b-np')).toHaveText('No preview');
  await page.getByRole('button', { name: 'Publish 3 drafts' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish 3 drafts' }).click();
  await expect(page.locator('.toast')).toContainText('3 drafts published');
  const published = await (await request.get(`${W}/nodes?parent=${AUDITED}`, { headers })).json();
  for (const n of Object.values(names)) expect(published.items.find((x: { name: string }) => x.name === n).state).toBe('published');
  // keep the demo's 1,248 published documents
  const ids = Object.values(names).map((n) => published.items.find((x: { name: string }) => x.name === n).id as string);
  try {

    await page.goto(roomPath('view', pngId));
    await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#vtag')).toContainText('1 page · PNG');
    await page.locator('#dl-btn').click();
    const pdf = page.waitForEvent('download');
    await page.locator('#dl-go').click();
    expect((await pdf).suggestedFilename()).toBe(`Site photo ${id}.pdf`);

    await page.goto(roomPath('view', modelId));
    const panel = page.locator('.nopv');
    await expect(panel.locator('h2')).toHaveText('No preview for this file type');
    await expect(panel.locator('p')).toHaveText('3MF files cannot be shown in the browser. Download the file to open it on your computer.');
    await expect(panel.locator('.cap').first()).toContainText('3MF file as uploaded, without a watermark');
    await expect(page.locator('#vtag')).toContainText('No preview · 3MF');
    await expect(page.locator('#info')).toContainText('PagesNo preview');
    await expect(page.locator('#info')).toContainText('WatermarkedNo');
    await expect(page.locator('#dl-btn')).toHaveCount(0);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoAxeViolations(page, `the no-preview panel (${scheme})`, { include: '.nopv' });
      await page.screenshot({ path: `${SHOTS}/c3-no-preview-panel-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    const original = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download the original file' }).click();
    expect((await original).suggestedFilename()).toBe(names.model);
    await expect(page.locator('.toast')).toContainText('Original file downloaded');

    await persona('jan');
    await page.goto(roomPath('view', modelId));
    await expect(panel.locator('p')).toHaveText('3MF files cannot be shown in the browser. You cannot download this file. Ask the room admin if you need it.');
    await expect(panel.getByRole('button')).toHaveCount(0);
    await expectNoAxeViolations(page, 'the no-preview panel for a bidder', { include: '.nopv' });
    await page.screenshot({ path: `${SHOTS}/c3-no-preview-bidder-light.png` });

    await page.goto(roomPath('view', pngId));
    await expect(page.locator('#p1 img')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#dl-btn')).toBeVisible();
  } finally {
    for (const nodeId of ids) expect((await request.post(`${W}/nodes/${nodeId}/withdraw`, { headers, data: {} })).ok()).toBe(true);
  }
});
