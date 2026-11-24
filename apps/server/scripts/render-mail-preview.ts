// SPDX-License-Identifier: AGPL-3.0-only
// Usage: tsx scripts/render-mail-preview.ts <output folder> [logo.png]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as t from '../src/mail/templates.js';
import * as ne from '../src/mail/notification-emails.js';
import type { NotificationContent } from '@vdrkit/core';
import type { MailBranding } from '../src/mail/layout.js';

const out = resolve(process.argv[2] ?? 'mail-preview');
mkdirSync(out, { recursive: true });
const logoFile = process.argv[3];
const logo = logoFile ? { png: readFileSync(logoFile), width: 168, height: 40 } : null;
const brand: MailBranding = { orgName: 'Quillmont Advisory', logo, privacyUrl: 'https://quillmont-advisory.example/privacy' };
const url = 'https://dataroom.quillmont-advisory.example';
const at = new Date('2026-11-14T08:29:00Z');
const ws = '00000000-0000-4000-8000-000000000001';
const n = t.notificationsUrl(url, ws);

const jan = { personId: 'p', email: 'jan.devries@orrinby-capital.example', givenName: 'Jan', timeZone: 'Europe/London', isAdmin: false, groupNames: ['Bidder A'] };
const heron = { id: ws, name: 'Project Heron', timeZone: 'Africa/Johannesburg' };
const d = (index: string, title: string, folderId: string, versionNo: number | null = null) =>
  ({ nodeId: index, indexNumber: index, title, folderId, versionNo, publishedBy: 'Anika Pillay', at: new Date('2026-11-13T11:42:00Z') });
const base: NotificationContent = { kind: 'summary', workspace: heron, recipient: jan, documents: [], versions: [], dates: [], comingUp: [], team: [], dropped: [],
  folders: {}, summaryTimes: ['08:00'], mode: 'digest', now: new Date('2026-11-13T08:00:00Z') };
const contracts = Array.from({ length: 13 }, (_, i) => d(`2.4.${i + 1}`, ['Master services agreement Kwelanet Business', 'Tarnley Logistics supply agreement',
  'Lease Germiston plant', 'Distribution agreement Namibia'][i] ?? `Material contract ${i + 1}`, 'f24'));

const mails: Record<string, t.Email> = {
  digest: ne.dailySummaryEmail({ ...base, documents: contracts, folders: { f24: { id: 'f24', indexNumber: '2.4', name: 'Material contracts' } },
    versions: [d('3.3.4', 'Five-year forecast model FY2027 to FY2031', 'f33', 2)],
    comingUp: [{ milestoneId: 'm', title: 'First-round bids', dueAt: new Date('2026-11-27T17:00:00Z') }],
    team: [{ change: 'joined', name: 'Lerato Mokoena', group: 'Bidder A', requestedAt: new Date('2026-11-11T09:00:00Z'), note: null, at: base.now }] }, brand, url),
  now: ne.newDocumentsEmail({ ...base, kind: 'documents', mode: 'immediate', folders: { f32: { id: 'f32', indexNumber: '3.2', name: 'Audited financial statements' } },
    documents: [d('3.2.5', 'Audited financial statements FY2023', 'f32'), d('3.2.6', "Auditor's report FY2023", 'f32'), d('3.2.7', 'Management letter FY2023', 'f32')] }, brand, url),
  deadline: ne.deadlineReminderEmail({ workspace: heron, recipient: jan, milestone: { id: 'm', title: 'First-round bids', dueAt: new Date('2026-11-27T17:00:00Z') },
    kind: '2d', forGroups: ['Bidder A'], now: new Date('2026-11-25T17:00:00Z') }, brand, url),
  moved: ne.timelineChangeEmail({ ...base, kind: 'deadlines', mode: 'immediate', dates: [{ milestoneId: 'm', title: 'First-round bids', change: 'changed',
    dueAt: new Date('2026-12-04T17:00:00Z'), dueBefore: new Date('2026-11-27T17:00:00Z'), at: base.now }] }, brand, url),
  dropped: ne.publishDroppedEmail({ ...base, kind: 'publish_dropped', mode: 'immediate', recipient: { ...jan, givenName: 'Johan', groupNames: ['Finance'] },
    dropped: [{ nodeId: 'n', indexNumber: '3.5.4', title: 'Payment receipt.pdf', folderId: 'f35', versionNo: null, reason: 'failed', code: null, at: base.now }] }, brand, url),
  invite: t.invitationEmail({ brand, room: 'Project Heron', subject: 'Invitation to the Project Heron data room',
    message: 'Dear colleague,\n\nQuillmont Advisory has invited you to the Project Heron data room on behalf of Drosvelt Holdings. Use the button in this email to sign in. You will be asked to accept the confidentiality agreement before you see any documents.\n\nYour access runs until Fri 29 Jan 2027.\n\nKind regards,\nAnika Pillay\nQuillmont Advisory',
    leadParagraph: 'You are invited as a lead for Bidder A. As a lead you can request to add colleagues and advisers to Bidder A. Use My team in the data room to send a request, and the room admin approves it.',
    url: `${url}/invite/abc`, to: 'jan.devries@orrinby-capital.example', linkDays: 14, fromName: 'Anika Pillay, Quillmont Advisory' }),
  signin: t.signInEmail({ brand, code: '482913', link: `${url}/sign-in/link?token=x`, minutes: 15, requestedAt: at, timeZone: 'Europe/London', browser: 'Chrome on Windows' }),
  request: t.colleagueRequestEmail({ brand, room: 'Project Heron', lead: 'Jan de Vries', group: 'Bidder A', name: 'Naledi Khumalo',
    email: 'naledi.khumalo@orrinby-capital.example', company: 'Orrinby Capital', role: 'Associate', reason: 'Naledi runs the financial model for us and needs 3 Finance.',
    reviewUrl: `${url}/rooms/${ws}/people`, notificationsUrl: n }),
  decision: t.requestDecisionEmail({ brand, room: 'Project Heron', approved: false, givenName: 'Jan', name: 'Naledi Khumalo', group: 'Bidder A',
    note: 'Naledi can join once 3.4 Tax is open to bidders.', teamUrl: `${url}/rooms/${ws}/team`, notificationsUrl: n }),
  join: t.siteAdminJoinedEmail({ brand, room: 'Project Heron', joiner: 'Ruth Mahlangu', joinedAt: new Date('2026-11-14T12:05:00Z'), timeZone: 'Africa/Johannesburg',
    reason: 'Anika is on leave this week. Taking over the NDA questions from Bidder C.', activityUrl: `${url}/rooms/${ws}/activity`, notificationsUrl: n }),
  health: t.healthAlertEmail({ brand, check: 'storage', label: 'File storage', since: new Date('2026-11-14T07:12:00Z'), now: new Date('2026-11-14T07:27:00Z'),
    timeZone: 'Africa/Johannesburg', lastError: 'connect ETIMEDOUT s3.af-south-1.amazonaws.com:443', healthUrl: `${url}/site/settings/health`, siteAdmin: true }),
  recovery: t.healthRecoveryEmail({ brand, check: 'storage', label: 'File storage', since: new Date('2026-11-14T07:12:00Z'), now: new Date('2026-11-14T08:01:00Z'),
    timeZone: 'Africa/Johannesburg', healthUrl: `${url}/site/settings/health`, siteAdmin: true }),
  test: t.testEmail({ brand, host: 'smtp.office365.com', port: 587, security: 'starttls', sender: 'dataroom@quillmont-advisory.example', sentAt: new Date('2026-11-14T08:31:00Z'), timeZone: 'Africa/Johannesburg' }),
  nda: t.ndaReminderEmail({ brand, room: 'Project Heron', givenName: 'Lars', url: `${url}/rooms/${ws}` }),
  copy: t.newCopyEmail({ brand, room: 'Project Heron', asker: 'Anika Pillay', document: '3.3.4 Five-year forecast model', passwordProtected: true,
    askedAt: at, timeZone: 'Africa/Johannesburg', url: `${url}/rooms/${ws}/documents` }),
  creator: t.siteRightEmail({ brand, right: 'room_creator', signInUrl: `${url}/sign-in` }),
};
for (const [name, m] of Object.entries(mails)) {
  let html = m.html;
  for (const image of m.inline ?? []) {
    const data = Buffer.from(image.content).toString('base64');
    html = html.split(`cid:${image.cid}`).join(`data:${image.contentType};base64,${data}`);
  }
  const fromName = m.fromName ?? m.fallbackFromName ?? '';
  writeFileSync(resolve(out, `${name}.html`), html);
  writeFileSync(resolve(out, `${name}.txt`), `Subject: ${m.subject}\nFrom name: ${fromName}\n\n${m.text}`);
}
console.log(`Wrote ${Object.keys(mails).length} emails to ${out}`);
