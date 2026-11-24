// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './db.js';
import { appendEvent } from './events.js';
import { canSeeVersion, present, versionAccess } from './permissions.js';
import { formatWhen, partsIn } from './notify-schedule.js';
import {
  loadPolicies, memberStanding, resolveForPerson, roomTiming, type Channel, type OutgoingMessage, type SendResult,
} from './notify.js';

// Access is re-checked per item at send time. At most once: claims commit before sending.

export interface DocumentLine {
  nodeId: string;
  indexNumber: string | null;
  title: string;
  /** may be hidden from the recipient; check `folders` */
  folderId: string | null;
  /** among visible versions only */
  versionNo: number | null;
  publishedBy: string | null;
  at: Date;
}

export interface DateLine {
  milestoneId: string;
  title: string | null;
  change: 'added' | 'changed' | 'removed';
  dueAt: Date | null;
  dueBefore: Date | null;
  at: Date;
}

export interface UpcomingDate { milestoneId: string; title: string; dueAt: Date }

export interface TeamLine {
  change: 'approved' | 'declined' | 'joined' | 'requested';
  name: string;
  group: string;
  requestedBy?: string | null;
  requestedAt: Date | null;
  note: string | null;
  at: Date;
}

export interface FolderRef { id: string; indexNumber: string | null; name: string }

export interface DroppedLine {
  nodeId: string;
  indexNumber: string | null;
  title: string;
  folderId: string | null;
  versionNo: number | null;
  reason: 'failed' | 'refused';
  code: string | null;
  at: Date;
}

export function publishDroppedReason(reason: 'failed' | 'refused', code: string | null): string {
  if (reason === 'failed') return 'it could not be prepared for viewing';
  switch (code) {
    case 'room_frozen': return 'the room was frozen when the file was ready';
    case 'room_closed': return 'the room was closed when the file was ready';
    case 'no_publish_right': return 'you no longer had the right to publish it when the file was ready';
    case 'four_eyes': return 'this room now needs a second person to publish files you uploaded yourself';
    default: return 'the publishing rules did not allow it when the file was ready';
  }
}

const docName = (d: { indexNumber: string | null; title: string }) => [d.indexNumber, d.title].filter(Boolean).join(' ');

export function publishDroppedSentence(d: Pick<DroppedLine, 'indexNumber' | 'title' | 'versionNo' | 'reason' | 'code'>): string {
  const name = docName(d);
  const what = d.versionNo ? `Version ${d.versionNo} of ${name}` : name;
  return `${what} was not published: ${publishDroppedReason(d.reason, d.code)}. It is still a draft.`;
}

export type ContentKind = 'documents' | 'versions' | 'deadlines' | 'agreements' | 'requests' | 'publish_dropped' | 'summary';

export interface Recipient {
  personId: string;
  email: string;
  givenName: string | null;
  timeZone: string;
  isAdmin: boolean;
  groupNames: string[];
}

export interface NotificationContent {
  kind: ContentKind;
  workspace: { id: string; name: string; timeZone: string };
  recipient: Recipient;
  documents: DocumentLine[];
  versions: DocumentLine[];
  dates: DateLine[];
  comingUp: UpcomingDate[];
  team: TeamLine[];
  dropped: DroppedLine[];
  folders: Record<string, FolderRef>;
  summaryTimes: string[];
  mode: string;
  settings?: Record<string, string>;
  locked?: string[];
  now: Date;
}

export type NotificationRenderer = (c: NotificationContent) => OutgoingMessage | Promise<OutgoingMessage>;

export type GateReason = 'recipient_erased' | 'recipient_disabled' | 'see_as_preview' | 'no_membership' | 'observer'
  | 'room_not_open' | 'nda_not_accepted' | 'switched_off';

export type Gate = { reason: GateReason } | { reason: null; groupIds: string[]; isAdmin: boolean };

export async function recipientGate(tx: SqlClient, workspaceId: string, personId: string, category: string | null, now: Date,
  opts: { nda?: boolean } = {}): Promise<Gate> {
  const p = (await tx.query<{ disabled: boolean; erased: boolean; stand_in: boolean }>(
    `select p.disabled_at is not null as disabled, p.erased_at is not null as erased,
            (p.email like '%@preview.invalid' or exists (select 1 from see_as_preview s where s.person_id = p.id)) as stand_in
       from person p where p.id = $1`, [personId])).rows[0];
  if (!p || p.erased) return { reason: 'recipient_erased' };
  if (p.disabled) return { reason: 'recipient_disabled' };
  if (p.stand_in) return { reason: 'see_as_preview' };
  const standing = await memberStanding(tx, workspaceId, personId, now);
  if (!standing) return { reason: 'no_membership' };
  if (await onlyObserver(tx, standing.groupIds)) return { reason: 'observer' };
  if (!(await mayEnterRoom(tx, workspaceId, personId, now))) return { reason: 'room_not_open' };
  if (opts.nda !== false && category !== 'agreements' && !(await ndaCleared(tx, workspaceId, personId, now))) {
    return { reason: 'nda_not_accepted' };
  }
  if (category) {
    const policies = await loadPolicies(tx, workspaceId, category);
    const timing = await roomTiming(tx, workspaceId);
    if (!resolveForPerson(policies, category, { personId, ...standing }, timing).enabled) return { reason: 'switched_off' };
  }
  return { reason: null, ...standing };
}

async function onlyObserver(tx: SqlClient, groupIds: string[]): Promise<boolean> {
  const r = (await tx.query<{ only: boolean }>(
    `select bool_and(role_template = 'observer') as only from groups where id = any($1::uuid[])`, [groupIds])).rows[0];
  return !!r?.only;
}

// must match effective_level()
async function mayEnterRoom(tx: SqlClient, workspaceId: string, personId: string, at: Date): Promise<boolean> {
  const r = (await tx.query<{ ok: boolean }>(
    `select case workspace_state_at($1, $3, record_clock())
              when 'preparing' then exists (
                select 1 from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
                 where g.workspace_id = $1 and m.person_id = $2 and m.status = 'active' and pa.kind = 'seller'
                   and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= record_clock() and record_clock() < m.superseded_at
                   and g.valid_from <= $3 and $3 < g.valid_to)
              when 'closed' then is_workspace_admin($2, $1, $3)
              when 'archived' then is_workspace_admin($2, $1, $3)
              when 'deleted' then false
              else true end as ok`, [workspaceId, personId, at.toISOString()])).rows[0];
  return !!r?.ok;
}

async function ndaCleared(tx: SqlClient, workspaceId: string, personId: string, at: Date): Promise<boolean> {
  const r = (await tx.query<{ ok: boolean }>(
    `select not w.requires_nda
         or exists (select 1 from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
                     where g.workspace_id = w.id and m.person_id = $2 and m.status = 'active' and pa.kind = 'seller'
                       and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= record_clock() and record_clock() < m.superseded_at
                       and g.valid_from <= $3 and $3 < g.valid_to)
         or nda_accepted($2, w.id, record_clock()) as ok
       from workspace w where w.id = $1`, [workspaceId, personId, at.toISOString()])).rows[0];
  return !!r?.ok;
}

async function acceptsNoNda(tx: SqlClient, workspaceId: string, personId: string, isAdmin: boolean, at: Date): Promise<boolean> {
  if (isAdmin) return true;
  const r = (await tx.query<{ seller: boolean }>(
    `select exists (select 1 from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
                     where g.workspace_id = $1 and m.person_id = $2 and m.status = 'active' and pa.kind = 'seller'
                       and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= record_clock() and record_clock() < m.superseded_at
                       and g.valid_from <= $3 and $3 < g.valid_to) as seller`, [workspaceId, personId, at.toISOString()])).rows[0];
  return !!r?.seller;
}

async function recipientOf(tx: SqlClient, workspaceId: string, personId: string, gate: { groupIds: string[]; isAdmin: boolean }): Promise<Recipient> {
  const p = (await tx.query<{ email: string; given_name: string | null; time_zone: string }>(
    `select email, given_name, time_zone from person where id = $1`, [personId])).rows[0]!;
  const groups = (await tx.query<{ name: string }>(
    `select name from groups where id = any($1::uuid[]) and role_template <> 'admin' order by name`, [gate.groupIds])).rows.map((g) => g.name);
  return { personId, email: p.email, givenName: p.given_name?.trim() || null, timeZone: p.time_zone || 'UTC', isAdmin: gate.isAdmin,
    groupNames: gate.isAdmin ? [] : groups };
}

async function workspaceOf(tx: SqlClient, workspaceId: string): Promise<NotificationContent['workspace']> {
  const w = (await tx.query<{ name: string; time_zone: string }>(`select name, time_zone from workspace where id = $1`, [workspaceId])).rows[0]!;
  return { id: workspaceId, name: w.name, timeZone: w.time_zone || 'UTC' };
}

interface NotificationRow { id: string; workspace_id: string; person_id: string; category: string; mode: string; mandatory: boolean; status: string }
interface ItemRow { id: string; notification_id: string; node_id: string | null; action: string; version_id: string | null; event_id: string; occurred_at: string }

export interface PreparedEmail {
  ids: string[];
  workspaceId: string;
  personId: string;
  category: string;
  categories: string[];
  mode: string;
  mandatory: boolean;
  content: NotificationContent;
  nodeIds: (string | null)[];
  itemsSent: number;
  itemsDropped: number;
}

export type Prepared = { status: 'skipped' } | { status: 'dropped'; itemsDropped: number } | { status: 'ready'; email: PreparedEmail };

const DOCUMENT_ACTIONS = new Set(['document.published', 'document.version_published']);
const TEAM_ACTIONS = new Set(['team_request.created', 'team_request.approved', 'team_request.declined', 'invitation.accepted']);

async function dropRow(tx: SqlClient, n: NotificationRow, reason: string, items: number, now: Date, itemsAlreadyMarked = false) {
  if (!itemsAlreadyMarked) await tx.query(`update notification_item set dropped_reason = $2 where notification_id = $1 and dropped_reason is null`, [n.id, reason]);
  await tx.query(`update notification set status = 'dropped', sent_at = $2 where id = $1`, [n.id, now.toISOString()]);
  await appendEvent(tx, {
    action: 'notification.dropped', workspaceId: n.workspace_id, resourceType: 'notification', resourceId: n.id,
    data: { recipient_person_id: n.person_id, category: n.category, items_dropped: items, reason },
    occurredAt: now,
  });
}

// with claim: commit before sending, then recordSent() in a new transaction
export async function prepareNotifications(tx: SqlClient, ids: string[], now: Date, opts: { claim: boolean; skipLocked?: boolean } = { claim: true }): Promise<Prepared> {
  const rows = (await tx.query<NotificationRow>(
    `select id, workspace_id, person_id, category, mode, mandatory, status from notification
      where id = any($1::uuid[]) and status = 'open' order by created_at for update ${opts.skipLocked === false ? '' : 'skip locked'}`, [ids])).rows;
  if (rows.length === 0) return { status: 'skipped' };
  const workspaceId = rows[0]!.workspace_id;
  const personId = rows[0]!.person_id;
  const mine = rows.filter((r) => r.workspace_id === workspaceId && r.person_id === personId);
  const items = (await tx.query<ItemRow>(
    `select id, notification_id, node_id, action, version_id, event_id, occurred_at from notification_item
      where notification_id = any($1::uuid[]) order by occurred_at, id`, [mine.map((r) => r.id)])).rows;
  const itemsOf = (n: NotificationRow) => items.filter((i) => i.notification_id === n.id);

  const base = await recipientGate(tx, workspaceId, personId, null, now, { nda: false });
  if (base.reason) {
    for (const n of mine) await dropRow(tx, n, base.reason, itemsOf(n).length, now);
    return { status: 'dropped', itemsDropped: items.length };
  }
  const policies = await loadPolicies(tx, workspaceId);
  const timing = await roomTiming(tx, workspaceId);
  const policyOf = (category: string) => resolveForPerson(policies, category, { personId, groupIds: base.groupIds, isAdmin: base.isAdmin }, timing);
  const enabled = (category: string) => policyOf(category).enabled;
  const nda = await ndaCleared(tx, workspaceId, personId, now);

  const workspace = await workspaceOf(tx, workspaceId);
  const recipient = await recipientOf(tx, workspaceId, personId, base);
  const summary = mine.some((n) => n.mode === 'digest' && n.category !== 'agreements');
  const content: NotificationContent = {
    kind: summary ? 'summary' : (mine[0]!.category as ContentKind), workspace, recipient,
    documents: [], versions: [], dates: [], comingUp: [], team: [], dropped: [], folders: {}, summaryTimes: timing.summaryTimes,
    mode: summary ? 'digest' : mine[0]!.mode, now,
  };

  const nodeIds = new Set<string>();
  for (const i of items) {
    if (i.node_id && DOCUMENT_ACTIONS.has(i.action)) nodeIds.add(i.node_id);
  }
  const visible = new Map<string, number>();
  if (nodeIds.size) {
    const { rows } = await tx.query<{ node_id: string; level: number }>(
      `select node_id, level from accessible_nodes($1, $2, $3, record_clock()) where node_id = any($4::uuid[])`,
      [personId, workspaceId, now.toISOString(), [...nodeIds]]);
    for (const r of rows) visible.set(r.node_id, Number(r.level));
  }

  const kept: PreparedEmail['nodeIds'] = [];
  const keptRows: NotificationRow[] = [];
  let dropped = 0;
  for (const n of mine) {
    const its = itemsOf(n);
    let gate: string | null = null;
    if (n.category !== 'agreements' && !nda) gate = 'nda_not_accepted';
    else if (n.category === 'agreements' && await acceptsNoNda(tx, workspaceId, personId, base.isAdmin, now)) gate = 'seller_side';
    else if (!enabled(n.category)) gate = 'switched_off';
    if (gate) {
      await dropRow(tx, n, gate, its.length, now);
      dropped += its.length;
      continue;
    }
    let keptHere = 0;
    for (const it of its) {
      const reason = await keepItem(tx, it, content, { personId, workspaceId, visible, now });
      if (reason) {
        await tx.query(`update notification_item set dropped_reason = $2 where id = $1`, [it.id, reason]);
        dropped++;
        continue;
      }
      kept.push(it.node_id);
      keptHere++;
    }
    if (keptHere === 0) await dropRow(tx, n, 'no_items_visible_at_send', its.length, now, true);
    else keptRows.push(n);
  }
  if (keptRows.length === 0) return { status: 'dropped', itemsDropped: dropped };

  if (summary && enabled('deadlines')) content.comingUp = await comingUp(tx, workspaceId, personId, recipient.timeZone, now, content.dates);
  const folderIds = new Set<string>();
  for (const d of [...content.documents, ...content.versions]) {
    if (d.folderId) folderIds.add(d.folderId);
  }
  if (folderIds.size) {
    const seen = (await tx.query<{ id: string; index_number: string | null; name: string }>(
      `select n.id, n.index_number, n.name from accessible_nodes($1, $2, $3, record_clock()) a join node n on n.id = a.node_id
        where a.node_id = any($4::uuid[]) and a.level >= 20 and n.kind = 'folder'`,
      [personId, workspaceId, now.toISOString(), [...folderIds]])).rows;
    for (const f of seen) content.folders[f.id] = { id: f.id, indexNumber: f.index_number, name: f.name };
  }
  const teamKey = (t: TeamLine) => `${t.name}|${t.group}`;
  const joined = new Set(content.team.filter((t) => t.change === 'joined').map(teamKey));
  content.team = content.team.filter((t) => t.change !== 'approved' || !joined.has(teamKey(t)));

  if (opts.claim) {
    await tx.query(`update notification set status = 'sending', claimed_at = $2 where id = any($1::uuid[])`,
      [keptRows.map((r) => r.id), now.toISOString()]);
  }
  const categories = [...new Set(keptRows.map((r) => r.category))];
  content.settings = Object.fromEntries(categories.map((c) => [c, policyOf(c).mode]));
  content.locked = categories.filter((c) => policyOf(c).locked);
  return {
    status: 'ready',
    email: {
      ids: keptRows.map((r) => r.id), workspaceId, personId,
      category: summary ? 'summary' : keptRows[0]!.category, categories,
      mode: summary ? 'digest' : keptRows[0]!.mode, mandatory: keptRows.some((r) => r.mandatory),
      content, nodeIds: kept, itemsSent: kept.length, itemsDropped: dropped,
    },
  };
}

async function keepItem(tx: SqlClient, it: ItemRow, c: NotificationContent,
  a: { personId: string; workspaceId: string; visible: Map<string, number>; now: Date }): Promise<string | null> {
  if (it.action === 'milestone.changed') {
    const line = await dateLine(tx, it.event_id, a.personId, a.now);
    if (line === 'still_visible') return 'milestone_still_visible';
    if (!line) return 'milestone_not_visible';
    c.dates.push(line);
    return null;
  }
  if (TEAM_ACTIONS.has(it.action)) {
    const line = await teamLine(tx, it, a.personId, a.workspaceId, a.now);
    if (!line) return it.action === 'team_request.created' ? 'request_not_pending' : 'not_lead_of_group';
    c.team.push(line);
    return null;
  }
  if (it.action === 'agreement.version_published') return null;
  if (it.action === 'document.publish_request_dropped') {
    const line = await droppedLine(tx, it, a.personId, a.now);
    if (!line) return 'publish_no_longer_dropped';
    c.dropped.push(line);
    return null;
  }
  if (!it.node_id) return null;
  const level = a.visible.get(it.node_id) ?? 0;
  if (level < 20) return 'not_visible';
  const principal = { kind: 'person' as const, personId: a.personId };
  let versionOk: boolean;
  if (it.version_id) versionOk = await canSeeVersion(tx, principal, it.version_id, present(a.now));
  else versionOk = !(await versionAccess(tx, principal, it.node_id, present(a.now))).hidden;
  if (!versionOk) return 'version_not_visible';
  const d = (await tx.query<{ index_number: string | null; name: string; parent_id: string | null; publisher: string | null; version_no: number | null }>(
    `select n.index_number, n.name, n.parent_id,
            (select p.name from event e join person p on p.id = (e.data ->> 'person_id')::uuid
              where e.id = $2 and e.resource_id = n.id limit 1) as publisher,
            case when $3::uuid is null then null else (
              select count(*) from document_version d2 join document_version dv on dv.id = $3
               where d2.node_id = n.id and d2.version_no <= dv.version_no and can_see_version($4, d2.id, $5, record_clock(), false)) end as version_no
       from node n where n.id = $1`, [it.node_id, it.event_id, it.version_id, a.personId, a.now.toISOString()])).rows[0];
  if (!d) return 'not_visible';
  const line: DocumentLine = {
    nodeId: it.node_id, indexNumber: d.index_number, title: d.name, folderId: d.parent_id,
    versionNo: d.version_no == null ? null : Number(d.version_no), publishedBy: d.publisher, at: new Date(it.occurred_at),
  };
  const list = it.action === 'document.version_published' ? c.versions : c.documents;
  const same = list.findIndex((x) => x.nodeId === line.nodeId);
  if (same >= 0) list[same] = line; else list.push(line);
  return null;
}

async function droppedLine(tx: SqlClient, it: Pick<ItemRow, 'node_id' | 'version_id' | 'event_id' | 'occurred_at'>, personId: string, now: Date): Promise<DroppedLine | null> {
  if (!it.node_id || !it.version_id) return null;
  const d = (await tx.query<{ index_number: string | null; name: string; parent_id: string | null; state: string; version_no: number;
    awaiting_release: boolean; withdrawn: boolean; newest: boolean; data: any; sees: boolean }>(
    `select n.index_number, n.name, n.parent_id, n.state, dv.version_no, dv.awaiting_release, dv.withdrawn_at is not null as withdrawn,
            not exists (select 1 from document_version o where o.node_id = n.id and o.version_no > dv.version_no and o.withdrawn_at is null) as newest,
            e.data,
            exists (select 1 from effective_level($2, n.id, $3, record_clock()) l where l.level >= 10 or l.can_publish or l.can_manage) as sees
       from document_version dv join node n on n.id = dv.node_id join event e on e.id = $4
      where dv.id = $1 and n.deleted_at is null and dv.publish_when_ready is null`,
    [it.version_id, personId, now.toISOString(), it.event_id])).rows[0];
  if (!d || d.withdrawn || !d.newest || !d.sees) return null;
  const isDraft = d.state === 'draft';
  if (!isDraft && !(d.state === 'published' && d.awaiting_release)) return null;
  return {
    nodeId: it.node_id,
    indexNumber: d.index_number,
    title: d.name,
    folderId: d.parent_id,
    versionNo: isDraft ? null : Number(d.version_no),
    reason: d.data?.reason === 'failed' ? 'failed' : 'refused',
    code: typeof d.data?.code === 'string' ? d.data.code : null,
    at: new Date(it.occurred_at),
  };
}

export const DROPPED_NOTICE_DAYS = 14;

export async function openDroppedPublishes(tx: SqlClient, workspaceId: string, personId: string, now: Date): Promise<DroppedLine[]> {
  const since = new Date(now.getTime() - DROPPED_NOTICE_DAYS * 86_400_000).toISOString();
  const events = (await tx.query<{ id: string; resource_id: string; version_id: string | null; occurred_at: string }>(
    `select id, resource_id, data ->> 'version_id' as version_id, occurred_at from event
      where workspace_id = $1 and action = 'document.publish_request_dropped' and data ->> 'person_id' = $2::text
        and occurred_at >= $3 and occurred_at <= $4
      order by occurred_at desc, id limit 50`, [workspaceId, personId, since, now.toISOString()])).rows;
  const out: DroppedLine[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.version_id || seen.has(e.version_id)) continue;
    seen.add(e.version_id);
    const line = await droppedLine(tx, { node_id: e.resource_id, version_id: e.version_id, event_id: e.id, occurred_at: e.occurred_at }, personId, now);
    if (line) out.push(line);
  }
  return out;
}

// a narrowed date logs removed + changed; still_visible means skip the removal
async function dateLine(tx: SqlClient, eventId: string, personId: string, now: Date): Promise<DateLine | null | 'still_visible'> {
  const m = (await tx.query<{ id: string; title: string; due_at: string; deleted: boolean; data: any; visible: boolean; occurred_at: string }>(
    `select m.id, m.title, m.due_at, m.deleted_at is not null as deleted, e.data, e.occurred_at,
            ${visibleSql('m', '$2', '$3')} as visible
       from event e join milestone m on m.id = e.resource_id
      where e.id = $1 and e.resource_type = 'milestone'`, [eventId, personId, now.toISOString()])).rows[0];
  if (!m) return null;
  const at = new Date(m.occurred_at);
  if (m.data?.change === 'removed') {
    if (!m.deleted && m.visible) return 'still_visible';
    return { milestoneId: m.id, title: m.data.title ?? null, change: 'removed', dueAt: null, dueBefore: null, at };
  }
  if (m.deleted || !m.visible) return null;
  const changed = m.data?.change === 'changed';
  const moved = changed && m.data.due_at_before && m.data.due_at_before !== m.data.due_at_after;
  return {
    milestoneId: m.id,
    title: m.title,
    change: changed ? 'changed' : 'added',
    dueAt: new Date(m.due_at),
    dueBefore: moved ? new Date(m.data.due_at_before) : null,
    at,
  };
}

function visibleSql(m: string, person: string, at: string): string {
  return `(is_workspace_admin(${person}, ${m}.workspace_id, ${at})
            or cardinality(${m}.visible_to_group_ids) = 0
            or exists (select 1 from membership ms join groups g on g.id = ms.group_id join party pa on pa.id = g.party_id
                        where ms.person_id = ${person} and g.workspace_id = ${m}.workspace_id and ms.status = 'active'
                          and pa.kind = 'seller' and g.role_template <> 'observer'
                          and ms.valid_from <= ${at} and ${at} < ms.valid_to and ms.superseded_at = 'infinity'
                          and g.valid_from <= ${at} and ${at} < g.valid_to)
            or ${m}.visible_to_group_ids && array(
                 select x from membership ms join groups g on g.id = ms.group_id,
                        lateral (values (g.id), (g.parent_group_id)) v(x)
                  where ms.person_id = ${person} and g.workspace_id = ${m}.workspace_id and ms.status = 'active' and x is not null
                    and ms.valid_from <= ${at} and ${at} < ms.valid_to and ms.superseded_at = 'infinity'
                    and g.valid_from <= ${at} and ${at} < g.valid_to))`;
}

async function comingUp(tx: SqlClient, workspaceId: string, personId: string, timeZone: string, now: Date, changed: DateLine[]): Promise<UpcomingDate[]> {
  const rows = (await tx.query<{ id: string; title: string; due_at: string }>(
    `select m.id, m.title, m.due_at from milestone m
      where m.workspace_id = $1 and m.deleted_at is null and m.due_at > $3 and m.due_at < $3::timestamptz + interval '16 days'
        and ${visibleSql('m', '$2', '$3')}
      order by m.due_at limit 10`, [workspaceId, personId, now.toISOString()])).rows;
  const listed = new Set(changed.map((d) => d.milestoneId));
  return rows
    .filter((r) => !listed.has(r.id) && calendarDays(now, new Date(r.due_at), timeZone) <= 14)
    .slice(0, 3)
    .map((r) => ({ milestoneId: r.id, title: r.title, dueAt: new Date(r.due_at) }));
}

export function calendarDays(from: Date, to: Date, timeZone: string): number {
  const a = partsIn(from, timeZone);
  const b = partsIn(to, timeZone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

function requestedName(payload: any): string {
  return payload?.name ?? `${payload?.givenName ?? ''} ${payload?.familyName ?? ''}`.trim();
}

async function teamLine(tx: SqlClient, it: ItemRow, personId: string, workspaceId: string, now: Date): Promise<TeamLine | null> {
  const e = (await tx.query<{ resource_id: string; data: any; occurred_at: string }>(
    `select resource_id, data, occurred_at from event where id = $1`, [it.event_id])).rows[0];
  if (it.action === 'team_request.created') {
    if (!e) return null;
    const a = (await tx.query<{ payload: any; status: string; created_at: string; lead: string | null; grp: string | null; admin: boolean }>(
      `select a.payload, a.status, a.created_at, case when p.erased_at is not null then null else p.name end as lead, g.name as grp,
              is_workspace_admin($3, $2, $4) as admin
         from approval a left join person p on p.id = a.requested_by left join groups g on g.id = a.group_id
        where a.id = $1 and a.workspace_id = $2 and a.kind = 'colleague_request'`, [e.resource_id, workspaceId, personId, now.toISOString()])).rows[0];
    if (!a || a.status !== 'pending' || !a.admin) return null;
    return {
      change: 'requested', name: requestedName(a.payload), group: a.grp ?? '', requestedBy: a.lead,
      requestedAt: new Date(a.created_at), note: null, at: new Date(e.occurred_at),
    };
  }
  const groupId: string | undefined = e?.data?.group_id;
  if (!e || !groupId) return null;
  const g = (await tx.query<{ name: string; lead: boolean }>(
    `select g.name, exists (
       select 1 from membership m where m.group_id = g.id and m.person_id = $2 and m.role = 'lead' and m.status = 'active'
          and m.valid_from <= $3 and $3 < m.valid_to and m.superseded_at = 'infinity'
          and not coalesce((m.metadata ->> 'revoked')::boolean, false)
          and g.parent_group_id is null) as lead
       from groups g where g.id = $1 and g.workspace_id = $4 and g.valid_from <= $3 and $3 < g.valid_to`,
    [groupId, personId, now.toISOString(), workspaceId])).rows[0];
  if (!g?.lead) return null;
  const at = new Date(e.occurred_at);
  if (it.action === 'invitation.accepted') {
    const p = (await tx.query<{ name: string; email: string }>(`select name, email from person where id = $1`, [e.data.person_id])).rows[0];
    if (!p) return null;
    const asked = (await tx.query<{ created_at: string }>(
      `select created_at from approval where workspace_id = $1 and kind = 'colleague_request' and status = 'approved' and group_id = $2
          and requested_by = $3 and lower(payload ->> 'email') = lower($4) order by created_at desc limit 1`,
      [workspaceId, groupId, personId, p.email])).rows[0];
    return { change: 'joined', name: p.name, group: g.name, requestedAt: asked ? new Date(asked.created_at) : null, note: null, at };
  }
  const a = (await tx.query<{ payload: any; created_at: string; decision_note: string | null; requested_by: string }>(
    `select payload, created_at, decision_note, requested_by from approval where id = $1 and workspace_id = $2`, [e.resource_id, workspaceId])).rows[0];
  if (!a) return null;
  return {
    change: it.action === 'team_request.approved' ? 'approved' : 'declined', name: requestedName(a.payload), group: g.name,
    requestedAt: a.requested_by === personId ? new Date(a.created_at) : null,
    note: it.action === 'team_request.declined' ? a.decision_note?.trim() || null : null, at,
  };
}

// outside the hash chain, so erasable
export function mailContext(personId: string, message: { to: string; subject: string } | undefined) {
  if (!message) return undefined;
  return { personal: { to: message.to, subject: message.subject.replace(/\b\d{3} ?\d{3}\b/g, '[code]') }, subjectPersonId: personId };
}

// error is hashed: strip the address
export function mailReason(error: string | undefined, to: string | undefined): string | null {
  if (!error) return null;
  if (!to) return error;
  const escaped = to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return error.replace(new RegExp(escaped, 'gi'), '[recipient]');
}

export async function recordSent(tx: SqlClient, email: PreparedEmail, channel: string,
  result: { status: 'accepted' | 'failed'; providerMessageId?: string; error?: string }, now: Date,
  message?: { to: string; subject: string }): Promise<SendResult> {
  const status = result.status === 'accepted' ? 'sent' : 'failed';
  await tx.query(
    `update notification set status = $2, sent_at = $3, channel = $4, delivery_status = $5, provider_message_id = $6 where id = any($1::uuid[])`,
    [email.ids, status, now.toISOString(), channel, result.status, result.providerMessageId ?? null]);
  await appendEvent(tx, {
    action: status === 'sent' ? 'notification.sent' : 'notification.failed',
    workspaceId: email.workspaceId, resourceType: 'notification', resourceId: email.ids[0]!,
    data: {
      recipient_person_id: email.personId, channel, category: email.category, mode: email.mode, mandatory: email.mandatory,
      ...(email.ids.length > 1 || email.category === 'summary' ? { notification_ids: email.ids, categories: email.categories } : {}),
      node_ids: email.nodeIds, items_dropped: email.itemsDropped, delivery_status: result.status,
      provider_message_id: result.providerMessageId ?? null,
      mail_type: email.category === 'summary' ? 'daily_summary' : 'notification',
      ...(email.content.dates.length ? { milestone_ids: [...new Set(email.content.dates.map((d) => d.milestoneId))] } : {}),
      ...(status === 'sent' ? {} : { error: mailReason(result.error, message?.to) }),
    },
    occurredAt: now,
    ...(message ? { context: mailContext(email.personId, message)! } : {}),
  });
  return { status, itemsSent: email.itemsSent, itemsDropped: email.itemsDropped };
}

export const CLAIM_TIMEOUT_MINUTES = 15;

const STOPPED_WHILE_SENDING = 'The worker stopped while sending. Not sent again.';

// never retried: the email may have gone
export async function closeStaleClaims(tx: SqlClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - CLAIM_TIMEOUT_MINUTES * 60_000).toISOString();
  const stale = (await tx.query<{ id: string; workspace_id: string; person_id: string; category: string }>(
    `update notification set status = 'failed', sent_at = $2, delivery_status = 'unknown'
      where status = 'sending' and claimed_at <= $1 returning id, workspace_id, person_id, category`, [cutoff, now.toISOString()])).rows;
  for (const n of stale) {
    await appendEvent(tx, {
      action: 'notification.failed', workspaceId: n.workspace_id, resourceType: 'notification', resourceId: n.id,
      data: { recipient_person_id: n.person_id, category: n.category, delivery_status: 'unknown', error: STOPPED_WHILE_SENDING },
      occurredAt: now,
    });
  }
  const reminders = (await tx.query<{ id: string; workspace_id: string; person_id: string; milestone_id: string; kind: string }>(
    `update deadline_reminder set status = 'failed', sent_at = $2, delivery_status = 'unknown'
      where status = 'sending' and claimed_at <= $1 returning id, workspace_id, person_id, milestone_id, kind`, [cutoff, now.toISOString()])).rows;
  for (const r of reminders) {
    await appendEvent(tx, {
      action: 'notification.failed', workspaceId: r.workspace_id, resourceType: 'deadline_reminder', resourceId: r.id,
      data: { milestone_id: r.milestone_id, recipient_person_id: r.person_id, category: 'deadlines', mode: 'reminder', reminder: r.kind, delivery_status: 'unknown',
        error: STOPPED_WHILE_SENDING },
      occurredAt: now,
    });
  }
  return stale.length + reminders.length;
}

export async function dueNotificationBatches(tx: SqlClient, now: Date, limit = 200): Promise<string[][]> {
  const rows = (await tx.query<{ id: string; person_id: string; workspace_id: string; mode: string; category: string }>(
    `select id, person_id, workspace_id, mode, category from notification where status = 'open' and due_at <= $1 order by due_at, id limit $2`,
    [now.toISOString(), limit])).rows;
  const out: string[][] = [];
  const digests = new Map<string, string[]>();
  for (const r of rows) {
    if (r.mode !== 'digest' || r.category === 'agreements') { out.push([r.id]); continue; }
    const key = `${r.person_id}|${r.workspace_id}`;
    const batch = digests.get(key);
    if (batch) {
      batch.push(r.id);
    } else {
      const fresh = [r.id];
      digests.set(key, fresh);
      out.push(fresh);
    }
  }
  return out;
}

// no claim: a crash can send twice
export async function sendNotification(tx: SqlClient, notificationId: string, channel: Channel, now: Date,
  render: NotificationRenderer = linesRenderer): Promise<SendResult> {
  const open = (await tx.query<{ status: string }>(`select status from notification where id = $1`, [notificationId])).rows[0];
  if (!open || open.status !== 'open') throw new Error(`Notification ${notificationId} is not open`);
  const p = await prepareNotifications(tx, [notificationId], now, { claim: false, skipLocked: false });
  if (p.status === 'skipped') throw new Error(`Notification ${notificationId} is not open`);
  if (p.status === 'dropped') return { status: 'dropped', itemsSent: 0, itemsDropped: p.itemsDropped };
  const msg = await render(p.email.content);
  const result = await channel.send(msg);
  return recordSent(tx, p.email, channel.name, result, now, msg);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function dateLineText(d: DateLine, timeZone: string, now: Date): string {
  const when = (v: Date) => formatWhen(v, timeZone, now);
  if (d.change === 'removed') return d.title ? `${d.title}: removed from your Timeline` : 'A date was removed from your Timeline';
  if (d.dueBefore) return `${d.title}: moved from ${when(d.dueBefore)} to ${when(d.dueAt!)}`;
  return `${d.title}: ${when(d.dueAt!)}`;
}

export function linesRenderer(c: NotificationContent): OutgoingMessage {
  const base = { personId: c.recipient.personId, to: c.recipient.email };
  const ws = c.workspace.name;
  const tz = c.recipient.timeZone;
  if (c.kind === 'deadlines') {
    const lines = c.dates.map((d) => dateLineText(d, tz, c.now));
    return { ...base, subject: `${ws}: ${lines.length === 1 ? 'a date changed' : `${lines.length} dates changed`} on the Timeline`, lines };
  }
  if (c.kind === 'requests') {
    const lines = c.team.map((t) => (t.change === 'requested' ? `${t.requestedBy ?? 'A lead'} asks to add ${t.name} to ${t.group}` : `${t.name}, ${t.group}: ${t.change}`));
    return { ...base, subject: `${ws}: ${lines.length === 1 ? 'team news' : `${lines.length} team updates`}`, lines };
  }
  if (c.kind === 'publish_dropped') {
    const lines = c.dropped.map(publishDroppedSentence);
    return { ...base, subject: `${ws}: ${lines.length === 1 ? 'a file was not published' : `${lines.length} files were not published`}`, lines };
  }
  if (c.kind === 'agreements') {
    return { ...base, subject: `${ws}: a new NDA to accept`,
      lines: ['A new version of the non-disclosure agreement was published. Sign in to read it; you accept it before you see documents again.'] };
  }
  const order = (a: DocumentLine, b: DocumentLine) => compareIndex(a.indexNumber, b.indexNumber) || a.title.localeCompare(b.title);
  if (c.kind === 'documents' || c.kind === 'versions') {
    const docs = [...(c.kind === 'versions' ? c.versions : c.documents)].sort(order);
    return { ...base, subject: `${ws}: ${plural(docs.length, c.kind === 'versions' ? 'new version' : 'new document')}`, lines: docs.map(docName) };
  }
  const lines = [
    ...[...c.documents].sort(order).map((d) => `New document: ${docName(d)}`),
    ...[...c.versions].sort(order).map((d) => `New version: ${docName(d)}`),
    ...c.dates.map((d) => dateLineText(d, tz, c.now)),
    ...c.comingUp.map((u) => `Coming up: ${u.title}, ${formatWhen(u.dueAt, tz, c.now)}`),
    ...c.team.map((t) => `${t.name}, ${t.group}: ${t.change}`),
    ...c.dropped.map(publishDroppedSentence),
  ];
  return { ...base, subject: `${ws}: daily summary`, lines };
}

export function compareIndex(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}
