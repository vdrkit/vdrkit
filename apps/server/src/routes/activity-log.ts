// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from '@vdrkit/core';
import { zonedToUtc } from '@vdrkit/core';
import { badRequest } from '../problems.js';

export const ACTION_LABELS: Record<string, string> = {
  'document.opened': 'Opened document',
  'document.viewed': 'Viewed document',
  'document.page_viewed': 'Viewed page',
  'document.downloaded': 'Downloaded document',
  'document.printed': 'Printed document',
  'document.uploaded': 'Uploaded document',
  'document.published': 'Published document',
  'document.version_published': 'Published new version',
  'document.withdrawn': 'Withdrew document',
  'document.moved': 'Moved document',
  'document.renamed': 'Renamed document',
  'document.deleted': 'Deleted document',
  'folder.created': 'Created folder',
  'grant.changed': 'Changed permissions',
  'grants.bulk_changed': 'Changed permissions',
  'grant.reset': 'Reset permissions',
  'agreement.version_published': 'Published NDA version',
  'agreement.accepted': 'Accepted NDA',
  'notification.sent': 'Sent notification',
  'notification.dropped': 'Dropped notification',
  'notification.failed': 'Notification failed',
  'milestone.changed': 'Changed milestone',
  'person.invited': 'Invited person',
  'person.erased': 'Erased personal data',
  'membership.changed': 'Changed group membership',
  'tenant.settings_changed': 'Changed settings',
  'workspace.settings_changed': 'Changed room settings',
  'workspace.state_changed': 'Changed room state',
  'workspace.open_at_sign_in_cleared': 'Cleared “Open at sign-in”',
  'person.details_changed': 'Changed personal details',
  'person.email_change_requested': 'Asked to change a sign-in email',
  'person.email_change_code_sent': 'Sent the code for a new sign-in email',
  'person.email_change_code_not_sent': 'Could not send the code for a new sign-in email',
  'person.email_change_approval_sent': 'Asked the current address to agree to a new sign-in email',
  'person.email_change_approval_not_sent': 'Could not ask the current address to agree to a new sign-in email',
  'person.email_change_approved': 'Agreed to a new sign-in email',
  'person.email_change_declined': 'Refused a new sign-in email',
  'person.email_changed': 'Changed sign-in email',
  'membership.role_changed': 'Changed lead',
  'membership.revoked': 'Revoked access',
  'membership.restored': 'Restored access',
  'account.disabled': 'Account disabled',
  'account.enabled': 'Account enabled again',
  'document.publish_requested': 'Asked to publish when ready',
  'document.publish_request_dropped': 'Not published as asked',
  'team_request.created': 'Requested a colleague',
  'team_request.approved': 'Approved colleague request',
  'team_request.declined': 'Declined colleague request',
  'team_request.withdrawn': 'Withdrew colleague request',
  'removal_request.created': 'Asked to remove a colleague',
  'removal_request.approved': 'Approved removal request',
  'removal_request.declined': 'Declined removal request',
  'workspace.created': 'Created room',
  'workspace.copied': 'Used as template for a new room',
  'workspace.standard_index_created': 'Created the standard M&A index',
  'notification.preferences_changed': 'Changed notification settings',
  'search.performed': 'Searched',
  'access.blocked': 'Blocked link',
  'activity.exported': 'Exported activity log',
  'invitation.reminded': 'Sent invitation reminder',
  'group.details_changed': 'Changed group details',
  'demo.seeded': 'Loaded the demo room',
  'document.processed': 'Prepared for viewing',
  'document.processing_failed': 'Processing failed',
  'document.processing_restarted': 'Processing started again',
  'node.renamed': 'Renamed',
  'index.renumbered': 'Renumbered',
  'folder.published': 'Published folder',
  'demo.activity_seeded': 'Loaded demo reading',
  'invitation.sent': 'Sent invitation',
  'invitation.accepted': 'Accepted invitation',
  'invitation.created': 'Invited person',
  'invitation.held': 'Invitation waits for the room to open',
  'room.seen_as': 'Saw the room as a team',
  'auth.signed_in': 'Signed in',
  'auth.sign_in_failed': 'Failed sign-in',
};

export const EVENT_PERSON = `case when coalesce(e.data ->> 'person_id', e.data ->> 'personId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then coalesce(e.data ->> 'person_id', e.data ->> 'personId')::uuid end`;

export const KINDS = {
  view: ['document.opened', 'document.viewed'],
  download: ['document.downloaded', 'document.printed'],
  upload: ['document.uploaded', 'document.version_uploaded', 'document.published', 'folder.published', 'document.version_published', 'folder.created'],
  access: ['grant.changed', 'grants.bulk_changed', 'grant.reset', 'group.created', 'group.revoked', 'membership.role_changed', 'membership.revoked', 'membership.restored',
    'membership.expiry_changed', 'invitation.created', 'invitation.held', 'team_request.approved', 'removal_request.approved', 'workspace.site_admin_joined'],
  signin: ['auth.signed_in', 'invitation.accepted', 'agreement.accepted', 'access.blocked', 'auth.signed_out_inactive', 'auth.signed_out_expired'],
} as const;
export type Kind = keyof typeof KINDS;

// never add document.processing_failed: admins must act on it
export const HOUSEKEEPING = ['document.processed', 'document.page_viewed', 'demo.seeded', 'demo.activity_seeded'];
export const KIND_NAMES = Object.keys(KINDS) as Kind[];

export function kindOf(action: string): Kind | 'other' {
  for (const k of KIND_NAMES) if ((KINDS[k] as readonly string[]).includes(action)) return k;
  return 'other';
}

// never add grants.bulk_changed, exports or demo seeds: they name things observers can't see
export const OBSERVER_ROOM_ACTIONS = ['workspace.created', 'workspace.state_changed', 'workspace.settings_changed', 'workspace.logo_changed',
  'workspace.logo_removed', 'workspace.copied', 'agreement.version_published', 'agreement.accepted'];

// allowlist: unknown resource types stay hidden
export function observerView(p: Params, ws: string, person: string, now: string): string {
  const per = p.add(person);
  const at = p.add(now);
  const room = p.add(OBSERVER_ROOM_ACTIONS);
  const w = p.add(ws);
  return `(
      case e.resource_type
        when 'node' then e.action not like 'grant%' and (e.resource_id in (select an.node_id from accessible_nodes(${per}, ${w}, ${at}, record_clock()) an)
                      or exists (select 1 from effective_level(${per}, e.resource_id, e.occurred_at, record_clock()) x
                                  where x.level > 0 or x.can_upload or x.can_manage or x.can_publish))
        when 'milestone' then exists (select 1 from milestone ms where ms.id = e.resource_id and ms.workspace_id = ${w})
        when 'workspace' then e.action = any(${room}::text[])
        when 'agreement_version' then e.action = any(${room}::text[])
        else false
      end)`;
}

export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export interface LogFilters {
  action?: string | undefined;
  kind?: Kind | undefined;
  person?: string | undefined;
  group?: string | undefined;
  node?: string | undefined;
  q?: string | undefined;
  from?: Date | null;
  to?: Date | null;
}

const PERSON_JOINS = `
  left join principal pr on pr.id = e.actor_id
  left join person pe on pe.id = coalesce(pr.person_id, pr.on_behalf_of_person_id, ${EVENT_PERSON})`;
const NODE_JOINS = `
  left join node n on e.resource_type = 'node' and n.id = e.resource_id
  left join lateral node_at(e.resource_id, e.occurred_at) nh on e.resource_type = 'node'`;

export const LOG_JOINS = `
  left join event_context ec on ec.event_id = e.id${PERSON_JOINS}${NODE_JOINS}`;

// avoid node_at() per row
export function filterJoins(f: LogFilters): string {
  return f.person || f.group || f.q?.trim() ? PERSON_JOINS : '';
}

export const anyFilter = (f: LogFilters) => !!(f.action || f.kind || f.person || f.group || f.node || f.q?.trim() || f.from || f.to);

// same expression as index event_data_person
const DATA_PERSON = `lower(coalesce(e.data ->> 'person_id', e.data ->> 'personId'))`;
const byAnyOf = (people: string) => `(e.actor_id in (select pr2.id from principal pr2 where pr2.person_id in (${people}) or pr2.on_behalf_of_person_id in (${people}))
      or ${DATA_PERSON} in (select y.x::text from (${people}) as y(x)))`;

export function filterSql(p: Params, ws: string, f: LogFilters): string {
  const parts = [`e.workspace_id = ${p.add(ws)}`];
  if (f.action) parts.push(`e.action = ${p.add(f.action)}`);
  else parts.push(`e.action <> all(${p.add(HOUSEKEEPING)}::text[])`);
  if (f.kind) parts.push(`e.action = any(${p.add([...KINDS[f.kind]])}::text[])`);
  if (f.person) {
    const person = p.add(f.person);
    parts.push(`pe.id = ${person}::uuid`, byAnyOf(`select ${person}::uuid`));
  }
  if (f.group) {
    const group = p.add(f.group);
    parts.push(`exists (select 1 from membership m where m.person_id = pe.id and m.group_id = ${group}::uuid and m.status = 'active'
      and m.valid_from <= e.occurred_at and e.occurred_at < m.valid_to and m.recorded_at <= e.occurred_at and e.occurred_at < m.superseded_at)`,
    byAnyOf(`select m3.person_id from membership m3 where m3.group_id = ${group}::uuid`));
  }
  if (f.node) {
    parts.push(`e.resource_type = 'node' and e.resource_id in (select b.id from node a join node b on b.path <@ a.path where a.id = ${p.add(f.node)}::uuid)`);
  }
  if (f.from) parts.push(`e.occurred_at >= ${p.add(f.from.toISOString())}::timestamptz`);
  if (f.to) parts.push(`e.occurred_at < ${p.add(f.to.toISOString())}::timestamptz`);
  const q = f.q?.trim();
  if (q) {
    const like = p.add(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const ix = p.add(`${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    parts.push(`((pe.erased_at is null and pe.name ilike ${like})
      or (e.resource_type = 'node' and exists (
            select 1 from (select 1) one left join node n2 on n2.id = e.resource_id
              left join lateral node_at(e.resource_id, e.occurred_at) h on true
             where coalesce(h.name, n2.name) ilike ${like} or coalesce(h.index_number, n2.index_number) ilike ${ix})))`);
    // narrowing only, for the index
    const w = p.add(ws);
    parts.push(`(${byAnyOf(`select px.id from person px where px.erased_at is null and px.name ilike ${like}`)}
      or (e.resource_type = 'node' and e.resource_id in (
            select h.node_id from node_history h where h.workspace_id = ${w} and (h.name ilike ${like} or h.index_number ilike ${ix})
            union select nx.id from node nx where nx.workspace_id = ${w} and (nx.name ilike ${like} or nx.index_number ilike ${ix}))))`);
  }
  return parts.join('\n and ');
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// `to` is exclusive
export function parseBound(s: string | undefined, timeZone: string, end: boolean): Date | null {
  if (!s) return null;
  const m = DATE_ONLY.exec(s);
  if (m) return zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]) + (end ? 1 : 0), 0, 0, timeZone);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${s}" is not a date. Use a date like 2026-11-12.`);
  return d;
}

export const LEVEL_WORDS: Record<number, string> = {
  0: 'No access', 10: 'Name only', 20: 'View', 30: 'Encrypted PDF', 40: 'View and print', 50: 'Download PDF', 60: 'Original',
};
export const levelWord = (l: number | null | undefined) => (l == null ? 'No access' : LEVEL_WORDS[l] ?? `Level ${l}`);

export function verbOf(action: string): { label: string; icon: string; tone: string } {
  switch (action) {
    case 'document.opened': case 'document.viewed': return { label: 'Viewed', icon: 'view', tone: 'view' };
    case 'document.downloaded': return { label: 'Downloaded', icon: 'down', tone: 'down' };
    case 'document.printed': return { label: 'Printed', icon: 'down', tone: 'down' };
    case 'document.uploaded': case 'document.version_uploaded': return { label: 'Uploaded', icon: 'up', tone: 'up' };
    case 'document.published': case 'folder.published': case 'document.version_published': return { label: 'Published', icon: 'pub', tone: 'up' };
    case 'folder.created': return { label: 'Created folder', icon: 'up', tone: 'up' };
    case 'auth.signed_in': case 'invitation.accepted': return { label: 'Signed in', icon: 'in', tone: 'access' };
    case 'agreement.accepted': return { label: 'Accepted NDA', icon: 'nda', tone: 'access' };
    case 'access.blocked': return { label: 'Blocked link', icon: 'x', tone: 'risk' };
    case 'auth.signed_out_inactive': case 'auth.signed_out_expired': return { label: 'Signed out', icon: 'in', tone: 'access' };
    default:
      if (kindOf(action) === 'access') return { label: 'Changed access', icon: 'perm', tone: 'perm' };
      return otherVerb(action);
  }
}

function otherVerb(action: string): { label: string; icon: string; tone: string } {
  const v = (label: string, tone = 'access') => ({ label, icon: 'other', tone });
  if (action === 'document.processing_failed') return v('Failed', 'risk');
  if (action === 'document.processed') return v('Processed');
  if (action === 'node.renamed' || action === 'index.renumbered') return v('Renamed');
  if (action.endsWith('withdrawn')) return v('Withdrew');
  if (action === 'activity.exported') return { label: 'Exported', icon: 'down', tone: 'down' };
  if (action === 'room.seen_as') return { label: 'Saw as', icon: 'view', tone: 'view' };
  if (action.startsWith('notification.') || action.startsWith('invitation.') || action.startsWith('auth.')) return v('Emailed');
  if (action.startsWith('workspace.') || action.startsWith('agreement.')) return v('Changed room');
  if (action === 'person.email_change_code_sent') return v('Emailed');
  if (action === 'person.email_change_code_not_sent') return v('Not sent', 'risk');
  if (action === 'person.email_change_approval_sent') return v('Emailed');
  if (action === 'person.email_change_approval_not_sent') return v('Not sent', 'risk');
  if (action === 'person.email_change_approved') return v('Agreed');
  if (action === 'person.email_change_declined') return v('Refused', 'risk');
  if (action.startsWith('person.')) return v('Changed details');
  return v('Recorded');
}

function emailOf(personal: Record<string, unknown> | null | undefined, side: 'before' | 'after'): string | null {
  const v = personal?.[side];
  if (!v || typeof v !== 'object') return null;
  const email = (v as { email?: unknown }).email;
  return typeof email === 'string' ? email : null;
}

export interface Names {
  groups: Map<string, string>;
  nodes: Map<string, { indexNumber: string | null; name: string }>;
}

// admins only, leaks hidden names
export async function loadNames(tx: SqlClient, ws: string, rows: { data: Record<string, unknown> }[]): Promise<Names> {
  const nodeIds = new Set<string>();
  for (const r of rows) {
    const cells = Array.isArray(r.data?.cells) ? (r.data.cells as { node_id?: string }[]) : [];
    for (const c of cells) if (c.node_id) nodeIds.add(c.node_id);
    if (typeof r.data?.node_id === 'string') nodeIds.add(r.data.node_id);
  }
  const groupRows = (await tx.query<{ id: string; name: string }>(`select id, name from groups where workspace_id = $1`, [ws])).rows;
  const nodeRows = (await tx.query<{ id: string; index_number: string | null; name: string }>(
    `select id, index_number, name from node where workspace_id = $1 and id = any($2::uuid[])`, [ws, [...nodeIds]])).rows;
  const groups = new Map<string, string>();
  for (const g of groupRows) groups.set(g.id, g.name);
  const nodes: Names['nodes'] = new Map();
  for (const x of nodeRows) nodes.set(x.id, { indexNumber: x.index_number, name: x.name });
  return { groups, nodes };
}

export function coverageText(c: { pagesSeen: number; pageCount: number; minutes: number }): string {
  const n = (x: number) => x.toLocaleString('en-GB');
  const pages = c.pageCount === 1 ? 'page' : 'pages';
  const time = c.minutes < 1 ? 'under a minute' : `${c.minutes} min`;
  return `${n(c.pagesSeen)} of ${n(c.pageCount)} ${pages} · ${time}`;
}

function signInMethod(method: string | null): string {
  switch (method) {
    case 'email_link': return 'Email link';
    case 'email_code': return 'Email code';
    case 'authenticator': return 'Email and authenticator code';
    default: return '';
  }
}

const BLOCKED: Record<string, string> = {
  no_access: 'Their group has no access to this document. They saw a not-found page.',
  version_hidden: 'The version they asked for is not shared with their group. They saw a not-found page.',
  withdrawn: 'The document was withdrawn. They saw a not-found page.',
  draft: 'The document is a draft. They saw a not-found page.',
};

export interface Described {
  item: string | null;
  detail: string;
}

export function describe(e: {
  action: string; data: Record<string, unknown>; resource_type: string | null; previous_levels?: (number | null)[] | null;
  agreement_version_no?: number | null; group_name?: string | null; subject_name?: string | null;
  personal?: Record<string, unknown> | null;
}, names: Names): Described {
  const d = e.data ?? {};
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
  const subject = e.subject_name ?? 'a person';
  switch (e.action) {
    case 'document.downloaded':
      return { item: null, detail: s('format') === 'original' ? 'Original file' : 'PDF with watermark' };
    case 'document.printed':
      return { item: null, detail: 'Printed with watermark' };
    case 'document.uploaded':
      return { item: null, detail: 'Draft, not visible to bidders' };
    case 'document.version_uploaded':
      return { item: null, detail: 'New version, waits for release' };
    case 'document.published':
      return { item: null, detail: 'Released to the groups with access' };
    case 'folder.published':
      return { item: null, detail: 'Folder released' };
    case 'document.version_published':
      return { item: null, detail: typeof d.version_no === 'number' ? `Version ${d.version_no} replaces the one before` : 'New version released' };
    case 'access.blocked': {
      const why = BLOCKED[s('reason') ?? ''] ?? 'They saw a not-found page.';
      return { item: null, detail: d.previouslySeen ? `Old link: they had seen it before. ${why}` : why };
    }
    case 'agreement.accepted':
      return { item: 'Accepted the confidentiality agreement', detail: e.agreement_version_no ? `Version ${e.agreement_version_no}` : '' };
    case 'agreement.version_published':
      return { item: 'Published a new NDA version', detail: d.mode === 'correction' ? 'Only people who have not accepted yet' : 'Everyone accepts again' };
    case 'invitation.accepted':
      return { item: 'Accepted the invitation', detail: '' };
    case 'auth.signed_in':
      return { item: 'Signed in', detail: signInMethod(s('method')) };
    case 'auth.signed_out_inactive':
      return { item: 'Signed out after inactivity', detail: '' };
    case 'auth.signed_out_expired':
      return { item: `Signed out ${typeof d.max_days === 'number' ? d.max_days : 30} days after signing in`, detail: '' };
    case 'grant.changed': case 'grant.reset': {
      const g = typeof d.subject_group_id === 'string' ? names.groups.get(d.subject_group_id) : undefined;
      const who = g ?? (d.subject_person_id ? 'One person' : 'A group');
      const lv = (x: unknown) => (x && typeof x === 'object' && typeof (x as { level?: unknown }).level === 'number' ? (x as { level: number }).level : null);
      const to = e.action === 'grant.reset' ? 'as the folder above' : levelWord(lv(d.after));
      return { item: null, detail: `${who}: ${levelWord(lv(d.before))} → ${to}` };
    }
    case 'grants.bulk_changed': {
      const cells = Array.isArray(d.cells) ? (d.cells as Record<string, unknown>[]) : [d];
      const words = cells.map((c, i) => {
        const who = (typeof c.group_id === 'string' && names.groups.get(c.group_id)) || (c.person_id ? 'One person' : 'A group');
        const to = c.reset ? 'as the folder above' : levelWord(typeof c.level === 'number' ? c.level : null);
        const before = e.previous_levels?.[i];
        return before !== undefined && !c.reset ? `${who}: ${levelWord(before)} → ${to}` : `${who}: ${to}`;
      });
      const nodeIds = [...new Set(cells.map((c) => c.node_id).filter((x): x is string => typeof x === 'string'))];
      const node = nodeIds.length === 1 ? names.nodes.get(nodeIds[0]!) : undefined;
      let item = `${cells.length} permission ${cells.length === 1 ? 'change' : 'changes'}`;
      if (node) item = [node.indexNumber, node.name].filter(Boolean).join(' ');
      let detail = words.join('; ');
      if (words.length > 3) detail = `${words.slice(0, 3).join('; ')}; ${words.length - 3} more`;
      return { item, detail };
    }
    case 'group.created': {
      const parent = typeof d.parent_group_id === 'string' ? names.groups.get(d.parent_group_id) : undefined;
      return { item: `Created group ${e.group_name ?? ''}`.trim(), detail: parent ? `Subgroup of ${parent}` : '' };
    }
    case 'group.revoked':
      return { item: `Closed group ${e.group_name ?? ''}`.trim(), detail: 'Everyone in it lost access' };
    case 'invitation.created':
      return { item: `Invited ${subject}`, detail: [e.group_name, s('role') === 'lead' ? 'as lead' : null,
        d.waits_for_room ? 'email sent when the room opens' : null].filter(Boolean).join(', ') };
    case 'invitation.held':
      return { item: `Invitation to ${subject} waits for the room to open`, detail: e.group_name ?? '' };
    case 'membership.role_changed':
      return { item: `${s('after') === 'lead' ? 'Made lead' : 'Made member'}: ${subject}`, detail: e.group_name ?? '' };
    case 'membership.revoked':
      return { item: `Revoked access of ${subject}`, detail: e.group_name ?? '' };
    case 'membership.restored':
      return { item: `Restored access of ${subject}`, detail: e.group_name ?? '' };
    case 'membership.expiry_changed':
      return { item: `Changed the access end date of ${subject}`, detail: '' };
    case 'team_request.approved':
      return { item: 'Approved a request to add a colleague', detail: e.group_name ?? '' };
    case 'removal_request.approved':
      return { item: 'Approved a request to remove a colleague', detail: e.group_name ?? '' };
    case 'person.email_change_requested': {
      const to = emailOf(e.personal, 'after');
      if (d.needs_approval) {
        return { item: `Asked to change the sign-in email of ${subject}`,
          detail: to ? `To ${to}. It changes once they agree at their current address and enter the code sent to the new one.`
            : 'It changes once they agree at their current address and enter the code sent to the new one.' };
      }
      return { item: `Asked to change the sign-in email of ${subject}`,
        detail: to ? `To ${to}. It changes once they enter the code sent there.` : 'It changes once they enter the code sent to the new address.' };
    }
    case 'person.email_change_approval_sent':
      return { item: `Asked ${subject} to agree to a new sign-in email`, detail: 'Sent to their current address.' };
    case 'person.email_change_approval_not_sent':
      return { item: `Could not ask ${subject} to agree to a new sign-in email`, detail: 'Ask again, or check the outgoing email in Site settings.' };
    case 'person.email_change_approved': {
      const to = emailOf(e.personal, 'after');
      return { item: `${subject} agreed to a new sign-in email`, detail: to ? `A code went to ${to}.` : '' };
    }
    case 'person.email_change_declined': {
      const from = emailOf(e.personal, 'before');
      return { item: `${subject} refused a new sign-in email`, detail: from ? `They keep ${from}.` : 'Nothing changed.' };
    }
    case 'person.email_change_code_sent':
      return { item: `Sent the code for a new sign-in email to ${subject}`, detail: '' };
    case 'person.email_change_code_not_sent':
      return { item: `Could not send the code for a new sign-in email to ${subject}`, detail: 'Ask again, or check the outgoing email in Site settings.' };
    case 'person.email_changed': {
      const from = emailOf(e.personal, 'before');
      const to = emailOf(e.personal, 'after');
      return { item: `Changed the sign-in email of ${subject}`, detail: from && to ? `${from} → ${to}` : '' };
    }
    case 'room.seen_as':
      return { item: `Saw the room as ${e.group_name ?? 'a team'}`, detail: 'Read only. Nothing they did was recorded.' };
    default: {
      const label = ACTION_LABELS[e.action] ?? e.action;
      if (e.resource_type === 'node') return { item: null, detail: label };
      return { item: label, detail: '' };
    }
  }
}
