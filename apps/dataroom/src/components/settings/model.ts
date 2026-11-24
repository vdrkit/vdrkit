// SPDX-License-Identifier: AGPL-3.0-only
import type { paths } from '@/api/client';

export type Settings = paths['/v1/workspaces/{ws}/settings']['get']['responses'][200]['content']['application/json'];
export type SettingsPatch = NonNullable<paths['/v1/workspaces/{ws}/settings']['patch']['requestBody']>['content']['application/json'];
export type NdaOverview = paths['/v1/workspaces/{ws}/nda/overview']['get']['responses'][200]['content']['application/json'];
export type Frequency = 'immediate' | 'bundled' | 'digest';
export type RoomState = 'preparing' | 'open' | 'frozen' | 'closed';

export type LogoChange = { kind: 'keep' } | { kind: 'new'; contentType: string; data: string; preview: string; fileName: string } | { kind: 'remove' };

export interface Cat { enabled: boolean; mode: Frequency; mandatory: boolean }

export interface Working {
  name: string;
  seller: string;
  tz: string;
  state: string;
  logoLight: LogoChange;
  logoDark: LogoChange;
  nda: boolean;
  wm: { name: boolean; email: boolean; group: boolean; dateTime: boolean; ip: boolean };
  tfa: boolean;
  trust: boolean;
  trustDays: number;
  idle: number;
  fourEyes: boolean;
  quiet: number;
  max: number;
  d1: string;
  d2: string;
  cats: Record<string, Cat>;
  inv: { from: string; reply: string; subject: string; body: string; lead: string };
}

export type Key = keyof Working;
export type SettingsTab = 'general' | 'nda' | 'signin' | 'wm' | 'pub' | 'notif' | 'invite';

export const TABS: [SettingsTab, string][] = [
  ['general', 'General'], ['nda', 'NDA'], ['signin', 'Sign-in'], ['wm', 'Watermark'], ['pub', 'Publishing'], ['notif', 'Notifications'], ['invite', 'Invitation email'],
];

export const OWNER: Record<Key, SettingsTab> = {
  name: 'general', seller: 'general', tz: 'general', state: 'general', logoLight: 'general', logoDark: 'general',
  nda: 'nda', wm: 'wm', tfa: 'signin', trust: 'signin', trustDays: 'signin', idle: 'signin', fourEyes: 'pub',
  quiet: 'notif', max: 'notif', d1: 'notif', d2: 'notif', cats: 'notif', inv: 'invite',
};

export const LABEL: Record<Key, string> = {
  name: 'room name', seller: 'seller', tz: 'time zone', state: 'room state', logoLight: 'room logo', logoDark: 'room logo', nda: 'NDA',
  wm: 'watermark', tfa: 'two-factor sign-in', trust: 'trusted browsers', trustDays: 'trusted browsers', idle: 'sign-out after inactivity',
  fourEyes: 'four-eyes rule', quiet: 'bundling', max: 'bundling', d1: 'summary time', d2: 'summary time',
  cats: 'notifications', inv: 'invitation email',
};

export function workingFrom(s: Settings): Working {
  const t = s.notificationTiming;
  const cats: Record<string, Cat> = {};
  for (const [k, v] of Object.entries(s.notifications)) {
    cats[k] = { enabled: v.mandatory || v.enabled, mode: v.mode as Frequency, mandatory: v.mandatory };
  }
  return {
    name: s.name, seller: s.sellerName ?? '', tz: s.timeZone, state: s.state,
    logoLight: { kind: 'keep' }, logoDark: { kind: 'keep' },
    nda: s.requiresNda, wm: { ...s.watermark },
    tfa: s.requireTwoFactor, trust: s.allowTrustedBrowser, trustDays: s.trustedBrowserDays, idle: s.idleSignOutMinutes,
    fourEyes: s.fourEyesPublish,
    quiet: t.bundleQuietMinutes, max: t.bundleMaxMinutes, d1: t.summaryTimes[0] ?? '08:00', d2: t.summaryTimes[1] ?? '',
    cats,
    inv: { from: s.invitation.senderName, reply: s.invitation.replyTo, subject: s.invitation.subject, body: s.invitation.message, lead: s.invitation.leadParagraph },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function changedKeys(w: Working, saved: Working): Key[] {
  // save trims, so spaces alone aren't a change
  const norm = (k: Key, v: unknown) => (k === 'name' || k === 'seller') && typeof v === 'string' ? v.trim() : v;
  return (Object.keys(OWNER) as Key[]).filter((k) => !same(norm(k, w[k]), norm(k, saved[k])));
}

export function problems(w: Working, saved?: Working): Partial<Record<Key, string>> {
  const out: Partial<Record<Key, string>> = {};
  if (w.name.trim().length < 2) out.name = 'Give the room a name of at least two characters.';
  // can't empty a named seller
  const sellerLen = w.seller.trim().length;
  if ((sellerLen > 0 || (saved?.seller.trim() ?? '') !== '') && sellerLen < 2) out.seller = 'Give the seller a name of at least two characters.';
  if (!w.wm.name && !w.wm.email) out.wm = 'A watermark must carry at least the name or the email address.';
  if (!Number.isInteger(w.trustDays) || w.trustDays < 1 || w.trustDays > 90) out.trustDays = 'Choose between 1 and 90 days.';
  if (!Number.isInteger(w.quiet) || w.quiet < 1 || w.quiet > 60) out.quiet = 'Quiet time is 1 to 60 minutes.';
  else if (!Number.isInteger(w.max) || w.max < 10 || w.max > 240) out.max = 'The longest wait is 10 to 240 minutes.';
  else if (w.max < w.quiet) out.max = 'The longest wait cannot be shorter than the quiet time.';
  if (!/^\d\d:\d\d$/.test(w.d1)) out.d1 = 'Choose a time for the daily summary.';
  else if (w.d2 && w.d2 === w.d1) out.d2 = 'Choose two different summary times, or only one.';
  if (!w.inv.subject.trim()) out.inv = 'The invitation needs a subject.';
  else if (!w.inv.body.trim()) out.inv = 'The invitation needs a message.';
  else if (w.inv.reply.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(w.inv.reply.trim())) out.inv = 'Replies need a valid email address, or leave the field empty.';
  return out;
}

// null keeps tracking the default text
export function patchFor(w: Working, saved: Working, s: Settings): SettingsPatch {
  const b: SettingsPatch = {};
  const ch = new Set(changedKeys(w, saved));
  if (ch.has('name')) b.name = w.name.trim();
  if (ch.has('seller') && w.seller.trim() !== saved.seller.trim()) b.sellerName = w.seller.trim();
  if (ch.has('tz')) b.timeZone = w.tz;
  if (ch.has('state')) b.state = w.state as SettingsPatch['state'];
  if (ch.has('nda')) b.requiresNda = w.nda;
  if (ch.has('wm')) b.watermark = w.wm;
  if (ch.has('tfa')) b.requireTwoFactor = w.tfa;
  if (ch.has('trust')) b.allowTrustedBrowser = w.trust;
  if (ch.has('trustDays')) b.trustedBrowserDays = w.trustDays;
  if (ch.has('idle')) b.idleSignOutMinutes = w.idle;
  if (ch.has('fourEyes')) b.fourEyesPublish = w.fourEyes;
  if (ch.has('quiet') || ch.has('max') || ch.has('d1') || ch.has('d2')) {
    b.notificationTiming = { bundleQuietMinutes: w.quiet, bundleMaxMinutes: w.max, summaryTimes: w.d2 ? [w.d1, w.d2] : [w.d1] };
  }
  if (ch.has('cats')) {
    b.notifications = {};
    for (const [k, c] of Object.entries(w.cats)) {
      if (same(c, saved.cats[k])) continue;
      const was = s.notifications[k];
      // keep fields this screen doesn't show
      b.notifications[k] = { enabled: c.mandatory || c.enabled, mode: c.mode, mandatory: c.mandatory,
        allowedModes: (was?.allowedModes ?? null) as never, digestTimes: was?.digestTimes ?? null };
    }
  }
  if (ch.has('inv')) {
    const d = s.invitationDefault;
    const inv: NonNullable<SettingsPatch['invitation']> = {};
    if (w.inv.subject !== saved.inv.subject) inv.subject = w.inv.subject.trim() === d.subject ? null : w.inv.subject;
    if (w.inv.body !== saved.inv.body) inv.message = w.inv.body.trim() === d.message ? null : w.inv.body;
    if (w.inv.lead !== saved.inv.lead) inv.leadParagraph = w.inv.lead.trim() === d.leadParagraph ? null : w.inv.lead;
    if (w.inv.from !== saved.inv.from) inv.senderName = w.inv.from.trim();
    if (w.inv.reply !== saved.inv.reply) inv.replyTo = w.inv.reply.trim();
    b.invitation = inv;
  }
  return b;
}

export function idleText(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return '1 hour';
  return `${minutes / 60} hours`;
}
