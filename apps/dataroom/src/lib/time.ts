// SPDX-License-Identifier: AGPL-3.0-only
// Keep in step with formatWhen() in packages/core: emails and screens must agree.

// [winter, summer]; Intl gives "GMT+2" for these
const KNOWN: Record<string, [string, string]> = {
  'Africa/Johannesburg': ['SAST', 'SAST'],
  'Europe/London': ['GMT', 'BST'],
  'Europe/Amsterdam': ['CET', 'CEST'],
  'Europe/Berlin': ['CET', 'CEST'],
  'Europe/Paris': ['CET', 'CEST'],
  'America/New_York': ['EST', 'EDT'],
  'Asia/Dubai': ['GST', 'GST'],
  'Asia/Singapore': ['SGT', 'SGT'],
  UTC: ['UTC', 'UTC'],
};

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function partsIn(d: Date, timeZone: string): Parts {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const n = (t: string) => Number(f.find((p) => p.type === t)?.value ?? 0);
  return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour'), minute: n('minute'), second: n('second') };
}

export function utcOffsetMinutes(d: Date, timeZone: string): number {
  const p = partsIn(d, timeZone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

export function zoneAbbreviation(d: Date, timeZone: string): string {
  const known = KNOWN[timeZone];
  if (known) {
    const jan = utcOffsetMinutes(new Date(Date.UTC(partsIn(d, timeZone).year, 0, 15)), timeZone);
    return utcOffsetMinutes(d, timeZone) === jan ? known[0] : known[1];
  }
  const name = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName');
  return name?.value ?? timeZone;
}

const toDate = (d: Date | string) => (typeof d === 'string' ? new Date(d) : d);
const pad = (n: number) => String(n).padStart(2, '0');

export function formatDay(at: Date | string, timeZone: string, now: Date = new Date()): string {
  const d = toDate(at);
  const p = partsIn(d, timeZone);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(d);
  // en-GB says "Sept"
  const month = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'short' }).format(d).slice(0, 3);
  const day = `${weekday} ${p.day} ${month}`;
  return p.year === partsIn(now, timeZone).year ? day : `${day} ${p.year}`;
}

export function formatTime(at: Date | string, timeZone: string): string {
  const d = toDate(at);
  const p = partsIn(d, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)} ${zoneAbbreviation(d, timeZone)}`;
}

export function formatWhen(at: Date | string, timeZone: string, now: Date = new Date()): string {
  return `${formatDay(at, timeZone, now)}, ${formatTime(at, timeZone)}`;
}

export function zoneCity(timeZone: string): string {
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
}
