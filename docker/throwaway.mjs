// SPDX-License-Identifier: AGPL-3.0-only
// The smoke test and drills end with `compose down -v` and delete their folder. Pointed at a real installation that
// would wipe its data, so every Compose call and clean-up checks `isThrowaway` first.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const MARKER = '.vdrkit-throwaway';
const passed = new Map();

export function throwawayFolder({ project, prefix, projectVar, dir, dirVar, wipe = true }) {
  if (!project.startsWith(prefix)) {
    throw new Error(`${projectVar}=${project}: the Compose project name must start with "${prefix}". `
      + 'This script removes the project\'s containers and volumes when it is done, so it never runs under the name of a real installation.');
  }
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, MARKER))) {
    throw new Error(`${dirVar}=${dir} holds files this script did not make, and it deletes that folder. Delete it yourself if it is left over from an earlier run, or point the script at a new folder.`);
  }
  if (wipe && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARKER), 'Made by a VDRkit test script, which deletes this folder.\n');
  passed.set(project, resolve(dir));
}

// call before `try`
export function enterThrowaway(opts, { tag, exit = process.exit } = {}) {
  try {
    throwawayFolder(opts);
  } catch (err) {
    console.error(`[${tag}] refused: ${err.message}`);
    exit(2);
    throw err;
  }
}

export function isThrowaway(project, dir) {
  const root = passed.get(project);
  if (!root) return false;
  const d = resolve(dir);
  return d === root || d.startsWith(root + sep);
}

export function assertThrowaway(project, dir) {
  if (!isThrowaway(project, dir)) throw new Error(`Refused: ${project} in ${dir} has not passed the throwaway check, so this script runs no Docker command and deletes nothing there.`);
}

// Shell variables beat .env, so a DATABASE_URL in the shell would aim the stack at that database.
// Upper case: Windows hands these on in any case (PROGRAMFILES vs ProgramFiles).
const KEEP = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME',
  'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_API_VERSION',
  'DOCKER_BUILDKIT', 'DOCKER_DEFAULT_PLATFORM',
  // not COMPOSE_PROFILES, COMPOSE_FILE or COMPOSE_ENV_FILES: they would replace what the script set
  'COMPOSE_HTTP_TIMEOUT', 'COMPOSE_PARALLEL_LIMIT', 'COMPOSE_ANSI', 'COMPOSE_PROGRESS', 'COMPOSE_STATUS_STDOUT', 'COMPOSE_MENU',
  'VDRKIT_IMAGE', 'VDRKIT_TAG',
]);

export function composeEnv(env = process.env, { drop = new Set(), extra = {} } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (drop.has(k)) continue;
    if (KEEP.has(k.toUpperCase()) || k.startsWith('SMOKE_') || k.startsWith('DRILL_')) out[k] = v;
  }
  return { ...out, ...extra };
}
