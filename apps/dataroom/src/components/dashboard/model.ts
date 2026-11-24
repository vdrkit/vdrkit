// SPDX-License-Identifier: AGPL-3.0-only
// Nothing here may name or count another bidder for a bidder.
import type { paths } from '@/api/schema';
import { formatDay, formatTime, partsIn, zoneAbbreviation } from '@/lib/time';

export type DashboardData = paths['/v1/workspaces/{ws}/dashboard']['get']['responses'][200]['content']['application/json'];
export type NewFolder = NonNullable<DashboardData['newSinceLastVisit']>[number];

export const NEW_PER_FOLDER = 5;

export const newCount = (folders: NewFolder[]) => folders.reduce((s, f) => s + f.count, 0);
export type TeamCoverage = NonNullable<DashboardData['teamCoverage']>;
export type Coverage = TeamCoverage;
export type MyRequest = NonNullable<DashboardData['myRequests']>[number];
export type ToDo = NonNullable<DashboardData['toDo']>;
export type NotPublished = NonNullable<DashboardData['notPublished']>[number];
export type GroupActivity = NonNullable<DashboardData['activity']>[number];
export type TeamRequest = paths['/v1/workspaces/{ws}/team-requests']['get']['responses'][200]['content']['application/json']['items'][number];

/** With a phase: the deadline that ends it. Empty audience = every group. */
export interface Milestone {
  id: string; title: string; dueAt: string;
  phase?: { name: string; startsOn: string | null } | null;
  visibleToGroupIds?: string[];
}

export interface Phase { n: number; name: string; startsOn: string | null; events: Milestone[]; end: Milestone }

// Events after the last deadline are loose. No first day: the day after the previous deadline, else the first event.
export function phasesOf(milestones: Milestone[]): { phases: Phase[]; loose: Milestone[] } {
  const sorted = [...milestones].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const phases: Phase[] = [];
  let events: Milestone[] = [];
  for (const m of sorted) {
    if (!m.phase) { events.push(m); continue; }
    phases.push({ n: phases.length + 1, name: m.phase.name, startsOn: m.phase.startsOn, events, end: m });
    events = [];
  }
  return { phases, loose: events };
}
export const GROUP_COLOURS = ['var(--g-a)', 'var(--g-b)', 'var(--g-c)'] as const;

export function groupColours(groups: { groupId: string; groupName: string; parentGroupId: string | null; partyKind?: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) if (g.partyKind === 'seller') out.set(g.groupId, 'var(--g-s)');
  const bidders = groups.filter((g) => !g.parentGroupId && g.partyKind !== 'seller');
  bidders.sort((a, b) => a.groupName.localeCompare(b.groupName));
  bidders.forEach((g, i) => out.set(g.groupId, GROUP_COLOURS[i % GROUP_COLOURS.length]!));
  for (const g of groups) if (g.parentGroupId) out.set(g.groupId, out.get(g.parentGroupId) ?? 'var(--g-s)');
  return out;
}

export const n = (x: number) => x.toLocaleString('en-GB');
export const plural = (k: number, one: string, many: string) => `${n(k)} ${k === 1 ? one : many}`;

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
export const word = (k: number) => WORDS[k] ?? n(k);

export function splitFolder(label: string | null): { ix: string; name: string } {
  if (!label) return { ix: '', name: 'Other folders' };
  const m = /^(\d+(?:\.\d+)*)\s+(.*)$/.exec(label);
  return m ? { ix: m[1]!, name: m[2]! } : { ix: '', name: label };
}

export function fileType(name: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

export function calendarDays(a: Date, b: Date, timeZone: string): number {
  const pa = partsIn(a, timeZone), pb = partsIn(b, timeZone);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

export function formatWhenWithYear(at: Date | string, timeZone: string): string {
  const d = new Date(at);
  return `${formatDay(d, timeZone, d)} ${partsIn(d, timeZone).year}, ${formatTime(d, timeZone)}`;
}

export function formatDayWithYear(at: Date | string, timeZone: string): string {
  const d = new Date(at);
  return `${formatDay(d, timeZone, d)} ${partsIn(d, timeZone).year}`;
}

export function formatAsked(at: string, timeZone: string, now: Date): string {
  const d = new Date(at);
  const day = calendarDays(d, now, timeZone) === 0 ? 'today' : formatDay(d, timeZone, now);
  return `${day}, ${formatTime(d, timeZone)}`;
}

/** calendar days in the viewer's zone; hours on the same day */
export function waited(since: string | null | undefined, now: Date, timeZone: string): string | null {
  if (!since) return null;
  const from = new Date(since);
  const days = calendarDays(from, now, timeZone);
  if (days >= 1) return `Waiting ${plural(days, 'day', 'days')}`;
  const hours = Math.floor((now.getTime() - from.getTime()) / 3_600_000);
  if (hours < 1) return 'Waiting under an hour';
  return `Waiting ${plural(hours, 'hour', 'hours')}`;
}

export function pastDay(day: Date, now: Date, timeZone: string): string {
  const back = calendarDays(day, now, timeZone);
  if (back === 0) return 'today';
  if (back === 1) return 'yesterday';
  if (back < 7) return `last ${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(day)}`;
  return `on ${formatDay(day, timeZone, now)}`;
}

export function lastSeen(at: string | null, timeZone: string, now: Date): string {
  if (!at) return 'Not yet';
  const d = new Date(at);
  const min = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const days = calendarDays(d, now, timeZone);
  if (days === 0) return formatTime(d, timeZone);
  if (days === 1) return `Yesterday, ${formatTime(d, timeZone)}`;
  return formatDay(d, timeZone, now);
}

export function zoneName(timeZone: string, now: Date): string {
  const city = (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
  return `${city} (${zoneAbbreviation(now, timeZone)})`;
}

export function seriesDays(now: Date, length = 7): Date[] {
  return Array.from({ length }, (_, i) => new Date(now.getTime() - (length - 1 - i) * 86_400_000));
}

export function slowdown(activity: GroupActivity[]): { group: GroupActivity; peak: number; peakIndex: number; today: number } | null {
  let best: { group: GroupActivity; peak: number; peakIndex: number; today: number } | null = null;
  for (const g of activity) {
    if (g.parentGroupId || g.partyKind === 'seller' || g.lastSevenDays.length < 2) continue;
    const before = g.lastSevenDays.slice(0, -1);
    const peak = Math.max(...before);
    const today = g.lastSevenDays.at(-1) ?? 0;
    if (peak < 10 || today * 4 > peak) continue;
    if (!best || peak - today > best.peak - best.today) best = { group: g, peak, peakIndex: before.indexOf(peak), today };
  }
  return best;
}
