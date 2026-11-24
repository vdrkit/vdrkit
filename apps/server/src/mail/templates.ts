// SPDX-License-Identifier: AGPL-3.0-only
import { zoneAbbreviation, type OutgoingMessage } from '@vdrkit/core';
import { siteName } from './branding.js';
import { renderEmail, type Block, type EmailContent, type FooterLine, type MailBranding } from './layout.js';

export interface Email {
  subject: string;
  html: string;
  text: string;
  inline: OutgoingMessage['inline'];
  fromName?: string;
  /** only if MAIL_FROM has no name */
  fallbackFromName?: string;
  replyTo?: string;
}

export function toMessage(e: Email, personId: string, to: string): OutgoingMessage {
  const msg: OutgoingMessage = { personId, to, subject: e.subject, html: e.html, text: e.text };
  if (e.inline?.length) msg.inline = e.inline;
  if (e.fromName) msg.fromName = e.fromName;
  if (e.fallbackFromName) msg.fallbackFromName = e.fallbackFromName;
  if (e.replyTo) msg.replyTo = e.replyTo;
  return msg;
}

export function build(subject: string, brand: MailBranding, content: EmailContent, from: Pick<Email, 'fromName' | 'fallbackFromName' | 'replyTo'>): Email {
  const r = renderEmail(subject, brand, content);
  return { subject, html: r.html, text: r.text, inline: r.inline, ...from };
}

const base = (url: string) => url.replace(/\/$/, '');

export function clockTime(d: Date, timeZone: string): string {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${t} ${zoneAbbreviation(d, timeZone)}`;
}

export function dayAndTime(d: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .format(d).replace(/,/g, '');
  return `${day}, ${clockTime(d, timeZone)}`;
}

export function duration(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (days) return hours ? `${part(days, 'day')} ${part(hours, 'hour')}` : part(days, 'day');
  if (hours) return minutes ? `${part(hours, 'hour')} ${part(minutes, 'minute')}` : part(hours, 'hour');
  return part(minutes, 'minute');
}

const greeting = (givenName: string) => (givenName ? `Dear ${givenName}` : 'Dear colleague');

function roomSentLine(room: string, brand: MailBranding): FooterLine {
  return [brand.orgName ? `Sent from the ${room} data room, run by ${brand.orgName}. Powered by VDRkit.` : `Sent from the ${room} data room. Powered by VDRkit.`];
}

export function roomFooter(why: string, room: string, brand: MailBranding, notificationsUrl: string | null): FooterLine[] {
  const first: FooterLine = notificationsUrl ? [`${why} `, { label: 'Change your email notifications', url: notificationsUrl }, '.'] : [why];
  return [first, roomSentLine(room, brand)];
}

function siteFooter(brand: MailBranding): FooterLine[] {
  const site = siteName(brand);
  return [[site ? `Sent by ${site}. Powered by VDRkit.` : 'Powered by VDRkit.']];
}

export const roomFrom = (room: string) => ({ fromName: `${room} data room` });
export function siteFrom(brand: MailBranding) {
  const name = siteName(brand);
  return name ? { fromName: name } : {};
}

export const notificationsUrl = (publicUrl: string, ws: string) => `${base(publicUrl)}/rooms/${ws}/profile?tab=notifications`;

export function invitationEmail(a: {
  brand: MailBranding; room: string; subject: string; message: string; leadParagraph: string | null; url: string; to: string;
  linkDays: number; fromName?: string; replyTo?: string;
}): Email {
  const blocks: Block[] = [{ kind: 'text', text: a.message.trim() }];
  if (a.leadParagraph) blocks.push({ kind: 'quote', text: a.leadParagraph });
  blocks.push({ kind: 'button', label: 'Open the data room', url: a.url });
  const sent = roomSentLine(a.room, a.brand)[0] as string;
  const from: Pick<Email, 'fromName' | 'replyTo'> = a.fromName ? { fromName: a.fromName } : roomFrom(a.room);
  if (a.replyTo) from.replyTo = a.replyTo;
  return build(a.subject, a.brand, {
    header: { room: a.room, label: 'Invitation' },
    blocks,
    footer: [[`This invitation is for ${a.to} only and expires after ${a.linkDays} days. ${sent}`]],
  }, from);
}

// no room name: a forwarded email must not reveal the deal
export function signInEmail(a: {
  brand: MailBranding; code: string | null; link: string | null; minutes: number; requestedAt: Date; timeZone: string;
  browser: string | null; ip?: string | null;
}): Email {
  // no spaces, or phones won't autofill
  const code = a.code ? a.code.replace(/\s+/g, '') : null;
  const subject = code ? `Your sign-in code: ${code}` : 'Your sign-in link';
  const from = [a.browser, a.ip ? `IP address ${a.ip}` : null].filter(Boolean).join(', ');
  const blocks: Block[] = [{ kind: 'heading', text: 'Sign in to your data room' }];
  let what: string;
  if (a.link && code) {
    what = 'The link and the code work';
    blocks.push({ kind: 'text', text: 'Click the button, or type this code on the sign-in page.' });
  } else if (a.link) {
    what = 'The link works';
    blocks.push({ kind: 'text', text: 'Click the button to sign in.' });
  } else {
    what = 'The code works';
    blocks.push({ kind: 'text', text: 'Type this code on the sign-in page.' });
  }
  if (code) blocks.push({ kind: 'code', code });
  if (a.link) blocks.push({ kind: 'button', label: 'Sign in', url: a.link });
  blocks.push({ kind: 'text', muted: true,
    text: `${what} once, within ${a.minutes} minutes. Requested at ${clockTime(a.requestedAt, a.timeZone)}${from ? ` from ${from}` : ''}.\n\n`
      + 'Did not ask to sign in? Ignore this email. Nobody can sign in without it.' });
  const site = a.brand.orgName ? `Sent by the data rooms of ${a.brand.orgName}. Powered by VDRkit.` : 'Powered by VDRkit.';
  return build(subject, a.brand, { header: { label: 'Sign in' }, blocks, footer: [[site]] }, siteFrom(a.brand));
}

export function colleagueRequestEmail(a: {
  brand: MailBranding; room: string; lead: string; group: string; name: string; email: string; company: string; role: string;
  reason: string; reviewUrl: string; notificationsUrl: string;
}): Email {
  const subject = `${a.lead} asks to add a colleague to ${a.group}`;
  const rows = [{ label: 'Name', value: a.name }, { label: 'Email', value: a.email }];
  if (a.company.trim()) rows.push({ label: 'Company', value: a.company });
  if (a.role.trim()) rows.push({ label: 'Role', value: a.role });
  const blocks: Block[] = [{ kind: 'heading', text: subject }, { kind: 'facts', rows }];
  if (a.reason.trim()) blocks.push({ kind: 'quote', text: a.reason.trim() });
  blocks.push({ kind: 'button', label: 'Review the request', url: a.reviewUrl });
  return build(subject, a.brand, {
    header: { room: a.room, label: 'Request' }, blocks,
    footer: roomFooter(`You get this email because you are a room admin of ${a.room}.`, a.room, a.brand, a.notificationsUrl),
  }, roomFrom(a.room));
}

export function requestDecisionEmail(a: {
  brand: MailBranding; room: string; approved: boolean; givenName: string; name: string; group: string; note: string | null;
  teamUrl: string; notificationsUrl: string;
}): Email {
  const subject = a.approved ? `${a.name} is invited to ${a.group}` : `Your request for ${a.name} was declined`;
  const outcome = a.approved
    ? `Your request to add ${a.name} to ${a.group} in the ${a.room} data room is approved. ${a.name} gets an invitation by email.`
    : `Your request to add ${a.name} to ${a.group} in the ${a.room} data room was declined. ${a.name} was not contacted.`;
  const blocks: Block[] = [
    { kind: 'heading', text: subject },
    { kind: 'text', text: `${greeting(a.givenName)},\n\n${outcome}` },
  ];
  if (!a.approved && a.note?.trim()) blocks.push({ kind: 'quote', text: `Reason from the room admin: ${a.note.trim()}` });
  blocks.push({ kind: 'text', text: 'You see all requests for your team under My team in the data room.' });
  blocks.push({ kind: 'button', label: 'Open My team', url: a.teamUrl });
  return build(subject, a.brand, {
    header: { room: a.room, label: 'Request' }, blocks,
    footer: roomFooter(`You get this email because you asked to add a colleague to ${a.group}.`, a.room, a.brand, a.notificationsUrl),
  }, roomFrom(a.room));
}

export function siteAdminJoinedEmail(a: {
  brand: MailBranding; room: string; joiner: string; joinedAt: Date; timeZone: string; reason: string; activityUrl: string; notificationsUrl: string;
}): Email {
  const first = a.joiner.trim().split(/\s+/)[0] || a.joiner;
  const site = siteName(a.brand);
  const role = site ? `${first} is a site admin of ${site}.` : `${first} is a site admin.`;
  const subject = `${a.joiner}, site admin, joined ${a.room}`;
  return build(subject, a.brand, {
    header: { room: a.room, label: 'Notice' },
    blocks: [
      { kind: 'heading', text: `${a.joiner} joined ${a.room} as room admin` },
      { kind: 'text', text: `${role} ${first} joined at ${clockTime(a.joinedAt, a.timeZone)} and gave this reason:` },
      { kind: 'quote', text: a.reason },
      { kind: 'text', text: `This is recorded in Activity. If you did not expect it, raise it with ${first} or with your site admins.` },
      { kind: 'button', label: 'See it in Activity', url: a.activityUrl },
    ],
    footer: roomFooter(`You get this email because you are a room admin of ${a.room}. It cannot be switched off.`, a.room, a.brand, a.notificationsUrl),
  }, roomFrom(a.room));
}

export const HEALTH_WORDS: Record<string, { down: string; up: string; effect: string; errorPage?: boolean }> = {
  database: { down: 'The database is not reachable', up: 'The database is reachable again', errorPage: true,
    effect: 'Nobody can sign in or open a room.' },
  storage: { down: 'File storage is not reachable', up: 'File storage is reachable again', errorPage: true,
    effect: 'Documents cannot be opened, downloaded or uploaded. Sign-in and the rest of the site work.' },
  email: { down: 'Outgoing email is not working', up: 'Outgoing email works again',
    effect: 'Invitations, sign-in codes and notifications cannot be sent. People who are signed in can keep working.' },
  conversion: { down: 'Document conversion is not working', up: 'Document conversion works again',
    effect: 'New Word, Excel and PowerPoint files cannot be converted, so they cannot be viewed yet. Documents already in the rooms open as before.' },
  virus_scanner: { down: 'The virus scanner is not reachable', up: 'The virus scanner is reachable again',
    effect: 'Uploads are not scanned for viruses.' },
  backups: { down: 'Backups cannot be checked', up: 'Backups can be checked again', effect: 'Nobody can tell whether the latest backup worked.' },
  version: { down: 'The version check is not working', up: 'The version check works again', effect: 'The site works as before.' },
};

const lowerFirst = (s: string) => (s.startsWith('The ') ? `the ${s.slice(4)}` : s.charAt(0).toLowerCase() + s.slice(1));

const healthButton = (url: string): Block[] => (/^https?:\/\//.test(url) ? [{ kind: 'button', label: 'Open Health', url }] : []);

function healthWords(check: string, label: string) {
  return HEALTH_WORDS[check] ?? { down: `${label} is not working`, up: `${label} works again`, effect: '' };
}

function healthFooter(brand: MailBranding, siteAdmin: boolean): FooterLine[] {
  const site = siteName(brand) ?? 'this data room site';
  const why = siteAdmin
    ? `You get this email because you are a site admin of ${site}.`
    : `You get this email because this address is set to get the health alerts of ${site}.`;
  return [[`${why} Change alerts in Site settings › Health. Powered by VDRkit.`]];
}

export function healthAlertEmail(a: {
  brand: MailBranding; check: string; label: string; since: Date; now: Date; timeZone: string; lastError: string; healthUrl: string; siteAdmin: boolean;
}): Email {
  const w = healthWords(a.check, a.label);
  const subject = `Problem: ${lowerFirst(w.down)}`;
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'Since', value: dayAndTime(a.since, a.timeZone) },
    { label: 'For', value: duration(a.now.getTime() - a.since.getTime()) },
  ];
  if (w.effect) rows.push({ label: 'Effect', value: w.effect });
  rows.push({ label: 'Last error', value: a.lastError, mono: true });
  return build(subject, a.brand, {
    header: { label: 'Health' },
    blocks: [
      { kind: 'alert', text: w.down },
      { kind: 'facts', rows },
      { kind: 'text', text: w.errorPage ? 'We email again when it recovers. Users see the "Something went wrong" page with a reference until then.' : 'We email again when it recovers.' },
      ...healthButton(a.healthUrl),
    ],
    footer: healthFooter(a.brand, a.siteAdmin),
  }, siteFrom(a.brand));
}

export function healthRecoveryEmail(a: {
  brand: MailBranding; check: string; label: string; since: Date | null; now: Date; timeZone: string; healthUrl: string; siteAdmin: boolean;
}): Email {
  const w = healthWords(a.check, a.label);
  const subject = `Recovered: ${lowerFirst(w.up)}`;
  const backAt = { label: 'Back at', value: dayAndTime(a.now, a.timeZone) };
  const rows = a.since
    ? [
      { label: 'Down since', value: dayAndTime(a.since, a.timeZone) },
      backAt,
      { label: 'Outage', value: duration(a.now.getTime() - a.since.getTime()) },
    ]
    : [backAt];
  return build(subject, a.brand, {
    header: { label: 'Health' },
    blocks: [{ kind: 'ok', text: w.up }, { kind: 'facts', rows }, ...healthButton(a.healthUrl)],
    footer: healthFooter(a.brand, a.siteAdmin),
  }, siteFrom(a.brand));
}

export function testEmail(a: { brand: MailBranding; host: string; port: number; security: 'starttls' | 'tls'; sender: string; sentAt: Date; timeZone: string }): Email {
  return build('Test email from your data room site', a.brand, {
    header: { label: 'Test' },
    blocks: [
      { kind: 'ok', text: 'Outgoing email works' },
      { kind: 'text', text: 'This email reached you, so your data room site can send invitations, sign-in codes and summaries.' },
      { kind: 'facts', rows: [
        { label: 'Server', value: a.host },
        { label: 'Port', value: `${a.port}, ${a.security === 'tls' ? 'TLS' : 'STARTTLS'}` },
        { label: 'Sender', value: a.sender },
        { label: 'Sent', value: dayAndTime(a.sentAt, a.timeZone) },
      ] },
      { kind: 'text', muted: true, text: 'Did it land in spam? Check the SPF, DKIM and DMARC results in Site settings › Outgoing email.' },
    ],
    footer: siteFooter(a.brand),
  }, siteFrom(a.brand));
}

export function ndaReminderEmail(a: { brand: MailBranding; room: string; givenName: string; url: string }): Email {
  const subject = `Reminder: accept the NDA for ${a.room}`;
  return build(subject, a.brand, {
    header: { room: a.room, label: 'Reminder' },
    blocks: [
      { kind: 'heading', text: `Accept the NDA for ${a.room}` },
      { kind: 'text', text: `${greeting(a.givenName)},\n\n`
        + `You have access to the ${a.room} data room, but you have not accepted its confidentiality agreement (NDA) yet. The documents open once you accept it.` },
      { kind: 'button', label: 'Open the data room', url: a.url },
    ],
    footer: [[`You get this email because a room admin of ${a.room} sent you a reminder.`], roomSentLine(a.room, a.brand)],
  }, roomFrom(a.room));
}

export function accessRestoredEmail(a: {
  brand: MailBranding; room: string; givenName: string; admin: string | null; groups: string[]; until: Date | null; timeZone: string;
  setUpTwoFactor: boolean; signInUrl: string;
}): Email {
  const subject = `Your access to ${a.room} is back`;
  const groups = a.groups.length > 1 ? `${a.groups.slice(0, -1).join(', ')} and ${a.groups.at(-1)}` : a.groups[0] ?? '';
  const who = a.admin || 'A room admin';
  let text = `${greeting(a.givenName)},\n\n`
    + `${who} restored your access to the ${a.room} data room. You are back in ${groups}, with the same access as before.`;
  if (a.until) text += ` Your access runs until ${dayAndTime(a.until, a.timeZone).split(',')[0]}.`;
  const blocks: Block[] = [{ kind: 'heading', text: subject }, { kind: 'text', text }];
  if (a.setUpTwoFactor) blocks.push({ kind: 'text', text: 'When you sign in, you set up two-factor sign-in again with an authenticator app.' });
  blocks.push({ kind: 'button', label: 'Sign in', url: a.signInUrl });
  return build(subject, a.brand, {
    header: { room: a.room, label: 'Access' }, blocks,
    footer: [[`You get this email because a room admin of ${a.room} restored your access.`], roomSentLine(a.room, a.brand)],
  }, roomFrom(a.room));
}

// not the converter's error text
export function newCopyEmail(a: { brand: MailBranding; room: string; asker: string; document: string; passwordProtected: boolean; askedAt: Date; timeZone: string; url: string }): Email {
  const subject = `${a.room}: please upload a new copy of ${a.document}`;
  return build(subject, a.brand, {
    header: { room: a.room, label: 'Request' },
    blocks: [
      { kind: 'heading', text: `Please upload a new copy of ${a.document}` },
      { kind: 'text', text: `${a.asker} asks you for a new copy of ${a.document} in ${a.room}. VDRkit could not read the copy you uploaded:` },
      { kind: 'quote', text: a.passwordProtected ? 'The file is password protected.' : 'The file could not be converted for viewing.' },
      { kind: 'text', text: a.passwordProtected
        ? 'Please upload a copy without a password, as a new version of the same document.'
        : 'Please upload a new copy, as a new version of the same document. Saving the file again in the program that made it often helps.' },
      { kind: 'facts', rows: [{ label: 'Asked', value: dayAndTime(a.askedAt, a.timeZone) }] },
      { kind: 'button', label: 'Open Documents', url: a.url },
    ],
    footer: [[`You get this email because you uploaded this file to ${a.room}.`], roomSentLine(a.room, a.brand)],
  }, roomFrom(a.room));
}

export function siteRightEmail(a: { brand: MailBranding; right: 'room_creator' | 'site_admin'; signInUrl: string }): Email {
  const where = siteName(a.brand) ?? 'this data room site';
  let subject: string, heading: string, body: string;
  if (a.right === 'room_creator') {
    subject = `You can now create rooms in ${where}`;
    heading = 'You can now create data rooms';
    body = `You can now create data rooms in ${where}. You become room admin of each room you create.`;
  } else {
    subject = `You are now a site admin of ${where}`;
    heading = 'You are now a site admin';
    body = `You are now a site admin of ${where}. You manage its settings, accounts and health. You see no room content unless a room admin invites you.`;
  }
  return build(subject, a.brand, {
    header: { label: 'Site' },
    blocks: [
      { kind: 'heading', text: heading },
      { kind: 'text', text: `${body} Sign in with this email address.` },
      { kind: 'button', label: 'Sign in', url: a.signInUrl },
    ],
    footer: siteFooter(a.brand),
  }, siteFrom(a.brand));
}

const linkLife = (hours: number) => (hours % 24 === 0 ? `${hours / 24} ${hours === 24 ? 'day' : 'days'}` : `${hours} hours`);

export function emailChangeCodeEmail(a: {
  brand: MailBranding; requestedBy: string; newEmail: string; code: string; url: string; hours: number;
}): Email {
  const code = a.code.replace(/\s+/g, '');
  const days = linkLife(a.hours);
  return build(`Confirm your new sign-in address: ${code}`, a.brand, {
    header: { label: 'Sign in' },
    blocks: [
      { kind: 'heading', text: 'Confirm your new sign-in address' },
      { kind: 'text', text: `${a.requestedBy} is changing the address you sign in with to this one, ${a.newEmail}. To confirm it, open the page and type this code.` },
      { kind: 'code', code },
      { kind: 'button', label: 'Confirm the new address', url: a.url },
      { kind: 'text', muted: true,
        text: `The link and the code work for ${days}. Until you confirm, you sign in with your old address.\n\n`
          + `Did not expect this? Ignore this email and tell ${a.requestedBy}. Nothing changes without the code.` },
    ],
    footer: siteFooter(a.brand),
  }, siteFrom(a.brand));
}

// to the current address; the change waits for this person to agree
export function emailChangeApprovalEmail(a: {
  brand: MailBranding; requestedBy: string; oldEmail: string; newEmail: string; url: string; hours: number;
}): Email {
  const days = linkLife(a.hours);
  return build('Change your sign-in address?', a.brand, {
    header: { label: 'Sign in' },
    blocks: [
      { kind: 'heading', text: 'Change your sign-in address?' },
      { kind: 'text', text: `${a.requestedBy} asked to change the address you sign in with from ${a.oldEmail} to ${a.newEmail}.` },
      { kind: 'text', text: 'Nothing changes unless you agree. Open the page to agree or to keep this address.' },
      { kind: 'button', label: 'Agree or refuse', url: a.url },
      { kind: 'text', muted: true,
        text: `The link works for ${days}. If you agree, a code goes to ${a.newEmail} to confirm the new address.\n\n`
          + 'Did not expect this? Refuse on the page and tell your site admin.' },
    ],
    footer: siteFooter(a.brand),
  }, siteFrom(a.brand));
}

export function emailChangedNoticeEmail(a: {
  brand: MailBranding; oldEmail: string; newEmail: string; changedAt: Date; timeZone: string;
}): Email {
  return build('Your sign-in address has changed', a.brand, {
    header: { label: 'Sign in' },
    blocks: [
      { kind: 'heading', text: 'Your sign-in address has changed' },
      { kind: 'text', text: `From now on you sign in with ${a.newEmail}. This address, ${a.oldEmail}, no longer works for signing in.` },
      { kind: 'text', text: 'You were signed out everywhere. Sign in again with the new address. Your authenticator app stays the same.' },
      { kind: 'text', muted: true, text: `Changed at ${dayAndTime(a.changedAt, a.timeZone)}. Did not expect this? Tell your site admin at once.` },
    ],
    footer: siteFooter(a.brand),
  }, siteFrom(a.brand));
}
