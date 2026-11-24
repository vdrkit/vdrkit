// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = [resolve(__dirname, '../src'), resolve(__dirname, '../../../packages/core/src')];
const FUNCTIONS = ['effective_level', 'accessible_nodes', 'readable_nodes', 'nda_accepted', 'can_see_version', 'visible_version'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function calls(text: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`\b${name}\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
    const args = text.slice(m.index + m[0].length, i - 1);
    if (args.trim()) out.push(args);
  }
  return out;
}

describe('database clock in permission calls', () => {
  it('passes record_clock() in every call', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const root of ROOTS) {
      for (const f of files(root)) {
        const text = readFileSync(f, 'utf8');
        for (const fn of FUNCTIONS) {
          for (const args of calls(text, fn)) {
            seen++;
            if (!/record_clock\(\)|knownSql\(/.test(args)) offenders.push(`${f.split(/[\\/]/).slice(-3).join('/')}: ${fn}(${args.replace(/\s+/g, ' ').slice(0, 120)})`);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('catches a call using the API clock', () => {
    expect(calls('select * from effective_level($1, $2, $3) e', 'effective_level')).toEqual(['$1, $2, $3']);
    expect(calls('as effective_level() decides, see accessible_nodes(f(x), $2, record_clock())', 'accessible_nodes')).toEqual(['f(x), $2, record_clock()']);
    expect(calls('as effective_level() decides', 'effective_level')).toEqual([]);
  });
});
