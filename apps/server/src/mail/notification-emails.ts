// SPDX-License-Identifier: AGPL-3.0-only
import {
  calendarDays, compareIndex, partsIn, publishDroppedSentence, type DateLine, type DroppedLine, type DocumentLine, type FolderRef, type NotificationContent,
  type OutgoingMessage, type ReminderContent, type TeamLine,
} from '@vdrkit/core';
import type { Block, ItemRow, MailBranding } from './layout.js';
import { build, clockTime, dayAndTime, notificationsUrl, roomFooter, roomFrom, toMessage, type Email } from './templates.js';

// name a folder only if it's in content.folders

const web = (u: string) => /^https?:\/\/[^/\s]/i.test(u);

class Links {
  private readonly base: string | null;
  constructor(publicUrl: string, private readonly ws: string) { this.base = web(publicUrl) ? publicUrl.replace(/\/$/, '') : null; }
  private at(path: string) { return this.base ? `${this.base}${path}` : null; }
  room() { return this.at(`/rooms/${this.ws}`); }
  documents() { return this.at(`/rooms/${this.ws}/documents`); }
  folder(id: string) { return this.at(`/rooms/${this.ws}/documents/${id}`); }
  document(id: string) { return this.at(`/rooms/${this.ws}/view/${id}`); }
  timeline() { return this.at(`/rooms/${this.ws}/timeline`); }
  team() { return this.at(`/rooms/${this.ws}/team`); }
  people() { return this.at(`/rooms/${this.ws}/people`); }
  notifications() { return this.base ? notificationsUrl(this.base, this.ws) : null; }
}

const button = (label: string, url: string | null): Block[] => (url ? [{ kind: 'button', label, url }] : []);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const docOrder = (a: DocumentLine, b: DocumentLine) => compareIndex(a.indexNumber, b.indexNumber) || a.title.localeCompare(b.title);
const folderName = (f: FolderRef) => [f.indexNumber, f.name].filter(Boolean).join(' ');
const versionNote = (d: DocumentLine) => (d.versionNo && d.versionNo > 1 ? `Version ${d.versionNo} replaces version ${d.versionNo - 1}` : null);
const sentToEveryone = (room: string) => `You get this email because the room admins of ${room} send these to everyone.`;

function longDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d).replace(/,/g, '');
}

function dueText(d: Date, timeZone: string): string {
  return `${longDay(d, timeZone)} at ${clockTime(d, timeZone)}`;
}

function shortDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(d).replace(/,/g, '');
}

const city = (timeZone: string) => (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');

function roomTime(d: Date, own: string, room: string, short = false): string | null {
  if (clockTime(d, own) === clockTime(d, room)) return null;
  const a = partsIn(d, own);
  const b = partsIn(d, room);
  let text = clockTime(d, room);
  if (a.year !== b.year || a.month !== b.month || a.day !== b.day) text = `${shortDay(d, room)}, ${text}`;
  if (!short) text += `, ${city(room)}`;
  return text;
}

const forWhom = (c: { recipient: { groupNames: string[] } }) => (c.recipient.groupNames.length ? ` for ${joinAnd(c.recipient.groupNames)}` : '');
const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function documentRows(docs: DocumentLine[], c: NotificationContent, links: Links, limit: number, note?: (d: DocumentLine) => string | null): Block[] {
  const rows = docs.slice(0, limit).map((d): ItemRow => ({
    number: d.indexNumber, title: d.title, url: links.document(d.nodeId), note: note?.(d) ?? null,
  }));
  const blocks: Block[] = [{ kind: 'items', rows }];
  const rest = docs.slice(limit);
  if (rest.length) {
    const only = oneFolder(rest, c);
    const label = only ? `And ${rest.length} more in ${folderName(only)}` : `And ${rest.length} more`;
    const url = only ? links.folder(only.id) : links.documents();
    blocks.push(url ? { kind: 'link', label, url } : { kind: 'text', muted: true, text: label });
  }
  return blocks;
}

function oneFolder(docs: DocumentLine[], c: NotificationContent): FolderRef | null {
  const ids = new Set(docs.map((d) => d.folderId));
  return ids.size === 1 ? c.folders[[...ids][0] ?? ''] ?? null : null;
}

function dateRow(d: DateLine, c: { recipient: { timeZone: string }; workspace: { timeZone: string } }, url: string | null): ItemRow {
  const tz = c.recipient.timeZone;
  if (d.change === 'removed') return { title: d.title ? `${d.title} was removed from the Timeline` : 'A date was removed from the Timeline', url };
  const rt = roomTime(d.dueAt!, tz, c.workspace.timeZone, true);
  const room = rt ? ` Room time ${rt}.` : '';
  if (d.dueBefore) return { title: `${d.title} moved to ${dueText(d.dueAt!, tz)}`, note: `It was ${dueText(d.dueBefore, tz)}.${room}`, url };
  return { title: `${d.title} due ${dueText(d.dueAt!, tz)}`, note: `${d.change === 'added' ? 'New on the Timeline.' : 'Changed on the Timeline.'}${room}`, url };
}

function teamRow(t: TeamLine, timeZone: string): ItemRow {
  if (t.change === 'requested') return { title: `${t.requestedBy ?? 'A lead'} asks to add ${t.name} to ${t.group}`, note: 'Approve or decline it under People in the room.' };
  const asked = t.requestedAt ? `Your request of ${shortDay(t.requestedAt, timeZone)} was approved` : null;
  switch (t.change) {
    case 'joined': return { title: `${t.name} joined ${t.group}`, note: asked };
    case 'approved': return { title: `${t.name} is invited to ${t.group}`, note: asked };
    case 'declined': return { title: `Your request for ${t.name} was declined`, note: t.note ? `Reason from the room admin: ${t.note}` : null };
  }
}

function summaryAt(times: string[]): string {
  return joinAnd([...new Set(times)].sort());
}

export function dailySummaryEmail(c: NotificationContent, brand: MailBranding, publicUrl: string): Email {
  const links = new Links(publicUrl, c.workspace.id);
  const tz = c.recipient.timeZone;
  const room = c.workspace.name;
  const docs = [...c.documents].sort(docOrder);
  const versions = [...c.versions].sort(docOrder);
  const added = c.dates.filter((d) => d.change === 'added').length;
  const changed = c.dates.length - added;
  const requests = c.team.filter((t) => t.change === 'requested');
  const team = c.team.filter((t) => t.change !== 'requested');
  const parts = [
    docs.length ? plural(docs.length, 'new document') : '',
    versions.length ? plural(versions.length, 'new version') : '',
    added ? plural(added, 'new date') : '',
    changed ? `${plural(changed, 'date')} changed` : '',
    c.comingUp.length ? `${plural(c.comingUp.length, 'deadline')} coming up` : '',
    team.length ? plural(team.length, 'team update') : '',
    requests.length ? plural(requests.length, 'colleague request') : '',
    c.dropped.length ? `${plural(c.dropped.length, 'file')} not published` : '',
  ].filter(Boolean);
  const subject = `${room}: ${parts.join(', ')}`;
  const day = longDay(c.now, tz);

  const blocks: Block[] = [
    { kind: 'heading', text: `What changed in ${room}` },
    { kind: 'text', muted: true, text: `Since your last summary${c.recipient.groupNames.length ? `, for ${joinAnd(c.recipient.groupNames)}` : ''}.` },
  ];
  if (docs.length) blocks.push({ kind: 'subheading', text: `New documents · ${docs.length}` }, ...documentRows(docs, c, links, 5));
  if (versions.length) {
    blocks.push({ kind: 'subheading', text: `New versions · ${versions.length}` },
      ...documentRows(versions, c, links, 5, versionNote));
  }
  if (c.dates.length + c.comingUp.length) {
    const timeline = links.timeline();
    const rows: ItemRow[] = [
      ...c.dates.map((d) => dateRow(d, c, timeline)),
      ...c.comingUp.map((u): ItemRow => {
        const days = calendarDays(c.now, u.dueAt, tz);
        let when = `In ${days} days.`;
        if (days <= 0) when = 'Today.';
        else if (days === 1) when = 'Tomorrow.';
        const rt = roomTime(u.dueAt, tz, c.workspace.timeZone, true);
        return { title: `${u.title} due ${dueText(u.dueAt, tz)}`, note: `${when}${rt ? ` Room time ${rt}.` : ''}`, url: timeline };
      }),
    ];
    blocks.push({ kind: 'subheading', text: 'Coming up' }, { kind: 'items', rows });
  }
  if (team.length) blocks.push({ kind: 'subheading', text: 'Your team' }, { kind: 'items', rows: team.map((t) => teamRow(t, tz)) });
  if (requests.length) {
    blocks.push({ kind: 'subheading', text: `Requests to add a colleague · ${requests.length}` },
      { kind: 'items', rows: requests.map((t) => ({ ...teamRow(t, tz), url: links.people() })) });
  }
  if (c.dropped.length) {
    blocks.push({ kind: 'subheading', text: `Not published · ${c.dropped.length}` },
      { kind: 'items', rows: c.dropped.map((d) => droppedRow(d, links)) });
  }
  blocks.push(...button(`Open ${room}`, links.room()));

  return build(subject, brand, {
    header: { room, label: `Summary for ${day}` },
    blocks,
    footer: roomFooter(summaryReason(c), room, brand, links.notifications()),
  }, roomFrom(room));
}

const aboutWhat = (c: NotificationContent) => (c.documents.length || !c.versions.length ? 'new documents' : 'new versions');

const lockedFor = (c: NotificationContent, ...categories: string[]) => categories.some((k) => c.locked?.includes(k));

function summaryReason(c: NotificationContent): string {
  const at = summaryAt(c.summaryTimes);
  const room = c.workspace.name;
  if (c.documents.length || c.versions.length) {
    const categories: string[] = [];
    if (c.documents.length) categories.push('documents');
    if (c.versions.length) categories.push('versions');
    if (lockedFor(c, ...categories)) return sentToEveryone(room);
    return `You get this email because you chose to hear about ${aboutWhat(c)} in ${room} in your daily summary at ${at}.`;
  }
  return `You get this summary at ${at} your time on days with news, because daily summary is on for ${room}.`;
}

function publishedLine(docs: DocumentLine[], folder: FolderRef | null, tz: string, verb: 'published' | 'released'): string {
  const where = folder ? ` in ${folderName(folder)}` : '';
  const who = new Set(docs.map((d) => d.publishedBy));
  const times = docs.map((d) => d.at.getTime());
  const first = new Date(Math.min(...times));
  const last = new Date(Math.max(...times));
  const them = docs.length === 1 ? 'it' : 'them';
  const when = clockTime(first, tz) === clockTime(last, tz) ? `at ${clockTime(last, tz)}` : `between ${clockTime(first, tz)} and ${clockTime(last, tz)}`;
  if (who.size === 1) return `${[...who][0]} ${verb} ${them}${where} ${when}.`;
  return `${verb === 'published' ? 'Published' : 'Released'}${where} ${when}.`;
}

export function newDocumentsEmail(c: NotificationContent, brand: MailBranding, publicUrl: string): Email {
  const links = new Links(publicUrl, c.workspace.id);
  const tz = c.recipient.timeZone;
  const room = c.workspace.name;
  const versions = c.kind === 'versions';
  const docs = [...(versions ? c.versions : c.documents)].sort(docOrder);
  const folder = oneFolder(docs, c);
  const what = versions ? plural(docs.length, 'new version') : plural(docs.length, 'new document');
  const subject = `${room}: ${what}${folder ? ` in ${folderName(folder)}` : ''}`;
  const blocks: Block[] = [
    { kind: 'heading', text: `${what}${forWhom(c)}` },
    { kind: 'text', text: publishedLine(docs, folder, tz, versions ? 'released' : 'published') },
    ...documentRows(docs, c, links, 10, versions ? versionNote : undefined),
    ...(folder ? button('Open the folder', links.folder(folder.id)) : button('Open Documents', links.documents())),
  ];
  const about = versions ? 'new versions' : 'new documents';
  const bundled = (c.settings?.[c.kind] ?? c.mode) === 'bundled';
  let reason = `You get this email because you chose to hear about ${about} in ${room} right away.`;
  if (lockedFor(c, c.kind)) reason = sentToEveryone(room);
  else if (bundled) reason = `You get this email because you chose to hear about ${about} in ${room} in bundled emails.`;
  return build(subject, brand, {
    header: { room, label: versions ? 'New versions' : 'New documents' },
    blocks,
    footer: roomFooter(reason, room, brand, links.notifications()),
  }, roomFrom(room));
}

export function timelineChangeEmail(c: NotificationContent, brand: MailBranding, publicUrl: string): Email {
  const links = new Links(publicUrl, c.workspace.id);
  const tz = c.recipient.timeZone;
  const room = c.workspace.name;
  const timeline = links.timeline();
  let subject: string;
  const blocks: Block[] = [];
  if (c.dates.length === 1) {
    const d = c.dates[0]!;
    const rt = d.dueAt ? roomTime(d.dueAt, tz, c.workspace.timeZone) : null;
    const roomRow = rt ? [{ label: 'Room time', value: rt }] : [];
    if (d.change === 'removed') {
      subject = `${room}: a date was removed from the Timeline`;
      blocks.push({ kind: 'heading', text: 'A date was removed from the Timeline' });
      if (d.title) blocks.push({ kind: 'text', text: `${d.title} is no longer on your Timeline.` });
    } else if (d.dueBefore) {
      subject = `${room}: ${d.title!} moved`;
      blocks.push({ kind: 'heading', text: `${d.title} moved` },
        { kind: 'facts', rows: [{ label: 'Was', value: dayAndTime(d.dueBefore, tz) }, { label: 'Now', value: dayAndTime(d.dueAt!, tz) }, ...roomRow] });
    } else {
      subject = d.change === 'added' ? `${room}: a new date on the Timeline` : `${room}: a date changed on the Timeline`;
      blocks.push({ kind: 'heading', text: d.change === 'added' ? `New date: ${d.title}` : `${d.title} changed` },
        { kind: 'facts', rows: [{ label: 'Due', value: dayAndTime(d.dueAt!, tz) }, ...roomRow] });
    }
  } else {
    subject = `${room}: ${c.dates.length} dates changed on the Timeline`;
    blocks.push({ kind: 'heading', text: `${c.dates.length} dates changed on the Timeline` }, { kind: 'items', rows: c.dates.map((d) => dateRow(d, c, timeline)) });
  }
  blocks.push(...button('Open the Timeline', timeline));
  return build(subject, brand, {
    header: { room, label: 'Timeline' },
    blocks,
    footer: roomFooter(`You get this email because Timeline changes are on for ${room}.`, room, brand, links.notifications()),
  }, roomFrom(room));
}

export function newNdaEmail(c: NotificationContent, brand: MailBranding, publicUrl: string): Email {
  const links = new Links(publicUrl, c.workspace.id);
  const room = c.workspace.name;
  return build(`${room}: a new NDA to accept`, brand, {
    header: { room, label: 'NDA' },
    blocks: [
      { kind: 'heading', text: 'A new NDA to accept' },
      { kind: 'text', text: 'A new version of the non-disclosure agreement was published. Sign in to read it; you accept it before you see documents again.' },
      ...button('Open the data room', links.room()),
    ],
    footer: roomFooter(`You get this email because new NDA versions are on for ${room}.`, room, brand, links.notifications()),
  }, roomFrom(room));
}

export function teamNewsEmail(c: NotificationContent, brand: MailBranding, publicUrl: string): Email {
  const links = new Links(publicUrl, c.workspace.id);
  const room = c.workspace.name;
  const tz = c.recipient.timeZone;
  const joined = c.team.filter((t) => t.change === 'joined');
  const one = c.team.length === 1 ? c.team[0]! : null;
  let subject: string;
  if (one?.change === 'joined') subject = `${one.name} joined ${one.group} in ${room}`;
  else if (one) subject = teamRow(one, tz).title;
  else if (joined.length === c.team.length) subject = `${plural(joined.length, 'colleague')} joined your team in ${room}`;
  else subject = `${room}: ${plural(c.team.length, 'team update')}`;
  const blocks: Block[] = [{ kind: 'heading', text: subject }];
  const greeting = c.recipient.givenName ? `Dear ${c.recipient.givenName},` : null;
  if (one?.change === 'joined') {
    blocks.push({ kind: 'text', text: `${greeting ? `${greeting}\n\n` : ''}${one.name} accepted the invitation and can now open the ${room} data room as a member of ${one.group}.` });
  } else {
    if (greeting) blocks.push({ kind: 'text', text: greeting });
    blocks.push({ kind: 'items', rows: c.team.map((t) => teamRow(t, tz)) });
  }
  blocks.push({ kind: 'text', text: 'You see your team under My team in the data room.' }, ...button('Open My team', links.team()));
  return build(subject, brand, {
    header: { room, label: 'Your team' },
    blocks,
    footer: roomFooter(`You get this email because you chose to hear about your requests to add a colleague in ${room} right away.`, room, brand, links.notifications()),
  }, roomFrom(room));
}

function droppedRow(d: DroppedLine, links: Links): ItemRow {
  return { title: publishDroppedSentence(d), url: d.folderId ? links.folder(d.folderId) : links.documents() };
}

export function publishDroppedEmail(c: NotificationContent, brand: MailBranding, publicUrl: string): Email {
  const links = new Links(publicUrl, c.workspace.id);
  const room = c.workspace.name;
  const one = c.dropped.length === 1 ? c.dropped[0]! : null;
  const name = (d: DroppedLine) => [d.indexNumber, d.title].filter(Boolean).join(' ');
  const subject = one ? `${room}: ${name(one)} was not published` : `${room}: ${plural(c.dropped.length, 'file')} were not published`;
  const greeting = c.recipient.givenName ? `Dear ${c.recipient.givenName},` : null;
  const blocks: Block[] = [{ kind: 'heading', text: one ? 'A file you asked to publish was not published' : 'Files you asked to publish were not published' }];
  if (greeting) blocks.push({ kind: 'text', text: greeting });
  if (one) blocks.push({ kind: 'text', text: publishDroppedSentence(one) });
  else blocks.push({ kind: 'items', rows: c.dropped.map((d) => droppedRow(d, links)) });
  blocks.push({ kind: 'text', muted: true, text: one ? 'Bidders cannot see it until it is published.' : 'Bidders cannot see them until they are published.' });
  const folder = one?.folderId ? links.folder(one.folderId) : null;
  blocks.push(...(folder ? button('Open the folder', folder) : button('Open Documents', links.documents())));
  const reason = lockedFor(c, 'publish_dropped')
    ? sentToEveryone(room)
    : `You get this email because you chose to hear in ${room} when a publish you asked for did not happen.`;
  return build(subject, brand, {
    header: { room, label: 'Not published' },
    blocks,
    footer: roomFooter(reason, room, brand, links.notifications()),
  }, roomFrom(room));
}

export function notificationEmail(c: NotificationContent, brand: MailBranding, publicUrl: string): Email {
  switch (c.kind) {
    case 'summary': return dailySummaryEmail(c, brand, publicUrl);
    case 'documents': case 'versions': return newDocumentsEmail(c, brand, publicUrl);
    case 'deadlines': return timelineChangeEmail(c, brand, publicUrl);
    case 'agreements': return newNdaEmail(c, brand, publicUrl);
    case 'requests': return teamNewsEmail(c, brand, publicUrl);
    case 'publish_dropped': return publishDroppedEmail(c, brand, publicUrl);
  }
}

export function notificationMessage(c: NotificationContent, brand: MailBranding, publicUrl: string): OutgoingMessage {
  return toMessage(notificationEmail(c, brand, publicUrl), c.recipient.personId, c.recipient.email);
}

export function deadlineReminderEmail(c: ReminderContent, brand: MailBranding, publicUrl: string): Email {
  const links = new Links(publicUrl, c.workspace.id);
  const tz = c.recipient.timeZone;
  const room = c.workspace.name;
  const inWhen = c.kind === '2d' ? 'in 2 days' : 'in 2 hours';
  const rt = roomTime(c.milestone.dueAt, tz, c.workspace.timeZone);
  const forText = c.forGroups === 'all' ? 'All bidder groups' : c.forGroups.join(', ');
  const rows = [{ label: 'Due', value: dayAndTime(c.milestone.dueAt, tz) }];
  if (rt) rows.push({ label: 'Room time', value: rt });
  if (forText) rows.push({ label: 'For', value: forText });
  return build(`${room}: ${c.milestone.title} due ${inWhen}`, brand, {
    header: { room, label: 'Reminder' },
    blocks: [
      { kind: 'heading', text: `${c.milestone.title} due ${inWhen}` },
      { kind: 'facts', rows },
      ...button('Open the Timeline', links.timeline()),
    ],
    footer: roomFooter(`You get this reminder because deadlines are on for ${room}.`, room, brand, links.notifications()),
  }, roomFrom(room));
}

export function reminderMessage(c: ReminderContent, brand: MailBranding, publicUrl: string): OutgoingMessage {
  return toMessage(deadlineReminderEmail(c, brand, publicUrl), c.recipient.personId, c.recipient.email);
}
