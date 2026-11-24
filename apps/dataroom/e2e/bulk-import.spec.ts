// SPDX-License-Identifier: AGPL-3.0-only
// uploads go in a per-run folder under 10 and are removed afterwards
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';
import { pdf, writeTree } from './import-files';
import { API_URL, expect, NODE, PERSONAS, ROOM_ID, roomPath, test, type PersonaKey } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const DIR = mkdtempSync(join(tmpdir(), 'vdrkit-d1-'));
const W = `${API_URL}/v1/workspaces/${ROOM_ID}`;
const idOf = (key: PersonaKey) => PERSONAS.find((p) => p.key === key)!.id;
const headers = (key: PersonaKey) => ({ 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': idOf(key) });

interface ApiNode { id: string; indexNumber: string | null; name: string; kind: string; state: string }
async function children(request: APIRequestContext, parent?: string): Promise<ApiNode[]> {
  const r = await request.get(`${W}/nodes${parent ? `?parent=${parent}` : ''}`, { headers: headers('anika') });
  expect(r.ok()).toBe(true);
  return (await r.json()).items;
}
const byIx = async (request: APIRequestContext, parent: string | undefined, ix: string) => (await children(request, parent)).find((n) => n.indexNumber === ix)!;

async function removeDrafts(request: APIRequestContext, folder: string) {
  for (const n of await children(request, folder)) {
    if (n.kind === 'folder') { await removeDrafts(request, n.id); continue; }
    const d = await (await request.get(`${W}/nodes/${n.id}/details`, { headers: headers('anika') })).json();
    for (const v of d.versions) if (v.status === 'draft') await request.post(`${W}/versions/${v.id}/remove-draft`, { headers: headers('anika'), data: {} });
  }
}

async function chooseFolder(page: Page, root: string) {
  await page.getByTestId('d1-folder').setInputFiles(root);
  await expect(page.getByRole('heading', { name: 'Check the index before you upload' })).toBeVisible();
}

const row = (page: Page, folder: string) => page.locator(`.trow2[data-folder="${folder}"]`);

test.describe('bulk import', () => {
  test('room admin sees the import screen', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('import'));
    await expect(page.getByRole('heading', { name: 'Import a set of documents into Project Heron' })).toBeVisible();
    await expect(page.locator('.crumbs')).toContainText('Bulk import');
    await expect(page.locator('.d1-steps li')).toHaveText(['Choose files', 'Check the index', 'Upload']);
    const into = page.getByLabel('Upload into');
    await expect(into.locator('option').first()).toHaveText('Top level of the index');
    await expect(into.locator('option', { hasText: '3 Finance' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Choose a folder', exact: true })).toBeVisible();
    const recent = page.getByRole('region', { name: 'Recent uploads' });
    await expect(recent.locator('.cap').first()).toHaveText('Times in SAST');
    await expect(recent.locator('.hist').first()).toContainText(/uploaded [\d,]+ files?/);
    await expect(page.getByRole('link', { name: 'Go to Documents' })).toHaveAttribute('href', roomPath('documents'));
  });

  test('Documents opens Bulk import on the open folder', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('import') + `?into=${NODE['2.4']}`);
    await expect(page.getByLabel('Upload into')).toHaveValue(NODE['2.4']);
  });

  test('a file dropped beside the drop zone keeps the check', async ({ page, persona }) => {
    await persona('anika');
    const root = writeTree(DIR, `Heron_DD_stray_${Date.now()}`, { 'Stray set/One.pdf': pdf(`Stray ${Date.now()}`) });
    await page.goto(roomPath('import'));
    await chooseFolder(page, root);
    // the browser opens a file whose dragover and drop nobody cancels
    const kept = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['%PDF-1.4'], 'Stray.pdf', { type: 'application/pdf' }));
      return ['dragover', 'drop'].map((type) => !document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })));
    });
    expect(kept).toEqual([true, true]);
  });

  test('checks numbers for a top-level import', async ({ page, persona }) => {
    await persona('anika');
    const stamp = Date.now();
    const root = writeTree(DIR, 'Heron_DD_check', {
      '03 Finance/Cash pool/Cash pool agreement.pdf': pdf(`Cash pool ${stamp}`),
      '12 Mining rights/01 Licences/Prospecting right.pdf': pdf(`Prospecting ${stamp}`),
      '12 Mining rights/02 Maps/Survey archive.zip': `PK fake ${stamp}`,
      'Broker letters/Letter one.pdf': pdf(`Broker ${stamp}`),
      'Broker letters/Thumbs.db': 'x',
    });
    await page.goto(roomPath('import'));
    await chooseFolder(page, root);
    await expect(page.locator('.head .sub')).toContainText('Heron_DD_check · 5 files in 6 folders');
    await expect(page.locator('.head .sub')).toContainText('into the top level of the index');

    await expect(row(page, '03 Finance').locator('.ix')).toHaveText('3');
    await expect(row(page, '03 Finance')).toContainText('Existing folder');
    await expect(row(page, '03 Finance/Cash pool')).toContainText('no number in the name, so placed after');
    await expect(row(page, '12 Mining rights').locator('input')).toHaveValue('12');
    await expect(row(page, '12 Mining rights')).toContainText('No bidder access');
    await expect(row(page, '12 Mining rights/02 Maps')).toContainText('1 without preview');
    await expect(row(page, 'Broker letters').locator('input')).toHaveValue('13');
    await expect(row(page, 'Broker letters')).toContainText('from Broker letters · no number in the name, so placed after 12');

    const summary = page.getByRole('region', { name: 'Summary' });
    await expect(summary.locator('.big2')).toHaveText('4');
    await expect(summary).toContainText('System files left out (Thumbs.db, .DS_Store)1');
    await expect(page.getByRole('region', { name: 'Bidder access' })).toContainText('2 new top-level folders have no bidder access');
    await expect(page.getByRole('region', { name: 'Files without preview' })).toContainText('1 file has no preview');
    const go = page.getByRole('button', { name: 'Upload 4 files as drafts' });
    await expect(go).toBeEnabled();

    const broker = row(page, 'Broker letters').locator('input');
    await broker.fill('12');
    await broker.press('Enter');
    await expect(row(page, 'Broker letters')).toContainText('Number used twice');
    await expect(row(page, '12 Mining rights')).toContainText('Number used twice');
    await expect(page.locator('#bar-cap')).toHaveText('Two folders have the same number. Change one of them to continue.');
    await expect(page.locator('#go-up')).toBeDisabled();
    await broker.fill('14');
    await broker.press('Enter');
    await expect(row(page, 'Broker letters')).toContainText('number set by you');
    await expect(page.locator('.trow2 .k-lock', { hasText: 'Number used twice' })).toHaveCount(0);
    await expect(page.locator('#go-up')).toBeEnabled();

    await page.getByRole('button', { name: 'Choose different files' }).click();
    await expect(page.getByRole('heading', { name: 'Import a set of documents into Project Heron' })).toBeVisible();
  });

  test('uploads into a folder and skips duplicates', async ({ page, persona, request }) => {
    await persona('anika');
    const ip = await byIx(request, undefined, '10');
    // same bytes as 2.4.2
    const original = await request.get(`${W}/nodes/${NODE['2.4.2']}/download?format=original`, { headers: headers('anika') });
    expect(original.ok()).toBe(true);
    const stamp = Date.now();
    const set = `Trade secrets ${stamp}`;
    const root = writeTree(DIR, `IP_${stamp}`, {
      [`${set}/Know-how register.pdf`]: pdf(`Know-how ${stamp}`),
      [`${set}/Assignment deed.pdf`]: pdf(`Assignment ${stamp}`),
      [`${set}/Copy of a contract.pdf`]: await original.body(),
    });
    await page.goto(roomPath('import') + `?into=${ip.id}`);
    await chooseFolder(page, root);
    await expect(page.locator('.head .sub')).toContainText('into 10 Intellectual property');
    const dups = page.getByRole('region', { name: 'Duplicates' });
    await expect(dups).toContainText('1 file is already in the room');
    await expect(dups).toContainText('Copy of a contract.pdf is identical to 2.4.2');
    await expect(page.locator('#go-up')).toHaveText('Upload 2 files as drafts');
    const number = await row(page, set).locator('input').inputValue();

    await page.locator('#go-up').click();
    try {
      await expect(page.getByRole('heading', { name: '2 files uploaded as drafts' })).toBeVisible({ timeout: 45_000 });
      await expect(page.locator('.head .sub')).toContainText('2 ready, 0 still processing', { timeout: 45_000 });
      await expect(page.getByRole('link', { name: 'Go to Release review' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to Documents' })).toHaveAttribute('href', roomPath('documents', ip.id));

      const folder = (await children(request, ip.id)).find((n) => n.name === set)!;
      expect(folder.indexNumber).toBe(`10.${number}`);
      expect((await children(request, folder.id)).map((n) => `${n.indexNumber} ${n.name}`))
        .toEqual([`10.${number}.1 Assignment deed.pdf`, `10.${number}.2 Know-how register.pdf`]);
    } finally {
      const folder = (await children(request, ip.id)).find((n) => n.name === set);
      if (folder) await removeDrafts(request, folder.id);
    }
  });

  test('keeps numbers when a file fails', async ({ page, persona, request }) => {
    await persona('anika');
    const ip = await byIx(request, undefined, '10');
    const stamp = Date.now();
    const set = `Licences ${stamp}`;
    const root = writeTree(DIR, `IPF_${stamp}`, {
      [`${set}/Assignment deed.pdf`]: pdf(`Assignment ${stamp}`),
      [`${set}/Know-how register.pdf`]: pdf(`Know-how ${stamp}`),
    });
    await page.route('**/upload-sessions', async (route) => {
      if (route.request().method() === 'POST' && (route.request().postData() ?? '').includes('Assignment deed')) {
        await route.fulfill({ status: 422, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Refused', detail: 'Refused for this test.' }) });
        return;
      }
      await route.continue();
    });
    await page.goto(roomPath('import') + `?into=${ip.id}`);
    await chooseFolder(page, root);
    await page.locator('#go-up').click();
    try {
      await expect(page.getByRole('heading', { name: '1 of 2 files uploaded as drafts' })).toBeVisible({ timeout: 45_000 });
      const attention = page.getByRole('region', { name: 'Files that need attention' });
      await expect(attention).toContainText('Refused for this test.');
      const folder = (await children(request, ip.id)).find((n) => n.name === set)!;
      // the folder number may be taken; only the .2 matters
      expect(folder.indexNumber).toMatch(/^10\.\d+$/);
      expect((await children(request, folder.id)).map((n) => `${n.indexNumber} ${n.name}`)).toEqual([`${folder.indexNumber}.2 Know-how register.pdf`]);
      await expect(attention).not.toContainText('as the check step showed');
    } finally {
      const folder = (await children(request, ip.id)).find((n) => n.name === set);
      if (folder) await removeDrafts(request, folder.id);
    }
  });

  test('asks about processing once every few seconds', async ({ page, persona, request }) => {
    await persona('anika');
    const ip = await byIx(request, undefined, '10');
    const stamp = Date.now();
    const set = `Slow previews ${stamp}`;
    const root = writeTree(DIR, `IPS_${stamp}`, { [`${set}/Patent schedule.pdf`]: pdf(`Patent ${stamp}`) });
    const asked: number[] = [];
    // hold every file in "processing" so the screen keeps asking
    await page.route('**/versions/processing', async (route) => {
      asked.push(Date.now());
      const r = await route.fetch();
      const body = await r.json();
      for (const it of body.items) it.status = 'processing';
      await route.fulfill({ response: r, json: body }).catch(() => undefined);
    });
    await page.goto(roomPath('import') + `?into=${ip.id}`);
    await chooseFolder(page, root);
    await page.locator('#go-up').click();
    try {
      await expect(page.getByRole('heading', { name: '1 file uploaded as drafts' })).toBeVisible({ timeout: 45_000 });
      await expect(page.locator('.head .sub')).toContainText('1 still processing');
      const from = asked.length;
      await page.waitForTimeout(7_000);
      expect(asked.length - from).toBeLessThanOrEqual(3);
      expect(asked.length - from).toBeGreaterThanOrEqual(1);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      for (const folder of (await children(request, ip.id)).filter((n) => n.name.startsWith('Slow previews '))) await removeDrafts(request, folder.id);
    }
  });

  test('contributor imports only where she may add files', async ({ page, persona }) => {
    await persona('maria');
    await page.goto(roomPath('import'));
    const options = await page.getByLabel('Upload into').locator('option').allTextContents();
    expect(options[0]).toBe('3 Finance');
    expect(options.every((o) => o.startsWith('3'))).toBe(true);
    const root = writeTree(DIR, 'Maria_set', { 'Bank letters/Facility letter.pdf': pdf(`Facility ${Date.now()}`), 'Bank letters/Other.pdf': pdf(`Other ${Date.now()}`) });
    await chooseFolder(page, root);
    await expect(page.locator('.trow2 input')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Bidder access' })).toHaveCount(0);
    await expect(page.locator('#bar-cap')).toContainText('Nothing is visible to bidders until it is published.');
  });

  for (const key of ['jan', 'lars', 'liesl'] as const) {
    test(`${key} gets "not available"`, async ({ page, persona }) => {
      await persona(key);
      await page.goto(roomPath('import'));
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    });
  }
});

test.describe('document details', () => {
  async function tarnley(request: APIRequestContext) { return byIx(request, NODE['2.4'], '2.4.3'); }

  test('room admin sees versions, access and views', async ({ page, persona, request }) => {
    await persona('anika');
    const doc = await tarnley(request);
    await page.goto(roomPath('details', doc.id));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('2.4.3Tarnley Logistics addendum 2024');
    await expect(page.locator('.crumbs')).toContainText('2.4.3 Tarnley Logistics addendum 2024');
    await expect(page.locator('.head .crumb')).toHaveText('2 Legal › 2.4 Material contracts');
    await expect(page.locator('.head .badge')).toHaveText('Version 2 waiting for release');
    await expect(page.getByRole('link', { name: 'Open in the viewer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload a new version' })).toBeVisible();

    const v2 = page.locator('.vrow[data-version="2"]');
    await expect(v2).toContainText('Bidders still see version 1 until this one is published.');
    await expect(v2.getByRole('link', { name: 'Review and publish' })).toHaveAttribute('href', roomPath('release'));
    // not pressed: other tests use 2.4.3
    await expect(v2.getByRole('button', { name: 'Release version 2' })).toBeEnabled();
    await expect(v2.getByRole('button', { name: 'Release version 2' })).toHaveAttribute('title', 'Publishes it now in place of version 1. Bidders hear about it as each chose in their notification settings.');
    await expect(page.getByRole('checkbox', { name: 'Release quietly, no email' })).not.toBeChecked();
    await expect(v2.getByRole('button', { name: 'Remove draft' })).toBeVisible();
    await expect(v2.locator('[data-step="virus"]')).toHaveAttribute('data-state', 'skipped');
    const v1 = page.locator('.vrow[data-version="1"]');
    await expect(v1.locator('.badge')).toHaveText('Bidders see this');
    await expect(v1).toContainText(/Published \w{3} \d+ \w{3}, \d\d:\d\d SAST by Anika Pillay\./);

    const who = page.getByRole('region', { name: 'Who can see it' });
    await expect(who.locator('.cap').first()).toHaveText('Follows 2.4 Material contracts');
    await expect(who.locator('[data-group="Bidder A"] .lv')).toHaveText('View and print');
    await expect(who.locator('[data-group="Bidder C financiers"] .lv')).toHaveText('No access');
    await expect(who).toContainText('These levels apply to version 2 once it is published.');
    await expect(page.getByRole('region', { name: 'Opened by' })).toContainText('Version 1, since it was published');
    await expect(page.getByRole('region', { name: 'File' })).toContainText(/SHA-256 [0-9a-f]{8} /);

    await v1.getByRole('button', { name: 'Withdraw' }).click();
    const dlg = page.getByRole('dialog', { name: 'Withdraw 2.4.3 from bidders' });
    await expect(dlg).toContainText('Bidder A, Bidder B and Bidder C stop seeing Tarnley Logistics addendum 2024 at once. Version 2 is still a draft, so no earlier version takes its place.');
    await expect(dlg.getByLabel(/Reason/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
  });

  test('copies the fingerprint', async ({ page, persona, request }) => {
    // Firefox and WebKit grant no clipboard read permission
    await page.addInitScript(() => {
      const w = window as unknown as { copied: string[]; refuse: boolean };
      w.copied = []; w.refuse = false;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (s: string) => { if (w.refuse) throw new DOMException('Not allowed', 'NotAllowedError'); w.copied.push(s); } },
      });
    });
    await persona('anika');
    const doc = await tarnley(request);
    await page.goto(roomPath('details', doc.id));
    const file = page.getByRole('region', { name: 'File' });
    await file.getByRole('button', { name: 'Copy fingerprint' }).click();
    await expect(page.locator('.toast')).toContainText('Fingerprint copied');
    const copied = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(/^[0-9a-f]{64}$/);
    await page.evaluate(() => { (window as unknown as { refuse: boolean }).refuse = true; });
    await file.getByRole('button', { name: 'Copy fingerprint' }).click();
    await expect(page.locator('.toast')).toContainText('The fingerprint was not copied');
    await expect(page.locator('.toast')).toContainText(copied[0]!);
  });

  test('contributor can remove her own draft but not publish', async ({ page, persona, request }) => {
    await persona('maria');
    const doc = await byIx(request, (await byIx(request, NODE['3'], '3.2')).id, '3.2.7');
    await page.goto(roomPath('details', doc.id));
    await expect(page.locator('.vrow[data-version="1"]')).toContainText('Johan Steyn or a room admin publishes it.');
    await expect(page.getByRole('button', { name: 'Remove draft' })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Review and publish' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Release/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Opened by' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Who can see it' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set access for this file' })).toHaveCount(0);
  });

  test('shows why processing failed', async ({ page, persona, request }) => {
    const aud = await byIx(request, NODE['3'], '3.2');
    const bytes = Buffer.from(`%PDF-1.7\n${'garbage '.repeat(100)}${Date.now()}`);
    const { createHash } = await import('node:crypto');
    const s = await (await request.post(`${W}/upload-sessions`, { headers: headers('maria'), data: {
      targetFolderId: aud.id, path: `Damaged report ${Date.now()}.pdf`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'application/pdf',
    } })).json();
    await request.put(`${API_URL}${s.uploadUrl}`, { headers: { ...headers('maria'), 'content-type': 'application/octet-stream' }, data: bytes });
    const done = await (await request.post(`${W}/upload-sessions/${s.id}/complete`, { headers: headers('maria'), data: {} })).json();

    await persona('anika');
    try {
      await expect(async () => {
        await page.goto(roomPath('details', done.nodeId));
        await expect(page.locator('.head .badge')).toHaveText('Not ready: processing failed', { timeout: 2000 });
      }).toPass({ timeout: 30_000 });
      const why = page.locator('.why');
      await expect(why).toContainText('Upload a new copy');
      await expect(page.locator('.step.bad')).toHaveCount(1);
      await why.getByRole('button', { name: 'Ask Maria Botha' }).click();
      await expect(page.locator('.toast')).toContainText('Email sent to Maria Botha');
      // the same file fails the same way, but it does go through the queue again
      await why.getByRole('button', { name: 'Process again' }).click();
      await expect(page.locator('.toast')).toContainText('Processing started again');
    } finally {
      await request.post(`${W}/versions/${done.versionId}/remove-draft`, { headers: headers('anika'), data: {} });
    }
  });

  test('new version stays a draft until removed', async ({ page, persona, request }) => {
    await persona('anika');
    const emp = await byIx(request, NODE['2'], '2.5');
    const doc = (await children(request, emp.id)).find((n) => n.kind === 'document' && n.state === 'published' && n.name.endsWith('.pdf'))!;
    await page.goto(roomPath('details', doc.id));
    await page.getByTestId('d2-file').setInputFiles({ name: doc.name, mimeType: 'application/pdf', buffer: pdf(`New version ${Date.now()}`) });
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^Upload as version \d+$/ }).click();
    await expect(page.locator('.toast')).toContainText('New version uploaded');
    const draft = page.locator('.vrow').first();
    await expect(draft.locator('.badge')).toHaveText('Draft');
    await expect(page.locator('.head .badge')).toHaveText(/^Version \d+ waiting for release$/);

    await draft.getByRole('button', { name: 'Remove draft' }).click();
    const confirm = page.getByRole('dialog', { name: /^Remove the draft of version \d+$/ });
    await expect(confirm).toContainText('Bidders keep seeing version 1.');
    await expect(confirm.locator('.dh')).toHaveCSS('display', 'block');
    await expect(confirm.locator('h2')).toHaveCSS('text-transform', 'none');
    await expect(confirm.locator('h2')).toHaveCSS('font-size', '18px');
    await confirm.getByRole('button', { name: 'Remove draft' }).click();
    await expect(page.locator('.toast')).toContainText('Draft removed');
    await expect(page.locator('.vrow').first()).toHaveAttribute('data-status', 'removed');
    await expect(page.locator('.head .badge')).toHaveText('Published');
  });

  test('hides details from bidders', async ({ page, persona }) => {
    for (const key of ['jan', 'pieter', 'lars'] as const) {
      await persona(key);
      await page.goto(roomPath('details', NODE['2.4.2']));
      await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
    }
    await persona('liesl');
    await page.goto(roomPath('details', NODE['2.4.2']));
    await expect(page.locator('.vrow')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Who can see it' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Upload a new/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  });

  test('fits a phone without scrolling sideways', async ({ page, persona, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await persona('anika');
    await page.goto(roomPath('details', (await tarnley(request)).id));
    await expect(page.locator('.vrow').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.goto(roomPath('import'));
    await expect(page.getByRole('heading', { name: 'Import a set of documents into Project Heron' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
