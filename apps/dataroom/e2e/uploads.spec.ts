// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { DEV_TENANT_ID } from '../src/dev-tools/personas';
import { pdf, writeTree } from './import-files';
import { API_URL, expect, hydrated, NODE, PERSONAS, ROOM_ID, roomPath, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const DIR = mkdtempSync(join(tmpdir(), 'vdrkit-uploads-'));
const W = `${API_URL}/v1/workspaces/${ROOM_ID}`;
const headers = { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': PERSONAS.find((p) => p.key === 'anika')!.id };

async function folder10(request: APIRequestContext): Promise<string> {
  const r = await request.get(`${W}/nodes`, { headers });
  return (await r.json()).items.find((n: { indexNumber: string }) => n.indexNumber === '10').id;
}
async function chooseFolder(page: Page, root: string) {
  await page.getByTestId('d1-folder').setInputFiles(root);
  await expect(page.getByRole('heading', { name: 'Check the index before you upload' })).toBeVisible();
}

test.describe('uploads', () => {
  test('shows the 5 GB limit per file', async ({ page, persona }) => {
    await persona('anika');
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    await page.getByRole('button', { name: 'Choose files' }).click();
    await expect(page.getByRole('dialog')).toContainText('PDF, Word, Excel, PowerPoint and images, up to 5 GB each. A dropped folder keeps its subfolders.');
    await page.goto(roomPath('import'));
    await expect(page.getByText('Up to 5,000 files and 20 GB at a time, 5 GB per file. If your connection drops, the upload carries on once you are back online.')).toBeVisible();
  });

  test('hashes a 300 MB file in pieces, matching Node', async ({ page, persona, request }) => {
    test.setTimeout(120_000);
    await persona('anika');
    // random, so order matters
    const root = join(DIR, `Hash_${Date.now()}`);
    mkdirSync(join(root, 'Large'), { recursive: true });
    const file = join(root, 'Large', 'Site survey scans.zip');
    const h = createHash('sha256');
    const fd = openSync(file, 'w');
    for (let i = 0; i < 300; i++) { const block = randomBytes(1024 * 1024); h.update(block); writeSync(fd, block); }
    closeSync(fd);
    const expected = h.digest('hex');
    try {
      const sent = new Promise<string>((resolve) => {
        void page.route('**/upload-plans', async (route) => {
          const body = route.request().postDataJSON() as { files: { path: string; sha256?: string }[] };
          const f = body.files.find((x) => x.sha256);
          if (f?.sha256) resolve(f.sha256);
          await route.continue();
        });
      });
      await page.goto(roomPath('import') + `?into=${await folder10(request)}`);
      await chooseFolder(page, root);
      expect(await sent).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Add files reads each file once to hash it', async ({ page, persona, request }) => {
    await persona('anika');
    await page.addInitScript(() => {
      const reads: Record<string, number> = {};
      (window as unknown as { reads: typeof reads }).reads = reads;
      File.prototype.slice = function (this: File, ...range: [number?, number?, string?]) {
        reads[this.name] = (reads[this.name] ?? 0) + 1;
        return Blob.prototype.slice.apply(this, range);
      };
    });
    const stamp = Date.now();
    const names = [1, 2, 3, 4].map((i) => `Hashed once ${stamp} ${i}.pdf`);
    await page.goto(roomPath('documents', await folder10(request)));
    await hydrated(page);
    await page.getByRole('button', { name: 'Choose files' }).click();
    const dialog = page.getByRole('dialog');
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Browse your computer' }).click();
    await (await chooser).setFiles(names.map((name) => ({ name, mimeType: 'application/pdf', buffer: pdf(name) })));
    await expect(dialog.getByRole('button', { name: 'Add 4 files as drafts' })).toBeEnabled();
    await expect(dialog).toContainText('No file is identical to a document already in the room.');
    const reads = await page.evaluate(() => (window as unknown as { reads: Record<string, number> }).reads);
    expect(names.map((n) => reads[n] ?? 0)).toEqual([1, 1, 1, 1]);
  });

  test('Bulk import resumes an S3 upload after a dropped connection', async ({ page, persona, request }) => {
    await persona('anika');
    const stamp = Date.now();
    const body = pdf(`Resume ${stamp}`);
    const partSize = Math.ceil(body.length / 2);
    const root = writeTree(DIR, `Resume_${stamp}`, { [`Set ${stamp}/Resume check.pdf`]: body });
    const sid = '7d0c4c39-3f43-4c1e-9a55-0d8c1f5e2b10';
    const puts: string[] = [];
    let resumed = 0;
    let completed: unknown = null;
    // part 2 drops once
    await page.route('**/upload-sessions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        id: sid, method: 'presigned', partSize, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        parts: [{ partNumber: 1, url: '/__store/p1' }, { partNumber: 2, url: '/__store/p2' }] }) });
    });
    await page.route(`**/upload-sessions/${sid}`, async (route) => {
      resumed++;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        id: sid, status: 'open', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), method: 'presigned', size: body.length, partSize,
        received: [{ partNumber: 1, etag: '"e1"', size: partSize }], parts: [{ partNumber: 2, url: '/__store/p2-fresh' }] }) });
    });
    await page.route(`**/upload-sessions/${sid}/complete`, async (route) => {
      completed = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        nodeId: '5b0c4c39-3f43-4c1e-9a55-0d8c1f5e2b11', versionId: '6b0c4c39-3f43-4c1e-9a55-0d8c1f5e2b12', versionNo: 1, indexNumber: null, createdFolders: [] }) });
    });
    await page.route('**/__store/**', async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop()!;
      puts.push(name);
      if (name === 'p2') return route.abort('connectionreset');
      await route.fulfill({ status: 200, headers: { etag: name === 'p1' ? '"e1"' : '"e2"' }, body: '' });
    });
    await page.goto(roomPath('import') + `?into=${await folder10(request)}`);
    await chooseFolder(page, root);
    await page.locator('#go-up').click();
    await expect(page.getByRole('heading', { name: '1 file uploaded as drafts' })).toBeVisible({ timeout: 45_000 });
    expect(puts).toEqual(['p1', 'p2', 'p2-fresh']);
    expect(resumed).toBe(1);
    expect(completed).toEqual({ parts: [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }] });
  });
});

test.describe('Add files after a hiccup', () => {
  async function addOne(page: Page, request: APIRequestContext, name: string) {
    return addSome(page, request, [name]);
  }
  async function addSome(page: Page, request: APIRequestContext, names: string[]) {
    await page.goto(roomPath('documents', await folder10(request)));
    await hydrated(page);
    await page.getByRole('button', { name: 'Choose files' }).click();
    const dialog = page.getByRole('dialog');
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Browse your computer' }).click();
    await (await chooser).setFiles(names.map((name) => ({ name, mimeType: 'application/pdf', buffer: pdf(name) })));
    await dialog.getByRole('button', { name: names.length === 1 ? 'Add 1 file as a draft' : `Add ${names.length} files as drafts` }).click();
    return dialog;
  }

  test('retries after a 503 from storage', async ({ page, persona, request }) => {
    await persona('anika');
    const name = `Retry ${Date.now()}.pdf`;
    let puts = 0;
    await page.route('**/upload-sessions/*/content', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      if (++puts === 1) {
        return route.fulfill({ status: 503, contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'about:blank', title: 'Storage unavailable', status: 503 }) });
      }
      return route.continue();
    });
    const dialog = await addOne(page, request, name);
    const row = dialog.locator(`.fl-r[data-file="${name}"]`);
    await expect(row.getByTestId('retrying')).toHaveText(/· trying again in [12] s$/);
    await expect(dialog.locator('.okbox')).toContainText('1 file is in 10 ');
    expect(puts).toBe(2);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
    await expect(page.locator('.dr', { hasText: name.replace(/\.pdf$/, '') })).toBeVisible();
  });

  test('New version shows the retry and can be closed while it waits', async ({ page, persona }) => {
    await persona('anika');
    let posts = 0;
    await page.route('**/upload-sessions', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++;
      return route.fulfill({ status: 503, contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Service unavailable', status: 503 }) });
    });
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    const row = page.locator('.dr', { hasText: 'Tarnley Logistics supply agreement' });
    const dialog = page.getByRole('dialog');
    await expect(async () => {
      await row.evaluate((el) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['%PDF-1.4'], 'Tarnley supply agreement signed.pdf', { type: 'application/pdf' }));
        for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await dialog.getByRole('button', { name: 'Upload as version 2' }).click();
    await expect(dialog.getByTestId('retrying')).toHaveText(/· trying again in \d+ s$/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    const sent = posts;
    await page.waitForTimeout(5_000);
    expect(posts).toBe(sent);
  });

  test('resends only the failed S3 part', async ({ page, persona, request }) => {
    await persona('anika');
    const name = `Retry part ${Date.now()}.pdf`;
    const size = pdf(name).length;
    const partSize = Math.ceil(size / 2);
    const sid = '8d0c4c39-3f43-4c1e-9a55-0d8c1f5e2b20';
    const puts: string[] = [];
    let completed: unknown = null;
    // part 2 gets a 503 once
    await page.route('**/upload-sessions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        id: sid, method: 'presigned', partSize, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        parts: [{ partNumber: 1, url: '/__store/q1' }, { partNumber: 2, url: '/__store/q2' }] }) });
    });
    await page.route(`**/upload-sessions/${sid}/complete`, async (route) => {
      completed = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        nodeId: '5b0c4c39-3f43-4c1e-9a55-0d8c1f5e2b21', versionId: '6b0c4c39-3f43-4c1e-9a55-0d8c1f5e2b22', versionNo: 1, indexNumber: '10.99', createdFolders: [] }) });
    });
    await page.route('**/__store/**', async (route) => {
      const part = new URL(route.request().url()).pathname.split('/').pop()!;
      puts.push(part);
      if (part === 'q2' && puts.filter((p) => p === 'q2').length === 1) return route.fulfill({ status: 503, body: '' });
      await route.fulfill({ status: 200, headers: { etag: `"${part}"` }, body: '' });
    });
    const dialog = await addOne(page, request, name);
    await expect(dialog.locator(`.fl-r[data-file="${name}"]`).getByTestId('retrying')).toBeVisible();
    await expect(dialog.locator('.okbox')).toContainText('1 file is in 10 ');
    expect(puts).toEqual(['q1', 'q2', 'q2']);
    expect(completed).toEqual({ parts: [{ partNumber: 1, etag: '"q1"' }, { partNumber: 2, etag: '"q2"' }] });
  });

  test('does not retry a 415', async ({ page, persona, request }) => {
    await persona('anika');
    const name = `Refused ${Date.now()}.pdf`;
    let starts = 0;
    await page.route('**/upload-sessions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      starts++;
      await route.fulfill({ status: 415, contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Unsupported media type', status: 415, detail: 'This type of file is not accepted.' }) });
    });
    const dialog = await addOne(page, request, name);
    await expect(dialog.getByRole('alert')).toContainText('1 file was not added');
    await expect(dialog.getByRole('alert')).toContainText(`${name}: This type of file is not accepted.`);
    expect(starts).toBe(1);
    await expect(dialog.getByTestId('retrying')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Try again/ })).toHaveCount(0);
  });

  test('Try again resends only the failed files', async ({ page, persona, request }) => {
    test.setTimeout(120_000);
    await persona('anika');
    const stamp = Date.now();
    const [ok, hiccup, refused] = [`Aa fine ${stamp}.pdf`, `Bb hiccup ${stamp}.pdf`, `Cc refused ${stamp}.pdf`];
    const starts: string[] = [];
    const hiccupSessions = new Set<string>();
    let hiccupPuts = 0;
    // 415 for one file, 503 on every try for the other
    await page.route('**/upload-sessions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const path = (route.request().postDataJSON() as { path: string }).path;
      starts.push(path);
      if (path === refused) {
        return route.fulfill({ status: 415, contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'about:blank', title: 'Unsupported media type', status: 415, detail: 'This type of file is not accepted.' }) });
      }
      const res = await route.fetch();
      const json = await res.json();
      if (path === hiccup) hiccupSessions.add(json.id);
      return route.fulfill({ response: res, json });
    });
    await page.route('**/upload-sessions/*/content', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
      if (route.request().method() === 'PUT' && hiccupSessions.has(id) && ++hiccupPuts <= 4) {
        return route.fulfill({ status: 503, contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'about:blank', title: 'Storage unavailable', status: 503 }) });
      }
      return route.continue();
    });
    const dialog = await addSome(page, request, [ok, hiccup, refused]);
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('2 files were not added', { timeout: 45_000 });
    await expect(alert).toContainText(`${hiccup}: Storage unavailable`);
    await expect(alert).toContainText(`${refused}: This type of file is not accepted.`);
    await expect(dialog.locator('.okbox')).toContainText('1 file is in 10 ');
    expect(hiccupPuts).toBe(4);
    await dialog.getByRole('button', { name: 'Try again (1 file)' }).click();
    await expect(dialog.locator('.okbox')).toContainText('2 files are in 10 ');
    await expect(alert).toContainText('1 file was not added');
    await expect(alert).toContainText(`${refused}: This type of file is not accepted.`);
    await expect(alert).not.toContainText(hiccup);
    await expect(dialog.getByRole('button', { name: /Try again/ })).toHaveCount(0);
    expect(starts.filter((p) => p === ok)).toHaveLength(1);
    expect(starts.filter((p) => p === hiccup)).toHaveLength(2);
    expect(starts.filter((p) => p === refused)).toHaveLength(1);
    expect(hiccupPuts).toBe(5);
    await dialog.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
    for (const n of [ok, hiccup]) await expect(page.locator('.dr', { hasText: n.replace(/.pdf$/, '') })).toBeVisible();
    await expect(page.locator('.dr', { hasText: refused.replace(/.pdf$/, '') })).toHaveCount(0);
  });
});

// moved or changed on disk after it was picked
test.describe('a file that cannot be read', () => {
  const lose = (page: Page) => page.addInitScript(() => {
    File.prototype.slice = function (this: File, ...range: [number?, number?, string?]) {
      const part = Blob.prototype.slice.apply(this, range);
      if (this.name.startsWith('Gone')) part.arrayBuffer = () => Promise.reject(new DOMException('The file could not be read.', 'NotReadableError'));
      return part;
    };
  });
  const WHY = 'could not be read. It may have been moved or changed since you chose it';

  test('Add files leaves it out and adds the rest', async ({ page, persona, request }) => {
    await persona('anika');
    await lose(page);
    const stamp = Date.now();
    const names = [`Gone ${stamp}.pdf`, `Kept ${stamp}.pdf`];
    await page.goto(roomPath('documents', await folder10(request)));
    await hydrated(page);
    await page.getByRole('button', { name: 'Choose files' }).click();
    const dialog = page.getByRole('dialog');
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Browse your computer' }).click();
    await (await chooser).setFiles(names.map((name) => ({ name, mimeType: 'application/pdf', buffer: pdf(name) })));
    await expect(dialog.locator(`.fl-r[data-file="${names[0]}"]`)).toContainText(WHY);
    await dialog.getByRole('button', { name: 'Add 1 file as a draft' }).click();
    await expect(dialog.locator('.okbox')).toContainText('1 file is in 10 ');
  });

  test('Bulk import goes back to choosing and names the file', async ({ page, persona }) => {
    await persona('anika');
    await lose(page);
    const stamp = Date.now();
    const root = writeTree(DIR, `Unreadable_${stamp}`, { [`Set ${stamp}/Gone.pdf`]: pdf(`Gone ${stamp}`), [`Set ${stamp}/Kept.pdf`]: pdf(`Kept ${stamp}`) });
    await page.goto(roomPath('import'));
    await hydrated(page);
    await page.getByTestId('d1-folder').setInputFiles(root);
    await expect(page.getByRole('alert').filter({ hasText: WHY })).toContainText('Gone.pdf');
    await expect(page.getByRole('button', { name: 'Choose a folder' })).toBeVisible();
  });
});

test.describe('virus scan', () => {
  test('says when a file is too large to scan', async ({ page, persona, request }) => {
    await persona('anika');
    const d = await (await request.get(`${W}/nodes/${NODE['2.4.2']}/details`, { headers })).json();
    const v = d.versions[0];
    const before = v.processing.steps.virus === 'done' ? 'clean' : v.processing.virusSkip?.reason ?? null;
    const set = (data: Record<string, unknown>) => request.post(`${API_URL}/v1/dev/virus-scan`, { headers, data });
    expect((await set({ versionId: v.id, virusScan: 'too_large', virusScanLimit: 1024 * 1024 * 1024 })).status()).toBe(204);
    try {
      await page.goto(roomPath('details', NODE['2.4.2']));
      const row = page.locator(`.vrow[data-version="${v.number}"]`);
      await expect(row.locator('[data-step="virus"]')).toHaveAttribute('data-state', 'skipped');
      await expect(row.getByTestId('not-scanned')).toHaveText('Not scanned: larger than 1 GB.');
      await expect(row.locator('[data-step="virus"]')).toHaveAttribute('title', 'Not scanned: larger than 1 GB.');
    } finally {
      await set({ versionId: v.id, virusScan: before });
    }
    await page.reload();
    await expect(page.getByTestId('not-scanned')).toHaveCount(0);
  });
});
