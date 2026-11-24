// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { withTenant } from '@vdrkit/core';
import { brandingFrom, mailBranding } from '../src/mail/branding.js';
import { renderEmail, type MailBranding } from '../src/mail/layout.js';
import { SmtpChannel } from '../src/mail/smtp.js';
import * as t from '../src/mail/templates.js';
import { MemoryStorage } from '../src/pipeline/pipeline.js';
import { heron, type Heron } from '../../../packages/core/test/fixture.js';
import { png as pngOf } from './site-helpers.js';


const URL_ = 'https://dataroom.quillmont.example';
const WS = '00000000-0000-4000-8000-000000000001';
const brand: MailBranding = { orgName: 'Quillmont Advisory', logo: null, privacyUrl: null };
const logoBrand: MailBranding = { orgName: 'Quillmont Advisory', logo: { png: Buffer.from('png-bytes'), width: 180, height: 40 }, privacyUrl: 'https://quillmont.example/privacy' };
const at = new Date('2026-11-14T08:29:00Z');
const n = t.notificationsUrl(URL_, WS);

const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const buttons = (html: string) => (html.match(/background:#13627A/g) ?? []).length;

function common(e: t.Email) {
  expect(e.html.startsWith('<!doctype html>')).toBe(true);
  expect(e.html).toContain('<meta name="color-scheme" content="light">');
  expect(e.html).toContain('font-family:Arial, Helvetica, sans-serif');
  expect(e.html).toContain(`<title>${e.subject.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}</title>`);
  expect(buttons(e.html)).toBeLessThanOrEqual(1);
  expect(e.text.length).toBeGreaterThan(40);
  expect(e.text).not.toMatch(/<[a-z!/]/i);
  expect(e.text).toContain('Powered by VDRkit.');
  expect(e.html).not.toMatch(/<script|<img[^>]+src="https?:/i);
}

describe('layout', () => {
  it('escapes values', () => {
    const r = renderEmail('<b>Hi</b>', brand, {
      header: { room: 'Heron <script>alert(1)</script>', label: 'Notice' },
      blocks: [
        { kind: 'heading', text: 'A & B "quoted"' },
        { kind: 'text', text: '<img src=x onerror=alert(1)>\nsecond line' },
        { kind: 'quote', text: "It's <b>bold</b>" },
        { kind: 'facts', rows: [{ label: 'Name <i>', value: '</td><td>broken' }] },
        { kind: 'button', label: 'Open <it>', url: 'https://example.com/a?b=1&c="2"' },
      ],
      footer: [['Footer <u>', { label: 'Link <x>', url: 'https://example.com/?q=<y>' }]],
    });
    expect(r.html).not.toMatch(/<script|<img src=x|<b>bold|<i>|<u>|<x>|<it>|<\/td><td>broken/);
    expect(r.html).toContain('Heron &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.html).toContain('A &amp; B &quot;quoted&quot;');
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;<br>second line');
    expect(r.html).toContain('It&#39;s &lt;b&gt;bold&lt;/b&gt;');
    expect(r.html).toContain('href="https://example.com/a?b=1&amp;c=%222%22"');
    expect(r.html).toContain('<title>&lt;b&gt;Hi&lt;/b&gt;</title>');
    expect(r.text).toContain('<img src=x onerror=alert(1)>\nsecond line');
    expect(r.text).toContain("> It's <b>bold</b>");
  });

  it('allows only http(s) links and one button', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'mailto:a@b.example']) {
      expect(() => renderEmail('s', brand, { header: { label: 'x' }, blocks: [{ kind: 'button', label: 'Go', url }], footer: [] })).toThrow();
    }
    expect(() => renderEmail('s', brand, { header: { label: 'x' }, footer: [],
      blocks: [{ kind: 'button', label: 'A', url: URL_ }, { kind: 'button', label: 'B', url: URL_ }] })).toThrow(/one button/);
  });

  it('embeds the logo or falls back to the name', () => {
    const withLogo = renderEmail('s', logoBrand, { header: { label: 'x' }, blocks: [], footer: [] });
    expect(withLogo.html).toContain('<img src="cid:logo@vdrkit" width="144" height="32" alt="Quillmont Advisory"');
    expect(withLogo.inline).toEqual([{ cid: 'logo@vdrkit', filename: 'logo.png', contentType: 'image/png', content: logoBrand.logo!.png }]);
    const without = renderEmail('s', brand, { header: { label: 'x' }, blocks: [], footer: [] });
    expect(without.html).not.toContain('<img');
    expect(without.html).toContain('>Quillmont Advisory</span>');
    expect(without.inline).toEqual([]);
  });

  it('links the privacy notice when set', () => {
    const on = renderEmail('s', logoBrand, { header: { label: 'x' }, blocks: [], footer: [['Footer.']] });
    expect(on.html).toContain('<a href="https://quillmont.example/privacy" target="_blank" style="color:#0F5568;">Privacy notice</a>');
    expect(on.text).toContain('Privacy notice (https://quillmont.example/privacy)');
    const off = renderEmail('s', brand, { header: { label: 'x' }, blocks: [], footer: [['Footer.']] });
    expect(off.html).not.toContain('Privacy notice');
    expect(off.text).not.toContain('Privacy notice');
  });
});

describe('templates', () => {
  it('invitation', () => {
    const e = t.invitationEmail({ brand, room: 'Project Heron', subject: 'Invitation to the Project Heron data room',
      message: 'Dear colleague,\n\nYour access runs until Fri 29 Jan 2027.\n\nKind regards,\nAnika Pillay\nQuillmont Advisory',
      leadParagraph: 'You are invited as a lead for Bidder A.', url: `${URL_}/invite/tok`, to: 'jan@orrinby.example', linkDays: 14,
      fromName: 'Anika Pillay, Quillmont Advisory' });
    common(e);
    expect(e.fromName).toBe('Anika Pillay, Quillmont Advisory');
    expect(e.html).toContain('<b style="color:#1A2531;">Project Heron</b><br>Invitation');
    expect(e.html).toContain('Kind regards,<br>Anika Pillay<br>Quillmont Advisory');
    expect(e.html).toContain('>Open the data room</a>');
    expect(e.text).toContain('> You are invited as a lead for Bidder A.');
    expect(e.text).toContain(`Open the data room: ${URL_}/invite/tok`);
    expect(e.text).toContain('This invitation is for jan@orrinby.example only and expires after 14 days. Sent from the Project Heron data room, run by Quillmont Advisory. Powered by VDRkit.');
    expect(buttons(e.html)).toBe(1);
    expect(t.invitationEmail({ brand, room: 'Project Heron', subject: 's', message: 'm', leadParagraph: null, url: URL_, to: 'a@b.example', linkDays: 14 }).fromName)
      .toBe('Project Heron data room');
  });

  it('sign-in link and code', () => {
    const e = t.signInEmail({ brand, code: '482913', link: `${URL_}/sign-in/link?token=x`, minutes: 15, requestedAt: at, timeZone: 'Europe/London', browser: 'Chrome on Windows' });
    common(e);
    // phones offer to copy codes
    expect(e.subject).toBe('Your sign-in code: 482913');
    expect(e.fromName).toBe('Quillmont Advisory data rooms');
    expect(e.text).toContain('Sign in to your data room\n\nClick the button, or type this code on the sign-in page.\n\n482913\n\nSign in: ');
    expect(e.text).toContain('The link and the code work once, within 15 minutes. Requested at 08:29 GMT from Chrome on Windows.');
    expect(e.text).toContain('Did not ask to sign in? Ignore this email. Nobody can sign in without it.');
    expect(e.text).toContain('Sent by the data rooms of Quillmont Advisory. Powered by VDRkit.');
    expect(e.html).toContain('letter-spacing:6px');
    // letter-spacing keeps the code one word
    expect(e.html).toContain('<span style="letter-spacing:6px;">48</span><span style="letter-spacing:22px;">2</span><span style="letter-spacing:6px;">913</span>');
    expect(e.html).not.toMatch(/482 913|482&nbsp;913/);
    expect(e.html.replace(/<[^>]+>/g, '')).toContain('482913');
    expect(e.html).toContain('>Sign in</a>');
    const code = t.signInEmail({ brand, code: '123456', link: null, minutes: 15, requestedAt: at, timeZone: 'Africa/Johannesburg', browser: null });
    expect(buttons(code.html)).toBe(0);
    expect(code.text).toContain('Type this code on the sign-in page.');
    expect(code.text).toContain('The code works once, within 15 minutes. Requested at 10:29 SAST.');
    const ip = t.signInEmail({ brand, code: '123456', link: `${URL_}/sign-in/link?token=x`, minutes: 15, requestedAt: at, timeZone: 'Africa/Johannesburg',
      browser: 'Chrome on Windows', ip: '203.0.113.18' });
    expect(ip.text).toContain('Requested at 10:29 SAST from Chrome on Windows, IP address 203.0.113.18.');
    const ipOnly = t.signInEmail({ brand, code: '123456', link: null, minutes: 15, requestedAt: at, timeZone: 'Africa/Johannesburg', browser: null, ip: '2001:db8::1' });
    expect(ipOnly.text).toContain('Requested at 10:29 SAST from IP address 2001:db8::1.');
  });

  it('colleague request', () => {
    const e = t.colleagueRequestEmail({ brand, room: 'Project Heron', lead: 'Jan de Vries', group: 'Bidder A', name: 'Naledi Khumalo',
      email: 'naledi@orrinby.example', company: 'Orrinby Capital', role: 'Associate', reason: 'Runs the model.', reviewUrl: `${URL_}/rooms/${WS}/people`, notificationsUrl: n });
    common(e);
    expect(e.subject).toBe('Jan de Vries asks to add a colleague to Bidder A');
    expect(e.fromName).toBe('Project Heron data room');
    expect(e.text).toContain('Name: Naledi Khumalo\nEmail: naledi@orrinby.example\nCompany: Orrinby Capital\nRole: Associate');
    expect(e.text).toContain('> Runs the model.');
    expect(e.text).toContain(`Review the request: ${URL_}/rooms/${WS}/people`);
    expect(e.text).toContain(`You get this email because you are a room admin of Project Heron. Change your email notifications (${n}).`);
    expect(e.html).not.toMatch(/approve|decide/i);
  });

  it('request decision', () => {
    const no = t.requestDecisionEmail({ brand, room: 'Project Heron', approved: false, givenName: 'Jan', name: 'Naledi Khumalo', group: 'Bidder A',
      note: 'Once 3.4 Tax is open.', teamUrl: `${URL_}/rooms/${WS}/team`, notificationsUrl: n });
    common(no);
    expect(no.subject).toBe('Your request for Naledi Khumalo was declined');
    expect(no.text).toContain('Dear Jan,\n\nYour request to add Naledi Khumalo to Bidder A in the Project Heron data room was declined. Naledi Khumalo was not contacted.');
    expect(no.text).toContain('> Reason from the room admin: Once 3.4 Tax is open.');
    const yes = t.requestDecisionEmail({ brand, room: 'Project Heron', approved: true, givenName: '', name: 'Naledi Khumalo', group: 'Bidder A',
      note: 'ignored', teamUrl: `${URL_}/rooms/${WS}/team`, notificationsUrl: n });
    expect(yes.subject).toBe('Naledi Khumalo is invited to Bidder A');
    expect(yes.text).toContain('Dear colleague,');
    expect(yes.text).not.toContain('ignored');
  });

  it('site admin joined', () => {
    const e = t.siteAdminJoinedEmail({ brand, room: 'Project Heron', joiner: 'Ruth Mahlangu', joinedAt: new Date('2026-11-14T12:05:00Z'),
      timeZone: 'Africa/Johannesburg', reason: 'Anika is on leave.', activityUrl: `${URL_}/rooms/${WS}/activity`, notificationsUrl: n });
    common(e);
    expect(e.subject).toBe('Ruth Mahlangu, site admin, joined Project Heron');
    expect(e.text).toContain('Ruth Mahlangu joined Project Heron as room admin');
    expect(e.text).toContain('Ruth is a site admin of Quillmont Advisory data rooms. Ruth joined at 14:05 SAST and gave this reason:\n\n> Anika is on leave.');
    expect(e.text).toContain('This is recorded in Activity. If you did not expect it, raise it with Ruth or with your site admins.');
    expect(e.text).toContain(`See it in Activity: ${URL_}/rooms/${WS}/activity`);
    expect(e.text).toContain('You get this email because you are a room admin of Project Heron. It cannot be switched off.');
  });

  it('health alert and recovery', () => {
    const e = t.healthAlertEmail({ brand, check: 'storage', label: 'File storage', since: new Date('2026-11-14T07:12:00Z'), now: new Date('2026-11-14T07:27:00Z'),
      timeZone: 'Africa/Johannesburg', lastError: 'connect ETIMEDOUT s3.af-south-1.amazonaws.com:443', healthUrl: `${URL_}/site/settings/health`, siteAdmin: true });
    common(e);
    expect(e.subject).toBe('Problem: file storage is not reachable');
    expect(e.text).toContain('File storage is not reachable\n\nSince: Sat 14 Nov 2026, 09:12 SAST\nFor: 15 minutes\n'
      + 'Effect: Documents cannot be opened, downloaded or uploaded. Sign-in and the rest of the site work.\n'
      + 'Last error: connect ETIMEDOUT s3.af-south-1.amazonaws.com:443');
    expect(e.text).toContain('We email again when it recovers. Users see the "Something went wrong" page with a reference until then.');
    expect(e.text).toContain('You get this email because you are a site admin of Quillmont Advisory data rooms. Change alerts in Site settings › Health. Powered by VDRkit.');
    expect(e.html).toContain('#FDECEA');
    const r = t.healthRecoveryEmail({ brand, check: 'storage', label: 'File storage', since: new Date('2026-11-14T07:12:00Z'), now: new Date('2026-11-14T08:01:00Z'),
      timeZone: 'Africa/Johannesburg', healthUrl: `${URL_}/site/settings/health`, siteAdmin: false });
    common(r);
    expect(r.subject).toBe('Recovered: file storage is reachable again');
    expect(r.text).toContain('Down since: Sat 14 Nov 2026, 09:12 SAST\nBack at: Sat 14 Nov 2026, 10:01 SAST\nOutage: 49 minutes');
    expect(r.html).toContain('#E4F3EA');
  });

  it('test email', () => {
    const e = t.testEmail({ brand, host: 'smtp.office365.com', port: 587, security: 'starttls', sender: 'dataroom@quillmont.example', sentAt: new Date('2026-11-14T08:31:00Z'), timeZone: 'Africa/Johannesburg' });
    common(e);
    expect(e.subject).toBe('Test email from your data room site');
    expect(buttons(e.html)).toBe(0);
    expect(e.text).toContain('Outgoing email works\n\nThis email reached you, so your data room site can send invitations, sign-in codes and summaries.');
    expect(e.text).toContain('Server: smtp.office365.com\nPort: 587, STARTTLS\nSender: dataroom@quillmont.example\nSent: Sat 14 Nov 2026, 10:31 SAST');
    expect(e.text).toContain('Did it land in spam? Check the SPF, DKIM and DMARC results in Site settings › Outgoing email.');
    expect(e.text).toContain('Sent by Quillmont Advisory data rooms. Powered by VDRkit.');
  });

  it('NDA reminder, new copy and site rights', () => {
    const nda = t.ndaReminderEmail({ brand, room: 'Project Heron', givenName: 'Lars', url: `${URL_}/rooms/${WS}` });
    common(nda);
    expect(nda.subject).toBe('Reminder: accept the NDA for Project Heron');
    expect(nda.text).toContain('Dear Lars,\n\nYou have access to the Project Heron data room, but you have not accepted its confidentiality agreement (NDA) yet.');
    const copy = t.newCopyEmail({ brand, room: 'Project Heron', asker: 'Anika Pillay', document: '3.3.4 Five-year forecast model', passwordProtected: true,
      askedAt: at, timeZone: 'Africa/Johannesburg', url: `${URL_}/rooms/${WS}/documents` });
    common(copy);
    expect(copy.subject).toBe('Project Heron: please upload a new copy of 3.3.4 Five-year forecast model');
    expect(copy.text).toContain('> The file is password protected.');
    expect(copy.text).toContain('Please upload a copy without a password, as a new version of the same document.');
    const other = t.newCopyEmail({ brand, room: 'Project Heron', asker: 'Anika Pillay', document: '3.3.4 Five-year forecast model', passwordProtected: false,
      askedAt: at, timeZone: 'Africa/Johannesburg', url: `${URL_}/rooms/${WS}/documents` });
    expect(other.text).toContain('> The file could not be converted for viewing.');
    expect(other.text).toContain('Please upload a new copy, as a new version of the same document. Saving the file again in the program that made it often helps.');
    expect(other.text).not.toMatch(/password/i);
    const admin = t.siteRightEmail({ brand, right: 'site_admin', signInUrl: `${URL_}/sign-in` });
    common(admin);
    expect(admin.subject).toBe('You are now a site admin of Quillmont Advisory data rooms');
    const creator = t.siteRightEmail({ brand, right: 'room_creator', signInUrl: `${URL_}/sign-in` });
    expect(creator.subject).toBe('You can now create rooms in Quillmont Advisory data rooms');
    expect(creator.text).toContain('You become room admin of each room you create. Sign in with this email address.');
  });

  it('address change agreement', () => {
    const e = t.emailChangeApprovalEmail({ brand, requestedBy: 'Anika Pillay', oldEmail: 'jan@bidder-a.example', newEmail: 'jan@orrinby.example',
      url: `${URL_}/email-change/approve/abc`, hours: 72 });
    common(e);
    expect(e.subject).toBe('Change your sign-in address?');
    expect(buttons(e.html)).toBe(1);
    expect(e.text).toContain('Anika Pillay asked to change the address you sign in with from jan@bidder-a.example to jan@orrinby.example.');
    expect(e.text).toContain('Nothing changes unless you agree.');
    expect(e.text).toContain('The link works for 3 days. If you agree, a code goes to jan@orrinby.example to confirm the new address.');
    expect(e.text).not.toMatch(/\b\d{6}\b/);
  });

  it('names documents by number and title only', () => {
    const copy = t.newCopyEmail({ brand, room: 'Project Heron', asker: 'Anika Pillay', document: '2.4.1 Master services agreement', passwordProtected: false,
      askedAt: at, timeZone: 'UTC', url: `${URL_}/rooms/${WS}/documents` });
    expect(visible(copy.html)).toContain('Please upload a new copy of 2.4.1 Master services agreement');
    expect(copy.text).not.toMatch(/Material contracts|page \d/i);
    expect(t.newCopyEmail.length).toBe(1);
  });
});

describe('email branding', () => {
  let h: Heron;
  beforeEach(async () => { h = await heron(); });
  afterEach(async () => { await h.pg.close(); });

  it('reads name, logo and privacy notice', async () => {
    const storage = new MemoryStorage();
    const read = () => withTenant(h.db, h.t1, (tx) => mailBranding(tx, storage, 'https://dataroom.quillmont.example/'), { role: 'vdrkit_app' });
    expect(await read()).toEqual({ orgName: 'Quillmont Advisory', logo: null, privacyUrl: null });

    const png = pngOf(360, 80);
    await storage.put('site/branding/logo-light-1.png', png);
    await h.pg.query(`insert into site_settings (tenant_id, org_name, logo_light, privacy_text) values ($1, 'Quillmont Advisory Ltd', $2, 'We keep your data safe.')`,
      [h.t1, JSON.stringify({ key: 'site/branding/logo-light-1.png', filename: 'logo.png', mime: 'image/png', size: png.length, width: 360, height: 80, sha256: 'a'.repeat(64) })]);
    const b = await read();
    expect(b.orgName).toBe('Quillmont Advisory Ltd');
    expect(b.logo).toEqual({ png, width: 180, height: 40 });
    expect(b.privacyUrl).toBe('https://dataroom.quillmont.example/privacy');
    await h.pg.query(`update site_settings set privacy_text = null, privacy_url = 'https://quillmont.example/privacy' where tenant_id = $1`, [h.t1]);
    expect((await read()).privacyUrl).toBe('https://quillmont.example/privacy');
    // only web addresses become links
    expect((await brandingFrom({ org_name: 'X', logo_light: null, privacy_text: 'x' }, undefined, '')).privacyUrl).toBeNull();
    expect((await brandingFrom({ org_name: 'X', logo_light: null, privacy_url: 'javascript:alert(1)' }, undefined, URL_)).privacyUrl).toBeNull();
    // no storage, no logo
    expect((await withTenant(h.db, h.t1, (tx) => mailBranding(tx, undefined, URL_), { role: 'vdrkit_app' })).logo).toBeNull();
  });
});

describe('SMTP channel', () => {
  const FROM_PLAIN = 'dataroom@quillmont.example';
  const msg = t.toMessage(t.signInEmail({ brand: logoBrand, code: '482913', link: `${URL_}/sign-in/link?token=SECRET-TOKEN`, minutes: 15, requestedAt: at,
    timeZone: 'UTC', browser: null }), '00000000-0000-4000-8000-000000000001', 'jan@orrinby.example');

  it('sends HTML, text and inline logo', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const spy = vi.spyOn(transport, 'sendMail');
    expect((await new SmtpChannel(transport, FROM_PLAIN).send(msg)).status).toBe('accepted');
    const raw = String(((await spy.mock.results[0]!.value) as { message: Buffer }).message);
    expect(raw).toMatch(/^From: Quillmont Advisory data rooms <dataroom@quillmont\.example>$/m);
    expect(raw).toMatch(/^Content-Type: multipart\/alternative/m);
    expect(raw).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(raw).toMatch(/^Content-Type: text\/html; charset=utf-8$/m);
    expect(raw).toMatch(/^Content-Type: image\/png; name=logo\.png$/m);
    expect(raw).toMatch(/^Content-ID: <logo@vdrkit>$/m);
    expect(raw).toMatch(/^Content-Disposition: inline; filename=logo\.png$/m);
  });

  it('uses the site or room name as sender', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const spy = vi.spyOn(transport, 'sendMail');
    await new SmtpChannel(transport, 'VDRkit <dataroom@quillmont.example>').send(msg);
    await new SmtpChannel(transport, 'VDRkit <dataroom@quillmont.example>').send({ ...msg, fromName: 'Project Heron data room' });
    const froms = await Promise.all(spy.mock.results.map(async (r) => JSON.parse(((await r.value) as { message: string }).message).from));
    expect(froms).toEqual([{ address: 'dataroom@quillmont.example', name: 'Quillmont Advisory data rooms' }, { address: 'dataroom@quillmont.example', name: 'Project Heron data room' }]);
  });

  it('logs failures without the code or link', async () => {
    const logs: string[] = [];
    const err = Object.assign(new Error(`rejected 482913 and 482 913 at ${URL_}/sign-in/link?token=SECRET-TOKEN`), { code: 'EENVELOPE' });
    const failing = nodemailer.createTransport({ name: 'f', version: '1', send: (_m: unknown, cb: (e: Error) => void) => cb(err) } as never);
    const r = await new SmtpChannel(failing, FROM_PLAIN, (m, extra) => logs.push(JSON.stringify({ m, ...extra }))).send(msg);
    expect(r.status).toBe('failed');
    for (const s of [r.error!, ...logs]) {
      expect(s).not.toContain('482913');
      expect(s).not.toContain('482 913');
      expect(s).not.toContain('SECRET-TOKEN');
    }
  });
});
