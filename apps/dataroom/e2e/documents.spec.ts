// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expect, hydrated, NODE, ROOM_ID, roomPath, test } from './fixtures';

test.skip(process.env.E2E_PROD === '1', 'Room routes run against next dev with the API');

const AUDITED = 'ce7385c5-8612-47d2-9896-ea1d7556ae85'; // 3.2 Audited financials

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

async function chooseFiles(page: Page, files: { name: string; text: string }[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('dialog').getByRole('button', { name: 'Browse your computer' }).click();
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: 'application/pdf', buffer: pdf(f.text) })));
}

test.describe('room admin', () => {
  test.beforeEach(async ({ persona }) => { await persona('anika'); });

  test('opens a folder with statuses and visibility', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    await expect(page.locator('.content .head .over')).toHaveText('2 Legal');
    await expect(page.locator('.content h1')).toHaveText('2.4Material contracts');
    const vis = page.locator('button.vis');
    await expect(vis).toHaveText(/Visible to 3 bidder groups/);
    await expect(page.locator('#vis-list')).toBeHidden();
    await vis.click();
    await expect(page.locator('#vis-list')).toContainText('Bidder AView and print');
    await expect(page.locator('#vis-list')).toContainText('Bidder BView');
    await expect(page.locator('.dr', { hasText: 'Tarnley Logistics addendum 2024' })).toContainText('Replacement in draft');
    // published version (6 pages), not the pending one (7)
    await expect(page.locator('.dr', { hasText: 'Tarnley Logistics addendum 2024' }).locator('span.r').first()).toHaveText('6');
    await expect(page.locator('.dr', { hasText: 'Framework agreement Velarail Freight Rail' })).toContainText('Draft');
    await expect(page.locator('.dr', { hasText: 'Tarnley Logistics supply agreement' }).locator('.badge')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Release review · \d+/ })).toBeVisible();
    await expect(page.locator('.dropzone')).toContainText('Drop files here to add them to 2.4 Material contracts, or onto a document to upload a new version.');
    expect(await page.locator('section[aria-label="Folder contents"] > *').first().getAttribute('class')).toContain('dropzone');
  });

  test('opens the viewer on click', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    await page.locator('.dr', { hasText: 'Tarnley Logistics supply agreement' }).locator('.r').first().click();
    await expect(page).toHaveURL(new RegExp(`/view/${NODE['2.4.2']}$`));
  });

  test('shows the folder overview', async ({ page }) => {
    await page.goto(roomPath('documents'));
    await hydrated(page);
    await expect(page.locator('.content h1')).toHaveText('Documents');
    await expect(page.locator('.content .sub')).toHaveText(/documents in 11 folders\.$/);
    await expect(page.locator('a.fo', { hasText: 'Insurance' })).toContainText('No bidder access');
    await page.locator('a.fo', { hasText: 'Legal' }).click();
    await expect(page).toHaveURL(new RegExp(`/documents/${NODE['2']}$`));
    await expect(page.locator('.content h1')).toHaveText('2Legal');
    await page.locator('a.fo', { hasText: 'Material contracts' }).click();
    await expect(page).toHaveURL(new RegExp(`/documents/${NODE['2.4']}$`));
    await expect(page.locator('.stree .sf.on')).toContainText('Material contracts');
  });

  test('document menu', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    await page.getByRole('button', { name: 'Actions for 2.4.6 Change of control consents tracker' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText([/Versions and details/, 'Upload a new version', /Set access for this file/, 'See who opened it in Activity']);
    await menu.getByRole('menuitem', { name: /Versions and details/ }).click();
    await expect(page).toHaveURL(/\/details\//);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('2.4.6Change of control consents tracker');
  });

  test('sets custom access for one file', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    const row = page.locator('.dr', { hasText: 'Change of control consents tracker' });
    await row.getByRole('button', { name: /Actions for/ }).click();
    await page.getByRole('menuitem', { name: /Set access for this file/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Set access for this file' })).toBeVisible();
    await dialog.getByLabel('Level for Bidder A').selectOption({ label: 'Original' });
    await dialog.getByRole('button', { name: 'Save, 1 group with own level' }).click();
    await expect(dialog).toBeHidden();
    await expect(row.locator('.badge.b-own')).toHaveText('Custom access');
    await expect(row.locator('.badge.b-own')).toHaveAttribute('title', 'Bidder A: Original. The rest follows the folder.');

    await row.getByRole('button', { name: /Actions for/ }).click();
    await page.getByRole('menuitem', { name: /Set access for this file/ }).click();
    await page.getByRole('dialog').getByLabel('Level for Bidder A').selectOption({ label: 'Same as the folder' });
    await page.getByRole('dialog').getByRole('button', { name: 'Save, follows the folder' }).click();
    await expect(row.locator('.badge.b-own')).toHaveCount(0);
  });

  test('Enter twice in New folder asks the server once', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    await page.getByRole('button', { name: 'Edit index' }).click();
    let posts = 0;
    await page.route('**/v1/workspaces/*/folders', async (r) => {
      if (r.request().method() !== 'POST') return r.continue();
      posts++;
      await new Promise((done) => setTimeout(done, 500));
      // answered here, so the demo room gets no folder
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000000' }) });
    });
    await page.locator('.stree').getByRole('button', { name: 'New folder' }).click();
    const nf = page.getByRole('dialog');
    const name = nf.getByRole('textbox');
    await name.fill('Environmental');
    await name.press('Enter');
    await name.press('Enter');
    await expect(nf).toBeHidden();
    expect(posts).toBe(1);
  });

  test('a file dropped beside the add-files dialog does not leave the page', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    await page.getByRole('button', { name: /^(Choose files|Upload files)$/ }).first().click();
    await chooseFiles(page, [{ name: `Beside ${unique()}.pdf`, text: 'beside' }]);
    await expect(page.getByRole('dialog').locator('.steps li.on')).toHaveText('2Check');
    // the browser opens a file whose dragover and drop nobody cancels
    const kept = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['%PDF-1.4'], 'Stray.pdf', { type: 'application/pdf' }));
      return ['dragover', 'drop'].map((type) => !document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })));
    });
    expect(kept).toEqual([true, true]);
  });

  test('edit mode asks before renumbering published documents', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    await page.getByRole('button', { name: 'Edit index' }).click();
    await expect(page.locator('.stree.editing .tnote')).toHaveText('Drag a folder by its handle to move it. Click a folder to rename it or type a new number. A folder can take any free number, such as 100.');
    await expect(page.locator('.editbar')).toContainText('Edit mode');
    await expect(page.locator('.dr', { hasText: 'Tarnley Logistics supply agreement' }).locator('.ixl')).toHaveText('2.4.2');

    await page.locator('.stree').getByRole('button', { name: 'New folder' }).click();
    const nf = page.getByRole('dialog');
    await expect(nf.getByText('Where should it go?')).toBeVisible();
    await expect(nf.locator('.opt')).toHaveCount(3);
    await expect(nf.locator('.opt').nth(0)).toContainText('Top level becomes 12');
    await expect(nf.locator('.opt').nth(1)).toContainText('Inside 2 Legal becomes 2.7');
    await expect(nf.locator('.opt').nth(2)).toContainText(/Inside 2.4 Material contracts becomes 2\.4\.\d+/);
    await expect(nf.getByRole('button', { name: /^Create folder 2\.4\.\d+$/ })).toBeDisabled();
    await nf.getByRole('button', { name: 'Cancel' }).click();

    const draft = page.locator('.dr', { hasText: 'Framework agreement Velarail Freight Rail' }).locator('input.ixe');
    await draft.fill('2.4.1');
    await draft.press('Enter');
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Give 2.4.13 Framework agreement Velarail Freight Rail the number 2.4.1?');
    await expect(confirm).toContainText('2.4.1becomes2.4.2');
    await expect(confirm.getByRole('button', { name: /^Renumber \d+ documents$/ })).toBeVisible();
    await confirm.getByRole('button', { name: 'Keep the current numbers' }).click();
    await expect(confirm).toBeHidden();

    const leases = page.locator('.stree .sf').filter({ has: page.locator('.ix', { hasText: /^2\.6$/ }) });
    await leases.click();
    await page.getByLabel('Index number for Property leases').fill('2.5');
    await page.getByRole('button', { name: 'Save 2.6' }).click();
    await expect(confirm).toContainText('Give 2.6 Property leases the number 2.5?');
    await expect(confirm).toContainText(/Both folders are published, so [\d,]+ documents get a new number\./);
    await expect(confirm).toContainText('Bidders see “Renumbered” beside them for 3 days, and the old numbers stay in the activity log. Questions that quote an old number still link to the right document.');
    await expect(confirm.locator('.swap')).toContainText('2.6becomes2.5');
    await expect(confirm.locator('.swap')).toContainText('2.5becomes2.6');
    await confirm.getByRole('button', { name: 'Keep the current numbers' }).click();
    await expect(confirm).toBeHidden();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.stree.editing')).toHaveCount(0);
  });

  test('renumbers drafts as you type', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    const id = unique();
    await page.getByRole('button', { name: 'Choose files' }).click();
    const dialog = page.getByRole('dialog');
    await chooseFiles(page, [{ name: `Aa renumber ${id}.pdf`, text: `e ${id}` }, { name: `Bb renumber ${id}.pdf`, text: `f ${id}` }]);
    await dialog.getByRole('button', { name: 'Add 2 files as drafts' }).click();
    await expect(dialog.locator('.okbox')).toBeVisible();
    await dialog.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
    const a = page.locator('.dr', { hasText: `Aa renumber ${id}` });
    const b = page.locator('.dr', { hasText: `Bb renumber ${id}` });
    const ixA = (await a.locator('.ix').textContent())!;
    await page.getByRole('button', { name: 'Edit index' }).click();
    // A and B may not be neighbours
    const after = ixA.replace(/\d+$/, (n) => String(Number(n) + 1));
    await b.locator('input.ixe').fill(ixA);
    await b.locator('input.ixe').press('Enter');
    await expect(b.locator('input.ixe')).toHaveValue(ixA);
    await expect(a.locator('input.ixe')).toHaveValue(after);
    await page.getByRole('button', { name: 'Done' }).click();
  });

  test('releases a new draft from its menu', async ({ page }) => {
    // no test counts drafts in 2.6
    const legal = await (await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes?parent=${NODE['2']}`)).json();
    const leases = legal.items.find((n: { indexNumber: string }) => n.indexNumber === '2.6').id as string;
    await page.goto(roomPath('documents', leases));
    await hydrated(page);
    const id = unique();
    await page.getByRole('button', { name: 'Choose files' }).click();
    const dialog = page.getByRole('dialog');
    await chooseFiles(page, [{ name: `Release from menu ${id}.pdf`, text: `r ${id}` }]);
    await dialog.getByRole('button', { name: 'Add 1 file as a draft' }).click();
    await expect(dialog.locator('.okbox')).toContainText('1 file is in 2.6 Property leases as a draft');
    await expect(dialog.locator('.okbox')).toContainText('Bidders cannot see it yet. Keep it as a draft, or publish it now. You can also publish it later in Release review or from its ⋯ menu.');
    await expect(dialog.locator('ul.facts li')).toHaveText([
      'It is being prepared for viewing. This takes about a minute per 100 pages.',
      'You can replace your draft with a new version until it is published.',
      'Once released, each bidder hears about it as they chose in their notification settings, unless the release is quiet.',
    ]);
    const foot = dialog.locator('.dw-f .btn');
    await expect(foot).toHaveText(['Publish now', 'Keep as draft']);
    expect(await foot.evaluateAll((bs) => bs.map((b) => b.className))).toEqual(['btn secondary', 'btn primary']);
    await expect(dialog.getByRole('link', { name: 'Go to Release review' })).toHaveCount(0);
    await expect(dialog.locator('.dw-h').getByRole('button', { name: 'Close' })).toBeVisible();
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/done-step.png` });
    await dialog.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/documents/${leases}$`));

    const row = page.locator('.dr', { hasText: `Release from menu ${id}` });
    const nodeId = (await row.getAttribute('data-doc'))!;
    const ix = (await row.locator('.ix').textContent())!;
    const release = page.getByRole('menu').getByRole('menuitem', { name: /^Release(?! quietly)/ });
    await expect(async () => {
      await page.reload();
      await hydrated(page);
      await row.getByRole('button', { name: /Actions for/ }).click();
      await expect(release).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([/^Release/, /^Release quietly, no email/, /Versions and details/, 'Upload a new version', /Set access for this file/, /^Delete draft/]);
    await expect(page.getByRole('menu').getByRole('menuitem', { name: /^Release quietly, no email/ }))
      .toHaveText('Release quietly, no emailFor a small fix. Publishes it now without emailing anyone. It still shows as new in the room, and is logged.');
    await expect(release).toHaveText('ReleasePublishes it now. Bidders hear about it as each chose in their notification settings.');
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/menu-release.png` });
    await release.click();
    await expect(page.locator('.toast')).toContainText(`${ix} is released`);
    await expect(page.locator('.toast')).toContainText('Bidders can open it now. They hear about it as each chose in their notification settings.');
    await expect(row.locator('.badge')).toHaveCount(0);
    const seen = await (await page.request.get(`/v1/workspaces/${ROOM_ID}/nodes/${nodeId}`)).json();
    expect(seen.state).toBe('published');

    // withdraw for the other specs
    expect((await page.request.post(`/v1/workspaces/${ROOM_ID}/nodes/${nodeId}/withdraw`, { data: {} })).ok()).toBe(true);
  });

  test('empty folder', async ({ page }) => {
    const name = `Empty ${unique()}`;
    const made = await page.request.post(`/v1/workspaces/${ROOM_ID}/folders`, { data: { parentId: NODE['2.4'], name } });
    expect(made.ok()).toBe(true);
    const { id } = await made.json();
    await page.goto(roomPath('documents', id));
    await hydrated(page);
    await expect(page.locator('.content .head .over')).toHaveText(new RegExp(`^2\\.4 Material contracts › 2\\.4\\.\\d+ ${name}$`));
    await expect(page.locator('.content .head .sub')).toHaveText(/^Visible to .+ and .+ once documents are published\.$/);
    await expect(page.locator('.content .head').getByRole('button', { name: 'New subfolder' })).toBeVisible();
    await expect(page.locator('.content .head').getByRole('button', { name: 'Upload files' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'This folder is empty' })).toBeVisible();
    await page.locator('.content .head').getByRole('button', { name: 'New subfolder' }).click();
    await expect(page.getByRole('dialog').getByText('Where should it go?')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  });

  test('renames a folder', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    await page.getByRole('button', { name: 'Edit index' }).click();
    const row = page.locator('.stree .sf').filter({ has: page.locator('.ix', { hasText: /^2\.2$/ }) });
    const before = (await row.locator('.nm').textContent())!;
    const after = `${before} ${unique()}`;
    await row.click();
    await page.getByLabel('Name of 2.2').fill(after);
    await page.getByRole('button', { name: 'Save 2.2' }).click();
    await expect(row.locator('.nm')).toHaveText(after);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(row.locator('.nm')).toHaveText(before);
  });

  test('dropping a file on a document opens New version', async ({ page }) => {
    await page.goto(roomPath('documents', NODE['2.4']));
    await hydrated(page);
    const row = page.locator('.dr', { hasText: 'Tarnley Logistics supply agreement' });
    const dialog = page.getByRole('dialog');
    // drop handlers attach after hydration
    await expect(async () => {
      await row.evaluate((el) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['%PDF-1.4'], 'Tarnley supply agreement signed.pdf', { type: 'application/pdf' }));
        for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await expect(dialog.locator('#dw-t')).toHaveText('New version of 2.4.2 Tarnley Logistics supply agreement');
    await expect(row).toHaveClass(/(^| )target( |$)/);
    await expect(dialog.locator('.ver').first()).toContainText(/Published \w{3} \d+ \w{3}/);
    await expect(dialog.locator('.ver').first()).toContainText(/opened by|not opened/);
    await expect(dialog.locator('.ver.nw')).toContainText('Tarnley supply agreement signed.pdf · 1 KB');
    await expect(dialog).toContainText('Until you publish, bidders keep seeing version 1.');
    await expect(dialog.getByRole('button', { name: 'Upload as version 2' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('contributor', () => {
  test.beforeEach(async ({ persona }) => { await persona('maria'); });

  test('adds two drafts', async ({ page }) => {
    await page.goto(roomPath('documents', AUDITED));
    await hydrated(page);
    await expect(page.locator('.content .head .sub')).toHaveText('You can add files to 3 Finance. Johan Steyn or Anika Pillay publishes what you add.');
    await expect(page.getByRole('button', { name: 'Edit index' })).toHaveCount(0);
    await expect(page.locator('button.vis')).toHaveText(/Visible to 4 bidder groups/);
    await expect(page.locator('.dr', { hasText: 'Audited financial statements FY2023' }).locator('.st')).toHaveText('DraftUploaded by you');

    const id = unique();
    await page.getByRole('button', { name: 'Choose files' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('#dw-t')).toHaveText('Add files to 3.2 Audited financials');
    await expect(dialog.locator('.steps li.on')).toHaveText('1Choose');
    // picked out of alphabetical order on purpose
    await chooseFiles(page, [{ name: `Management letter ${id}.pdf`, text: `b ${id}` }, { name: `Going concern ${id}.pdf`, text: `a ${id}` }]);
    await expect(dialog.locator('.dw-sec h3').first()).toHaveText('You chose 2 files');
    await expect(dialog.locator('.fl-r .ix').first()).toHaveText(/^3\.2\.\d+$/);
    const [first, second] = await dialog.locator('.fl-r .ix').allTextContents();
    expect(Number(second!.split('.').pop())).toBe(Number(first!.split('.').pop()) + 1);
    const promised = Object.fromEntries((await dialog.locator('.fl-r').evaluateAll((rs) => rs.map((r) => [r.querySelector('.nm')!.firstChild!.textContent!, r.querySelector('.ix')!.textContent!]))));
    await expect(dialog.locator('.fl-r .k')).toHaveText(['Added', 'Added']);
    await expect(dialog).toContainText('No file is identical to a document already in the room.');
    await expect(dialog).toContainText('They arrive as drafts. Johan Steyn or Anika Pillay publishes them.');
    await expect(dialog.locator('.dw-sec', { hasText: 'Who will see them once published' }).locator('.gchip')).toHaveCount(4);
    await dialog.getByRole('button', { name: 'Add 2 files as drafts' }).click();
    await expect(dialog.locator('.okbox')).toContainText('2 files are in 3.2 Audited financials as drafts');
    await expect(dialog.locator('.okbox')).toContainText('Bidders cannot see them yet. Johan Steyn or Anika Pillay publishes them. You get a notice when they do.');
    await expect(dialog.locator('ul.facts li').first()).toHaveText('They are being prepared for viewing. This takes about a minute per 100 pages.');
    await expect(dialog.locator('ul.facts li').nth(1)).toHaveText('You can replace your drafts with a new version until they are published.');
    await expect(dialog.getByRole('link', { name: 'Go to Release review' })).toHaveCount(0);
    await expect(dialog.locator('.dw-f .btn')).toHaveText(['Keep as draft']);
    await dialog.locator('.dw-f').getByRole('button', { name: 'Keep as draft' }).click();
    await expect(page.locator('.dr', { hasText: `Going concern ${id}` })).toContainText(/Draft|Processing/);
    for (const [name, ix] of Object.entries(promised)) {
      await expect(page.locator('.dr', { hasText: name.replace(/\.pdf$/, '') }).locator('.ix')).toHaveText(ix);
    }
  });

  test('Delete clicked twice deletes once', async ({ page }) => {
    let posts = 0;
    await page.route('**/v1/workspaces/*/versions/*/remove-draft', async (r) => {
      posts++;
      await new Promise((done) => setTimeout(done, 500));
      // answered here, so the demo draft stays
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ removed: 'document' }) });
    });
    await page.goto(roomPath('documents', AUDITED));
    await hydrated(page);
    await page.getByRole('button', { name: /^Actions for 3\.2\.7 / }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: /^Delete draft/ }).click();
    const confirm = page.getByRole('dialog');
    // the second click lands before the first has redrawn the button
    await confirm.getByRole('button', { name: 'Delete draft' }).evaluate((b: HTMLElement) => { b.click(); b.click(); });
    await expect(confirm).toHaveCount(0);
    expect(posts).toBe(1);
  });

  test('can delete but not release her draft', async ({ page }) => {
    await page.goto(roomPath('documents', AUDITED));
    await hydrated(page);
    await page.getByRole('button', { name: /^Actions for 3\.2\.7 / }).click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([/^Versions and details/, 'Upload a new version', /^Delete draft/]);
    await expect(page.getByRole('menu').getByRole('menuitem', { name: /^Release/ })).toHaveCount(0);
  });

  test('skips a file with the same name', async ({ page }) => {
    await page.goto(roomPath('documents', AUDITED));
    await hydrated(page);
    await page.getByRole('button', { name: 'Choose files' }).click();
    const id = unique();
    await chooseFiles(page, [{ name: 'Management letter FY2022.pdf', text: `c ${id}` }, { name: `Board pack ${id}.pdf`, text: `d ${id}` }]);
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.ask h3')).toHaveText('One question before you add');
    await expect(dialog.locator('.fl-r', { hasText: 'Management letter FY2022.pdf' }).locator('.k')).toHaveText('Replaces 3.2.4');
    await dialog.getByText('Skip this file').click();
    await expect(dialog.locator('.fl-r.skipped .k')).toHaveText('Not added');
    await expect(dialog.locator('.dw-sec h3').first()).toHaveText('You chose 2 files · 1 will be added');
    await expect(dialog.getByRole('button', { name: 'Add 1 file as a draft' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Back' }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
});

test('publisher can publish in his folder', async ({ page, persona }) => {
  await persona('johan');
  await page.goto(roomPath('documents', AUDITED));
  await hydrated(page);
  await expect(page.locator('.content .head .sub')).toHaveText('You can add and publish files in 3 Finance. Who sees 3 Finance is set by the room admins.');
  await expect(page.locator('button.vis')).toHaveText(/Visible to 4 bidder groups/);
  await expect(page.getByRole('link', { name: /^Release review · \d+$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit index' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for 3.2.1 Audited financial statements FY2021' }).click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([/^Versions and details/, 'Upload a new version']);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu').getByRole('menuitem', { name: 'Upload a new version' }).click();
  await (await chooser).setFiles({ name: 'FY2021 restated.pdf', mimeType: 'application/pdf', buffer: pdf('restated') });
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('label.chk')).toHaveText('Keep the name Audited financial statements FY2021. Leave unticked to use the new file name.');
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // not released here
  await page.getByRole('button', { name: /^Actions for 3\.2\.7 / }).click();
  await expect(page.getByRole('menu').getByRole('menuitem').first()).toHaveText(/^Release(Publishes it now\.|Still being prepared)/);
});

test('bidder sees no drafts or admin controls', async ({ page, persona }) => {
  await persona('jan');
  await page.goto(roomPath('documents', NODE['2.4']));
  await hydrated(page);
  await expect(page.locator('.content h1')).toHaveText('2.4Material contracts');
  await expect(page.locator('.dr', { hasText: 'Tarnley Logistics supply agreement' })).toBeVisible();
  await expect(page.locator('.dr', { hasText: 'Framework agreement Velarail Freight Rail' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Bidder B');
  await expect(page.locator('button.vis')).toHaveCount(0);
  await expect(page.locator('.dropzone')).toHaveCount(0);
  await expect(page.locator('.dr .icon-btn')).toHaveCount(0);
  await expect(page.locator('.badge')).toHaveCount(0);
});
