// SPDX-License-Identifier: AGPL-3.0-only
import type { paths } from '@/api/client';
import { formatDay, formatTime, partsIn } from '@/lib/time';

export type LogPage = paths['/v1/workspaces/{ws}/events']['get']['responses'][200]['content']['application/json'];
export type LogEntry = LogPage['items'][number];
export type Summary = paths['/v1/workspaces/{ws}/activity/summary']['get']['responses'][200]['content']['application/json'];
export type SummaryGroup = Summary['groups'][number];
export type GroupPeople = paths['/v1/workspaces/{ws}/activity/groups/{group}/people']['get']['responses'][200]['content']['application/json'];
export type Chain = paths['/v1/workspaces/{ws}/events/verify']['get']['responses'][200]['content']['application/json'];

export const KINDS = [
  ['all', 'All'], ['view', 'Views'], ['download', 'Downloads'], ['upload', 'Uploads and publishing'], ['access', 'Access changes'],
  ['signin', 'Sign-ins and blocked links'],
] as const;
export type KindKey = (typeof KINDS)[number][0];

export const PERIODS = [
  ['7d', 'Last 7 days'], ['today', 'Today'], ['30d', 'Last 30 days'], ['all', 'Since the room opened'], ['custom', 'Choose dates…'],
] as const;
export type PeriodKey = (typeof PERIODS)[number][0];

export interface Filters {
  group: string;
  person: string;
  kind: KindKey;
  q: string;
  period: PeriodKey;
  /** YYYY-MM-DD, reader's zone */
  from: string;
  to: string;
}

export const NO_FILTERS: Filters = { group: '', person: '', kind: 'all', q: '', period: '7d', from: '', to: '' };

const pad = (n: number) => String(n).padStart(2, '0');

export function dayIn(timeZone: string, back: number, now = new Date()): string {
  const p = partsIn(now, timeZone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function logQuery(f: Filters, timeZone: string, now = new Date()): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.group) q.group = f.group;
  if (f.person) q.person = f.person;
  if (f.kind !== 'all') q.kind = f.kind;
  if (f.q.trim()) q.q = f.q.trim();
  if (f.period === '7d') q.from = dayIn(timeZone, 6, now);
  if (f.period === 'today') q.from = dayIn(timeZone, 0, now);
  if (f.period === '30d') q.from = dayIn(timeZone, 29, now);
  if (f.period === 'custom') {
    if (f.from) q.from = f.from;
    if (f.to) q.to = f.to;
  }
  return q;
}

export function filterSearch(f: Filters): string {
  const s = new URLSearchParams();
  if (f.group) s.set('group', f.group);
  if (f.person) s.set('person', f.person);
  if (f.kind !== 'all') s.set('kind', f.kind);
  if (f.q.trim()) s.set('q', f.q.trim());
  if (f.period !== '7d') s.set('period', f.period);
  if (f.period === 'custom') {
    if (f.from) s.set('from', f.from);
    if (f.to) s.set('to', f.to);
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

export function filtersFrom(sp: Record<string, string | string[] | undefined>): Filters {
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
  const uuid = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : '');
  const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const kind = KINDS.find((k) => k[0] === one('kind'))?.[0] ?? 'all';
  const period = PERIODS.find((p) => p[0] === one('period'))?.[0] ?? '7d';
  return {
    group: uuid(one('group')),
    person: uuid(one('person')),
    kind,
    q: one('q').slice(0, 200),
    period,
    from: date(one('from')),
    to: date(one('to')),
  };
}

export function dayHeading(at: string, timeZone: string, now = new Date()): string {
  const key = dayIn(timeZone, 0, new Date(at));
  const day = formatDay(at, timeZone, now);
  if (key === dayIn(timeZone, 0, now)) return `Today, ${day}`;
  if (key === dayIn(timeZone, 1, now)) return `Yesterday, ${day}`;
  return day;
}

export function clockTime(at: string, timeZone: string): string {
  return formatTime(at, timeZone).split(' ')[0]!;
}

export function lastSeen(at: string, timeZone: string, now = new Date()): string {
  return dayIn(timeZone, 0, new Date(at)) === dayIn(timeZone, 0, now) ? `Today ${clockTime(at, timeZone)}` : formatDay(at, timeZone, now);
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${pad(m)} min` : `${h} h`;
}

export const n = (x: number) => x.toLocaleString('en-GB');

export function groupColours(groups: { id: string; name: string; parentGroupId: string | null }[]): Map<string, string> {
  const COLOURS = ['var(--g-a)', 'var(--g-b)', 'var(--g-c)'];
  const out = new Map<string, string>();
  const mains = groups.filter((g) => !g.parentGroupId).sort((a, b) => a.name.localeCompare(b.name));
  mains.forEach((g, i) => out.set(g.id, COLOURS[i % COLOURS.length]!));
  for (const g of groups) if (g.parentGroupId) out.set(g.id, out.get(g.parentGroupId) ?? 'var(--g-s)');
  return out;
}

export function entryColour(e: LogEntry, colours: Map<string, string>): string {
  if (!e.group || e.group.isAdmin) return 'var(--muted)';
  return colours.get(e.group.id) ?? (e.group.parentGroupId ? colours.get(e.group.parentGroupId) : undefined) ?? 'var(--g-s)';
}

export function coverageText(c: NonNullable<LogEntry['coverage']>): string {
  return `${n(c.pagesSeen)} of ${n(c.pageCount)} ${c.pageCount === 1 ? 'page' : 'pages'} · ${c.minutes < 1 ? 'under a minute' : `${c.minutes} min`}`;
}
