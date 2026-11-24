// SPDX-License-Identifier: AGPL-3.0-only
// The seed shifts demo dates by whole weeks so the load day falls in 13-19 Nov 2026 (see demoShiftMs in
// apps/server/src/demo/seed-demo.ts). Specs write the original dates and read them back shifted.
import { formatDay, formatTime } from '../src/lib/time';

export const SAST = 'Africa/Johannesburg';
export const LONDON = 'Europe/London';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const STORY_LOAD_FROM = Date.UTC(2026, 10, 13);

export const roomDay = (at: Date = new Date()): string => new Date(at.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);

export function demoShiftMs(today: string = process.env.VDRKIT_DEMO_TODAY || roomDay()): number {
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(t)) throw new Error(`VDRKIT_DEMO_TODAY: "${today}" is not a day as YYYY-MM-DD`);
  return Math.floor((t - STORY_LOAD_FROM) / WEEK_MS) * WEEK_MS;
}

export const demoAt = (iso: string): Date => new Date(Date.parse(iso) + demoShiftMs());
export const demoIso = (iso: string): string => demoAt(iso).toISOString();
export const demoDay = (day: string): string => demoIso(`${day}T00:00:00Z`).slice(0, 10);

// "Fri 27 Nov"
export const dayOf = (iso: string, timeZone: string): string => formatDay(demoAt(iso), timeZone, demoAt(iso));
// "Fri 27 Nov 2026"
export const dayWithYear = (iso: string, timeZone: string): string => formatDay(demoAt(iso), timeZone, new Date(0));
export const timeOf = (iso: string, timeZone: string): string => formatTime(demoAt(iso), timeZone);
export const whenOf = (iso: string, timeZone: string): string => `${dayOf(iso, timeZone)}, ${timeOf(iso, timeZone)}`;
export const dayOfDate = (day: string): string => dayOf(`${day}T12:00:00Z`, 'UTC');

export const re = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
