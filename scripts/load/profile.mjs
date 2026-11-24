#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// API CPU profile. Start the API with LOAD_NODE_OPTIONS=--inspect=127.0.0.1:4609, then:
//   node scripts/load/profile.mjs [seconds]
import { writeFileSync } from 'node:fs';
import { WORK } from './config.mjs';

const seconds = Number(process.argv[2] ?? 20);
const [target] = await (await fetch('http://127.0.0.1:4609/json/list')).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 500 });
await send('Profiler.start');
await new Promise((r) => setTimeout(r, seconds * 1000));
const { profile } = await send('Profiler.stop');
ws.close();
writeFileSync(`${WORK}/api.cpuprofile`, JSON.stringify(profile));

const dt = new Map();
for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
const total = [...dt.values()].reduce((a, b) => a + b, 0);
const self = new Map();
const pkg = new Map();
for (const n of profile.nodes) {
  const t = dt.get(n.id) ?? 0;
  if (!t) continue;
  const f = n.callFrame;
  const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*node_modules[\\/]\.pnpm[\\/]/, '').replace(/^file:\/\/\/.*?load[\\/]/, '')}:${f.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + t);
  const p = /node_modules[\\/]\.pnpm[\\/]([^\\/]+)/.exec(f.url)?.[1] ?? (f.url.includes('apps/server') ? 'vdrkit server' : f.url.includes('packages/core') ? 'vdrkit core' : f.url ? 'node' : f.functionName);
  pkg.set(p, (pkg.get(p) ?? 0) + t);
}
const pct = (t) => `${((100 * t) / total).toFixed(1)}%`.padStart(6);
console.log('By package:');
for (const [k, t] of [...pkg].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${pct(t)}  ${k}`);
console.log('\nBy function (own time):');
for (const [k, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${pct(t)}  ${k.slice(0, 150)}`);
