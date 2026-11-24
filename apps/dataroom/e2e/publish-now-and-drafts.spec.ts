// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expectNoAxeViolations } from './a11y-helpers';
import { API_URL, expect, hydrated, NODE, ROOM_ID, roomPath, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

function pdf(text: string): Buffer {
  const body = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function childByNumber(page: Page, parent: string | null, ix: string): Promise<string> {
  const list = await (await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes${parent ? `?parent=${parent}` : ''}`)).json();
  return list.items.find((n: { indexNumber: string }) => n.indexNumber === ix).id as string;
}

async function upload(page: Page, files: { name: string; text: string }[]) {
  await page.getByRole('button', { name: 'Choose files' }).click();
  const dialog = page.getByRole('dialog');
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Browse your computer' }).click();
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: 'application/pdf', buffer: pdf(f.text) })));
  return dialog;
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('Publish now confirms once and rejects duplicates', async ({ page, persona }) => {
      await persona('anika');
      const leases = await childByNumber(page, NODE['2'], '2.6');
      await page.goto(roomPath('documents', leases));
      await hydrated(page);
      const first = page.locator('section[aria-label="Folder contents"] > *').first();
      await expect(first).toHaveClass(/dropzone/);
      await expect(first).toContainText('Drop files here to add them to 2.6 Property leases');

      const id = unique();
      const name = `Publish now ${scheme} ${id}`;
      const dialog = await upload(page, [{ name: `${name}.pdf`, text: `p ${id}` }]);
      await dialog.getByRole('button', { name: 'Add 1 file as a draft' }).click();
      await expect(dialog.locator('.okbox')).toContainText('Keep it as a draft, or publish it now.');
      await expect(dialog.locator('.dw-f .btn')).toHaveText(['Publish now', 'Keep as draft']);
      await expect(dialog.locator('.dw-f .btn.primary')).toBeFocused();
      await expectNoAxeViolations(page, `the Done step with Publish now (${scheme})`);

      await dialog.getByRole('button', { name: 'Publish now' }).click();
      const ask = dialog.getByRole('group', { name: 'Publish 1 file now?' });
      await expect(ask).toContainText('Bidder A, Bidder B and Bidder C will see it, each at the level set for the folder.');
      await expect(ask).toContainText('A file still being prepared for viewing is published as soon as it is ready.');
      await expect(dialog.locator('.dw-f .btn')).toHaveText(['Cancel', 'Publish 1 file']);
      await expect(dialog.getByRole('button', { name: 'Publish 1 file' })).toBeFocused();
      await expectNoAxeViolations(page, `the Publish now confirmation (${scheme})`);
      await dialog.getByRole('button', { name: 'Publish 1 file' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/documents/${leases}$`));
      await expect(page.locator('.toast')).toContainText(/1 file is (being )?published/);

      const row = page.locator('.dr', { hasText: name });
      const nodeId = (await row.getAttribute('data-doc'))!;
      await expect(async () => {
        const n = await (await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes/${nodeId}`)).json();
        expect(n.state).toBe('published');
      }).toPass({ timeout: 60_000 });

      await page.reload();
      await hydrated(page);
      const again = await upload(page, [{ name: `Copy ${id}.pdf`, text: `p ${id}` }]);
      const dup = again.locator('.fl-r', { hasText: `Copy ${id}.pdf` });
      await expect(dup.locator('.why')).toHaveText(new RegExp(`^Not added: the same file is already 2\\.6\\.\\d+ ${name}\\.pdf\\.$`));
      await expect(dup.locator('.k')).toHaveText('Not added');
      await expect(again).toContainText('1 file is already in the room, so it is not added.');
      await expectNoAxeViolations(page, `the upload check with a duplicate (${scheme})`);
      await again.getByRole('button', { name: 'Back' }).click();
      await again.getByRole('button', { name: 'Cancel' }).click();

      expect((await page.request.post(`/v1/workspaces/${ROOM_ID}/nodes/${nodeId}/withdraw`, { data: {} })).ok()).toBe(true);
    });

    test('deletes a draft from its menu', async ({ page, persona }) => {
      await persona('anika');
      const leases = await childByNumber(page, NODE['2'], '2.6');
      await page.goto(roomPath('documents', leases));
      await hydrated(page);
      const id = unique();
      const name = `Delete me ${scheme} ${id}`;
      const dialog = await upload(page, [{ name: `${name}.pdf`, text: `d ${id}` }]);
      await dialog.getByRole('button', { name: 'Add 1 file as a draft' }).click();
      await dialog.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
      const row = page.locator('.dr', { hasText: name });
      const ix = (await row.locator('.ix').textContent())!;
      await row.getByRole('button', { name: /Actions for/ }).click();
      const del = page.getByRole('menu').getByRole('menuitem', { name: /^Delete draft/ });
      await expect(del).toHaveText('Delete draftDeletes it and its file. It was never published.');
      await del.click();
      const confirm = page.getByRole('dialog', { name: `Delete ${ix} ${name}?` });
      await expect(confirm.locator('ul.facts li')).toHaveText([
        'It was never published, so nobody outside the seller team has seen it.',
        'The file is deleted and cannot be brought back.',
        'The upload and the deletion stay in the activity log.',
      ]);
      await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expectNoAxeViolations(page, `the Delete draft confirmation (${scheme})`);
      await confirm.getByRole('button', { name: 'Delete draft' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(page.locator('.toast')).toContainText(`${ix} ${name} is deleted`);
      await expect(row).toHaveCount(0);
    });

    test('Permissions outline inherited levels', async ({ page, persona }) => {
      await persona('anika');
      await page.goto(roomPath('permissions'));
      await hydrated(page);
      const legend = page.locator('.e3 .lg');
      await expect(legend).toContainText('Outlined: follows the folder above');
      await expect(legend).toContainText('NoneNo access given');
      await expect(legend).toContainText('BlockedBlocked here, even if the folder above gives access');
      const none = page.locator('.e3 .mx .cell .lvl.none').first();
      await expect(none).toHaveText('None');
      const shape = await none.evaluate((el) => { const s = getComputedStyle(el); return [s.borderTopStyle, s.height, s.paddingLeft]; });
      expect(shape).toEqual(['solid', '24px', '9px']);
      await page.getByRole('button', { name: 'Open Finance' }).click();
      const inh = page.locator('.e3 .mx .lvl.inh').first();
      await expect(inh).toBeVisible();
      const look = await inh.evaluate((el) => { const c = getComputedStyle(el); return [c.borderTopStyle, c.backgroundColor, c.height, c.paddingLeft]; });
      expect(look).toEqual(['solid', 'rgba(0, 0, 0, 0)', '24px', '9px']);
      await expectNoAxeViolations(page, `E3 Permissions (${scheme})`);
    });
  });
}

test('folder can take a free number such as 100', async ({ page, persona }) => {
  await persona('anika');
  const make = async (name: string) => {
    const r = await page.request.post(`/v1/workspaces/${ROOM_ID}/folders`, { data: { parentId: NODE['3'], name } });
    expect(r.status()).toBe(201);
    return (await r.json()) as { id: string; indexNumber: string };
  };
  const id = unique();
  const a = await make(`Leases ${id}`);
  expect(a.indexNumber).toMatch(/^3\.\d+$/);
  await page.goto(roomPath('documents', await childByNumber(page, NODE['3'], '3.2')));
  await hydrated(page);
  await page.getByRole('button', { name: 'Edit index' }).click();
  await expect(page.locator('.stree.editing .tnote')).toContainText('A folder can take any free number, such as 100.');
  const entry = (ix: string) => page.locator('.stree .sf').filter({ has: page.locator('.ix', { hasText: new RegExp(`^${ix.replace(/\./g, '\\.')}$`) }) });
  const renumber = async (from: string) => {
    await entry(from).click();
    await page.getByLabel(`Index number for Leases ${id}`).fill('3.100');
    await page.getByRole('button', { name: `Save ${from}` }).click();
    await expect(entry('3.100')).toBeVisible();
  };
  await renumber(a.indexNumber);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(entry(a.indexNumber)).toContainText(`Leases ${id}`);
  await renumber(a.indexNumber);
  // not 3.101
  const b = await make(`Title deeds ${id}`);
  expect(b.indexNumber).toBe(a.indexNumber);
  await page.getByRole('button', { name: 'Done' }).click();
});

test('document name in Release review opens the preview', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(roomPath('release'));
  await hydrated(page);
  const row = page.locator('.rr').filter({ has: page.locator('.ix', { hasText: /^2\.4\.13$/ }) });
  const eye = row.getByRole('link', { name: 'Preview 2.4.13 in the viewer' });
  const nameLink = row.getByRole('link', { name: 'Framework agreement Velarail Freight Rail' });
  await expect(nameLink).toHaveAttribute('href', (await eye.getAttribute('href'))!);
  await nameLink.focus();
  await expect(nameLink).toBeFocused();
  await nameLink.click();
  await expect(page).toHaveURL(/\/view\/[0-9a-f-]{36}$/);
});

test('seller publishers get "Drafts to publish"', async ({ page, persona }) => {
  await persona('johan');
  await page.goto(roomPath('dashboard'));
  await hydrated(page);
  const card = page.getByRole('region', { name: 'Drafts to review and publish' });
  await expect(card).toBeVisible();
  await expect(card.locator('.over')).toHaveText('Drafts to publish');
  await expect(card.locator('.why')).toHaveText('Bidders cannot see these until you publish them. These are the drafts in the folders where you may publish.');
  for (const n of await card.locator('li .n').allTextContents()) expect(n).toMatch(/^3\./);
  await expect(card.getByRole('link', { name: 'Review and publish' })).toHaveAttribute('href', roomPath('release'));
  await expectNoAxeViolations(page, 'C1 for a seller-side publisher');
  await persona('maria');
  await page.goto(roomPath('dashboard'));
  await hydrated(page);
  await expect(page.getByRole('region', { name: 'Drafts to review and publish' })).toHaveCount(0);
});

test('Decline on the dashboard asks for a reason', async ({ page, persona, request }) => {
  const family = `Ndlovu${Date.now()}`;
  const res = await request.post(`${API_URL}/v1/workspaces/${ROOM_ID}/team-requests`, {
    headers: { 'x-dev-tenant': 'de300000-0000-4000-8000-000000000001', 'x-dev-person': '49ef5130-7c1a-459b-82c1-711e02ebe85e', 'content-type': 'application/json' },
    data: { givenName: 'Sipho', familyName: family, email: `sipho.${Date.now()}@bidder-a.example.com`, company: 'Orrinby Capital' },
  });
  expect(res.ok()).toBe(true);
  await persona('anika');
  await page.goto(roomPath('dashboard'));
  await hydrated(page);
  const ask = page.locator(`[data-request="Sipho ${family}"]`);
  const look = await ask.evaluate((el) => { const s = getComputedStyle(el); return [s.borderLeftWidth, s.borderRadius, s.backgroundColor]; });
  expect(look).toEqual(['0px', '0px', 'rgba(0, 0, 0, 0)']);
  await ask.getByRole('button', { name: 'Decline' }).click();
  const dlg = page.getByRole('dialog', { name: `Decline the request for Sipho ${family}?` });
  await expect(dlg.getByLabel('Reason for Jan (optional)')).toBeFocused();
  await expectNoAxeViolations(page, 'the Decline dialog on the dashboard');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Decline' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Decline and tell Jan' }).click();
  await expect(page.locator(`[data-request="Sipho ${family}"]`)).toHaveCount(0, { timeout: 20_000 });
});

test('finished timeline items show a check mark', async ({ page, persona }) => {
  await persona('anika');
  await page.goto(roomPath('timeline'));
  await hydrated(page);
  const done = page.locator('.f2 .trow.done:not(.end) .when i').first();
  await expect(done).toBeVisible();
  const mark = await done.evaluate((el) => {
    const s = getComputedStyle(el);
    const a = getComputedStyle(el, '::after');
    return { round: s.borderRadius, check: a.content !== 'none' && a.borderLeftStyle === 'solid' && a.borderBottomStyle === 'solid' };
  });
  expect(mark).toEqual({ round: '50%', check: true });
  await expectNoAxeViolations(page, 'F2 Timeline');
});
