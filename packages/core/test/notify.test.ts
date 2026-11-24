// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendEvent, dueNotificationIds, enqueueForEvent, Level, sendNotification, setGrant, verifyChain,
  type Channel, type OutgoingMessage, type SqlClient,
} from '../src/index.js';
import { heron, pinClock, T, type Heron } from './fixture.js';

let h: Heron;
let outbox: OutgoingMessage[];
const email: Channel = { name: 'email', send: async (m) => { outbox.push(m); return { status: 'accepted', providerMessageId: `pm-${outbox.length}` }; } };

const min = (n: number) => new Date(T.at.getTime() + n * 60_000);

beforeEach(async () => {
  h = await heron();
  outbox = [];
  await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View, now: T.grantsSet }));
  await h.pg.query(`update person set time_zone = 'Europe/London' where id in ($1, $2)`, [h.person.jan, h.person.lars]);
});
afterEach(async () => { await h.pg.close(); });

async function publish(tx: SqlClient, nodeId: string, at: Date) {
  const ev = await appendEvent(tx, { action: 'document.published', workspaceId: h.ws, resourceType: 'node', resourceId: nodeId, occurredAt: at });
  return enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: nodeId, occurredAt: at, actorPersonId: h.person.anika });
}
async function dueFor(personId: string, at: Date) {
  const ids = await h.app((tx) => dueNotificationIds(tx, at));
  const r = await h.pg.query<{ id: string }>(`select id from notification where person_id = $1 and id = any($2::uuid[])`, [personId, ids]);
  return r.rows.map((x) => x.id);
}
async function notificationsFor(personId: string) {
  return (await h.pg.query<any>(`select n.*, (select count(*)::int from notification_item i where i.notification_id = n.id) as items
    from notification n where person_id = $1 order by created_at`, [personId])).rows;
}

describe('queueing', () => {
  it('notifies everyone who can see the document except the actor', async () => {
    await h.app((tx) => publish(tx, h.node.aud1, T.at));
    expect((await notificationsFor(h.person.jan)).length).toBe(1);
    expect((await notificationsFor(h.person.lars)).length).toBe(0);
    expect((await notificationsFor(h.person.mei)).length).toBe(0);
    expect((await notificationsFor(h.person.anika)).length).toBe(0);
  });

  it('bundles a burst of uploads', async () => {
    await h.app(async (tx) => {
      await publish(tx, h.node.aud1, min(0));
      await publish(tx, h.node.tax1, min(12));
      await publish(tx, h.node.aud, min(25));
    });
    const [n] = await notificationsFor(h.person.jan);
    expect(n.items).toBe(3);
    expect(new Date(n.due_at)).toEqual(min(35));
  });

  it('respects a category switched off unless mandatory', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, enabled)
      values ($1, $2, 'user', $3, 'documents', false)`, [h.t1, h.ws, h.person.jan]);
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    expect((await notificationsFor(h.person.jan)).length).toBe(0);

    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, category, mode, mandatory)
      values ($1, $2, 'workspace', 'documents', 'immediate', true)`, [h.t1, h.ws]);
    await h.app((tx) => publish(tx, h.node.tax1, min(1)));
    const [n] = await notificationsFor(h.person.jan);
    expect([n.mode, n.mandatory]).toEqual(['immediate', true]);
  });

  it('sends digests in the recipient time zone', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, group_id, category, mode, digest_times)
      values ($1, $2, 'group', $3, 'documents', 'digest', '{08:00,17:00}')`, [h.t1, h.ws, h.group.a]);
    await h.app((tx) => publish(tx, h.node.aud1, new Date('2026-11-12T14:30:00Z')));
    const [n] = await notificationsFor(h.person.jan);
    expect(new Date(n.due_at)).toEqual(new Date('2026-11-12T17:00:00Z'));
  });
});

describe('releases', () => {
  async function release(nodeId: string, at: Date, quiet?: boolean) {
    return h.app(async (tx) => {
      const ev = await appendEvent(tx, { action: 'document.published', workspaceId: h.ws, resourceType: 'node', resourceId: nodeId, occurredAt: at });
      return enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: nodeId, occurredAt: at, actorPersonId: h.person.anika,
        ...(quiet === undefined ? {} : { quiet }) });
    });
  }

  it('follows personal settings', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, mode)
      values ($1, $2, 'user', $3, 'documents', 'digest')`, [h.t1, h.ws, h.person.jan]);
    await release(h.node.aud1, new Date('2026-11-12T09:30:00Z'), false);
    const [jan] = await notificationsFor(h.person.jan);
    expect([jan.mode, new Date(jan.due_at)]).toEqual(['digest', new Date('2026-11-13T08:00:00Z')]);
    const [maria] = await notificationsFor(h.person.maria);
    expect(maria.mode).toBe('bundled');
  });

  it('emails nobody about a quiet release', async () => {
    expect(await release(h.node.aud1, min(0), true)).toBe(0);
    expect(await notificationsFor(h.person.jan)).toHaveLength(0);
    expect(await notificationsFor(h.person.maria)).toHaveLength(0);
  });

  it('sends mandatory emails for quiet releases, except to admins', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, category, mode, mandatory)
      values ($1, $2, 'workspace', 'documents', 'digest', true)`, [h.t1, h.ws]);
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, mode)
      values ($1, $2, 'user', $3, 'documents', 'immediate')`, [h.t1, h.ws, h.person.jan]);
    await release(h.node.tax1, min(1), true);
    expect((await notificationsFor(h.person.jan)).map((n: any) => [n.mode, n.mandatory])).toEqual([['immediate', true]]);
  });

  it('skips bidders who switched the event off', async () => {
    await h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, enabled)
      values ($1, $2, 'user', $3, 'documents', false)`, [h.t1, h.ws, h.person.jan]);
    await release(h.node.aud1, min(0));
    expect(await notificationsFor(h.person.jan)).toHaveLength(0);
  });
});

describe('sending', () => {
  it('sends when due and audits it', async () => {
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    expect(await dueFor(h.person.jan, min(5))).toEqual([]);
    const [id] = await dueFor(h.person.jan, min(10));
    const res = await h.app((tx) => sendNotification(tx, id!, email, min(10)));
    expect(res).toEqual({ status: 'sent', itemsSent: 1, itemsDropped: 0 });
    expect(outbox[0]).toMatchObject({ to: 'jan@bidder-a.example', subject: 'Project Heron: 1 new document', lines: ['3.2.1 Audited financial statements FY2025.pdf'] });

    const ev = (await h.pg.query<any>(`select data from event where action = 'notification.sent' and data->>'recipient_person_id' = $1`, [h.person.jan])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ recipient_person_id: h.person.jan, channel: 'email', delivery_status: 'accepted', node_ids: [h.node.aud1], mandatory: false });
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toMatchObject({ firstBroken: null });
  });

  it('keeps personal data out of the event chain', async () => {
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    const [id] = await dueFor(h.person.jan, min(10));
    await h.app((tx) => sendNotification(tx, id!, email, min(10)));
    const sent = (await h.pg.query<any>(
      `select e.data, c.personal, c.subject_person_id from event e join event_context c on c.event_id = e.id
        where e.action = 'notification.sent' and e.data->>'recipient_person_id' = $1`, [h.person.jan])).rows[0];
    expect(sent.data).toMatchObject({ mail_type: 'notification', category: 'documents', provider_message_id: 'pm-1', node_ids: [h.node.aud1] });
    expect(JSON.stringify(sent.data)).not.toContain('jan@bidder-a.example');
    expect(sent.personal).toEqual({ to: 'jan@bidder-a.example', subject: 'Project Heron: 1 new document' });
    expect(sent.subject_person_id).toBe(h.person.jan);

    const refusing: Channel = { name: 'email', send: async (m) => ({ status: 'failed', error: `550 5.1.1 <${m.to.toUpperCase()}>: Recipient address rejected` }) };
    await h.app((tx) => publish(tx, h.node.tax1, min(20)));
    const [next] = await dueFor(h.person.jan, min(30));
    await h.app((tx) => sendNotification(tx, next!, refusing, min(30)));
    const failed = (await h.pg.query<any>(`select data from event where action = 'notification.failed' and data->>'recipient_person_id' = $1`, [h.person.jan])).rows[0];
    expect(failed.data.error).toBe('550 5.1.1 <[recipient]>: Recipient address rejected');

    await h.pg.query(`update person set erased_at = now() where id = $1`, [h.person.jan]);
    expect((await h.pg.query<any>(`select count(*)::int as n from event_context where subject_person_id = $1 and personal is not null`, [h.person.jan])).rows[0].n).toBe(0);
    expect(await h.app((tx) => verifyChain(tx, h.ws))).toMatchObject({ firstBroken: null });
  });

  it('drops items the recipient can no longer see', async () => {
    await h.app(async (tx) => {
      await publish(tx, h.node.aud1, min(0));
      await publish(tx, h.node.tax1, min(1));
    });
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.tax, subject: { groupId: h.group.a }, level: Level.None, now: min(5) }));
    const [id] = await dueFor(h.person.jan, min(11));
    const res = await h.app((tx) => sendNotification(tx, id!, email, min(11)));
    expect(res).toEqual({ status: 'sent', itemsSent: 1, itemsDropped: 1 });
    expect(outbox[0]!.lines).toEqual(['3.2.1 Audited financial statements FY2025.pdf']);
  });

  it('should not email disabled accounts', async () => {
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    await h.pg.query(`update person set disabled_at = now() where id = $1`, [h.person.jan]);
    await h.app((tx) => publish(tx, h.node.tax1, min(1)));
    const [n] = await notificationsFor(h.person.jan);
    expect(n.items).toBe(1);
    const [id] = await dueFor(h.person.jan, min(11));
    expect(await h.app((tx) => sendNotification(tx, id!, email, min(11)))).toEqual({ status: 'dropped', itemsSent: 0, itemsDropped: 1 });
    expect(outbox).toEqual([]);
    const ev = (await h.pg.query<any>(`select data from event where action = 'notification.dropped' and data->>'recipient_person_id' = $1`, [h.person.jan])).rows;
    expect(ev[0].data).toMatchObject({ reason: 'recipient_disabled', items_dropped: 1 });
    expect((await h.pg.query<any>(`select dropped_reason from notification_item where notification_id = $1`, [id])).rows).toEqual([{ dropped_reason: 'recipient_disabled' }]);
  });

  it('drops the email when no items remain', async () => {
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    await h.app((tx) => setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.None, now: min(5) }));
    const [id] = await dueFor(h.person.jan, min(10));
    expect(await h.app((tx) => sendNotification(tx, id!, email, min(10)))).toEqual({ status: 'dropped', itemsSent: 0, itemsDropped: 1 });
    expect(outbox).toEqual([]);
    expect((await h.pg.query(`select 1 from event where action = 'notification.dropped' and data->>'recipient_person_id' = $1`, [h.person.jan])).rows).toHaveLength(1);
  });

  it('names documents by index and title', async () => {
    await h.app(async (tx) => {
      await publish(tx, h.node.tax1, min(0));
      await publish(tx, h.node.aud1, min(1));
    });
    const [id] = await dueFor(h.person.jan, min(11));
    await h.app((tx) => sendNotification(tx, id!, email, min(11)));
    expect(outbox[0]!.subject).toBe('Project Heron: 2 new documents');
    expect(outbox[0]!.lines).toEqual(['3.2.1 Audited financial statements FY2025.pdf', '3.4.6 Tax clearance certificate 2026.pdf']);
  });

  it('never names folders', async () => {
    await h.app(async (tx) => {
      await setGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.None, now: min(-30) });
      await setGrant(tx, { workspaceId: h.ws, nodeId: h.node.aud, subject: { groupId: h.group.a }, level: Level.View, now: min(-30) });
    });
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    const [id] = await dueFor(h.person.jan, min(10));
    await h.app((tx) => sendNotification(tx, id!, email, min(10)));
    const text = [outbox[0]!.subject, ...outbox[0]!.lines].join(' ');
    expect(outbox[0]!.lines).toEqual(['3.2.1 Audited financial statements FY2025.pdf']);
    expect(text).not.toMatch(/Finance|Audited financials/);
  });

  it('ignores hide_names', async () => {
    await h.pg.query(`update workspace set metadata = '{"hide_names_in_email": true}' where id = $1`, [h.ws]);
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    const [id] = await dueFor(h.person.jan, min(10));
    await h.app((tx) => sendNotification(tx, id!, email, min(10)));
    expect(outbox[0]!.lines).toEqual(['3.2.1 Audited financial statements FY2025.pdf']);
  });

  it('logs failed deliveries', async () => {
    const broken: Channel = { name: 'email', send: async () => ({ status: 'failed', error: 'SMTP 550' }) };
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    const [id] = await dueFor(h.person.jan, min(10));
    expect((await h.app((tx) => sendNotification(tx, id!, broken, min(10)))).status).toBe('failed');
    expect((await h.pg.query(`select 1 from event where action = 'notification.failed'`)).rows).toHaveLength(1);
  });
});

describe('per-room settings', () => {
  const userRow = (personId: string, category: string, enabled: boolean | null, mode: string | null = null) =>
    h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, enabled, mode)
      values ($1, $2, 'user', $3, $4, $5, $6)`, [h.t1, h.ws, personId, category, enabled, mode]);
  const roomRow = (category: string, mode: string, mandatory: boolean, enabled = true) =>
    h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, category, mode, mandatory, enabled)
      values ($1, $2, 'workspace', $3, $4, $5, $6)`, [h.t1, h.ws, category, mode, mandatory, enabled]);

  it('uses the room bundle timings', async () => {
    await h.pg.query(`insert into notification_room_setting (tenant_id, workspace_id, bundle_quiet_minutes, bundle_max_minutes)
      values ($1, $2, 5, 20)`, [h.t1, h.ws]);
    await h.app(async (tx) => {
      await publish(tx, h.node.aud1, min(0));
      await publish(tx, h.node.tax1, min(4));
    });
    expect(new Date((await notificationsFor(h.person.jan))[0].due_at)).toEqual(min(9));
    await h.app((tx) => publish(tx, h.node.aud, min(18)));
    expect(new Date((await notificationsFor(h.person.jan))[0].due_at)).toEqual(min(20));
  });

  it('uses room digest times in the person time zone', async () => {
    await h.pg.query(`insert into notification_room_setting (tenant_id, workspace_id, summary_times) values ($1, $2, '{07:30,16:00}')`, [h.t1, h.ws]);
    await userRow(h.person.jan, 'documents', null, 'digest');
    await h.app((tx) => publish(tx, h.node.aud1, new Date('2026-11-12T10:00:00Z')));
    expect(new Date((await notificationsFor(h.person.jan))[0].due_at)).toEqual(new Date('2026-11-12T16:00:00Z'));
  });

  it('queues new versions as a separate category', async () => {
    await userRow(h.person.jan, 'versions', false);
    const ev = await h.app((tx) => appendEvent(tx, { action: 'document.version_published', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.aud1 }));
    await h.app((tx) => enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: h.node.aud1, occurredAt: min(0), actorPersonId: h.person.anika }));
    await h.app((tx) => publish(tx, h.node.tax1, min(1)));
    expect((await notificationsFor(h.person.jan)).map((n) => n.category)).toEqual(['documents']);
  });

  it('lets admins switch off mandatory events', async () => {
    await roomRow('documents', 'immediate', true);
    await userRow(h.person.jan, 'documents', false);
    await userRow(h.person.anika, 'documents', false);
    await h.app((tx) => publish(tx, h.node.tax1, min(0)));
    const ev = await h.app((tx) => appendEvent(tx, { action: 'document.published', workspaceId: h.ws, resourceType: 'node', resourceId: h.node.aud1 }));
    await h.app((tx) => enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: h.node.aud1, occurredAt: min(1), actorPersonId: h.person.maria }));
    expect((await notificationsFor(h.person.jan)).length).toBe(1);
    expect((await notificationsFor(h.person.anika)).length).toBe(0);
  });

  it('drops queued email after the event is switched off', async () => {
    await h.app((tx) => publish(tx, h.node.aud1, min(0)));
    await userRow(h.person.jan, 'documents', false);
    const [id] = await dueFor(h.person.jan, min(10));
    expect(await h.app((tx) => sendNotification(tx, id!, email, min(10)))).toEqual({ status: 'dropped', itemsSent: 0, itemsDropped: 1 });
    expect(outbox).toEqual([]);
    const ev = (await h.pg.query<any>(`select data from event where action = 'notification.dropped'`)).rows;
    expect(ev[0].data).toMatchObject({ recipient_person_id: h.person.jan, reason: 'switched_off' });
  });

  it('drops email for someone who left the room', async () => {
    const ev = await h.app((tx) => appendEvent(tx, { action: 'milestone.changed', workspaceId: h.ws, resourceType: 'milestone' }));
    await h.app((tx) => enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: null, occurredAt: min(0), actorPersonId: h.person.anika }));
    expect((await notificationsFor(h.person.mei)).length).toBe(1);
    await h.pg.query(`update membership set valid_to = $2 where person_id = $1`, [h.person.mei, min(1).toISOString()]);
    const [id] = await dueFor(h.person.mei, min(5));
    expect((await h.app((tx) => sendNotification(tx, id!, email, min(5)))).status).toBe('dropped');
    expect(outbox).toEqual([]);
    expect((await h.pg.query<any>(`select data from event where action = 'notification.dropped'`)).rows[0].data.reason).toBe('no_membership');
  });

  it('sends bidders nothing while the room is preparing', async () => {
    const ev = await h.app((tx) => appendEvent(tx, { action: 'milestone.changed', workspaceId: h.ws, resourceType: 'milestone' }));
    await h.app((tx) => enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: null, occurredAt: min(0), actorPersonId: h.person.anika }));
    expect((await notificationsFor(h.person.mei)).length).toBe(1);
    await h.app((tx) => tx.query(`update workspace set state = 'preparing' where id = $1`, [h.ws]));
    const [id] = await dueFor(h.person.mei, min(5));
    expect((await h.app((tx) => sendNotification(tx, id!, email, min(5)))).status).toBe('dropped');
    expect(outbox).toEqual([]);
    expect((await h.pg.query<any>(`select data from event where action = 'notification.dropped'`)).rows[0].data.reason).toBe('room_not_open');
  });

  it('holds Timeline emails until the NDA is accepted', async () => {
    await pinClock(h.pg, min(0));
    await h.pg.query(`insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at)
      values ($1, $2, 2, 'Confidentiality undertaking, version 2', $3)`, [h.t1, h.nda.agreement, min(0).toISOString()]);
    const ms = (await h.pg.query<{ id: string }>(`insert into milestone (tenant_id, workspace_id, title, due_at)
      values ($1, $2, 'Management presentation, Bidder B', '2026-12-08T08:00:00Z') returning id`, [h.t1, h.ws])).rows[0]!.id;
    const queue = async (action: string, resourceType: string, resourceId: string) => {
      const ev = await h.app((tx) => appendEvent(tx, { action, workspaceId: h.ws, resourceType, resourceId, occurredAt: min(1) }));
      await h.app((tx) => enqueueForEvent(tx, { id: ev.id, action, workspaceId: h.ws, resourceId: null, occurredAt: min(1), actorPersonId: h.person.anika }));
    };
    await queue('milestone.changed', 'milestone', ms);
    await queue('agreement.version_published', 'agreement', h.nda.agreement);
    await pinClock(h.pg, min(5));
    const sent: Record<string, string> = {};
    for (const id of await dueFor(h.person.mei, min(5))) {
      const cat = (await h.pg.query<{ category: string }>(`select category from notification where id = $1`, [id])).rows[0]!.category;
      sent[cat] = (await h.app((tx) => sendNotification(tx, id, email, min(5)))).status;
    }
    expect(sent).toEqual({ deadlines: 'dropped', agreements: 'sent' });
    expect(outbox.map((m) => m.subject)).toEqual([expect.stringMatching(/a new NDA to accept/)]);
    expect(outbox.flatMap((m) => m.lines).join(' ')).not.toMatch(/Management presentation/);
    const dropped = (await h.pg.query<any>(`select data from event where action = 'notification.dropped'`)).rows;
    expect(dropped.map((r) => r.data.reason)).toEqual(['nda_not_accepted']);

    await h.pg.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at)
      select $1, id, $2, $3 from agreement_version where agreement_id = $4 and version_no = 2`, [h.t1, h.person.mei, min(6).toISOString(), h.nda.agreement]);
    await pinClock(h.pg, min(7));
    const ev = await h.app((tx) => appendEvent(tx, { action: 'milestone.changed', workspaceId: h.ws, resourceType: 'milestone', resourceId: ms, occurredAt: min(7) }));
    await h.app((tx) => enqueueForEvent(tx, { id: ev.id, action: ev.action, workspaceId: h.ws, resourceId: null, occurredAt: min(7), actorPersonId: h.person.anika }));
    await pinClock(h.pg, min(10));
    const [again] = await dueFor(h.person.mei, min(10));
    expect((await h.app((tx) => sendNotification(tx, again!, email, min(10)))).status).toBe('sent');
  });

  it('rejects invalid stored policies', async () => {
    await expect(h.pg.query(`insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, mode)
      values ($1, $2, 'user', $3, 'documents', 'off')`, [h.t1, h.ws, h.person.jan])).rejects.toThrow(/notification_policy_mode_is_frequency/);
    await expect(roomRow('documents', 'bundled', true, false)).rejects.toThrow(/notification_policy_mandatory_is_on/);
  });

  it('keeps room timing per tenant', async () => {
    await expect(h.app((tx) => tx.query(`insert into notification_room_setting (tenant_id, workspace_id) values ($1, $2)`, [h.t2, h.ws])))
      .rejects.toThrow(/row-level security/);
  });
});
