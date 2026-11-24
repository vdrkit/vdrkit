// SPDX-License-Identifier: AGPL-3.0-only
// preloaded via start.mjs; peak RSS/heap/ELU to .work/<role>-mem.json
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const role = process.env.LOAD_ROLE ?? 'proc';
const file = new URL(`./.work/${role}-mem.json`, import.meta.url);
const peak = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0, eventLoopBusy: 0, since: new Date().toISOString() };
// ELU 1 = JS-bound
let elu = performance.eventLoopUtilization();
const loop = setInterval(() => {
  const now = performance.eventLoopUtilization();
  const u = performance.eventLoopUtilization(now, elu).utilization;
  elu = now;
  if (u > peak.eventLoopBusy) { peak.eventLoopBusy = Math.round(u * 100) / 100; writeFileSync(file, JSON.stringify({ ...peak, at: new Date().toISOString() })); }
}, 1000);
loop.unref();
const t = setInterval(() => {
  const m = process.memoryUsage();
  let changed = false;
  for (const k of ['rss', 'heapUsed', 'external', 'arrayBuffers']) if (m[k] > peak[k]) { peak[k] = m[k]; changed = true; }
  if (changed) writeFileSync(file, JSON.stringify({ ...peak, at: new Date().toISOString() }));
}, 250);
t.unref();
