// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { NOTIFICATION_EVENTS, partsIn, zoneAbbreviation, type SqlClient } from '@vdrkit/core';
import { browserLabel } from '../auth/sessions.js';
import { levelWord } from './activity-log.js';

export interface ProofLine { label: string; value: string; mono?: boolean }

export interface ProofRow {
  id: string; action: string; occurred_at: string | Date; resource_type: string | null; resource_id: string | null;
  data: Record<string, any>; personal: Record<string, any> | null; ip: string | null; user_agent: string | null;
  node_name: string | null; node_index_number: string | null;
  pages_list: number[] | null; page_count: number | null; minutes: number | null;
  previous_levels?: (number | null)[] | null;
}

export interface ProofLookups {
  room: string;
  timeZone: string;
  people: Map<string, string>;
  groups: Map<string, string>;
  nodes: Map<string, { indexNumber: string | null; name: string }>;
  milestones: Map<string, string>;
  versions: Map<string, number>;
  agreements: Map<string, { versionNo: number; name: string | null; sha256: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && UUID.test(x));

export async function proofLookups(tx: SqlClient, ws: string, timeZone: string, rows: ProofRow[], groups: Map<string, string>): Promise<ProofLookups> {
  const people = new Set<string>();
  const nodes = new Set<string>();
  const milestones = new Set<string>();
  const versions = new Set<string>();
  const agreements = new Set<string>();
  const collect = (set: Set<string>, v: unknown) => {
    for (const x of ids(v)) set.add(x);
  };
  for (const r of rows) {
    const d = r.data ?? {};
    collect(people, d.recipient_person_id);
    collect(people, d.person_id);
    collect(nodes, d.node_ids);
    if (Array.isArray(d.cells)) for (const c of d.cells) collect(nodes, c?.node_id);
    collect(milestones, d.milestone_id);
    collect(milestones, d.milestone_ids);
    collect(versions, d.version_id);
    if (r.action === 'agreement.accepted' && r.resource_id) agreements.add(r.resource_id);
  }
  const q = async <T>(sql: string, list: Set<string>): Promise<T[]> => {
    if (!list.size) return [];
    const { rows } = await tx.query<T>(sql, [[...list], ws]);
    return rows;
  };
  const [room, p, n, m, v, a] = await Promise.all([
    tx.query<{ name: string }>(`select name from workspace where id = $1`, [ws]).then((x) => x.rows[0]?.name ?? ''),
    q<{ id: string; name: string }>(`select id, case when erased_at is not null then 'Erased user' else name end as name from person where id = any($1::uuid[]) and $2::uuid is not null`, people),
    q<{ id: string; index_number: string | null; name: string }>(`select id, index_number, name from node where id = any($1::uuid[]) and workspace_id = $2`, nodes),
    q<{ id: string; title: string }>(`select id, title from milestone where id = any($1::uuid[]) and workspace_id = $2`, milestones),
    q<{ id: string; version_no: number }>(
      `select v.id, v.version_no from document_version v join node d on d.id = v.node_id where v.id = any($1::uuid[]) and d.workspace_id = $2`, versions),
    q<{ id: string; version_no: number; name: string | null; body: string }>(
      `select v.id, v.version_no, v.name, v.body from agreement_version v join agreement a on a.id = v.agreement_id
        where v.id = any($1::uuid[]) and a.workspace_id = $2`, agreements),
  ]);
  return {
    room, timeZone, groups,
    people: new Map(p.map((x) => [x.id, x.name])),
    nodes: new Map(n.map((x) => [x.id, { indexNumber: x.index_number, name: x.name }])),
    milestones: new Map(m.map((x) => [x.id, x.title])),
    versions: new Map(v.map((x) => [x.id, Number(x.version_no)])),
    agreements: new Map(a.map((x) => [x.id, { versionNo: Number(x.version_no), name: x.name, sha256: createHash('sha256').update(x.body, 'utf8').digest('hex') }])),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function proofTime(at: Date, timeZone: string): string {
  const p = partsIn(at, timeZone);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(at).replace(/,/g, '');
  return `${day}, ${pad(p.hour)}:${pad(p.minute)}:${pad(at.getUTCSeconds())} ${zoneAbbreviation(at, timeZone)}`;
}

function endDay(v: unknown, timeZone: string): string {
  if (typeof v !== 'string' || !v || v === 'infinity') return 'No end date';
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() > 9000) return 'No end date';
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d).replace(/,/g, '');
}

export function pageRanges(pages: number[]): string {
  const list = [...new Set(pages.filter((p) => p > 0))].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j]! + 1) j++;
    out.push(j > i ? `${list[i]}–${list[j]}` : String(list[i]));
    i = j;
  }
  return out.join(', ');
}

const MAIL_TYPES: Record<string, string> = {
  invitation: 'Invitation', invitation_reminder: 'Invitation reminder', nda_reminder: 'NDA reminder',
  colleague_request: 'Request to add a colleague', request_decision: 'Decision on a request to add a colleague',
  copy_request: 'Request for a new copy of a file', site_admin_joined: 'A site admin joined the room', access_restored: 'Access restored',
  email_change_code: 'Code to confirm a new sign-in email', email_change_approval: 'Request to agree to a new sign-in email',
  daily_summary: 'Daily summary', deadline_reminder: 'Deadline reminder',
};

function guessMailType(action: string, d: Record<string, any>): string | undefined {
  if (action.startsWith('invitation.')) return 'invitation';
  if (d.kind === 'nda_reminder') return 'nda_reminder';
  if (action === 'team_request.admin_told') return 'colleague_request';
  if (action === 'team_request.lead_told') return 'request_decision';
  if (action === 'document.copy_requested') return 'copy_request';
  if (action.startsWith('workspace.join_notice')) return 'site_admin_joined';
  if (action.startsWith('person.email_change_code')) return 'email_change_code';
  if (action.startsWith('person.email_change_approval')) return 'email_change_approval';
  if (d.category === 'summary') return 'daily_summary';
  if (d.mode === 'reminder') return 'deadline_reminder';
  return undefined;
}

function mailType(action: string, d: Record<string, any>): string {
  const t: string | undefined = d.mail_type ?? guessMailType(action, d);
  if (t && MAIL_TYPES[t]) return MAIL_TYPES[t]!;
  let categories: string[] = [];
  if (Array.isArray(d.categories) && d.categories.length) categories = d.categories;
  else if (d.category) categories = [d.category];
  const labels = categories.map((c) => NOTIFICATION_EVENTS.find((e) => e.key === c)?.label ?? c);
  return labels.length ? `Notification: ${labels.join(', ')}` : 'Notification';
}

export function mailOutcome(d: Record<string, any>): string {
  const reason = typeof d.error === 'string' && d.error ? d.error : null;
  switch (d.delivery_status) {
    case 'accepted': return d.provider_message_id ? `Accepted, message ID ${d.provider_message_id}` : 'Accepted';
    case 'failed': return `Not accepted: ${reason ?? 'no reason given'}`;
    case 'no_mailer': return 'Not sent: no mail server is set up';
    case 'switched_off': return 'Not sent: this email is switched off for them';
    case 'not_member': return 'Not sent: they are no longer in the room';
    case 'in_summary': return 'Not sent now: it goes in their daily summary';
    case 'unknown': return `Unknown: ${reason ?? 'the outcome never came back'}`;
    default:
      if (typeof d.delivery_status !== 'string') return reason ?? 'Not recorded';
      return reason ? `${d.delivery_status}: ${reason}` : d.delivery_status;
  }
}

const isEmail = (action: string, d: Record<string, any>) =>
  d.channel === 'email' || ((action === 'notification.sent' || action === 'notification.failed') && 'delivery_status' in d);

function documentList(list: string[], l: ProofLookups): string | null {
  const named: string[] = [];
  for (const id of list) {
    const node = l.nodes.get(id);
    if (node) named.push([node.indexNumber, node.name].filter(Boolean).join(' '));
  }
  if (!named.length) return null;
  if (named.length <= 6) return named.join('; ');
  return `${named.slice(0, 6).join('; ')}; and ${named.length - 6} more`;
}

const roleWord = (r: unknown) => (r === 'lead' ? 'Lead' : r === 'admin' ? 'Room admin' : 'Member');

export function proofOf(r: ProofRow, l: ProofLookups): ProofLine[] | null {
  const d = r.data ?? {};
  const pers = r.personal ?? {};
  const at = new Date(r.occurred_at);
  const out: ProofLine[] = [];
  const add = (label: string, value: string | null | undefined, mono = false) => {
    if (!value) return;
    const line: ProofLine = { label, value };
    if (mono) line.mono = true;
    out.push(line);
  };
  const ip = r.ip ? r.ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/\/(32|128)$/, '') : null;
  const group = (id: unknown) => (typeof id === 'string' ? l.groups.get(id) ?? null : null);

  if (isEmail(r.action, d)) {
    add('Email', mailType(r.action, d));
    const name = typeof d.recipient_person_id === 'string' ? l.people.get(d.recipient_person_id) : undefined;
    add('To', [name, typeof pers.to === 'string' ? pers.to : null].filter(Boolean).join(', '));
    add('Subject', typeof pers.subject === 'string' ? pers.subject : null);
    const docs = documentList(ids(d.node_ids), l);
    add(docs && ids(d.node_ids).length > 1 ? 'Documents' : 'Document', docs);
    const dates = [...ids(d.milestone_id), ...ids(d.milestone_ids)].map((id) => l.milestones.get(id)).filter(Boolean);
    add(dates.length > 1 ? 'Dates' : 'Date', dates.length ? [...new Set(dates)].join('; ') : null);
    add('Room', l.room);
    add('Mail server', mailOutcome(d), d.delivery_status === 'accepted' && !!d.provider_message_id);
    add('Sent at', proofTime(at, l.timeZone));
    return out;
  }

  switch (r.action) {
    case 'agreement.accepted': {
      const v = r.resource_id ? l.agreements.get(r.resource_id) : undefined;
      const no = typeof d.version_no === 'number' ? d.version_no : v?.versionNo;
      const name = typeof d.version_name === 'string' ? d.version_name : v?.name;
      add('NDA version', no ? `Version ${no}${name ? `, ${name}` : ''}` : null);
      add('Text fingerprint (SHA-256)', typeof d.text_sha256 === 'string' ? d.text_sha256 : v?.sha256, true);
      add('Accepted at', proofTime(typeof d.accepted_at === 'string' ? new Date(d.accepted_at) : at, l.timeZone));
      add('IP address', ip, true);
      add('Browser', r.user_agent ? browserLabel(r.user_agent) : null);
      return out;
    }
    case 'document.opened': case 'document.viewed': {
      const no = typeof d.version_id === 'string' ? l.versions.get(d.version_id) : undefined;
      add('Version', no ? `Version ${no}` : null);
      const count = r.page_count ?? (typeof d.page_count === 'number' ? d.page_count : null);
      const seen = r.pages_list ?? [];
      if (count !== null) add('Pages viewed', seen.length ? `${seen.length} of ${count}: ${pageRanges(seen)}` : `None of ${count} yet`);
      if (r.minutes !== null) add('Time spent', r.minutes < 1 ? 'Under a minute' : `${r.minutes} min`);
      add('Opened at', proofTime(at, l.timeZone));
      add('IP address', ip, true);
      return out;
    }
    case 'document.downloaded': case 'document.printed': {
      const no = typeof d.version_id === 'string' ? l.versions.get(d.version_id) : undefined;
      add('Version', no ? `Version ${no}` : null);
      const original = d.format === 'original';
      add('Format', original ? 'Original file, unchanged' : r.action === 'document.printed' ? 'Printed with watermark' : 'PDF with watermark');
      const marks = Array.isArray(pers.watermark) ? (pers.watermark as unknown[]).filter((x) => typeof x === 'string').join(' · ') : null;
      add('Watermark', original ? 'None: the original file is never stamped' : marks || null);
      add('File fingerprint (SHA-256)', typeof d.sha256 === 'string' ? d.sha256 : null, true);
      add('Part of the file', typeof d.range === 'string' ? d.range : null);
      add('Downloaded at', proofTime(at, l.timeZone));
      add('IP address', ip, true);
      return out;
    }
    case 'grant.changed': case 'grant.reset': {
      const lv = (x: any) => (x && typeof x.level === 'number' ? x.level : null);
      add('Group', group(d.subject_group_id) ?? (d.subject_person_id ? (l.people.get(d.subject_person_id) ?? 'One person') : null));
      add('Folder or document', [r.node_index_number, r.node_name].filter(Boolean).join(' ') || null);
      add('Before', levelWord(lv(d.before)));
      add('After', r.action === 'grant.reset' ? 'As the folder above' : levelWord(lv(d.after)));
      return out;
    }
    case 'grants.bulk_changed': {
      const cells: any[] = Array.isArray(d.cells) ? d.cells : [];
      for (const [i, c] of cells.slice(0, 50).entries()) {
        const who = group(c.group_id) ?? (c.person_id ? l.people.get(c.person_id) ?? 'One person' : 'A group');
        const node = typeof c.node_id === 'string' ? l.nodes.get(c.node_id) : undefined;
        const where = node ? [node.indexNumber, node.name].filter(Boolean).join(' ') : 'a folder';
        let was = typeof c.before_level === 'number' ? c.before_level : undefined;
        if (was === undefined && !c.reset) was = r.previous_levels?.[i];
        const before = typeof was === 'number' ? levelWord(was) : null;
        let after: string;
        if (typeof c.after_level === 'number') after = levelWord(c.after_level);
        else if (c.reset) after = 'As the folder above';
        else after = levelWord(typeof c.level === 'number' ? c.level : null);
        add(`${who}, ${where}`, before ? `${before} → ${after}` : after);
      }
      if (cells.length > 50) add('More', `${cells.length - 50} more changes in the same save`);
      return out.length ? out : null;
    }
    case 'membership.role_changed':
      add('Group', group(d.group_id));
      add('Before', roleWord(d.before));
      add('After', roleWord(d.after));
      return out;
    case 'membership.expiry_changed':
      add('Before', endDay(d.before, l.timeZone));
      add('After', endDay(d.after, l.timeZone));
      return out;
    case 'membership.revoked':
      add('Group', group(d.group_id));
      add('Before', `${d.role ? roleWord(d.role) : 'Member'} of ${group(d.group_id) ?? 'the group'}`);
      add('After', 'No access');
      return out;
    case 'membership.restored': {
      const end = endDay(d.valid_to, l.timeZone);
      add('Group', group(d.group_id));
      add('Before', 'No access, revoked');
      add('After', `${roleWord(d.role)} of ${group(d.group_id) ?? 'the group'}, ${end === 'No end date' ? 'no end date' : `until ${end}`}`);
      return out;
    }
    case 'invitation.created':
      add('Group', group(d.group_id));
      add('Role', roleWord(d.role));
      add('Access ends', d.access_expires_at ? endDay(d.access_expires_at, l.timeZone) : null);
      return out;
    case 'group.details_changed': {
      const before = (d.before ?? {}) as Record<string, unknown>;
      const after = (d.after ?? {}) as Record<string, unknown>;
      const words: Record<string, string> = { name: 'Name', organisation: 'Organisation', accessEndsAt: 'End date', valid_to: 'End date' };
      const show = (k: string, v: unknown) => {
        if (k === 'accessEndsAt' || k === 'valid_to') return endDay(v, l.timeZone);
        return v == null || v === '' ? '(none)' : String(v);
      };
      for (const k of Object.keys(after)) {
        if (before[k] === after[k]) continue;
        add(words[k] ?? k, `${show(k, before[k])} → ${show(k, after[k])}`);
      }
      return out.length ? out : null;
    }
    case 'team_request.approved': case 'removal_request.approved':
      add('Group', group(d.group_id));
      return out.length ? out : null;
    default:
      return null;
  }
}

export const proofText = (lines: ProofLine[] | null | undefined) => (lines ?? []).map((x) => `${x.label}: ${x.value}`).join(' | ');
