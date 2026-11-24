// SPDX-License-Identifier: AGPL-3.0-only
import type { paths } from '@/api/schema';
import { calendarDays, formatDayWithYear } from '@/components/dashboard/model';
import { formatDay, formatWhen, partsIn } from '@/lib/time';

export type MyRoomsResponse = paths['/v1/me/rooms']['get']['responses'][200]['content']['application/json'];
export type RoomCard = MyRoomsResponse['rooms'][number];
export type PastRoomCard = MyRoomsResponse['past'][number];
type Group = RoomCard['groups'][number];

export type FactTone = 'hot' | 'warn' | 'quiet' | '';
export interface Fact { tone: FactTone; text: string }

const n = (x: number) => x.toLocaleString('en-GB');
const count = (k: number, one: string, many: string) => `${n(k)} ${k === 1 ? one : many}`;

export function roomInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('').slice(0, 2);
}

export function youAre(r: { isAdmin: boolean; groups: Group[] }): string {
  if (r.isAdmin) return 'Room admin';
  const g = r.groups.find((x) => !x.subgroup) ?? r.groups[0];
  if (!g) return 'Member';
  return `${g.name} · ${g.role === 'lead' ? 'Lead' : 'Member'}`;
}

export function companyLine(sellerName: string | null, runBy: string): string {
  return sellerName ?? `Run by ${runBy}`;
}

export const COUNTDOWN_DAYS = 7;

function countdown(dueAt: string, timeZone: string, now: Date): string {
  const d = calendarDays(now, new Date(dueAt), timeZone);
  if (d > COUNTDOWN_DAYS) return '';
  if (d <= 0) return ' · today';
  if (d === 1) return ' · tomorrow';
  return ` · ${n(d)} days`;
}

export function deadlineLine(m: { title: string; dueAt: string }, timeZone: string, now: Date): string {
  return `${m.title} ${formatWhen(m.dueAt, timeZone, now)}${countdown(m.dueAt, timeZone, now)}`;
}

// skip when it is the last visit the card already shows
function sinceNote(since: string | null, lastVisitAt: string | null, timeZone: string, now: Date): string {
  if (!since) return '';
  if (lastVisitAt && calendarDays(new Date(since), new Date(lastVisitAt), timeZone) === 0) return '';
  return ` since ${formatDay(since, timeZone, now)}`;
}

export function roomFacts(r: RoomCard, timeZone: string, now: Date): Fact[] {
  const out: Fact[] = [];
  const a = r.attention;
  let milestone = r.nextMilestone;
  if (r.state === 'preparing') {
    out.push({ tone: '', text: r.canEnter ? 'Bidders cannot sign in yet' : 'Not open yet. The room admin emails you when it opens' });
  }
  if (r.state === 'frozen') {
    let text = 'Nobody can upload or publish';
    if (milestone) text = `${milestone.title} ${formatDay(milestone.dueAt, timeZone, now)}. ${text}`;
    out.push({ tone: '', text });
    milestone = null;
  }
  if (a.ndaToAccept) out.push({ tone: 'warn', text: 'Accept the NDA to enter the room' });
  let requests: Fact | null = null;
  if (a.colleagueRequests) {
    const text = `${count(a.colleagueRequests, 'request', 'requests')} to add a colleague`;
    requests = { tone: 'warn', text: r.isAdmin ? text : `${text} waiting` };
  }
  const drafts = a.draftsWaiting ? { tone: 'warn' as const, text: `${count(a.draftsWaiting, 'draft', 'drafts')} waiting in Release review` } : null;
  const fresh = a.newDocuments && a.newDocuments.count > 0
    ? { tone: 'hot' as const, text: `${count(a.newDocuments.count, 'new document', 'new documents')}${sinceNote(a.newDocuments.since, r.lastVisitAt, timeZone, now)}` }
    : null;
  const deadline = milestone ? { tone: '' as const, text: deadlineLine(milestone, timeZone, now) } : null;
  const order = r.isAdmin ? [requests, drafts, deadline] : [fresh, deadline, requests, drafts];
  for (const f of order) if (f) out.push(f);
  const busy = out.some((f) => f.tone === 'hot' || f.tone === 'warn');
  if (!busy && r.canEnter && out.length < 3) out.push({ tone: 'quiet', text: 'Nothing new since your last visit' });
  return out.slice(0, 3);
}

export function pastFacts(r: PastRoomCard, timeZone: string): Fact[] {
  if (!r.endedAt) return [{ tone: '', text: r.kind === 'closed' ? 'Closed' : 'Your access has ended' }];
  const day = formatDayWithYear(r.endedAt, timeZone);
  return [{ tone: '', text: r.kind === 'closed' ? `Closed ${day}` : `Your access ended ${day}` }];
}

function clock(at: string, timeZone: string): string {
  const p = partsIn(new Date(at), timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function lastVisit(at: string | null, timeZone: string, now: Date): string {
  if (!at) return 'No visit yet';
  const d = calendarDays(new Date(at), now, timeZone);
  if (d === 0) return `Last visit Today ${clock(at, timeZone)}`;
  if (d === 1) return `Last visit Yesterday ${clock(at, timeZone)}`;
  return `Last visit ${formatDay(at, timeZone, now)}`;
}

export function statusBadge(state: string): { cls: string; label: string } {
  switch (state) {
    case 'open': return { cls: 'b-ok', label: 'Open' };
    case 'preparing': return { cls: 'b-neutral', label: 'Preparing' };
    case 'frozen': return { cls: 'b-warn', label: 'Frozen' };
    case 'access_ended': return { cls: 'b-neutral', label: 'Access ended' };
    default: return { cls: 'b-neutral', label: 'Closed' };
  }
}

export function matches(q: string, ...texts: string[]): boolean {
  const s = q.trim().toLowerCase();
  return !s || texts.join(' ').toLowerCase().includes(s);
}
