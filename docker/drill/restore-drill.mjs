#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Restore drill. env: VDRKIT_IMAGE, VDRKIT_TAG, DRILL_PROJECT, DRILL_*_PORT, DRILL_DIR, DRILL_KEEP=1
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  apiContext, countDiff, downloadOriginal, firstRunSetup, logger, newSecrets, openBrowser, pdf, printLogs, rtf, signIn,
  snapshot, stack, sleep, upload, verifyRoomChain, viewPage1, waitForStack, post,
} from './lib.mjs';
import { enterThrowaway, isThrowaway } from '../throwaway.mjs';

const env = process.env;
const project = env.DRILL_PROJECT ?? 'vdrkit-restore-drill';
const root = resolve(env.DRILL_DIR ?? join(tmpdir(), project));
const ports = { httpPort: env.DRILL_HTTP_PORT ?? '4120', httpsPort: env.DRILL_HTTPS_PORT ?? '4121', mailPort: env.DRILL_MAIL_PORT ?? '4122' };
const image = env.VDRKIT_IMAGE ?? 'vdrkit';
const tag = env.VDRKIT_TAG ?? 'smoke';
const admin = { givenName: 'Thandi', familyName: 'Mokoena', company: 'Grenlodge Partners', email: 'thandi.mokoena@drill.example' };
const { results, log, step } = logger('restore-drill');
results.timings = {};

// must come first: exits on refusal
enterThrowaway({ project, prefix: 'vdrkit-restore-drill', projectVar: 'DRILL_PROJECT', dir: root, dirVar: 'DRILL_DIR' }, { tag: 'restore-drill' });

const a = stack({ project, dir: join(root, 'install-a'), ...ports, backupDir: '../kept-backups' });
const b = stack({ project, dir: join(root, 'install-b'), ...ports, backupDir: '../kept-backups' });
let current = a;

async function folderIds(page, roomId) {
  const { items } = await (await page.request.get(`/v1/workspaces/${roomId}/nodes`)).json();
  return Object.fromEntries(items.filter((n) => n.kind === 'folder').map((n) => [n.name, n.id]));
}

async function main() {
  const t0 = Date.now();
  const secretsA = newSecrets();
  a.prepare({ image, tag, secrets: secretsA, profiles: 'postgres,backup' });
  a.compose(['up', '-d']);
  const apiA = await apiContext(a);
  await waitForStack(a, apiA, { setupOpen: true });
  await firstRunSetup(a, apiA, admin);
  await apiA.dispose();
  step('install A: first-run setup finished');

  const docs = [];
  let roomId;
  let authenticator;
  {
    const { browser, page } = await openBrowser(a);
    try {
      authenticator = (await signIn(a, page, admin.email)).secret;
      const room = await post(page, a.base, '/v1/workspaces', { name: 'Project Heron', start: 'empty', topFolders: ['Finance', 'Legal'], timeZone: 'Africa/Johannesburg' });
      roomId = room.id;
      const folders = await folderIds(page, roomId);
      for (const [folder, name, bytes, mime] of [
        ['Finance', 'Management accounts FY2026.pdf', pdf('Management accounts FY2026', 3), 'application/pdf'],
        ['Finance', 'Budget 2027.pdf', pdf('Budget 2027', 2), 'application/pdf'],
        ['Legal', 'Shareholders agreement.rtf', rtf('Shareholders agreement between the parties, restore drill.'), 'application/rtf'],
      ]) {
        const nodeId = await upload(page, a.base, roomId, folders[folder], name, bytes, mime);
        docs.push({ name, nodeId, sha256: await downloadOriginal(page, roomId, nodeId) });
      }
      results.before = { chainApi: await verifyRoomChain(page, roomId) };
      if (!results.before.chainApi.intact) throw new Error(`The chain is broken before the backup: ${JSON.stringify(results.before.chainApi)}`);
    } finally {
      await browser.close();
    }
  }
  step('install A: signed in with two-factor set-up, room with two folders, three documents viewed', { room: roomId, docs: docs.map((d) => d.name) });

  // churn during the backup
  const writer = `
    const fs = require('fs'), c = require('crypto'), root = '/data/storage';
    fs.mkdirSync(root + '/quarantine/drill', { recursive: true });
    const q = root + '/quarantine/drill/' + c.randomUUID();
    fs.writeFileSync(q, 'an upload in progress, not encrypted yet');
    fs.mkdirSync(root + '/drill-churn', { recursive: true });
    const tmp = root + '/drill-inflight.' + c.randomBytes(6).toString('hex') + '.tmp';
    const w = fs.createWriteStream(tmp);
    let mb = 0, churn = 0;
    const churner = setInterval(() => {
      fs.writeFileSync(root + '/drill-churn/f' + churn, c.randomBytes(4096));
      if (churn > 0) fs.rmSync(root + '/drill-churn/f' + (churn - 1), { force: true });
      churn++;
    }, 50);
    const t = setInterval(() => {
      w.write(c.randomBytes(1 << 20));
      if (++mb < 40) return;
      clearInterval(t); clearInterval(churner);
      w.end(() => {
        fs.rmSync(tmp, { force: true }); fs.rmSync(root + '/drill-churn', { recursive: true, force: true });
        fs.rmSync(root + '/quarantine/drill', { recursive: true, force: true });
        console.log('wrote ' + mb + ' MB, churned ' + churn + ' files');
      });
    }, 250);`;
  const writing = a.composeAsync(['exec', '-T', 'api', 'node', '-e', writer]);
  await sleep(1500);
  const online = await a.composeAsync(['run', '--rm', 'backup', 'now']);
  const wrote = await writing;
  if (wrote.status !== 0) throw new Error(`The writer in the API container failed:\n${wrote.output}`);
  const onlineName = /Backup (vdrkit-\d{8}T\d{6}Z) finished/.exec(online.output)?.[1];
  if (online.status !== 0 || !onlineName) throw new Error(`The backup while VDRkit was in use failed:\n${online.output}`);
  const members = a.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'backup', '-c', `tar -tzf /backups/${onlineName}/files.tar.gz`])
    .split(/\r?\n/).filter(Boolean);
  const leaked = members.filter((m) => /^\.\/(quarantine|health)(\/|$)|\.tmp$/.test(m));
  if (leaked.length) throw new Error(`The backup holds files it must leave out: ${leaked.join(', ')}`);
  a.compose(['run', '--rm', 'backup', 'verify', onlineName]);
  results.onlineBackup = {
    name: onlineName, writer: wrote.output.trim().split('\n').at(-1), files: members.filter((m) => !m.endsWith('/')).length,
    tarNote: /were added or deleted while they were packed/.test(online.output) ? 'tar exit code 1, accepted' : 'tar exit code 0',
  };
  step('a backup while files are written, added and deleted succeeds, verifies, and holds no upload in progress and no .tmp file', results.onlineBackup);

  a.compose(['stop', 'proxy', 'web', 'api', 'worker']);
  const before = snapshot(a);
  results.before = { ...results.before, tables: Object.keys(before.counts).length, events: before.counts['public.event'],
    chains: before.chains.length, migrations: before.migrations.length, files: before.files };
  if (before.chains.some((c) => !c.intact)) throw new Error(`A chain is broken before the backup: ${JSON.stringify(before.chains)}`);
  const backupStarted = Date.now();
  const out = a.compose(['run', '--rm', 'backup', 'now']);
  results.timings.backupMs = Date.now() - backupStarted;
  const name = /Backup (vdrkit-\d{8}T\d{6}Z) finished/.exec(out)?.[1];
  if (!name) throw new Error(`No backup name in:\n${out}`);
  a.compose(['run', '--rm', 'backup', 'verify', name]);
  const listed = a.compose(['run', '--rm', 'backup', 'list']).trim();
  results.backup = { name, list: listed.split('\n').at(-1) };
  step('backup made and verified', { name, ms: results.timings.backupMs, list: results.backup.list });

  const kept = { VDRKIT_MASTER_KEY: secretsA.VDRKIT_MASTER_KEY, BETTER_AUTH_SECRET: secretsA.BETTER_AUTH_SECRET };
  a.destroy({ keepBackups: true });
  rmSync(a.dir, { recursive: true, force: true });
  const left = leftovers('ps', project);
  const volumes = leftovers('volume', project);
  if (left.length || volumes.length) throw new Error(`Install A was not fully removed: containers ${left}, volumes ${volumes.join(', ')}`);
  step('install A destroyed: no container, no volume, no folder left', { keptBackup: name });

  current = b;
  const secretsB = { ...newSecrets(), ...kept };
  b.prepare({ image, tag, secrets: secretsB, profiles: 'postgres,backup' });
  const restoreStarted = Date.now();
  b.compose(['up', '-d', '--wait', 'postgres']);
  const dbOut = b.compose(['exec', '-T', 'postgres', 'sh', '/vdrkit-backup/restore-db.sh', name]);
  const filesOut = b.compose(['run', '--rm', '--no-deps', 'backup', 'restore-files', name]);
  results.timings.restoreMs = Date.now() - restoreStarted;
  // before the worker rewrites health state
  const after = snapshot(b);
  const again = b.compose(['exec', '-T', 'postgres', 'sh', '/vdrkit-backup/restore-db.sh', name], { allowFail: true, both: true });
  b.compose(['up', '-d']);
  results.restore = {
    database: dbOut.trim().split('\n').at(-1),
    files: filesOut.trim().split('\n').at(-1),
  };
  step('restored into install B (Postgres alone, restore-db.sh, restore-files)', { ...results.restore, ms: results.timings.restoreMs });

  const apiB = await apiContext(b);
  await waitForStack(b, apiB, { setupOpen: false });
  const setup = await (await apiB.get('/v1/setup')).json();
  await apiB.dispose();
  if (setup.open) throw new Error('First-run setup is open again after the restore');
  const migrateLog = b.compose(['logs', '--no-color', 'migrate']);
  if (!/none pending/.test(migrateLog)) throw new Error(`migrate did more than nothing after the restore:\n${migrateLog}`);
  step('install B answers; migrate found nothing to do; setup stays closed', { migrate: migrateLog.trim().split('\n').at(-1).replace(/^\S+\s+\|\s*/, '') });

  const diff = countDiff(before.counts, after.counts);
  const chainsSame = JSON.stringify(before.chains) === JSON.stringify(after.chains);
  const migrationsSame = JSON.stringify(before.migrations) === JSON.stringify(after.migrations);
  const filesSame = before.files.count === after.files.count && before.files.digest === after.files.digest;
  results.after = { tables: Object.keys(after.counts).length, events: after.counts['public.event'], chains: after.chains, files: after.files, countDiff: diff };
  if (diff.length || !chainsSame || !migrationsSame || !filesSame || after.chains.some((c) => !c.intact)) {
    throw new Error(`Install B differs from A: ${JSON.stringify({ diff, chainsSame, migrationsSame, filesSame, before: before.chains, after: after.chains })}`);
  }
  step('same rows in every table, every hash chain verifies with the same length, same migrations, same files', {
    tables: Object.keys(after.counts).length, events: after.counts['public.event'], chains: after.chains.map((c) => `${c.length} entries, intact`),
    files: after.files.count,
  });
  if (!/already holds \d+ tables/.test(again)) throw new Error(`A second restore over the restored database did not refuse:\n${again}`);
  step('a second restore into the filled database is refused');

  {
    const { browser, page } = await openBrowser(b);
    try {
      const signedIn = await signIn(b, page, admin.email, authenticator);
      if (signedIn.twoFactor !== 'enter') throw new Error(`Expected the authenticator step after the restore, got "${signedIn.twoFactor}"`);
      step('signed in on install B with the emailed code and the authenticator set up on install A');
      const rooms = await (await page.request.get('/v1/me/workspaces')).json();
      const list = rooms.items ?? rooms;
      if (!JSON.stringify(list).includes(roomId)) throw new Error(`The room is missing from My rooms: ${JSON.stringify(rooms)}`);
      const checked = [];
      for (const d of docs) {
        const hash = await downloadOriginal(page, roomId, d.nodeId);
        if (hash !== d.sha256) throw new Error(`${d.name} differs after the restore: ${d.sha256} -> ${hash}`);
        await viewPage1(page, roomId, d.nodeId, d.name);
        checked.push(d.name);
      }
      step('every document downloads byte for byte and shows in the viewer', { checked });
      const chain = await verifyRoomChain(page, roomId);
      if (!chain.intact || chain.checked < results.before.chainApi.checked) throw new Error(`Chain after the restore: ${JSON.stringify(chain)}`);
      const folders = await folderIds(page, roomId);
      const newId = await upload(page, b.base, roomId, folders.Legal, 'After the restore.pdf', pdf('After the restore', 1), 'application/pdf');
      const chain2 = await verifyRoomChain(page, roomId);
      if (!chain2.intact || chain2.checked <= chain.checked) throw new Error(`Chain after a new upload: ${JSON.stringify(chain2)}`);
      results.after.chainApi = { afterSignIn: chain, afterNewUpload: chain2 };
      step('the room chain verifies through the API; a new upload works and extends the intact chain', {
        before: results.before.chainApi.checked, afterSignIn: chain.checked, afterNewUpload: chain2.checked, newDocument: newId,
      });
    } finally {
      await browser.close();
    }
  }
  step('container states', b.containerStates());
  results.timings.totalMs = Date.now() - t0;
}

function leftovers(kind, p) {
  const args = kind === 'ps' ? ['ps', '-a', '-q'] : ['volume', 'ls', '-q'];
  return execFileSync('docker', [...args, '--filter', `label=com.docker.compose.project=${p}`], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`[restore-drill] FAILED: ${err.stack ?? err}`);
  printLogs(current, 60);
} finally {
  if (env.DRILL_KEEP === '1') log(`left running (DRILL_KEEP=1) in ${current.dir}`);
  else if (isThrowaway(project, root)) {
    // backups hold the database in clear
    current.destroy();
    try {
      rmSync(join(root, 'kept-backups'), { recursive: true, force: true });
      log('stacks, volumes, throwaway secrets and backups removed');
    } catch (err) {
      console.error(`[restore-drill] Could not delete ${join(root, 'kept-backups')} (${err.code}). It holds a copy of the test database; delete it as root.`);
    }
  }
  console.log(JSON.stringify({ ok: !failed, ...results }, null, 2));
  process.exit(failed ? 1 : 0);
}
