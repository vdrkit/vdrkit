// SPDX-License-Identifier: AGPL-3.0-only
// The deadline milestone carries the phase's name and first day. Entered in room time, stored as instants.
import type { paths } from '@/api/schema';
import { phasesOf, type Milestone } from '@/components/dashboard/model';
import { formatDay, partsIn, utcOffsetMinutes } from '@/lib/time';

export type TimelineGroup = paths['/v1/workspaces/{ws}/timeline/groups']['get']['responses'][200]['content']['application/json']['items'][number];

const pad = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function dayIn(at: Date | string, timeZone: string): string {
  const p = partsIn(new Date(at), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function timeIn(at: Date | string, timeZone: string): string {
  const p = partsIn(new Date(at), timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [hh, mm] = (time || '00:00').split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall - utcOffsetMinutes(new Date(wall), timeZone) * 60_000;
  // again with the guessed offset, for the days the clocks change
  t = wall - utcOffsetMinutes(new Date(t), timeZone) * 60_000;
  return new Date(t);
}

export function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function lowerFirst(s: string): string {
  const second = s[1];
  if (second && /[A-Z&]/.test(second)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export interface PhaseCard {
  n: number;
  name: string;
  from: string;
  fromSet: boolean;
  startsOn: string | null;
  events: Milestone[];
  end: Milestone;
  status: 'now' | 'next' | 'done';
}

/** Now: running today, else the next to come. Done: deadline passed. */
export function phaseCards(milestones: Milestone[], roomTimeZone: string, now: Date): { phases: PhaseCard[]; loose: Milestone[] } {
  const { phases, loose } = phasesOf(milestones);
  const today = dayIn(now, roomTimeZone);
  let prevEnd: string | null = null;
  const cards: PhaseCard[] = phases.map((p) => {
    const endDay = dayIn(p.end.dueAt, roomTimeZone);
    let worked = endDay;
    if (prevEnd) worked = nextDay(prevEnd);
    else if (p.events[0]) worked = dayIn(p.events[0].dueAt, roomTimeZone);
    const from = p.startsOn ?? (worked > endDay ? endDay : worked);
    prevEnd = endDay;
    return { n: p.n, name: p.name, from, fromSet: !!p.startsOn, startsOn: p.startsOn, events: p.events, end: p.end, status: 'next' as const };
  });
  const ahead = cards.filter((c) => new Date(c.end.dueAt) > now);
  const current = ahead.find((c) => c.from <= today) ?? ahead[0];
  for (const c of cards) {
    if (c === current) c.status = 'now';
    else if (!ahead.includes(c)) c.status = 'done';
  }
  return { phases: cards, loose };
}

export function phaseDates(ph: PhaseCard, today: string, timeZone: string): { range: string; extra: string } {
  const from = new Date(`${ph.from}T12:00:00Z`);
  const range = `${formatDay(from, 'UTC', from)} to ${formatDay(ph.end.dueAt, timeZone, new Date(0))}`;
  let extra = '';
  if (ph.status === 'now') {
    extra = ` · ${plural(daysBetween(today, dayIn(ph.end.dueAt, timeZone)), 'day left', 'days left')}`;
  } else if (ph.status === 'next') {
    const starts = daysBetween(today, ph.from);
    if (starts > 0) extra = ` · starts in ${plural(starts, 'day', 'days')}`;
  }
  return { range, extra };
}

export function phaseFor(cards: PhaseCard[], at: Date): PhaseCard | null {
  return cards.find((c) => new Date(c.end.dueAt).getTime() >= at.getTime()) ?? null;
}

/** subgroups inherit their parent's dates */
export function groupSees(m: Milestone, g: Pick<TimelineGroup, 'id' | 'parentGroupId'>): boolean {
  const ids = m.visibleToGroupIds ?? [];
  return ids.length === 0 || ids.includes(g.id) || (!!g.parentGroupId && ids.includes(g.parentGroupId));
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function audienceText(ids: string[], groups: TimelineGroup[]): { text: string; one: boolean } {
  if (ids.length) {
    const names = groups.filter((g) => ids.includes(g.id)).map((g) => g.name);
    return { text: joinNames(names), one: names.length === 1 };
  }
  if (groups.length === 1) return { text: groups[0]!.name, one: true };
  return { text: `All ${groups.length} bidder groups`, one: false };
}
