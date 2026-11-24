// SPDX-License-Identifier: AGPL-3.0-only
import { zoneAbbreviation as abbreviation } from './time';

export function zoneAbbreviation(timeZone: string, at: Date): string {
  return abbreviation(at, timeZone);
}

export function clockTime(timeZone: string, at: Date): string {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${hm} ${zoneAbbreviation(timeZone, at)}`;
}

export function utcOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

export function utcOffsetLabel(timeZone: string, at: Date): string {
  const m = utcOffsetMinutes(timeZone, at);
  const sign = m < 0 ? '-' : '+';
  const a = Math.abs(m);
  const mins = a % 60 ? `:${String(a % 60).padStart(2, '0')}` : '';
  return `UTC${sign}${Math.floor(a / 60)}${mins}`;
}

export function sameClock(a: string, b: string, at: Date): boolean {
  return a === b || utcOffsetMinutes(a, at) === utcOffsetMinutes(b, at);
}
