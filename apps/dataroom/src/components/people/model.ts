// SPDX-License-Identifier: AGPL-3.0-only
import type { paths } from '@/api/client';
import { GROUP_COLOURS } from '@/components/dashboard/model';
import { formatDay, formatTime, partsIn, utcOffsetMinutes } from '@/lib/time';

export type PeopleData = paths['/v1/workspaces/{ws}/people']['get']['responses'][200]['content']['application/json'];
export type ApiGroup = PeopleData['parties'][number]['groups'][number];
export type ApiMember = ApiGroup['members'][number];
export type ColleagueRequest = paths['/v1/workspaces/{ws}/team-requests']['get']['responses'][200]['content']['application/json']['items'][number];
export type Removal = paths['/v1/workspaces/{ws}/removal-requests']['get']['responses'][200]['content']['application/json']['items'][number];

export type Side = 'bid' | 'sell';

export interface Group {
  id: string;
  name: string;
  side: Side;
  partyId: string;
  parentId: string | null;
  admin: boolean;
  observer: boolean;
  colour: string;
  organisation: string | null;
  note: string | null;
  until: string | null;
  soon: boolean;
  revoked: boolean;
  ended: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  members: ApiMember[];
}

export interface Folder { id: string; ix: string; name: string }

export function andList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function noteOf(g: ApiGroup): string | null {
  if (g.roleTemplate === 'admin') return 'See and manage everything';
  if (g.roleTemplate === 'observer') return 'Observers · read only';
  const parts: string[] = [];
  if (g.uploadFolders.length) parts.push(`Contributors · add files to ${andList(g.uploadFolders)}`);
  if (g.publishFolders.length) parts.push(`${parts.length ? 'publishes' : 'Publishes'} in ${andList(g.publishFolders)}`);
  return parts.length ? parts.join(' · ') : null;
}

export function groupsOf(data: PeopleData, now: Date): Group[] {
  const flat = data.parties.flatMap((p) => p.groups.map((g) => ({ g, side: (p.kind === 'seller' ? 'sell' : 'bid') as Side, partyId: p.id })));
  const ended = (x: ApiGroup) => x.revoked && !x.revokedBy;
  const bidTops = flat.filter((x) => x.side === 'bid' && !x.g.parentGroupId && !x.g.revoked).sort((a, b) => a.g.name.localeCompare(b.g.name));
  const colour = new Map<string, string>();
  bidTops.forEach((x, i) => colour.set(x.g.id, GROUP_COLOURS[i % GROUP_COLOURS.length]!));
  const soonAt = now.getTime() + 14 * 86_400_000;
  const colourOf = (g: ApiGroup, side: Side) => {
    if (g.revoked) return 'var(--muted)';
    if (g.roleTemplate === 'admin') return 'var(--accent)';
    if (side === 'sell') return 'var(--g-s)';
    return colour.get(g.id) ?? colour.get(g.parentGroupId ?? '') ?? 'var(--g-s)';
  };
  const toGroup = ({ g, side, partyId }: (typeof flat)[number]): Group => ({
    id: g.id,
    name: g.name,
    side,
    partyId,
    parentId: g.parentGroupId,
    admin: g.roleTemplate === 'admin',
    observer: g.roleTemplate === 'observer',
    colour: colourOf(g, side),
    organisation: g.organisation,
    note: side === 'sell' ? noteOf(g) : null,
    until: g.accessEndsAt,
    soon: !g.revoked && !!g.accessEndsAt && new Date(g.accessEndsAt).getTime() <= soonAt,
    revoked: g.revoked && !ended(g),
    ended: ended(g),
    revokedAt: g.revokedAt,
    revokedBy: g.revokedBy,
    revokedReason: g.revokedReason,
    members: g.members,
  });

  type Entry = (typeof flat)[number];
  const byRevokedThenName = (a: Entry, b: Entry) => Number(a.g.revoked) - Number(b.g.revoked) || a.g.name.localeCompare(b.g.name);
  const adminFirst = (a: Entry, b: Entry) =>
    Number(a.g.revoked) - Number(b.g.revoked)
    || Number(b.g.roleTemplate === 'admin') - Number(a.g.roleTemplate === 'admin')
    || a.g.name.localeCompare(b.g.name);

  const out: Group[] = [];
  for (const side of ['bid', 'sell'] as const) {
    const mine = flat.filter((x) => x.side === side);
    const tops = mine.filter((x) => !x.g.parentGroupId).sort(adminFirst);
    for (const t of tops) {
      out.push(toGroup(t));
      const subs = mine.filter((x) => x.g.parentGroupId === t.g.id).sort(byRevokedThenName);
      for (const x of subs) out.push(toGroup(x));
    }
  }
  return out;
}

export type StatusKind = '' | 'att' | 'off';

export const noName = (m: ApiMember) => !m.givenName || m.name === m.email;

export function statusOf(m: ApiMember, g: Group, roomTz: string, now: Date, ownTz: string = roomTz): { text: string; kind: StatusKind; remind: boolean } {
  if (m.status === 'revoked' || g.revoked) {
    const at = m.revokedAt ?? g.revokedAt;
    return { text: at ? `Access revoked ${formatDay(at, ownTz, now)}` : 'Access revoked', kind: 'off', remind: false };
  }
  if (m.status === 'expired' || g.ended) {
    const at = m.accessEndsAt ?? g.until;
    return { text: at ? `Access ended ${formatDay(at, roomTz, now)}` : 'Access ended', kind: 'off', remind: false };
  }
  if (m.disabled) return { text: 'Account disabled by a site admin', kind: 'off', remind: false };
  // recorded, not emailed: room not open to this group yet
  if (m.invitationWaits) return { text: 'Invitation waits for the room to open', kind: '', remind: false };
  const invited = m.invitedAt ? `Invited ${formatDay(m.invitedAt, ownTz, now)}` : 'Invited';
  if (m.status === 'invited') return { text: `${invited}, not signed in`, kind: 'att', remind: true };
  if (m.status === 'link_expired') return { text: `${invited}, link expired`, kind: 'att', remind: true };
  if (m.ndaAccepted === false) return { text: 'Has not accepted the NDA', kind: 'att', remind: true };
  if (m.removalRequested) return { text: 'A lead asked to remove them', kind: 'att', remind: false };
  return { text: 'Active', kind: '', remind: false };
}

export const waitingIn = (g: Group, roomTz: string, now: Date) => g.members.filter((m) => statusOf(m, g, roomTz, now).remind).length;

export const hasEnded = (m: ApiMember, g: Group) => g.revoked || g.ended || m.status === 'revoked' || m.status === 'expired';

// access ends 23:59 room time
export function longDay(iso: string, tz: string): string {
  const d = new Date(iso);
  const p = partsIn(d, tz);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(d);
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'short' }).format(d);
  return `${weekday} ${p.day} ${month} ${p.year}`;
}

// must match {until} in the invitation email
export function untilWords(iso: string | null, roomTz: string): string {
  if (!iso) return 'the room closes';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: roomTz })
    .format(new Date(iso)).replace(/,/g, '');
}

export function dayInput(iso: string | null, roomTz: string): string {
  if (!iso) return '';
  const p = partsIn(new Date(iso), roomTz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// ask the zone twice for summer time
export function endOfDay(day: string, roomTz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59);
  let t = local - utcOffsetMinutes(new Date(local), roomTz) * 60_000;
  t = local - utcOffsetMinutes(new Date(t), roomTz) * 60_000;
  return new Date(t).toISOString();
}

function calendarDaysAgo(iso: string, now: Date, tz: string): number {
  const a = partsIn(new Date(iso), tz);
  const b = partsIn(now, tz);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function whenShort(iso: string, tz: string, now: Date): string {
  const days = calendarDaysAgo(iso, now, tz);
  if (days === 0) return `Today ${formatTime(iso, tz)}`;
  if (days === 1) return `Yesterday ${formatTime(iso, tz)}`;
  return formatDay(iso, tz, now);
}

export function mailsIn(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@')))];
}

export const isEmail = (x: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);

export const firstName = (m: { givenName?: string; name: string }) => m.givenName || m.name.split(' ')[0] || m.name;

export function problemText(error: unknown, fallback: string): string {
  const p = error as { detail?: string; title?: string } | undefined;
  return p?.detail ?? p?.title ?? fallback;
}
