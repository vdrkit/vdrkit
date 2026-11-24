// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './db.js';
import { appendEvent } from './events.js';
import type { Channel, OutgoingMessage, SendResult } from './notify.js';
import { mailContext, mailReason, recipientGate, type Recipient } from './notify-send.js';

// claim row committed before sending: whoever inserts it sends

export type ReminderKind = '2d' | '2h';
export const REMINDER_OFFSET_MS: Record<ReminderKind, number> = { '2d': 2 * 86_400_000, '2h': 2 * 3_600_000 };

export interface ReminderContent {
  workspace: { id: string; name: string; timeZone: string };
  recipient: Recipient;
  milestone: { id: string; title: string; dueAt: Date };
  kind: ReminderKind;
  forGroups: string[] | 'all';
  now: Date;
}

export type ReminderRenderer = (c: ReminderContent) => OutgoingMessage | Promise<OutgoingMessage>;

export interface DueReminder { milestoneId: string; workspaceId: string; title: string; dueAt: Date; kind: ReminderKind; groupIds: string[] }

// late reminders are skipped, not sent
export const REMINDER_GRACE_MS: Record<ReminderKind, number> = { '2d': 60 * 60_000, '2h': 15 * 60_000 };

export async function dueReminders(tx: SqlClient, now: Date): Promise<DueReminder[]> {
  const rows = (await tx.query<{ id: string; workspace_id: string; title: string; due_at: string; due_set_at: string; visible_to_group_ids: string[] }>(
    `select id, workspace_id, title, due_at, due_set_at, visible_to_group_ids from milestone
      where deleted_at is null and due_at > $1 and due_at - interval '2 days' <= $1 order by due_at`, [now.toISOString()])).rows;
  const out: DueReminder[] = [];
  for (const r of rows) {
    const due = new Date(r.due_at);
    for (const kind of ['2h', '2d'] as const) {
      const moment = due.getTime() - REMINDER_OFFSET_MS[kind];
      if (moment > now.getTime() || now.getTime() - moment > REMINDER_GRACE_MS[kind]) continue;
      if (new Date(r.due_set_at).getTime() > moment) continue;
      out.push({ milestoneId: r.id, workspaceId: r.workspace_id, title: r.title, dueAt: due, kind, groupIds: r.visible_to_group_ids });
      break;
    }
  }
  return out;
}

export async function reminderRecipients(tx: SqlClient, d: DueReminder, now: Date): Promise<string[]> {
  return (await tx.query<{ person_id: string }>(
    `select distinct m.person_id from membership m join groups g on g.id = m.group_id join person p on p.id = m.person_id
      where g.workspace_id = $1 and m.status = 'active' and m.valid_from <= $2 and $2 < m.valid_to and m.superseded_at = 'infinity'
        and g.valid_from <= $2 and $2 < g.valid_to and p.erased_at is null and p.disabled_at is null
        and (cardinality($3::uuid[]) = 0 or g.id = any($3::uuid[]) or g.parent_group_id = any($3::uuid[])
             or exists (select 1 from party pa where pa.id = g.party_id and pa.kind = 'seller') or is_workspace_admin(m.person_id, $1, $2))
        and not exists (select 1 from deadline_reminder r where r.milestone_id = $4 and r.person_id = m.person_id and r.kind = $5 and r.due_at = $6)
      order by m.person_id`,
    [d.workspaceId, now.toISOString(), d.groupIds, d.milestoneId, d.kind, d.dueAt.toISOString()])).rows.map((r) => r.person_id);
}

export interface ClaimedReminder { reminderId: string; content: ReminderContent; personId: string; workspaceId: string; milestoneId: string; kind: ReminderKind }

export async function claimReminder(tx: SqlClient, d: DueReminder, personId: string, now: Date): Promise<ClaimedReminder | null> {
  // may have moved since dueReminders
  const m = (await tx.query<{ title: string; due_at: string; deleted: boolean; groups: string[] }>(
    `select title, due_at, deleted_at is not null as deleted, visible_to_group_ids as groups from milestone where id = $1`,
    [d.milestoneId])).rows[0];
  if (!m || m.deleted || new Date(m.due_at).getTime() !== d.dueAt.getTime()) return null;
  const gate = await recipientGate(tx, d.workspaceId, personId, 'deadlines', now);
  if (gate.reason) return null;
  const inGroups = (await tx.query<{ ok: boolean }>(
    `select cardinality($2::uuid[]) = 0 or $3::boolean
         or exists (select 1 from groups g join party pa on pa.id = g.party_id where g.id = any($1::uuid[])
                     and (g.id = any($2::uuid[]) or g.parent_group_id = any($2::uuid[]) or (pa.kind = 'seller' and g.role_template <> 'observer'))) as ok`,
    [gate.groupIds, m.groups, gate.isAdmin])).rows[0]?.ok;
  if (!inGroups) return null;
  const ins = (await tx.query<{ id: string }>(
    `insert into deadline_reminder (tenant_id, workspace_id, milestone_id, person_id, kind, due_at, claimed_at)
     values (current_tenant_id(), $1, $2, $3, $4, $5, $6) on conflict (milestone_id, person_id, kind, due_at) do nothing returning id`,
    [d.workspaceId, d.milestoneId, personId, d.kind, d.dueAt.toISOString(), now.toISOString()])).rows[0];
  if (!ins) return null;

  const w = (await tx.query<{ name: string; time_zone: string }>(`select name, time_zone from workspace where id = $1`, [d.workspaceId])).rows[0]!;
  const p = (await tx.query<{ email: string; given_name: string | null; time_zone: string }>(
    `select email, given_name, time_zone from person where id = $1`, [personId])).rows[0]!;
  const mine = (await tx.query<{ id: string; name: string; seller: boolean }>(
    `select g.id, g.name, pa.kind = 'seller' as seller from groups g join party pa on pa.id = g.party_id
      where g.id = any($1::uuid[]) and g.role_template <> 'admin' order by g.name`, [gate.groupIds])).rows;
  const sellerSide = gate.isAdmin || mine.some((g) => g.seller);
  let forGroups: string[] | 'all';
  if (sellerSide && m.groups.length === 0) {
    forGroups = 'all';
  } else if (sellerSide) {
    const { rows } = await tx.query<{ name: string }>(
      `select name from groups where id = any($1::uuid[]) order by name`, [m.groups]);
    forGroups = rows.map((g) => g.name);
  } else {
    // never reveal which other teams a date is for
    const { rows } = await tx.query<{ name: string }>(
      `select g.name from groups g where g.id = any($1::uuid[])
          and (cardinality($2::uuid[]) = 0 or g.id = any($2::uuid[]) or g.parent_group_id = any($2::uuid[])) order by g.name`,
      [gate.groupIds, m.groups]);
    forGroups = rows.map((g) => g.name);
  }
  const recipient: Recipient = {
    personId, email: p.email, givenName: p.given_name?.trim() || null, timeZone: p.time_zone || 'UTC', isAdmin: gate.isAdmin,
    groupNames: gate.isAdmin ? [] : mine.map((g) => g.name),
  };
  return {
    reminderId: ins.id, personId, workspaceId: d.workspaceId, milestoneId: d.milestoneId, kind: d.kind,
    content: { workspace: { id: d.workspaceId, name: w.name, timeZone: w.time_zone || 'UTC' }, recipient,
      milestone: { id: d.milestoneId, title: m.title, dueAt: d.dueAt }, kind: d.kind, forGroups, now },
  };
}

export async function recordReminder(tx: SqlClient, c: ClaimedReminder, channel: string,
  result: { status: 'accepted' | 'failed'; providerMessageId?: string; error?: string }, now: Date,
  message?: { to: string; subject: string }): Promise<SendResult['status']> {
  const status = result.status === 'accepted' ? 'sent' : 'failed';
  await tx.query(
    `update deadline_reminder set status = $2, sent_at = $3, channel = $4, delivery_status = $5, provider_message_id = $6 where id = $1`,
    [c.reminderId, status, now.toISOString(), channel, result.status, result.providerMessageId ?? null]);
  await appendEvent(tx, {
    action: status === 'sent' ? 'notification.sent' : 'notification.failed',
    workspaceId: c.workspaceId, resourceType: 'deadline_reminder', resourceId: c.reminderId,
    data: {
      milestone_id: c.milestoneId, recipient_person_id: c.personId, channel, category: 'deadlines', mode: 'reminder', reminder: c.kind, mandatory: false,
      node_ids: [], items_dropped: 0, delivery_status: result.status, provider_message_id: result.providerMessageId ?? null,
      mail_type: 'deadline_reminder',
      ...(status === 'sent' ? {} : { error: mailReason(result.error, message?.to) }),
    },
    occurredAt: now,
    ...(message ? { context: mailContext(c.personId, message)! } : {}),
  });
  return status;
}

export function reminderLines(c: ReminderContent): OutgoingMessage {
  const when = c.kind === '2d' ? '2 days' : '2 hours';
  return { personId: c.recipient.personId, to: c.recipient.email, subject: `${c.workspace.name}: ${c.milestone.title} due in ${when}`,
    lines: [`${c.milestone.title}: due ${c.milestone.dueAt.toISOString()}`] };
}

// run() must commit per call
export async function sendDueReminders(run: <T>(fn: (tx: SqlClient) => Promise<T>) => Promise<T>, channel: Channel, now: Date,
  render: ReminderRenderer = reminderLines): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const due = await run((tx) => dueReminders(tx, now));
  for (const d of due) {
    const people = await run((tx) => reminderRecipients(tx, d, now));
    for (const personId of people) {
      const claimed = await run((tx) => claimReminder(tx, d, personId, now));
      if (!claimed) continue;
      const rendering = Promise.resolve(render(claimed.content));
      let sent: OutgoingMessage | undefined;
      let result: Awaited<ReturnType<Channel['send']>>;
      try {
        sent = await rendering;
        result = await channel.send(sent);
      } catch (err) {
        result = { status: 'failed', error: err instanceof Error ? err.message.slice(0, 200) : 'failed' };
      }
      const status = await run((tx) => recordReminder(tx, claimed, channel.name, result, now, sent));
      if (status === 'sent') out.sent++;
      else out.failed++;
    }
  }
  return out;
}
