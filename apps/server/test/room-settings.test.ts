// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Channel, OutgoingMessage } from '@vdrkit/core';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { withName } from '../src/mail/smtp.js';
import { heron, T, type Heron } from '../../../packages/core/test/fixture.js';
import { CAN_RACE, together } from './race.js';
import * as mupdf from 'mupdf';


let h: Heron;
let app: FastifyInstance;
let outbox: OutgoingMessage[];
const mailer: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `pm-${outbox.length}` }; } };

beforeEach(async () => {
  h = await heron();
  outbox = [];
  app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => T.at, mailer, publicUrl: 'https://dataroom.example' });
});
afterEach(async () => { await app.close(); await h.pg.close(); });

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, person: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });
const W = () => `/v1/workspaces/${h.ws}`;
const NDA_TEXT = 'Confidentiality undertaking, corrected wording of clause 4.';

describe('NDA overview', () => {
  it('uses the room time zone', async () => {
    const at = new Date((await h.pg.query<{ published_at: Date }>(
      `select v.published_at from agreement_version v join agreement a on a.id = v.agreement_id where a.workspace_id = $1`, [h.ws])).rows[0]!.published_at);
    // one of these is always another day in UTC
    const zone = at.getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
    const day = (timeZone: string) => at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone });
    expect(day(zone)).not.toBe(day('UTC'));
    await h.pg.query(`update workspace set time_zone = $2 where id = $1`, [h.ws, zone]);
    const pdf = await call('GET', `${W()}/nda/pdf`, h.person.anika);
    expect(pdf.statusCode).toBe(200);
    const text = mupdf.Document.openDocument(pdf.rawPayload, 'application/pdf').loadPage(0).toStructuredText().asText();
    expect(text).toContain(`published ${day(zone)}`);
  });

  it('shows acceptances per group', async () => {
    const res = await call('GET', `${W()}/nda/overview`, h.person.anika);
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.required).toBe(true);
    expect(o.current).toMatchObject({ versionNo: 1, name: 'Project Heron NDA', publishedBy: null, mode: 'everyone' });
    expect(o.current.pages).toBeGreaterThan(0);
    expect(o.people).toEqual({ accepted: 3, total: 3 });
    expect(o.groups.map((g: any) => [g.name, g.accepted, g.total])).toEqual([['Bidder A', 1, 1], ['Bidder A financier', 1, 1], ['Bidder B', 1, 1]]);
    expect(o.history).toEqual([]);
  });

  it('should be admin only', async () => {
    expect((await call('GET', `${W()}/nda/overview`, h.person.jan)).statusCode).toBe(403);
    expect((await call('GET', `${W()}/nda/overview`, h.person.maria)).statusCode).toBe(403);
    const outsider = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Out Sider', 'out@x.example') returning id`, [h.t1])).rows[0]!.id;
    const missing = await call('GET', `/v1/workspaces/00000000-0000-4000-8000-000000000000/nda/overview`, h.person.anika);
    const notMine = await call('GET', `${W()}/nda/overview`, outsider);
    expect(notMine.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(notMine.json().title).toBe(missing.json().title);
  });

  it('keeps version names and publishers', async () => {
    const pub = await call('PUT', `${W()}/nda`, h.person.anika, { body: NDA_TEXT, mode: 'everyone', name: 'Heron NDA 2026-11' });
    expect(pub.statusCode).toBe(200);
    const o = (await call('GET', `${W()}/nda/overview`, h.person.anika)).json();
    expect(o.current).toMatchObject({ versionNo: 2, name: 'Heron NDA 2026-11', publishedBy: 'Anika Pillay', mode: 'everyone', body: NDA_TEXT });
    expect(o.people).toEqual({ accepted: 0, total: 3 });
    expect(o.history).toEqual([{ versionNo: 1, name: 'Project Heron NDA', publishedAt: expect.any(String), replacedAt: o.current.publishedAt, accepted: 3 }]);
    expect((await call('GET', `${W()}/nda`, h.person.jan)).json().name).toBe('Heron NDA 2026-11');
  });

  it('counts corrections as accepted', async () => {
    await call('PUT', `${W()}/nda`, h.person.anika, { body: NDA_TEXT, mode: 'everyone', name: 'Heron NDA 2026-11' });
    await call('PUT', `${W()}/nda`, h.person.anika, { body: `${NDA_TEXT} Typo fixed.`, mode: 'correction' });
    const o = (await call('GET', `${W()}/nda/overview`, h.person.anika)).json();
    expect(o.current).toMatchObject({ versionNo: 3, name: 'Heron NDA 2026-11', mode: 'correction' });
    expect(o.history.map((v: any) => v.versionNo)).toEqual([2, 1]);
    expect(o.people.total).toBe(3);
  });

  it('rejects long version names', async () => {
    expect((await call('PUT', `${W()}/nda`, h.person.anika, { body: NDA_TEXT, name: 'x'.repeat(121) })).statusCode).toBe(400);
  });
});

describe('room settings', () => {
  it('renames the seller', async () => {
    const s = (await call('GET', `${W()}/settings`, h.person.anika)).json();
    expect(s.sellerName).toBe('Seller');
    const res = await call('PATCH', `${W()}/settings`, h.person.anika, { sellerName: '  Drosvelt Holdings (Pty) Ltd ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().sellerName).toBe('Drosvelt Holdings (Pty) Ltd');
    const ev = (await call('GET', `${W()}/events?action=workspace.settings_changed`, h.person.anika)).json().items[0];
    expect(ev.data.before.sellerName).toBe('Seller');
    expect(ev.data.after.sellerName).toBe('Drosvelt Holdings (Pty) Ltd');
    expect(ev.data.after.publishers).toBeUndefined();
    expect(ev.data.after.invitationDefault).toBeUndefined();
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { sellerName: 'x' })).statusCode).toBe(400);
  });

  it('has no room default for notifying bidders', async () => {
    expect((await call('GET', `${W()}/settings`, h.person.anika)).json()).not.toHaveProperty('publishNotify');
    expect((await call('GET', `${W()}/release-review`, h.person.anika)).json().room).not.toHaveProperty('publishNotify');
  });

  it('lists publishers', async () => {
    expect((await call('GET', `${W()}/settings`, h.person.anika)).json().publishers).toEqual([]);
    const g = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true }] });
    expect(g.statusCode).toBe(200);
    const s = (await call('GET', `${W()}/settings`, h.person.anika)).json();
    expect(s.publishers).toEqual([{ name: 'Seller finance team', folders: ['3 Finance'] }]);
  });

  it('returns the default invitation text', async () => {
    const s = (await call('GET', `${W()}/settings`, h.person.anika)).json();
    expect(s.invitationDefault.subject).toBe('Invitation to the Project Heron data room');
    expect(s.invitation).toMatchObject({ senderName: '', replyTo: '' });
  });

  it("uses the room's sender and reply-to", async () => {
    const res = await call('PATCH', `${W()}/settings`, h.person.anika, { invitation: { senderName: 'Anika Pillay, Quillmont Advisory', replyTo: 'anika@quillmont.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().invitation).toMatchObject({ senderName: 'Anika Pillay, Quillmont Advisory', replyTo: 'anika@quillmont.example' });
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'sven@bidder-b.example' }] });
    expect(outbox[0]).toMatchObject({ fromName: 'Anika Pillay, Quillmont Advisory', replyTo: 'anika@quillmont.example' });

    const back = await call('PATCH', `${W()}/settings`, h.person.anika, { invitation: { senderName: '', replyTo: '' } });
    expect(back.json().invitation).toMatchObject({ senderName: '', replyTo: '' });
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'ola@bidder-b.example' }] });
    expect(outbox[1]!.fromName).toBe('Anika Pillay, Quillmont Advisory');
    expect(outbox[1]!.replyTo).toBeUndefined();
  });

  it('validates reply-to', async () => {
    expect((await call('PATCH', `${W()}/settings`, h.person.anika, { invitation: { replyTo: 'not an address' } })).statusCode).toBe(400);
    expect((await call('PATCH', `${W()}/settings`, h.person.jan, { sellerName: 'Phish Ltd' })).statusCode).toBe(403);
    expect((await call('PATCH', `${W()}/settings`, h.person.maria, { fourEyesPublish: true })).statusCode).toBe(403);
  });
});

describe('From line', () => {
  it("keeps the installation's address", () => {
    expect(withName('"Quillmont" <dataroom@quillmont.example>', 'Anika Pillay, Quillmont Advisory')).toBe('"Anika Pillay, Quillmont Advisory" <dataroom@quillmont.example>');
    expect(withName('dataroom@quillmont.example', 'Anika')).toBe('"Anika" <dataroom@quillmont.example>');
    expect(withName('dataroom@quillmont.example', 'Evil"\r\nBcc: x@y <z>')).toBe('"EvilBcc: x@y z" <dataroom@quillmont.example>');
    expect(withName('dataroom@quillmont.example', '  ')).toBe('dataroom@quillmont.example');
  });
});

describe('mail channel', () => {
  it('should pass sender and reply-to', async () => {
    const { SmtpChannel } = await import('../src/mail/smtp.js');
    const sent: any[] = [];
    const ch = new SmtpChannel({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'x', rejected: [] } as any; } } as any,
      '"VDRkit" <dataroom@quillmont.example>', () => {});
    await ch.send({ personId: 'p', to: 'a@b.example', subject: 's', lines: ['x'], fromName: 'Anika Pillay', replyTo: 'anika@quillmont.example' });
    await ch.send({ personId: 'p', to: 'a@b.example', subject: 's', lines: ['x'] });
    expect(sent[0]).toMatchObject({ from: '"Anika Pillay" <dataroom@quillmont.example>', replyTo: 'anika@quillmont.example' });
    expect(sent[1].from).toBe('"VDRkit" <dataroom@quillmont.example>');
    expect(sent[1].replyTo).toBeUndefined();
  });
});

describe('room settings edge cases', () => {
  it('puts the firm and seller in the invitation', async () => {
    const s = (await call('GET', `${W()}/settings`, h.person.anika)).json();
    expect(s.invitationDefault.message.split('\n')[2]).toBe(
      'Quillmont Advisory has invited you to the Project Heron data room on behalf of Seller. Use the button in this email to sign in. You will be asked to accept the confidentiality agreement before you see any documents.');
    expect(s.invitation.message).toBe(s.invitationDefault.message);
    await call('PATCH', `${W()}/settings`, h.person.anika, { sellerName: 'Drosvelt Holdings' });
    await call('POST', `${W()}/invitations`, h.person.anika, { groupId: h.group.b, people: [{ email: 'sven@bidder-b.example' }] });
    expect(outbox[0]!.text!.split('\n')[2]).toContain('on behalf of Drosvelt Holdings.');
  });

  it('updates the seller on the invitation page', async () => {
    await h.pg.query(`insert into party (tenant_id, workspace_id, name, kind, created_at) values ($1, $2, 'Aardvark Trust', 'seller', now() + interval '1 day')`, [h.t1, h.ws]);
    expect((await call('GET', `${W()}/settings`, h.person.anika)).json().sellerName).toBe('Seller');
    await call('PATCH', `${W()}/settings`, h.person.anika, { sellerName: 'Drosvelt Holdings' });
    const names = (await h.pg.query<{ name: string }>(`select name from party where workspace_id = $1 and kind = 'seller' order by name`, [h.ws])).rows.map((r) => r.name);
    expect(names).toEqual(['Aardvark Trust', 'Drosvelt Holdings']);
    const rooms = (await call('GET', `/v1/me/workspaces`, h.person.anika)).json();
    expect(rooms.items.find((r: any) => r.id === h.ws).onBehalfOf).toBe('Drosvelt Holdings');
  });

  it('skips denied people and ended memberships', async () => {
    await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true }] });
    const pubs = async () => (await call('GET', `${W()}/settings`, h.person.anika)).json().publishers;
    expect(await pubs()).toEqual([{ name: 'Seller finance team', folders: ['3 Finance'] }]);

    const deny = await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, personId: h.person.maria, effect: 'deny' }] });
    expect(deny.statusCode).toBe(200);
    expect(await pubs()).toEqual([]);
  });

  it('leaves out ended groups', async () => {
    expect((await call('PUT', `${W()}/grants`, h.person.anika, { changes: [{ nodeId: h.node.fin, groupId: h.group.contributors, level: 20, canUpload: true, canPublish: true }] })).statusCode).toBe(200);
    await h.pg.query(`update membership set valid_to = $2 where person_id = $1`, [h.person.maria, T.at.toISOString()]);
    expect((await call('GET', `${W()}/settings`, h.person.anika)).json().publishers).toEqual([]);
  });

  it('logs the NDA version name and copies it', async () => {
    await call('PUT', `${W()}/nda`, h.person.anika, { body: NDA_TEXT, mode: 'everyone', name: 'Heron NDA 2026-11' });
    const ev = (await call('GET', `${W()}/events?action=agreement.version_published`, h.person.anika)).json().items[0];
    expect(ev.data).toMatchObject({ version_no: 2, mode: 'everyone', name: 'Heron NDA 2026-11' });
    await h.pg.query(`update person set can_create_rooms = true where id = $1`, [h.person.anika]);
    const res = await call('POST', '/v1/workspaces', h.person.anika, { name: 'Project Osprey', start: 'copy', copyFrom: { workspaceId: h.ws } });
    expect(res.statusCode).toBe(201);
    const o = (await call('GET', `/v1/workspaces/${res.json().id}/nda/overview`, h.person.anika)).json();
    expect(o.current).toMatchObject({ versionNo: 1, name: 'Heron NDA 2026-11', publishedBy: 'Anika Pillay', body: NDA_TEXT });
  });
});

describe.skipIf(!CAN_RACE)('concurrent saves', () => {
  it('should keep both', async () => {
    const done = await together(h, () => [
      call('PATCH', `${W()}/settings`, h.person.anika, { timeZone: 'Europe/Amsterdam' }),
      call('PATCH', `${W()}/settings`, h.person.anika, { fourEyesPublish: true }),
    ]);
    expect(done.map((r) => r.statusCode), done.map((r) => r.body).join('\n')).toEqual([200, 200]);
    expect((await call('GET', `${W()}/settings`, h.person.anika)).json()).toMatchObject({ timeZone: 'Europe/Amsterdam', fourEyesPublish: true });
  });
});
