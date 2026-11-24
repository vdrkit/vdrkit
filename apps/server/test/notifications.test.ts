// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  appendEvent, claimReminder, dueReminders, enqueueForEvent, enqueueTeamNews, Level, prepareNotifications, setGrant,
  type Channel, type OutgoingMessage,
} from '@vdrkit/core';
import { LocalKeyProvider } from '../src/crypto/envelope.js';
import { DbKeyring } from '../src/crypto/keyring.js';
import { buildApp, DevHeaderAuthenticator } from '../src/index.js';
import { GotenbergClient, MemoryStorage } from '../src/pipeline/pipeline.js';
import { sendDeadlineReminders, sendDueNotifications, type WorkerContext } from '../src/worker/jobs.js';
import { heron, pinClock, T, type Heron } from '../../../packages/core/test/fixture.js';


const SITE = 'https://dataroom.quillmont.example';
let h: Heron;
let ctx: WorkerContext;
let outbox: OutgoingMessage[];
let clock: Date;
let failNext = false;
const mailer: Channel = {
  name: 'email',
  send: async (m) => {
    if (failNext) { failNext = false; return { status: 'failed', error: 'SMTP 451' }; }
    outbox.push(m); return { status: 'accepted', providerMessageId: `pm-${outbox.length}` };
  },
};

const at = (iso: string) => new Date(iso);
const min = (n: number) => new Date(T.at.getTime() + n * 60_000);
const to = (email: string) => outbox.filter((m) => m.to === email);
const JAN = 'jan@bidder-a.example';
const MEI = 'mei@bidder-b.example';
const ANIKA = 'anika@quillmont.example';

let aud2: string;

beforeEach(async () => {
  h = await heron();
  outbox = [];
  clock = T.at;
  failNext = false;
  ctx = {
    db: h.db, storage: new MemoryStorage(), keyring: new DbKeyring(new LocalKeyProvider(randomBytes(32).toString('base64'))),
    gotenberg: new GotenbergClient('http://127.0.0.1:9'), mailer, dbRole: 'vdrkit_app', now: () => clock, publicUrl: SITE,
  };
  // reader in London, room in Johannesburg
  await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View, now: T.grantsSet }));
  await h.pg.query(`update person set time_zone = 'Europe/London' where id in ($1, $2)`, [h.person.jan, h.person.lars]);
  await h.pg.query(`update person set time_zone = 'Africa/Johannesburg' where id in ($1, $2, $3)`, [h.person.anika, h.person.maria, h.person.mei]);
  await h.pg.query(`update person set given_name = split_part(name, ' ', 1) where tenant_id = $1`, [h.t1]);
  aud2 = (await h.pg.query<{ id: string }>(`insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
    values ($1, $2, $3, 'document', 'Auditor''s report FY2025.pdf', '3.2.2', 'published') returning id`, [h.t1, h.ws, h.node.aud])).rows[0]!.id;
});
afterEach(async () => { await h.pg.close(); });

async function publish(nodeId: string, when: Date, quiet?: boolean) {
  return h.app(async (tx) => {
    const ev = await appendEvent(tx, { action: 'document.published', workspaceId: h.ws, resourceType: 'node', resourceId: nodeId,
      data: { person_id: h.person.anika }, occurredAt: when });
    return enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: nodeId, occurredAt: when, actorPersonId: h.person.anika,
      ...(quiet === undefined ? {} : { quiet }) });
  });
}
const own = (person: string, category: string, fields: { enabled?: boolean; mode?: string }) => h.pg.query(
  `insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, enabled, mode) values ($1, $2, 'user', $3, $4, $5, $6)`,
  [h.t1, h.ws, person, category, fields.enabled ?? null, fields.mode ?? null]);
const milestone = (title: string, due: string, groups: string[] = [], setAt: Date = T.at) => h.pg.query<{ id: string }>(
  `insert into milestone (tenant_id, workspace_id, title, due_at, visible_to_group_ids, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $6) returning id`,
  [h.t1, h.ws, title, due, groups, setAt.toISOString()]).then((r) => r.rows[0]!.id);
const run = async (when: Date) => { clock = when; return sendDueNotifications(ctx, h.t1); };
const remind = async (when: Date) => { clock = when; await pinClock(h.pg, when); return sendDeadlineReminders(ctx, h.t1); };
const sentEvents = async () => (await h.pg.query<any>(`select data, resource_type from event where action = 'notification.sent' order by seq`)).rows;

describe('daily summary', () => {
  it('sends one email at summary time on days with news', async () => {
    await own(h.person.jan, 'documents', { mode: 'digest' });
    await milestone('First-round bids', '2026-11-20T17:00:00Z');
    await publish(h.node.aud1, at('2026-11-12T09:30:00Z'));
    await publish(h.node.tax1, at('2026-11-12T10:00:00Z'));

    await run(at('2026-11-13T07:59:00Z'));
    expect(to(JAN)).toHaveLength(0);
    await run(at('2026-11-13T08:00:00Z'));   // 08:00 London
    const [m] = to(JAN);
    expect(to(JAN)).toHaveLength(1);
    expect(m!.subject).toBe('Project Heron: 2 new documents, 1 deadline coming up');
    expect(m!.fromName).toBe('Project Heron data room');
    const text = m!.text!;
    expect(text).toContain('What changed in Project Heron');
    expect(text).toContain('Since your last summary, for Bidder A.');
    expect(text).toContain('NEW DOCUMENTS · 2');
    expect(text).toContain(`- 3.2.1 Audited financial statements FY2025.pdf (${SITE}/rooms/${h.ws}/view/${h.node.aud1})`);
    expect(text).toContain('- 3.4.6 Tax clearance certificate 2026.pdf');
    expect(text).toContain('COMING UP');
    expect(text).toContain('First-round bids due Fri 20 Nov 2026 at 17:00 GMT');
    expect(text).toContain('In 7 days. Room time 19:00 SAST.');
    expect(text).toContain(`Open Project Heron: ${SITE}/rooms/${h.ws}`);
    expect(text).toContain('You get this email because you chose to hear about new documents in Project Heron in your daily summary at 08:00.');
    expect(m!.html).toContain('Summary for Fri 13 Nov 2026');
    expect(text).not.toMatch(/NEW VERSIONS|YOUR TEAM/);
    const ev = (await sentEvents()).filter((e) => e.data.recipient_person_id === h.person.jan);
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ category: 'summary', mode: 'digest', categories: ['documents'], node_ids: [h.node.aud1, h.node.tax1], delivery_status: 'accepted' });

    // a coming date alone is not news
    await run(at('2026-11-14T08:00:00Z'));
    expect(to(JAN)).toHaveLength(1);
  });

  it('lists only what is visible at send time', async () => {
    await own(h.person.jan, 'documents', { mode: 'digest' });
    await publish(h.node.aud1, at('2026-11-12T09:30:00Z'));
    await publish(h.node.tax1, at('2026-11-12T10:00:00Z'));
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.tax, subject: { groupId: h.group.a }, level: Level.None, now: at('2026-11-12T15:00:00Z') }));
    await run(at('2026-11-13T08:00:00Z'));
    const [m] = to(JAN);
    expect(m!.subject).toBe('Project Heron: 1 new document');
    expect(m!.text).not.toMatch(/Tax clearance|3\.4/);
    expect(m!.html).not.toMatch(/Tax clearance|3\.4/);

    // nothing left: dropped and logged
    await publish(aud2, at('2026-11-13T09:00:00Z'));
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.None, now: at('2026-11-13T12:00:00Z') }));
    await run(at('2026-11-14T08:00:00Z'));
    expect(to(JAN)).toHaveLength(1);
    const dropped = (await h.pg.query<any>(`select data from event where action = 'notification.dropped' and data->>'recipient_person_id' = $1`, [h.person.jan])).rows;
    expect(dropped.map((d) => d.data.reason)).toEqual(['no_items_visible_at_send']);
  });

  it('names the remaining folder only when visible', async () => {
    await own(h.person.jan, 'documents', { mode: 'digest' });
    const more: string[] = [];
    for (let i = 3; i <= 7; i++) {
      more.push((await h.pg.query<{ id: string }>(`insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
        values ($1, $2, $3, 'document', $4, $5, 'published') returning id`, [h.t1, h.ws, h.node.aud, `Note ${i}.pdf`, `3.2.${i}`])).rows[0]!.id);
    }
    for (const id of [h.node.aud1, aud2, ...more]) await publish(id, at('2026-11-12T09:30:00Z'));
    await run(at('2026-11-13T08:00:00Z'));
    expect(to(JAN)[0]!.text).toContain(`And 2 more in 3.2 Audited financials: ${SITE}/rooms/${h.ws}/documents/${h.node.aud}`);
  });

  it('omits Coming up when timeline emails are off', async () => {
    await own(h.person.jan, 'documents', { mode: 'digest' });
    await own(h.person.jan, 'deadlines', { enabled: false });
    await milestone('First-round bids', '2026-11-20T17:00:00Z');
    await publish(h.node.aud1, at('2026-11-12T09:30:00Z'));
    await run(at('2026-11-13T08:00:00Z'));
    expect(to(JAN)[0]!.subject).toBe('Project Heron: 1 new document');
    expect(to(JAN)[0]!.text).not.toMatch(/COMING UP|First-round/);
  });

  it('sends a new NDA as its own email', async () => {
    await own(h.person.jan, 'documents', { mode: 'digest' });
    await own(h.person.jan, 'agreements', { mode: 'digest' });
    await publish(h.node.aud1, at('2026-11-12T09:30:00Z'));
    await h.app(async (tx) => {
      const ev = await appendEvent(tx, { action: 'agreement.version_published', workspaceId: h.ws, resourceType: 'agreement', resourceId: h.nda.agreement, occurredAt: at('2026-11-12T10:00:00Z') });
      await enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: null, occurredAt: at('2026-11-12T10:00:00Z'), actorPersonId: h.person.anika });
    });
    await run(at('2026-11-13T08:00:00Z'));
    expect(to(JAN).map((m) => m.subject).sort()).toEqual(['Project Heron: 1 new document', 'Project Heron: a new NDA to accept']);
  });

  it('sends new NDA emails to the buyer side only', async () => {
    const tell = (when: Date, actor: string | null) => h.app(async (tx) => {
      const ev = await appendEvent(tx, { action: 'agreement.version_published', workspaceId: h.ws, resourceType: 'agreement', resourceId: h.nda.agreement, occurredAt: when });
      await enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: null, occurredAt: when, actorPersonId: actor });
    });
    await tell(min(0), null);
    expect((await h.pg.query(`select 1 from notification where person_id = any($1::uuid[])`, [[h.person.anika, h.person.maria]])).rows).toHaveLength(0);
    await run(min(1));
    expect(outbox.map((m) => m.to).sort()).toEqual([JAN, 'lars@skarvik.example', MEI]);
    expect(to(JAN)[0]!.subject).toBe('Project Heron: a new NDA to accept');
    outbox = [];
    await tell(min(2), null);
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, h.person.mei, h.group.contributors, min(2).toISOString()]);
    await run(min(3));
    expect(to(MEI)).toHaveLength(0);
    const d = (await h.pg.query<any>(`select data from event where action = 'notification.dropped' and data ->> 'recipient_person_id' = $1`, [h.person.mei])).rows;
    expect(d.map((r) => r.data.reason)).toEqual(['seller_side']);
  });

  it('skips quiet releases unless mandatory', async () => {
    await own(h.person.jan, 'documents', { mode: 'digest' });
    await publish(h.node.aud1, at('2026-11-12T09:30:00Z'), true);
    await run(at('2026-11-12T09:45:00Z'));
    await run(at('2026-11-13T08:00:00Z'));
    expect(outbox).toHaveLength(0);
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, category, mode, mandatory)
      values ($1, $2, 'workspace', 'documents', 'digest', true)`, [h.t1, h.ws]);
    await publish(h.node.tax1, at('2026-11-13T09:30:00Z'), true);
    await run(at('2026-11-14T08:00:00Z'));
    expect(to(JAN).map((m) => m.subject)).toEqual(['Project Heron: 1 new document']);
    expect(to(JAN)[0]!.text).toContain('You get this email because the room admins of Project Heron send these to everyone.');
    // mandatory does not apply to admins
    expect(to(ANIKA)).toHaveLength(0);
  });

});

describe('right away', () => {
  it('batches a burst of releases', async () => {
    await publish(h.node.aud1, min(0));
    await publish(aud2, min(4));
    await run(min(13));
    expect(to(JAN)).toHaveLength(0);
    await run(min(14));
    const [m] = to(JAN);
    expect(to(JAN)).toHaveLength(1);
    expect(m!.subject).toBe('Project Heron: 2 new documents in 3.2 Audited financials');
    expect(m!.text).toContain('2 new documents for Bidder A');
    expect(m!.text).toContain('Anika Pillay published them in 3.2 Audited financials between 08:00 GMT and 08:04 GMT.');
    expect(m!.text).toContain(`Open the folder: ${SITE}/rooms/${h.ws}/documents/${h.node.aud}`);
    expect(m!.text).toContain('You get this email because you chose to hear about new documents in Project Heron in bundled emails.');
  });

  it('hides folders the person cannot see', async () => {
    await h.app(async (tx) => {
      await setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.None, now: min(-30) });
      await setGrant(tx, { workspaceId: h.ws, nodeId: h.node.aud1, subject: { groupId: h.group.a }, level: Level.View, now: min(-30) });
    });
    await own(h.person.jan, 'documents', { mode: 'immediate' });
    await publish(h.node.aud1, min(0));
    await run(min(0));
    const [m] = to(JAN);
    expect(m!.subject).toBe('Project Heron: 1 new document');
    expect(m!.text).toContain('Anika Pillay published it at 08:00 GMT.');
    expect(m!.text).toContain(`Open Documents: ${SITE}/rooms/${h.ws}/documents\n`);
    expect(m!.text).toContain('You get this email because you chose to hear about new documents in Project Heron right away.');
    expect(`${m!.subject} ${m!.text} ${m!.html}`).not.toMatch(/Audited financials|Finance/);
  });

  it('mentions mandatory emails', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, category, mode, mandatory)
      values ($1, $2, 'workspace', 'documents', 'immediate', true)`, [h.t1, h.ws]);
    await publish(h.node.aud1, min(0));
    await run(min(1));
    const [m] = to(JAN);
    expect(to(JAN)).toHaveLength(1);
    expect(m!.text).toContain('You get this email because the room admins of Project Heron send these to everyone.');
    expect(m!.text).not.toContain('you chose');
  });

  it('skips quiet releases', async () => {
    await own(h.person.jan, 'documents', { mode: 'immediate' });
    await publish(h.node.aud1, min(0), true);
    await run(min(30));
    expect(outbox).toHaveLength(0);
    expect((await h.pg.query(`select 1 from event where action = 'document.published' and resource_id = $1`, [h.node.aud1])).rows).toHaveLength(1);
  });
});

describe('timeline notice', () => {
  it('handles a narrowed date', async () => {
    const id = await milestone('Site visit', '2026-11-20T08:00:00Z');
    await h.pg.query(`update milestone set visible_to_group_ids = $2 where id = $1`, [id, [h.group.a]]);
    await h.app(async (tx) => {
      const tell = async (data: Record<string, unknown>, groups: string[]) => {
        const ev = await appendEvent(tx, { action: 'milestone.changed', workspaceId: h.ws, resourceType: 'milestone', resourceId: id, data, occurredAt: min(0) });
        await enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: null, occurredAt: min(0), actorPersonId: h.person.maria, audienceGroupIds: groups });
      };
      await tell({ change: 'changed', due_at_before: '2026-11-20T08:00:00.000Z', due_at_after: '2026-11-20T08:00:00.000Z' }, [h.group.a]);
      await tell({ change: 'removed', title: 'Site visit' }, [h.group.b]);
    });
    await run(min(60 * 24));
    const anika = to(ANIKA).map((m) => `${m.subject} ${m.text}`).join(' ');
    expect(anika).toContain('Site visit changed');
    expect(anika).not.toMatch(/removed from the Timeline|2 dates changed/);
    expect(to(MEI).map((m) => m.subject)).toEqual(['Project Heron: a date was removed from the Timeline']);
    const d = (await h.pg.query<any>(`select i.dropped_reason from notification_item i join notification n on n.id = i.notification_id
      where n.person_id = $1 and i.dropped_reason is not null`, [h.person.anika])).rows;
    expect(d.map((r) => r.dropped_reason)).toEqual(['milestone_still_visible']);
  });

  it('tells the seller side about a moved single-bidder date', async () => {
    const obs = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Heron management', 'observer') returning id`,
      [h.t1, h.ws, h.party.seller])).rows[0]!.id;
    const liesl = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Liesl van Wyk', 'liesl@drosvelt.example') returning id`, [h.t1])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, liesl, obs, T.setup.toISOString()]);
    for (const p of [h.person.maria, h.person.jan, liesl]) await own(p, 'deadlines', { mode: 'digest' });
    await own(h.person.jan, 'documents', { mode: 'digest' });
    const moved = await milestone('Management presentation', '2026-11-19T09:00:00Z', [h.group.b]);
    await milestone('Site visit for Bidder B', '2026-11-17T09:00:00Z', [h.group.b]);
    await h.pg.query(`update milestone set due_at = '2026-11-20T09:00:00Z' where id = $1`, [moved]);
    await h.app(async (tx) => {
      const ev = await appendEvent(tx, { action: 'milestone.changed', workspaceId: h.ws, resourceType: 'milestone', resourceId: moved, occurredAt: min(0),
        data: { change: 'changed', due_at_before: '2026-11-19T09:00:00.000Z', due_at_after: '2026-11-20T09:00:00.000Z' } });
      await enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: null, occurredAt: min(0), actorPersonId: h.person.anika, audienceGroupIds: [h.group.b] });
    });
    await publish(h.node.aud1, min(0));
    expect((await h.pg.query(`select 1 from notification where person_id = $1`, [liesl])).rows).toHaveLength(0);

    await run(min(60 * 24));
    const maria = to('maria@drosvelt.example').map((m) => m.text).join(' ');
    expect(maria).toContain('Management presentation');
    expect(maria).toContain('COMING UP');
    expect(maria).toContain('Site visit for Bidder B');
    expect(to(JAN)).toHaveLength(1);
    expect(to(JAN)[0]!.text).not.toMatch(/Management presentation|Site visit for Bidder B/);
    expect(to('liesl@drosvelt.example')).toHaveLength(0);
  });
});

describe('exactly once', () => {
  it('should not send twice', async () => {
    await publish(h.node.aud1, min(0));
    // worker A claims and dies before sending
    const [jan] = (await h.pg.query<{ id: string }>(`select id from notification where person_id = $1`, [h.person.jan])).rows;
    const claimed = await h.app((tx) => prepareNotifications(tx, [jan!.id], min(10), { claim: true }));
    expect(claimed.status).toBe('ready');
    expect(await h.app((tx) => prepareNotifications(tx, [jan!.id], min(10), { claim: true }))).toEqual({ status: 'skipped' });
    await run(min(10));
    await run(min(11));
    expect(to(JAN)).toHaveLength(0);
    await run(min(26));
    expect(to(JAN)).toHaveLength(0);
    const row = (await h.pg.query<any>(`select status, delivery_status from notification where id = $1`, [jan!.id])).rows[0];
    expect(row).toEqual({ status: 'failed', delivery_status: 'unknown' });
    const failed = (await h.pg.query<any>(`select data from event where action = 'notification.failed' and resource_id = $1`, [jan!.id])).rows;
    expect(failed[0].data).toMatchObject({ recipient_person_id: h.person.jan, delivery_status: 'unknown' });
  });

  it('sends once with two workers', async () => {
    await publish(h.node.aud1, min(0));
    clock = min(10);
    await Promise.all([sendDueNotifications(ctx, h.t1), sendDueNotifications(ctx, h.t1)]);
    expect(to(JAN)).toHaveLength(1);
    expect(to('maria@drosvelt.example')).toHaveLength(1);
    expect((await sentEvents()).length).toBe(2);
  });

  it('marks refused delivery as failed', async () => {
    await own(h.person.maria, 'documents', { enabled: false });
    await publish(h.node.aud1, min(0));
    failNext = true;
    expect(await run(min(10))).toEqual({ sent: 0, dropped: 0, failed: 1 });
    expect(await run(min(11))).toEqual({ sent: 0, dropped: 0, failed: 0 });
    expect(outbox).toHaveLength(0);
    expect((await h.pg.query(`select 1 from event where action = 'notification.failed'`)).rows).toHaveLength(1);
  });
});

describe('excluded recipients', () => {
  let liesl: string;
  beforeEach(async () => {
    const obs = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Heron management', 'observer') returning id`,
      [h.t1, h.ws, h.party.seller])).rows[0]!.id;
    liesl = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Liesl van Wyk', 'liesl@drosvelt.example') returning id`, [h.t1])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, liesl, obs, T.setup.toISOString()]);
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: obs }, level: Level.View, now: T.grantsSet }));
  });

  it('skips seller observers', async () => {
    await publish(h.node.aud1, min(0));
    expect((await h.pg.query(`select 1 from notification where person_id = $1`, [liesl])).rows).toHaveLength(0);
    const n = (await h.pg.query<{ id: string }>(`insert into notification (tenant_id, workspace_id, person_id, category, mode, first_event_at, last_event_at, due_at)
      values ($1, $2, $3, 'documents', 'bundled', $4, $4, $4) returning id`, [h.t1, h.ws, liesl, min(0).toISOString()])).rows[0]!.id;
    const ev = (await h.pg.query<{ id: string }>(`select id from event where action = 'document.published' limit 1`)).rows[0]!.id;
    await h.pg.query(`insert into notification_item (tenant_id, notification_id, event_id, action, node_id, occurred_at) values ($1, $2, $3, 'document.published', $4, $5)`,
      [h.t1, n, ev, h.node.aud1, min(0).toISOString()]);
    await run(min(10));
    expect(to('liesl@drosvelt.example')).toHaveLength(0);
    const d = (await h.pg.query<any>(`select data from event where action = 'notification.dropped' and resource_id = $1`, [n])).rows[0];
    expect(d.data.reason).toBe('observer');
    await milestone('First-round bids', '2026-11-27T17:00:00Z');
    await remind(at('2026-11-25T17:00:00Z'));
    expect(to('liesl@drosvelt.example')).toHaveLength(0);
    expect(to(JAN).map((m) => m.subject)).toContain('Project Heron: First-round bids due in 2 days');
  });

  it('mails observers who are also bidders', async () => {
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, liesl, h.group.a, T.setup.toISOString()]);
    await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at)
      select tenant_id, agreement_version_id, $1, accepted_at from acceptance where person_id = $2`, [liesl, h.person.jan]);
    await publish(h.node.aud1, min(0));
    await run(min(10));
    expect(to('liesl@drosvelt.example').map((m) => m.subject)).toEqual(['Project Heron: 1 new document in 3.2 Audited financials']);
    await milestone('Management presentation', '2026-11-27T09:00:00Z', [h.group.a]);
    await remind(at('2026-11-25T09:00:00Z'));
    expect(to('liesl@drosvelt.example').map((m) => m.subject)).toContain('Project Heron: Management presentation due in 2 days');
  });

  it('never queues see-as stand-ins', async () => {
    const seen = { standIn: -1, jan: -1 };
    // preview never commits, so count inside it
    await expect(h.app(async (tx) => {
      const standIn = (await tx.query<{ person_id: string }>(`select person_id from see_as_begin($1, $2, $3, $4)`, [h.person.anika, h.ws, h.group.a, min(0).toISOString()])).rows[0]!.person_id;
      const ev = await appendEvent(tx, { action: 'document.published', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.aud1, occurredAt: min(0) });
      await enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: h.node.aud1, occurredAt: min(0), actorPersonId: h.person.anika });
      seen.standIn = (await tx.query(`select person_id from notification where person_id = $1`, [standIn])).rows.length;
      seen.jan = (await tx.query(`select person_id from notification where person_id = $1`, [h.person.jan])).rows.length;
    })).rejects.toThrow(/never saved/);
    expect(seen).toEqual({ standIn: 0, jan: 1 });
  });
});

describe('deadline reminder', () => {
  it('reminds 2 days and 2 hours before', async () => {
    await milestone('First-round bids', '2026-11-27T17:00:00Z');
    expect(await remind(at('2026-11-25T16:59:00Z'))).toEqual({ sent: 0, failed: 0 });
    const first = await remind(at('2026-11-25T17:00:00Z'));
    expect(outbox.map((m) => m.to).sort()).toEqual([ANIKA, JAN, 'lars@skarvik.example', 'maria@drosvelt.example', MEI]);
    expect(first.sent).toBe(5);
    const jan = to(JAN)[0]!;
    expect(jan.subject).toBe('Project Heron: First-round bids due in 2 days');
    expect(jan.text).toContain('First-round bids due in 2 days');
    expect(jan.text).toContain('Due: Fri 27 Nov 2026, 17:00 GMT');
    expect(jan.text).toContain('Room time: 19:00 SAST, Johannesburg');
    expect(jan.text).toContain('For: Bidder A');
    expect(jan.text).not.toMatch(/Bidder B/);
    expect(jan.text).toContain(`Open the Timeline: ${SITE}/rooms/${h.ws}/timeline`);
    expect(jan.text).toContain('You get this reminder because deadlines are on for Project Heron.');
    const anika = to(ANIKA)[0]!;
    expect(anika.text).toContain('Due: Fri 27 Nov 2026, 19:00 SAST');
    expect(anika.text).not.toContain('Room time');
    expect(anika.text).toContain('For: All bidder groups');
    expect(to(MEI)[0]!.text).toContain('For: Bidder B');

    expect(await remind(at('2026-11-25T17:01:00Z'))).toEqual({ sent: 0, failed: 0 });
    outbox = [];
    await remind(at('2026-11-27T15:00:00Z'));
    expect(to(JAN).map((m) => m.subject)).toEqual(['Project Heron: First-round bids due in 2 hours']);
    outbox = [];
    expect(await remind(at('2026-11-27T17:01:00Z'))).toEqual({ sent: 0, failed: 0 });
    const ev = (await sentEvents()).filter((e) => e.resource_type === 'deadline_reminder' && e.data.recipient_person_id === h.person.jan);
    expect(ev.map((e) => e.data.reminder)).toEqual(['2d', '2h']);
    expect(ev[0].data).toMatchObject({ category: 'deadlines', mode: 'reminder', delivery_status: 'accepted' });
  });

  it('reminds only the audience of the date', async () => {
    await milestone('Management presentation', '2026-11-27T09:00:00Z', [h.group.b]);
    await remind(at('2026-11-25T09:00:00Z'));
    expect(outbox.map((m) => m.to).sort()).toEqual([ANIKA, 'maria@drosvelt.example', MEI]);
    expect(to(MEI)[0]!.text).toContain('For: Bidder B');
    expect(to(JAN)).toHaveLength(0);
    expect(to('lars@skarvik.example')).toHaveLength(0);
  });

  it('respects timeline setting and NDA gate', async () => {
    await own(h.person.jan, 'deadlines', { enabled: false });
    await h.pg.query(`delete from acceptance where person_id = $1`, [h.person.mei]);
    await milestone('First-round bids', '2026-11-27T17:00:00Z');
    await remind(at('2026-11-25T17:00:00Z'));
    expect(to(JAN)).toHaveLength(0);
    expect(to(MEI)).toHaveLength(0);
    await h.pg.query(`delete from notification_policy where person_id = $1`, [h.person.jan]);
    await remind(at('2026-11-27T15:00:00Z'));
    expect(to(JAN)).toHaveLength(1);
  });

  it('skips late 2-day reminders', async () => {
    const LARS = 'lars@skarvik.example';
    await own(h.person.jan, 'deadlines', { enabled: false });
    await own(h.person.lars, 'deadlines', { enabled: false });
    await milestone('First-round bids', '2026-11-27T17:00:00Z');
    await remind(at('2026-11-25T17:00:00Z'));
    expect(to(JAN)).toHaveLength(0);
    expect(to(LARS)).toHaveLength(0);
    await h.pg.query(`delete from notification_policy where person_id = $1`, [h.person.lars]);
    await remind(at('2026-11-25T17:59:00Z'));
    expect(to(LARS).map((m) => m.subject)).toEqual(['Project Heron: First-round bids due in 2 days']);
    await h.pg.query(`delete from notification_policy where person_id = $1`, [h.person.jan]);
    expect(await remind(at('2026-11-26T20:00:00Z'))).toEqual({ sent: 0, failed: 0 });
    await remind(at('2026-11-27T15:10:00Z'));
    expect(to(JAN).map((m) => m.subject)).toEqual(['Project Heron: First-round bids due in 2 hours']);
    // nothing stale after 15 minutes
    await h.pg.query(`delete from deadline_reminder where person_id = $1 and kind = '2h'`, [h.person.lars]);
    expect(await remind(at('2026-11-27T15:16:00Z'))).toEqual({ sent: 0, failed: 0 });
  });

  it('reschedules reminders for a moved date', async () => {
    const id = await milestone('First-round bids', '2026-11-27T17:00:00Z');
    await remind(at('2026-11-25T17:00:00Z'));
    expect(to(JAN)).toHaveLength(1);
    await h.pg.query(`update milestone set due_at = '2026-11-28T10:00:00Z', updated_at = '2026-11-26T09:00:00Z' where id = $1`, [id]);
    await remind(at('2026-11-26T10:00:00Z'));
    expect(to(JAN)).toHaveLength(2);
    await h.pg.query(`update milestone set due_at = '2026-11-28T10:30:00Z', updated_at = '2026-11-28T09:00:00Z' where id = $1`, [id]);
    await remind(at('2026-11-28T09:01:00Z'));
    expect(to(JAN)).toHaveLength(2);
    await h.pg.query(`update milestone set title = 'Final bids', updated_at = '2026-11-28T09:30:00Z' where id = $1`, [id]);
    expect((await h.pg.query<any>(`select due_set_at from milestone where id = $1`, [id])).rows[0].due_set_at).toEqual(at('2026-11-28T09:00:00Z'));
  });

  it('claims each reminder once', async () => {
    await milestone('First-round bids', '2026-11-27T17:00:00Z');
    const now = at('2026-11-25T17:00:00Z');
    const [d] = await h.app((tx) => dueReminders(tx, now));
    expect(await h.app((tx) => claimReminder(tx, d!, h.person.jan, now))).not.toBeNull();
    expect(await h.app((tx) => claimReminder(tx, d!, h.person.jan, now))).toBeNull();
  });
});

describe('team news for leads', () => {
  beforeEach(async () => { await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]); });

  async function decided(status: 'approved' | 'declined', note: string | null = null) {
    // pin the db clock
    await pinClock(h.pg, at('2026-11-11T10:00:00Z'));
    const a = (await h.pg.query<{ id: string }>(`insert into approval (tenant_id, workspace_id, kind, status, requested_by, group_id, payload, decision_note)
      values ($1, $2, 'colleague_request', $3, $4, $5, $6, $7) returning id`,
      [h.t1, h.ws, status, h.person.jan, h.group.a, JSON.stringify({ givenName: 'Naledi', familyName: 'Khumalo', email: 'naledi@bidder-a.example' }), note])).rows[0]!.id;
    await pinClock(h.pg, T.at);
    return h.app(async (tx) => {
      const ev = await appendEvent(tx, { action: `team_request.${status}`, workspaceId: h.ws, resourceType: 'approval', resourceId: a, data: { group_id: h.group.a }, occurredAt: min(0) });
      return enqueueTeamNews(tx, { eventId: ev.id, action: `team_request.${status}`, workspaceId: h.ws, leadIds: [h.person.jan], occurredAt: min(0) });
    });
  }

  it('lists decisions for current leads', async () => {
    expect(await decided('approved')).toBe(0);
    await own(h.person.jan, 'requests', { mode: 'digest' });
    expect(await decided('approved')).toBe(1);
    expect(await decided('declined', 'Once 3.4 Tax is open to bidders.')).toBe(1);
    await run(at('2026-11-13T08:00:00Z'));
    const [m] = to(JAN);
    expect(m!.subject).toBe('Project Heron: 2 team updates');
    expect(m!.text).toContain('YOUR TEAM');
    expect(m!.text).toContain('- Naledi Khumalo is invited to Bidder A\n  Your request of Wed 11 Nov was approved');
    expect(m!.text).toContain('- Your request for Naledi Khumalo was declined\n  Reason from the room admin: Once 3.4 Tax is open to bidders.');

    await decided('approved');
    await h.pg.query(`update membership set role = 'member' where person_id = $1`, [h.person.jan]);
    await run(at('2026-11-14T08:00:00Z'));
    expect(to(JAN)).toHaveLength(1);
  });
});

describe('colleague request decisions', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    await h.pg.query(`update membership set role = 'lead' where person_id = $1`, [h.person.jan]);
    app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer, publicUrl: SITE });
  });
  afterEach(async () => { await app.close(); });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, person: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 }, ...(payload !== undefined ? { payload } : {}) });

  it('waits for the summary when chosen', async () => {
    await call('PUT', `/v1/workspaces/${h.ws}/me/notifications`, h.person.jan, { events: { requests: { enabled: true, frequency: 'digest' } } });
    const id = (await call('POST', `/v1/workspaces/${h.ws}/team-requests`, h.person.jan,
      { givenName: 'Peter', familyName: 'Moss', email: 'peter.moss@thornquist-legal.example', company: 'Thornquist Legal', reason: 'Tax' })).json().id;
    outbox = [];
    await call('POST', `/v1/workspaces/${h.ws}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' });
    expect(outbox.map((m) => m.to)).toEqual(['peter.moss@thornquist-legal.example']);
    const told = (await h.pg.query<any>(`select data from event where action = 'team_request.lead_told'`)).rows;
    expect(told[0].data).toMatchObject({ delivery_status: 'in_summary' });
    const token = /\/invite\/(\S+)/.exec(outbox[0]!.text!)![1]!;
    clock = min(30);
    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token, givenName: 'Peter', familyName: 'Moss', company: 'Thornquist Legal' } })).statusCode).toBe(200);
    outbox = [];
    await run(at('2026-11-13T08:00:00Z'));
    const [m] = to(JAN);
    expect(to(JAN)).toHaveLength(1);
    expect(m!.text).toContain('- Peter Moss joined Bidder A\n  Your request of Thu 12 Nov was approved');
    expect(m!.text).not.toContain('is invited to');
  });

  it('tells a lead right away when a colleague joins', async () => {
    const id = (await call('POST', `/v1/workspaces/${h.ws}/team-requests`, h.person.jan,
      { givenName: 'Peter', familyName: 'Moss', email: 'peter.moss@thornquist-legal.example', company: 'Thornquist Legal', reason: 'Tax' })).json().id;
    await call('POST', `/v1/workspaces/${h.ws}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' });
    const token = /\/invite\/(\S+)/.exec(outbox.find((m) => m.to === 'peter.moss@thornquist-legal.example')!.text!)![1]!;
    outbox = [];
    clock = min(30);
    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token, givenName: 'Peter', familyName: 'Moss', company: 'Thornquist Legal' } })).statusCode).toBe(200);
    await run(min(31));
    expect(to(JAN).map((m) => m.subject)).toEqual(['Peter Moss joined Bidder A in Project Heron']);
    expect(to(JAN)[0]!.text).toContain('You get this email because you chose to hear about your requests to add a colleague in Project Heron right away.');
    await run(at('2026-11-13T08:00:00Z'));
    expect(to(JAN)).toHaveLength(1);
  });

  it('respects the lead opt-out', async () => {
    await call('PUT', `/v1/workspaces/${h.ws}/me/notifications`, h.person.jan, { events: { requests: { enabled: false } } });
    const id = (await call('POST', `/v1/workspaces/${h.ws}/team-requests`, h.person.jan,
      { givenName: 'Peter', familyName: 'Moss', email: 'peter.moss@thornquist-legal.example', company: 'Thornquist Legal', reason: 'Tax' })).json().id;
    await call('POST', `/v1/workspaces/${h.ws}/team-requests/${id}/decide`, h.person.anika, { decision: 'approve' });
    const token = /\/invite\/(\S+)/.exec(outbox.find((m) => m.to === 'peter.moss@thornquist-legal.example')!.text!)![1]!;
    clock = min(30);
    expect((await app.inject({ method: 'POST', url: '/v1/public/invitations/accept', payload: { token, givenName: 'Peter', familyName: 'Moss', company: 'Thornquist Legal' } })).statusCode).toBe(200);
    await run(min(31));
    await run(at('2026-11-13T08:00:00Z'));
    expect(to(JAN)).toEqual([]);
  });

  it('sends admins requests at their own frequency', async () => {
    const ask = (email: string, givenName: string) => call('POST', `/v1/workspaces/${h.ws}/team-requests`, h.person.jan,
      { givenName, familyName: 'Moss', email, company: 'Thornquist Legal', reason: 'Tax' });
    outbox = [];
    expect((await ask('peter.moss@thornquist-legal.example', 'Peter')).statusCode).toBe(201);
    expect(to(ANIKA).map((m) => m.subject)).toEqual(['Jan de Vries asks to add a colleague to Bidder A']);
    // daily: 06:00 UTC
    await call('PUT', `/v1/workspaces/${h.ws}/me/notifications`, h.person.anika, { events: { requests: { enabled: true, frequency: 'digest' } } });
    outbox = [];
    expect((await ask('ola.moss@thornquist-legal.example', 'Ola')).statusCode).toBe(201);
    expect(to(ANIKA)).toEqual([]);
    await run(at('2026-11-13T06:00:00Z'));
    expect(to(ANIKA).map((m) => m.subject)).toEqual(['Project Heron: 1 colleague request']);
    expect(to(ANIKA)[0]!.text).toContain('Jan de Vries asks to add Ola Moss to Bidder A');
    await call('PUT', `/v1/workspaces/${h.ws}/me/notifications`, h.person.anika, { events: { requests: { enabled: false } } });
    outbox = [];
    expect((await ask('kim.moss@thornquist-legal.example', 'Kim')).statusCode).toBe(201);
    await run(at('2026-11-14T06:00:00Z'));
    expect(to(ANIKA)).toEqual([]);
  });

  it('drops decided requests from the summary', async () => {
    expect((await call('PUT', `/v1/workspaces/${h.ws}/me/notifications`, h.person.anika, { events: { requests: { enabled: true, frequency: 'digest' } } })).statusCode).toBe(200);
    const id = (await call('POST', `/v1/workspaces/${h.ws}/team-requests`, h.person.jan,
      { givenName: 'Peter', familyName: 'Moss', email: 'peter.moss@thornquist-legal.example', company: 'Thornquist Legal', reason: 'Tax' })).json().id;
    await call('POST', `/v1/workspaces/${h.ws}/team-requests/${id}/decide`, h.person.anika, { decision: 'decline', note: 'Not now.' });
    outbox = [];
    await run(at('2026-11-13T06:00:00Z'));
    expect(to(ANIKA)).toEqual([]);
  });
});

describe('notification settings', () => {
  it('hides New NDA version from observers', async () => {
    const app = await buildApp({ db: h.db, auth: new DevHeaderAuthenticator(), dbRole: 'vdrkit_app', now: () => clock, mailer, publicUrl: SITE });
    const obs = (await h.pg.query<{ id: string }>(`insert into groups (tenant_id, workspace_id, party_id, name, role_template) values ($1, $2, $3, 'Heron management', 'observer') returning id`,
      [h.t1, h.ws, h.party.seller])).rows[0]!.id;
    const liesl = (await h.pg.query<{ id: string }>(`insert into person (tenant_id, name, email) values ($1, 'Liesl van Wyk', 'liesl@drosvelt.example') returning id`, [h.t1])).rows[0]!.id;
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, liesl, obs, T.setup.toISOString()]);
    const keys = async (person: string) => (await app.inject({ method: 'GET', url: `/v1/workspaces/${h.ws}/me/notifications`,
      headers: { 'x-dev-person': person, 'x-dev-tenant': h.t1 } })).json().events.map((e: any) => e.key);
    expect(await keys(liesl)).not.toContain('agreements');
    expect(await keys(h.person.jan)).toContain('agreements');
    expect(await keys(h.person.anika)).toHaveLength(9);
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`, [h.t1, liesl, h.group.a, T.setup.toISOString()]);
    expect(await keys(liesl)).toContain('agreements');
    await app.close();
  });
});
