// SPDX-License-Identifier: AGPL-3.0-only
// Runs without Docker: `node --test docker/`
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stack } from './drill/lib.mjs';
import { assertThrowaway, composeEnv, enterThrowaway, isThrowaway, throwawayFolder } from './throwaway.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'vdrkit-throwaway-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function recorder() {
  const calls = [];
  const run = (...a) => { calls.push(a); return { status: 0, stdout: '', stderr: '' }; };
  const start = (...a) => { calls.push(a); throw new Error('spawn must not be reached'); };
  return { calls, run, start };
}

// a folder as a real installation would have it
function installation(name) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'backups'), { recursive: true });
  writeFileSync(join(dir, '.env'), 'VDRKIT_MASTER_KEY=keep-me\n');
  writeFileSync(join(dir, 'ca-key.pem'), 'key');
  writeFileSync(join(dir, 'backups', 'vdrkit-1.dump'), 'dump');
  return dir;
}

function assertUntouched(dir) {
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'VDRKIT_MASTER_KEY=keep-me\n');
  assert.ok(existsSync(join(dir, 'ca-key.pem')));
  assert.ok(existsSync(join(dir, 'backups', 'vdrkit-1.dump')));
  assert.ok(!existsSync(join(dir, '.vdrkit-throwaway')));
}

function assertNothingRuns(project, dir, installed = dir) {
  const r = recorder();
  const s = stack({ project, dir, httpPort: 1, httpsPort: 2, mailPort: 3, run: r.run, start: r.start });
  assert.throws(() => s.compose(['down', '-v']), /Refused/);
  assert.throws(() => s.composeAsync(['up']), /Refused/);
  assert.throws(() => s.prepare({ image: 'vdrkit', tag: 'x', secrets: {} }), /Refused/);
  s.destroy();
  assert.deepEqual(r.calls, []);
  assertUntouched(installed);
}

describe('the throwaway guard', () => {
  test('refuses the name of a real installation', () => {
    const dir = installation('real-name');
    assert.throws(() => throwawayFolder({ project: 'vdrkit', prefix: 'vdrkit-smoke', projectVar: 'SMOKE_PROJECT', dir, dirVar: 'SMOKE_DIR' }), /must start with/);
    assert.equal(isThrowaway('vdrkit', dir), false);
    assertNothingRuns('vdrkit', dir);
  });

  test('refuses a folder with files it did not make', () => {
    const dir = installation('real-folder');
    const project = 'vdrkit-restore-drill-folder';
    assert.throws(() => throwawayFolder({ project, prefix: 'vdrkit-restore-drill', projectVar: 'DRILL_PROJECT', dir, dirVar: 'DRILL_DIR' }), /did not make/);
    assert.equal(isThrowaway(project, dir), false);
    assert.equal(isThrowaway(project, join(dir, 'install-a')), false);
    assertNothingRuns(project, join(dir, 'install-a'), dir);
    assertNothingRuns(project, dir);
  });

  test('exits on refusal before anything runs', () => {
    const dir = installation('entry');
    const codes = [];
    assert.throws(() => enterThrowaway({ project: 'vdrkit', prefix: 'vdrkit-restore-drill', projectVar: 'DRILL_PROJECT', dir, dirVar: 'DRILL_DIR', wipe: false },
      { tag: 'test', exit: (c) => codes.push(c) }));
    assert.deepEqual(codes, [2]);
    assertUntouched(dir);
  });

  test('only cleans up below the folder it was given', () => {
    const root = join(scratch, 'passed');
    const project = 'vdrkit-restore-drill-passed';
    throwawayFolder({ project, prefix: 'vdrkit-restore-drill', projectVar: 'DRILL_PROJECT', dir: root, dirVar: 'DRILL_DIR' });
    assert.ok(isThrowaway(project, join(root, 'install-a')));
    assert.equal(isThrowaway(project, scratch), false);
    assert.equal(isThrowaway(project, `${root}-other`), false);
    assert.equal(isThrowaway('vdrkit', root), false);
    assert.throws(() => assertThrowaway(project, scratch), /Refused/);

    const dir = join(root, 'install-a');
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, '.env'), 'x');
    const r = recorder();
    const s = stack({ project, dir, httpPort: 1, httpsPort: 2, mailPort: 3, run: r.run, start: r.start });
    s.destroy();
    assert.equal(r.calls.length, 2);
    assert.ok(r.calls.every(([cmd, args]) => cmd === 'docker' && args.includes(project)));
    assert.ok(!existsSync(join(dir, '.env')));
  });
});

describe('the environment passed to Compose', () => {
  const referenced = ['docker-compose.yml', 'docker/smoke/compose.smoke.yml']
    .flatMap((f) => [...readFileSync(join(here, '..', f), 'utf8').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));

  test('leaves out the shell\'s Compose settings', () => {
    const shell = Object.fromEntries([...referenced, 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AWS_SECRET_ACCESS_KEY', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES', 'COMPOSE_FILE']
      .map((k) => [k, 'from-the-shell']));
    const out = composeEnv({ ...shell, PATH: '/bin', DOCKER_HOST: 'unix:///x', SMOKE_DATABASE_URL: 'postgres://outside', DRILL_DIR: '/d' });
    const leaked = Object.keys(out).filter((k) => k in shell && !['VDRKIT_IMAGE', 'VDRKIT_TAG', 'SMOKE_MAIL_PORT'].includes(k));
    assert.deepEqual(leaked, []);
    assert.equal(out.PATH, '/bin');
    assert.equal(out.DOCKER_HOST, 'unix:///x');
    assert.equal(out.SMOKE_DATABASE_URL, 'postgres://outside');
    assert.equal(out.DRILL_DIR, '/d');
  });

  // docker needs these to find the compose plugin
  test('passes Windows folder variables in any case', () => {
    const gitBash = composeEnv({ PROGRAMFILES: 'C:\\Program Files', SYSTEMROOT: 'C:\\WINDOWS', ProgramW6432: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\a' });
    assert.deepEqual(Object.keys(gitBash).sort(), ['PROGRAMFILES', 'ProgramW6432', 'SYSTEMROOT', 'USERPROFILE']);
    const powerShell = composeEnv({ ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\WINDOWS', Path: 'C:\\bin', database_url: 'postgres://prod' });
    assert.deepEqual(Object.keys(powerShell).sort(), ['Path', 'ProgramFiles', 'SystemRoot']);
  });

  test('drill keeps its .env names and the shell database out', () => {
    const root = join(scratch, 'env');
    const project = 'vdrkit-restore-drill-env';
    throwawayFolder({ project, prefix: 'vdrkit-restore-drill', projectVar: 'DRILL_PROJECT', dir: root, dirVar: 'DRILL_DIR' });
    const saved = { ...process.env };
    Object.assign(process.env, { DATABASE_URL: 'postgres://prod', MIGRATION_DATABASE_URL: 'postgres://prod', VDRKIT_TAG: '9.9.9' });
    try {
      const r = recorder();
      const s = stack({ project, dir: root, httpPort: 1, httpsPort: 2, mailPort: 3, run: r.run, start: r.start });
      s.writeEnv({ image: 'vdrkit', tag: 'old', secrets: {} });
      s.compose(['ps']);
      const { env } = r.calls[0][2];
      assert.equal(env.DATABASE_URL, undefined);
      assert.equal(env.MIGRATION_DATABASE_URL, undefined);
      assert.equal(env.VDRKIT_TAG, undefined);
      assert.equal(env.SMOKE_MAIL_PORT, 3);
    } finally {
      for (const k of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'VDRKIT_TAG']) {
        if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
      }
    }
  });
});

describe('the scripts', () => {
  const scripts = ['smoke/smoke.mjs', 'drill/restore-drill.mjs'];
  for (const f of scripts) {
    test(`${f} runs the guard first`, () => {
      const src = readFileSync(join(here, f), 'utf8');
      const guard = src.search(/^enterThrowaway\(/m);
      assert.ok(guard > 0, 'calls enterThrowaway at the top level');
      assert.ok(guard < src.indexOf('try {'), 'before the first try');
      assert.ok(guard < src.search(/^(async )?function /m), 'before any function that can run');
      assert.doesNotMatch(src, /throwawayFolder\(/);
      assert.match(src, /} finally {\n[^\n]*\n {2}else if \(isThrowaway\(project, /);
      assert.doesNotMatch(src, /\.\.\.(process\.)?env\b/);
    });
  }

  test('smoke test compose refuses without the guard', () => {
    const src = readFileSync(join(here, 'smoke/smoke.mjs'), 'utf8');
    assert.match(src, /function compose\(args, opts = \{\}\) \{\n {2}assertThrowaway\(project, dir\);/);
    assert.match(src, /env: dockerEnv/);
  });
});
