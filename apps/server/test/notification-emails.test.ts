// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { NotificationContent, ReminderContent } from '@vdrkit/core';
import type { MailBranding } from '../src/mail/layout.js';
import { dailySummaryEmail, deadlineReminderEmail, newDocumentsEmail, notificationEmail, timelineChangeEmail } from '../src/mail/notification-emails.js';


const brand: MailBranding = { orgName: 'Quillmont Advisory', logo: null, privacyUrl: null };
const SITE = 'https://dataroom.quillmont.example';
const WS = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-11-13T08:00:00Z');
const buttons = (html: string) => (html.match(/background:#13627A/g) ?? []).length;

function content(over: Partial<NotificationContent> = {}): NotificationContent {
  return {
    kind: 'summary', workspace: { id: WS, name: 'Project Heron', timeZone: 'Africa/Johannesburg' },
    recipient: { personId: 'p', email: 'jan@example.com', givenName: 'Jan', timeZone: 'Europe/London', isAdmin: false, groupNames: ['Bidder A'] },
    documents: [], versions: [], dates: [], comingUp: [], team: [], dropped: [], folders: {}, summaryTimes: ['08:00'], mode: 'digest', now, ...over,
  };
}
const doc = (n: string, title: string, folderId = 'f1', versionNo: number | null = null) =>
  ({ nodeId: `n${n}`, indexNumber: n, title, folderId, versionNo, publishedBy: 'Anika Pillay', at: new Date('2026-11-13T11:42:00Z') });

describe('daily summary', () => {
  it('renders the four sections in order', () => {
    const e = dailySummaryEmail(content({
      documents: [doc('2.4.1', 'Master services agreement Kwelanet Business')],
      versions: [doc('3.3.4', 'Five-year forecast model FY2027 to FY2031', 'f2', 2)],
      comingUp: [{ milestoneId: 'm', title: 'First-round bids', dueAt: new Date('2026-11-27T17:00:00Z') }],
      team: [{ change: 'joined', name: 'Lerato Mokoena', group: 'Bidder A', requestedAt: new Date('2026-11-11T09:00:00Z'), note: null, at: now }],
    }), brand, SITE);
    expect(e.subject).toBe('Project Heron: 1 new document, 1 new version, 1 deadline coming up, 1 team update');
    const dated = dailySummaryEmail(content({
      dates: [{ milestoneId: 'a', title: 'Site visit', change: 'added', dueAt: new Date('2026-11-20T08:00:00Z'), dueBefore: null, at: now },
        { milestoneId: 'b', title: 'Q&A closes', change: 'changed', dueAt: new Date('2026-11-21T08:00:00Z'), dueBefore: new Date('2026-11-20T08:00:00Z'), at: now }],
      comingUp: [{ milestoneId: 'm', title: 'First-round bids', dueAt: new Date('2026-11-27T17:00:00Z') },
        { milestoneId: 'n', title: 'Management presentation', dueAt: new Date('2026-11-24T09:00:00Z') }],
    }), brand, SITE);
    expect(dated.subject).toBe('Project Heron: 1 new date, 1 date changed, 2 deadlines coming up');
    const order = ['What changed in Project Heron', 'Since your last summary, for Bidder A.', 'NEW DOCUMENTS · 1', 'NEW VERSIONS · 1',
      'Version 2 replaces version 1', 'COMING UP', 'First-round bids due Fri 27 Nov 2026 at 17:00 GMT', 'In 14 days. Room time 19:00 SAST.',
      'YOUR TEAM', 'Lerato Mokoena joined Bidder A', 'Your request of Wed 11 Nov was approved', 'Open Project Heron'];
    let at = -1;
    for (const s of order) { const i = e.text.indexOf(s); expect(i, s).toBeGreaterThan(at); at = i; }
    expect(e.html).toContain('Summary for Fri 13 Nov 2026');
    expect(buttons(e.html)).toBe(1);
    expect(e.text).toContain('You get this email because you chose to hear about new documents in Project Heron in your daily summary at 08:00.');
  });

  it('names summary times and omits "for" for admins', () => {
    const e = dailySummaryEmail(content({ documents: [doc('1', 'A')], summaryTimes: ['17:00', '08:00'],
      recipient: { personId: 'p', email: 'a@example.com', givenName: 'Anika', timeZone: 'Africa/Johannesburg', isAdmin: true, groupNames: [] } }), brand, SITE);
    expect(e.text).toContain('Since your last summary.');
    expect(e.text).toContain('You get this email because you chose to hear about new documents in Project Heron in your daily summary at 08:00 and 17:00.');
    const dates = dailySummaryEmail(content({ documents: [], versions: [], comingUp: [{ milestoneId: 'm', title: 'First-round bids', dueAt: new Date('2026-11-27T17:00:00Z') }],
      dates: [], team: [{ change: 'joined', name: 'Lerato Mokoena', group: 'Bidder A', requestedAt: null, note: null, at: new Date('2026-11-13T06:00:00Z') }] }), brand, SITE);
    expect(dates.text).toContain('You get this summary at 08:00 your time on days with news, because daily summary is on for Project Heron.');
  });

  it('escapes titles and omits links without a site url', () => {
    const e = dailySummaryEmail(content({ documents: [doc('1', '<script>alert(1)</script> & Co')] }), brand, '');
    expect(e.html).not.toContain('<script>alert');
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(e.html).not.toMatch(/href=/);
    expect(buttons(e.html)).toBe(0);
  });
});

describe('right away and timeline notices', () => {
  it('shows the folder only when visible', () => {
    const folders = { f1: { id: 'f1', indexNumber: '3.2', name: 'Audited financial statements' } };
    const docs = [doc('3.2.5', 'Audited financial statements FY2023'), doc('3.2.6', 'Auditor’s report FY2023'), doc('3.2.7', 'Management letter FY2023')];
    const seen = newDocumentsEmail(content({ kind: 'documents', mode: 'bundled', documents: docs, folders }), brand, SITE);
    expect(seen.subject).toBe('Project Heron: 3 new documents in 3.2 Audited financial statements');
    expect(seen.text).toContain('3 new documents for Bidder A');
    expect(seen.text).toContain('Anika Pillay published them in 3.2 Audited financial statements at 11:42 GMT.');
    expect(seen.text).toContain(`Open the folder: ${SITE}/rooms/${WS}/documents/f1`);
    const hidden = newDocumentsEmail(content({ kind: 'documents', mode: 'bundled', documents: docs }), brand, SITE);
    expect(hidden.subject).toBe('Project Heron: 3 new documents');
    expect(hidden.text).not.toContain('Audited financial statements at');
    expect(hidden.text).toContain('Open Documents');
  });

  it('shows old and new time for a moved date', () => {
    const e = timelineChangeEmail(content({ kind: 'deadlines', mode: 'immediate', dates: [{ milestoneId: 'm', title: 'First-round bids', change: 'changed',
      dueAt: new Date('2026-12-04T17:00:00Z'), dueBefore: new Date('2026-11-27T17:00:00Z'), at: now }] }), brand, SITE);
    expect(e.subject).toBe('Project Heron: First-round bids moved');
    expect(e.text).toContain('Was: Fri 27 Nov 2026, 17:00 GMT');
    expect(e.text).toContain('Now: Fri 4 Dec 2026, 17:00 GMT');
    expect(e.text).toContain('Room time: 19:00 SAST, Johannesburg');
  });

  it('renders every kind with at most one button', () => {
    for (const kind of ['summary', 'documents', 'versions', 'deadlines', 'agreements'] as const) {
      const c = content({ kind, documents: [doc('1', 'A')], versions: [doc('2', 'B', 'f1', 3)],
        dates: [{ milestoneId: 'm', title: 'X', change: 'removed', dueAt: null, dueBefore: null, at: now }] });
      const e = notificationEmail(c, brand, SITE);
      expect(buttons(e.html)).toBeLessThanOrEqual(1);
      expect(e.text).toContain('Powered by VDRkit.');
    }
  });
});

describe('deadline reminder', () => {
  const r = (over: Partial<ReminderContent> = {}): ReminderContent => ({
    workspace: { id: WS, name: 'Project Heron', timeZone: 'Africa/Johannesburg' },
    recipient: { personId: 'p', email: 'jan@example.com', givenName: 'Jan', timeZone: 'Europe/London', isAdmin: false, groupNames: ['Bidder A'] },
    milestone: { id: 'm', title: 'First-round bids', dueAt: new Date('2026-11-27T17:00:00Z') }, kind: '2d', forGroups: ['Bidder A'], now, ...over,
  });

  it('renders subject, times and audience', () => {
    const e = deadlineReminderEmail(r(), brand, SITE);
    expect(e.subject).toBe('Project Heron: First-round bids due in 2 days');
    expect(e.html).toContain('Reminder');
    expect(e.text).toContain('Due: Fri 27 Nov 2026, 17:00 GMT\nRoom time: 19:00 SAST, Johannesburg\nFor: Bidder A');
    expect(e.text).toContain('You get this reminder because deadlines are on for Project Heron.');
  });

  it('keeps title case and shows the room day', () => {
    const e = deadlineReminderEmail(r({ kind: '2h', milestone: { id: 'm', title: 'SPA mark-up', dueAt: new Date('2026-11-27T23:00:00Z') } }), brand, SITE);
    expect(e.subject).toBe('Project Heron: SPA mark-up due in 2 hours');
    expect(deadlineReminderEmail(r({ kind: '2d', milestone: { id: 'm', title: 'Site visit, Weaver mill', dueAt: new Date('2026-11-27T08:00:00Z') } }), brand, SITE).subject)
      .toBe('Project Heron: Site visit, Weaver mill due in 2 days');
    expect(e.text).toContain('Room time: Sat 28 Nov, 01:00 SAST, Johannesburg');
  });
});

describe('team news', () => {
  it('tells a lead a colleague joined', () => {
    const e = notificationEmail(content({ kind: 'requests', mode: 'immediate',
      team: [{ change: 'joined', name: 'Lerato Mokoena', group: 'Bidder A', requestedAt: new Date('2026-11-11T09:00:00Z'), note: null, at: now }] }), brand, SITE);
    expect(e.subject).toBe('Lerato Mokoena joined Bidder A in Project Heron');
    expect(e.fromName).toBe('Project Heron data room');
    expect(e.text).toContain('Dear Jan,\n\nLerato Mokoena accepted the invitation and can now open the Project Heron data room as a member of Bidder A.');
    expect(e.text).toContain(`Open My team: ${SITE}/rooms/${WS}/team`);
    expect(e.text).toContain('You get this email because you chose to hear about your requests to add a colleague in Project Heron right away.');
    expect(buttons(e.html)).toBe(1);
  });

  it('lists requests in the admin summary', () => {
    const e = dailySummaryEmail(content({
      recipient: { personId: 'p', email: 'anika@example.com', givenName: 'Anika', timeZone: 'Africa/Johannesburg', isAdmin: true, groupNames: [] },
      team: [{ change: 'requested', name: 'Peter Moss', group: 'Bidder A', requestedBy: 'Jan de Vries', requestedAt: now, note: null, at: now }],
    }), brand, SITE);
    expect(e.subject).toBe('Project Heron: 1 colleague request');
    expect(e.text).toContain('REQUESTS TO ADD A COLLEAGUE · 1');
    expect(e.text).toContain(`- Jan de Vries asks to add Peter Moss to Bidder A (${SITE}/rooms/${WS}/people)\n  Approve or decline it under People in the room.`);
    expect(e.text).not.toContain('YOUR TEAM');
  });
});

describe('new documents reason', () => {
  it('names own choice or mandatory', () => {
    const mine = newDocumentsEmail(content({ kind: 'documents', mode: 'bundled', documents: [doc('3.2.1', 'Audited financial statements FY2025.pdf')] }), brand, SITE);
    expect(mine.text).toContain('You get this email because you chose to hear about new documents in Project Heron in bundled emails.');
    const now = newDocumentsEmail(content({ kind: 'documents', mode: 'immediate', documents: [doc('3.2.1', 'Audited financial statements FY2025.pdf')] }), brand, SITE);
    expect(now.text).toContain('You get this email because you chose to hear about new documents in Project Heron right away.');
    const versions = newDocumentsEmail(content({ kind: 'versions', mode: 'immediate', versions: [doc('3.2.1', 'Audited financial statements FY2025.pdf', 'f1', 2)] }), brand, SITE);
    expect(versions.text).toContain('You get this email because you chose to hear about new versions in Project Heron right away.');
    const locked = newDocumentsEmail(content({ kind: 'documents', mode: 'bundled', locked: ['documents'], documents: [doc('3.2.1', 'A.pdf')] }), brand, SITE);
    expect(locked.text).toContain('You get this email because the room admins of Project Heron send these to everyone.');
    const summary = dailySummaryEmail(content({ locked: ['documents'], documents: [doc('3.2.1', 'A.pdf')] }), brand, SITE);
    expect(summary.text).toContain('You get this email because the room admins of Project Heron send these to everyone.');
  });
});

describe('failed Publish now', () => {
  const dropped = (over: Partial<NotificationContent['dropped'][number]> = {}) => ({
    nodeId: 'n1', indexNumber: '3.5.4', title: 'Payment receipt.pdf', folderId: 'f35', versionNo: null, reason: 'failed' as const, code: null, at: now, ...over,
  });
  const johan = { personId: 'p', email: 'johan@example.com', givenName: 'Johan', timeZone: 'Africa/Johannesburg', isAdmin: false, groupNames: ['Finance'] };

  it('names the file, reason and folder', () => {
    const e = notificationEmail(content({ kind: 'publish_dropped', mode: 'immediate', recipient: johan, dropped: [dropped()] }), brand, SITE);
    expect(e.subject).toBe('Project Heron: 3.5.4 Payment receipt.pdf was not published');
    expect(e.text).toContain('A file you asked to publish was not published');
    expect(e.text).toContain('Dear Johan,');
    expect(e.text).toContain('3.5.4 Payment receipt.pdf was not published: it could not be prepared for viewing. It is still a draft.');
    expect(e.text).toContain('Bidders cannot see it until it is published.');
    expect(e.text).toContain(`Open the folder: ${SITE}/rooms/${WS}/documents/f35`);
    expect(e.text).toContain('You get this email because you chose to hear in Project Heron when a publish you asked for did not happen.');
    expect(buttons(e.html)).toBe(1);
  });

  it('lists several files with reasons', () => {
    const e = notificationEmail(content({ kind: 'publish_dropped', mode: 'bundled', recipient: johan, dropped: [
      dropped({ reason: 'refused', code: 'room_frozen' }),
      dropped({ nodeId: 'n2', indexNumber: '3.5.5', title: 'Bank letter.pdf', reason: 'refused', code: 'no_publish_right', versionNo: 2 }),
      dropped({ nodeId: 'n3', indexNumber: '3.5.6', title: 'Lease.pdf', reason: 'refused', code: 'four_eyes' }),
      dropped({ nodeId: 'n4', indexNumber: '3.5.7', title: 'Other.pdf', reason: 'refused', code: null }),
    ] }), brand, SITE);
    expect(e.subject).toBe('Project Heron: 4 files were not published');
    expect(e.text).toContain('3.5.4 Payment receipt.pdf was not published: the room was frozen when the file was ready. It is still a draft.');
    expect(e.text).toContain('Version 2 of 3.5.5 Bank letter.pdf was not published: you no longer had the right to publish it when the file was ready. It is still a draft.');
    expect(e.text).toContain('3.5.6 Lease.pdf was not published: this room now needs a second person to publish files you uploaded yourself. It is still a draft.');
    expect(e.text).toContain('3.5.7 Other.pdf was not published: the publishing rules did not allow it when the file was ready. It is still a draft.');
    expect(e.text).toContain('Bidders cannot see them until they are published.');
  });

  it('has a section in the daily summary', () => {
    const e = dailySummaryEmail(content({ recipient: johan, dropped: [dropped()] }), brand, SITE);
    expect(e.subject).toBe('Project Heron: 1 file not published');
    expect(e.text).toContain('NOT PUBLISHED · 1');
    expect(e.text).toContain('3.5.4 Payment receipt.pdf was not published: it could not be prepared for viewing. It is still a draft.');
  });
});
