// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './db.js';
import { effectiveAccess, versionAccess, canSeeVersion, present } from './permissions.js';
import { DEFAULT_DIGEST, dueAt, resolvePolicy, type Mode, type PolicySetting, type ResolvedPolicy } from './notify-schedule.js';
import { CATEGORY_OF, notificationEvent } from './notify-events.js';


export interface SourceEvent {
  id: string;
  action: string;
  workspaceId: string;
  resourceId: string | null;
  occurredAt: Date;
  actorPersonId?: string | null;
  /** plus subgroups; admins and seller side always included */
  audienceGroupIds?: string[];
  versionId?: string | null;
  quiet?: boolean;
  urgent?: boolean;
}

export interface RoomTiming {
  bundleQuietMinutes: number;
  bundleMaxMinutes: number;
  summaryTimes: string[];
}
export const DEFAULT_ROOM_TIMING: RoomTiming = { bundleQuietMinutes: 10, bundleMaxMinutes: 60, summaryTimes: DEFAULT_DIGEST };

export async function roomTiming(tx: SqlClient, workspaceId: string): Promise<RoomTiming> {
  const r = (await tx.query<{ q: number; m: number; t: string[] }>(
    `select bundle_quiet_minutes as q, bundle_max_minutes as m, summary_times as t from notification_room_setting where workspace_id = $1`,
    [workspaceId])).rows[0];
  if (!r) return { ...DEFAULT_ROOM_TIMING };
  return { bundleQuietMinutes: Number(r.q), bundleMaxMinutes: Number(r.m), summaryTimes: r.t };
}

export interface PolicyRow {
  scope: string; category: string; group_id: string | null; person_id: string | null; enabled: boolean | null;
  mode: Mode | null; digest_times: string[] | null; allowed_modes: Mode[] | null; mandatory: boolean;
}

export async function loadPolicies(tx: SqlClient, workspaceId: string, category?: string): Promise<PolicyRow[]> {
  return (await tx.query<PolicyRow>(
    `select scope, category, group_id, person_id, enabled, mode, digest_times, allowed_modes, mandatory
       from notification_policy where workspace_id = $1 and ($2::text is null or category = $2)`, [workspaceId, category ?? null])).rows;
}

function setting(r: PolicyRow | undefined): PolicySetting | undefined {
  if (!r) return undefined;
  return {
    enabled: r.enabled ?? undefined,
    mode: r.mode ?? undefined,
    digestTimes: r.digest_times ?? undefined,
    allowedModes: r.allowed_modes ?? undefined,
  };
}

export function roomDefault(policies: PolicyRow[], category: string, timing: RoomTiming): PolicySetting & { mode: Mode; mandatory: boolean } {
  const ws = policies.find((p) => p.scope === 'workspace' && p.category === category);
  const fallback = notificationEvent(category)?.defaultFrequency ?? 'bundled';
  return {
    enabled: ws?.enabled ?? true,
    mode: ws?.mode ?? fallback,
    digestTimes: ws?.digest_times ?? timing.summaryTimes,
    allowedModes: ws?.allowed_modes ?? undefined,
    mandatory: ws?.mandatory ?? false,
  };
}

export function resolveForPerson(
  policies: PolicyRow[], category: string, person: { personId: string; groupIds: string[]; isAdmin: boolean }, timing: RoomTiming,
): ResolvedPolicy {
  const ws = roomDefault(policies, category, timing);
  const groupRow = policies.find((p) => p.scope === 'group' && p.category === category && p.group_id && person.groupIds.includes(p.group_id));
  const userRow = policies.find((p) => p.scope === 'user' && p.category === category && p.person_id === person.personId);
  return resolvePolicy({ workspace: ws, group: setting(groupRow), user: setting(userRow) }, ws.mandatory, { mandatoryExempt: person.isAdmin });
}

export async function enqueueForEvent(tx: SqlClient, e: SourceEvent): Promise<number> {
  const category = CATEGORY_OF[e.action];
  if (!category) return 0;

  const policies = await loadPolicies(tx, e.workspaceId, category);
  const timing = await roomTiming(tx, e.workspaceId);

  const people = await tx.query<{ person_id: string; time_zone: string; group_ids: string[]; is_admin: boolean; seller: boolean }>(
    `select m.person_id, p.time_zone, array_agg(m.group_id order by g.name) as group_ids, is_workspace_admin(m.person_id, $1, $2) as is_admin,
            bool_or(pa.kind = 'seller') as seller
       from membership m join groups g on g.id = m.group_id join person p on p.id = m.person_id join party pa on pa.id = g.party_id
      where g.workspace_id = $1 and m.status = 'active' and p.erased_at is null and p.disabled_at is null
        and m.valid_from <= $2 and $2 < m.valid_to and m.superseded_at = 'infinity'
        -- see-as stand-ins
        and p.email not like '%@preview.invalid' and not exists (select 1 from see_as_preview s where s.person_id = p.id)
      group by m.person_id, p.time_zone
     having (cardinality($3::uuid[]) = 0
         or bool_or(g.id = any($3::uuid[]) or g.parent_group_id = any($3::uuid[]))
         or bool_or(pa.kind = 'seller' and g.role_template <> 'observer')
         or is_workspace_admin(m.person_id, $1, $2))
        and bool_or(g.role_template <> 'observer')`,
    [e.workspaceId, e.occurredAt.toISOString(), e.audienceGroupIds ?? []]);

  let queued = 0;
  for (const person of people.rows) {
    if (person.person_id === e.actorPersonId) continue;
    if (e.action === 'agreement.version_published' && (person.is_admin || person.seller)) continue;
    if (e.resourceId) {
      const access = await effectiveAccess(tx, person.person_id, e.resourceId, present(e.occurredAt));
      if (access.level < 20) continue;
      if (!(await versionVisible(tx, person.person_id, e.resourceId, e.versionId ?? null, e.occurredAt))) continue;
    }
    const resolved = resolveForPerson(policies, category, { personId: person.person_id, groupIds: person.group_ids, isAdmin: person.is_admin }, timing);
    if (resolved.mode === 'off') continue;
    if (e.quiet && !resolved.locked) continue;
    let policy = resolved;
    if (e.urgent) policy = { ...policy, mode: 'immediate' };

    await addToQueue(tx, { personId: person.person_id, workspaceId: e.workspaceId, category, mode: policy.mode, mandatory: policy.mandatory,
      timeZone: person.time_zone, digestTimes: policy.digestTimes, timing },
      { eventId: e.id, action: e.action, nodeId: e.resourceId, versionId: e.versionId ?? null, occurredAt: e.occurredAt });
    queued++;
  }
  return queued;
}

async function addToQueue(tx: SqlClient,
  n: { personId: string; workspaceId: string; category: string; mode: Mode; mandatory: boolean; timeZone: string; digestTimes: string[]; timing: RoomTiming },
  item: { eventId: string; action: string; nodeId: string | null; versionId: string | null; occurredAt: Date }): Promise<void> {
  const open = await tx.query<{ id: string; first_event_at: string }>(
    `select id, first_event_at from notification
      where person_id = $1 and workspace_id = $2 and category = $3 and mode = $4 and status = 'open' for update`,
    [n.personId, n.workspaceId, n.category, n.mode]);
  let id = open.rows[0]?.id;
  const first = open.rows[0] ? new Date(open.rows[0].first_event_at) : item.occurredAt;
  const due = dueAt(n.mode, first, item.occurredAt, {
    timeZone: n.timeZone, digestTimes: n.digestTimes,
    bundle: { quietMinutes: n.timing.bundleQuietMinutes, maxMinutes: n.timing.bundleMaxMinutes },
  })!;
  if (id) {
    await tx.query(`update notification set last_event_at = $2, due_at = $3 where id = $1`, [id, item.occurredAt.toISOString(), due.toISOString()]);
  } else {
    const ins = await tx.query<{ id: string }>(
      `insert into notification (tenant_id, workspace_id, person_id, category, mode, mandatory, first_event_at, last_event_at, due_at)
       values (current_tenant_id(), $1, $2, $3, $4, $5, $6, $6, $7) returning id`,
      [n.workspaceId, n.personId, n.category, n.mode, n.mandatory, item.occurredAt.toISOString(), due.toISOString()]);
    id = ins.rows[0]!.id;
  }
  await tx.query(
    `insert into notification_item (tenant_id, notification_id, event_id, action, node_id, occurred_at, version_id)
     values (current_tenant_id(), $1, $2, $3, $4, $5, $6)`, [id, item.eventId, item.action, item.nodeId, item.occurredAt.toISOString(), item.versionId]);
}

export type TeamNewsAction = 'team_request.created' | 'team_request.approved' | 'team_request.declined' | 'invitation.accepted';

// without rightAway the caller emails immediately itself; only digests are queued
export async function enqueueTeamNews(tx: SqlClient, e: {
  eventId: string; action: TeamNewsAction; workspaceId: string;
  leadIds: string[]; occurredAt: Date; rightAway?: boolean;
}): Promise<number> {
  if (e.leadIds.length === 0) return 0;
  const policies = await loadPolicies(tx, e.workspaceId, 'requests');
  const timing = await roomTiming(tx, e.workspaceId);
  let queued = 0;
  for (const personId of [...new Set(e.leadIds)]) {
    const standing = await memberStanding(tx, e.workspaceId, personId, e.occurredAt);
    if (!standing) continue;
    const policy = resolveForPerson(policies, 'requests', { personId, ...standing }, timing);
    let mode: Mode;
    if (policy.mode === 'digest') mode = 'digest';
    else if (policy.mode !== 'off' && e.rightAway) mode = 'immediate';
    else continue;
    const tz = await activeTimeZone(tx, personId);
    if (!tz) continue;
    await addToQueue(tx, { personId, workspaceId: e.workspaceId, category: 'requests', mode, mandatory: policy.mandatory,
      timeZone: tz, digestTimes: policy.digestTimes, timing },
      { eventId: e.eventId, action: e.action, nodeId: null, versionId: null, occurredAt: e.occurredAt });
    queued++;
  }
  return queued;
}

export async function enqueuePublishDropped(tx: SqlClient, e: {
  eventId: string; workspaceId: string; personId: string; nodeId: string; versionId: string | null; occurredAt: Date;
}): Promise<number> {
  const standing = await memberStanding(tx, e.workspaceId, e.personId, e.occurredAt);
  if (!standing) return 0;
  const policies = await loadPolicies(tx, e.workspaceId, 'publish_dropped');
  const timing = await roomTiming(tx, e.workspaceId);
  const policy = resolveForPerson(policies, 'publish_dropped', { personId: e.personId, ...standing }, timing);
  if (policy.mode === 'off') return 0;
  const tz = await activeTimeZone(tx, e.personId);
  if (!tz) return 0;
  await addToQueue(tx, { personId: e.personId, workspaceId: e.workspaceId, category: 'publish_dropped', mode: policy.mode, mandatory: policy.mandatory,
    timeZone: tz, digestTimes: policy.digestTimes, timing },
    { eventId: e.eventId, action: 'document.publish_request_dropped', nodeId: e.nodeId, versionId: e.versionId, occurredAt: e.occurredAt });
  return 1;
}

async function activeTimeZone(tx: SqlClient, personId: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ time_zone: string }>(
    `select time_zone from person where id = $1 and erased_at is null and disabled_at is null`, [personId]);
  return rows[0]?.time_zone;
}

async function versionVisible(tx: SqlClient, personId: string, nodeId: string, versionId: string | null, at: Date): Promise<boolean> {
  const principal = { kind: 'person' as const, personId };
  if (versionId) return canSeeVersion(tx, principal, versionId, present(at));
  return !(await versionAccess(tx, principal, nodeId, present(at))).hidden;
}

export interface InlineImage {
  cid: string;
  filename: string;
  contentType: 'image/png';
  content: Uint8Array;
}

export interface OutgoingMessage {
  personId: string;
  to: string;
  subject: string;
  text?: string;
  /** pre-escaped */
  html?: string;
  inline?: InlineImage[];
  lines?: string[];
  fromName?: string;
  fallbackFromName?: string;
  replyTo?: string;
}

export interface Channel {
  readonly name: string;
  send(msg: OutgoingMessage): Promise<{ status: 'accepted' | 'failed'; providerMessageId?: string; error?: string }>;
}

export interface SendResult {
  status: 'sent' | 'dropped' | 'failed';
  itemsSent: number;
  itemsDropped: number;
}

export async function memberStanding(tx: SqlClient, workspaceId: string, personId: string, at: Date): Promise<{ groupIds: string[]; isAdmin: boolean } | null> {
  const r = (await tx.query<{ group_ids: string[] | null; is_admin: boolean }>(
    `select array_agg(m.group_id order by g.name) as group_ids, is_workspace_admin($2, $1, $3) as is_admin
       from membership m join groups g on g.id = m.group_id
      where g.workspace_id = $1 and m.person_id = $2 and m.status = 'active'
        and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= record_clock() and record_clock() < m.superseded_at
        and g.valid_from <= $3 and $3 < g.valid_to`, [workspaceId, personId, at.toISOString()])).rows[0];
  return r?.group_ids?.length ? { groupIds: r.group_ids, isAdmin: r.is_admin } : null;
}

export async function dueNotificationIds(tx: SqlClient, now: Date, limit = 100): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `select id from notification where status = 'open' and due_at <= $1 order by due_at limit $2`, [now.toISOString(), limit]);
  return rows.map((r) => r.id);
}
