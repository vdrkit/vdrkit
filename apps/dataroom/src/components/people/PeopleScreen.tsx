// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import { roomHref } from '@/components/room/routes';
import {
  ChangeEmailDialog, DeclineDialog, EditGroupDialog, EditPersonDialog, EndDateDialog, InviteDialog, ResetTwoFactorDialog, RestoreAccessDialog, RevokeGroupDialog, RevokeMemberDialog,
} from './dialogs';
import {
  firstName, groupsOf, hasEnded, longDay, noName, problemText, statusOf, waitingIn, whenShort,
  type ApiMember, type ColleagueRequest, type Folder, type Group, type PeopleData, type Removal, type Side,
} from './model';
import { NewGroupDialog, type NewGroupStart } from './NewGroupDialog';
import { I, Menu, Toast, type MenuItem } from './ui';
import { formatDay } from '@/lib/time';
import { onTabListKeys } from '@/lib/a11y';

export interface PeopleScreenProps {
  ws: string;
  people: PeopleData;
  requests: ColleagueRequest[];
  removals: Removal[];
  invitation: { message: string; leadParagraph: string };
  folders: Folder[];
  myPersonId: string;
  timeZone: string;
  roomTz: string;
  now: string;
  roomHolds: boolean;
}

type DialogState =
  | { kind: 'new'; start: NewGroupStart }
  | { kind: 'invite'; groupId: string; mails?: string }
  | { kind: 'edit'; group: Group }
  | { kind: 'decline'; request: ColleagueRequest }
  | { kind: 'revokeGroup'; group: Group }
  | { kind: 'revokeMember'; member: ApiMember; group: Group }
  | { kind: 'restore'; member: ApiMember; group: Group }
  | { kind: 'until'; member: ApiMember; group: Group }
  | { kind: 'person'; member: ApiMember }
  | { kind: 'twofa'; member: ApiMember }
  | { kind: 'email'; member: ApiMember };

export function PeopleScreen(p: PeopleScreenProps) {
  const router = useRouter();
  const now = useMemo(() => new Date(p.now), [p.now]);
  const groups = useMemo(() => groupsOf(p.people, now), [p.people, now]);
  const [side, setSide] = useState<Side>('bid');
  const firstWaiting = groups.find((g) => g.side === 'bid' && !g.revoked && waitingIn(g, p.roomTz, now) > 0);
  const [open, setOpen] = useState<Record<string, boolean>>(firstWaiting ? { [firstWaiting.id]: true } : {});
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[]; key: string } | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState<{ title: string; text: string; key: number; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = (title: string, text: string, error = false) => {
    setToast({ title, text, key: Date.now(), error });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4200);
  };
  const done = (title: string, text: string) => { setDialog(null); say(title, text); router.refresh(); };
  const fail = (error: unknown, fallback: string) => say('Not done', problemText(error, fallback), true);
  const api = browserApi();
  const path = { ws: p.ws };

  const sellerParty = p.people.parties.find((x) => x.kind === 'seller')?.id ?? null;
  const list = groups.filter((g) => g.side === side);
  const bidGroups = groups.filter((g) => g.side === 'bid');
  const nb = bidGroups.filter((g) => !g.revoked && !g.ended).length;
  const nr = bidGroups.filter((g) => g.revoked).length;
  const ns = groups.filter((g) => g.side === 'sell' && !g.revoked && !g.ended).length;
  const subsOf = (g: Group) => groups.filter((x) => x.parentId === g.id && !x.revoked && !x.ended);
  const defaultUntil = (() => {
    const c = new Map<string, number>();
    for (const g of bidGroups) if (g.until && !g.revoked && !g.ended) c.set(g.until, (c.get(g.until) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  })();
  const defaultInviteGroup = () => (groups.find((g) => g.side === side && !g.revoked && !g.ended && !g.admin)
    ?? groups.find((g) => !g.revoked && !g.ended))?.id;

  async function run(key: string, call: () => Promise<{ data?: unknown; error?: unknown }>, ok: [string, string], fallback: string) {
    if (running.current.has(key)) return;
    running.current.add(key);
    setBusy(key);
    const r = await call();
    running.current.delete(key);
    setBusy(null);
    if (r.data === undefined) { fail(r.error, fallback); return; }
    say(ok[0], ok[1]);
    router.refresh();
  }

  const approve = (r: ColleagueRequest) => run(`rq-${r.id}`,
    () => api.POST('/v1/workspaces/{ws}/team-requests/{id}/decide', { params: { path: { ...path, id: r.id } }, body: { decision: 'approve' } }),
    [`${r.name} invited to ${r.groupName}`, `${r.requestedBy} gets an email that the request was approved. ${r.name} gets the standard invitation.`],
    'The request could not be approved.');
  const decideRemoval = (r: Removal, decision: 'approve' | 'decline') => run(`rm-${r.id}`,
    () => api.POST('/v1/workspaces/{ws}/removal-requests/{id}/decide', { params: { path: { ...path, id: r.id } }, body: { decision } }),
    decision === 'approve' ? [`Access revoked for ${r.name}`, `${r.name} no longer has access to ${r.groupName}. Logged in Activity.`]
      : [`${r.name} keeps access`, `The request from ${r.requestedBy} is closed. Logged in Activity.`],
    'The request could not be settled.');
  const remind = (m: ApiMember) => run(`rd-${m.membershipId}`,
    () => api.POST('/v1/workspaces/{ws}/memberships/{id}/remind', { params: { path: { ...path, id: m.membershipId } } }),
    [`Reminder sent to ${m.name}`, m.status === 'active' ? 'They are asked to sign in and accept the NDA. Logged in Activity.'
      : 'They get their invitation link again. Logged in Activity.'],
    'The reminder could not be sent.');
  const setRole = (m: ApiMember, g: Group, lead: boolean) => void run(`rl-${m.membershipId}`,
    () => api.POST(lead ? '/v1/workspaces/{ws}/memberships/{id}/make-lead' : '/v1/workspaces/{ws}/memberships/{id}/make-member',
      { params: { path: { ...path, id: m.membershipId } } }),
    lead ? [`${m.name} is now a lead of ${g.name}`, `${firstName(m)} may now request colleagues. Logged in Activity.`]
      : [`${m.name} is now a member of ${g.name}`, 'They can no longer request colleagues. Logged in Activity.'],
    'The role could not be changed.');

  function groupMenu(g: Group, anchor: HTMLElement) {
    const items: MenuItem[] = [];
    if (g.revoked || g.ended) {
      const start: NewGroupStart = { side: g.side, name: g.name, organisation: g.organisation ?? '', copyFrom: g.id };
      if (g.parentId) start.parentId = g.parentId;
      items.push({ label: 'Invite people again', onSelect: () => setDialog({ kind: 'new', start }) });
    } else {
      items.push({ label: 'Edit details and end date', onSelect: () => setDialog({ kind: 'edit', group: g }) });
      items.push({ label: 'Invite people', onSelect: () => setDialog({ kind: 'invite', groupId: g.id }) });
      if (g.side === 'bid' && !g.parentId) {
        items.push({ label: 'Add subgroup', onSelect: () => setDialog({ kind: 'new', start: { side: 'bid', parentId: g.id } }) });
      }
      items.push({ label: 'Change access in Permissions', onSelect: () => router.push(`${roomHref(p.ws, 'permissions')}?group=${g.id}`) });
      if (!g.admin) items.push({ label: 'Revoke access', danger: true, separated: true, onSelect: () => setDialog({ kind: 'revokeGroup', group: g }) });
    }
    setMenu({ anchor, items, key: g.id });
  }

  function memberItems(m: ApiMember, g: Group): MenuItem[] {
    const ended = hasEnded(m, g);
    // disabled by a site admin: revoke or fix details only
    const off = m.disabled;
    const items: MenuItem[] = [];
    // subgroups have no leads; treat any as members
    if (!ended && !off && !g.admin && !g.parentId) {
      items.push(m.role === 'lead'
        ? { label: 'Make member, no longer a lead', onSelect: () => setRole(m, g, false) }
        : { label: `Make lead of ${g.name}`, onSelect: () => setRole(m, g, true) });
    }
    if (!ended && !off && !g.admin) items.push({ label: `Change end date for ${noName(m) ? m.email : firstName(m)}`, onSelect: () => setDialog({ kind: 'until', member: m, group: g }) });
    // site admins, and people in rooms we don't run, are the site admin's
    if (!m.siteAdmin && !m.otherRooms) items.push({ label: 'Edit name, company and role', onSelect: () => setDialog({ kind: 'person', member: m }) });
    if (!ended && !off && !m.siteAdmin && !m.otherRooms && (m.status === 'active' || m.status === 'invited' || m.status === 'link_expired')) {
      items.push({ label: 'Change email', onSelect: () => setDialog({ kind: 'email', member: m }) });
    }
    if (!ended && !off && m.status === 'active' && !m.siteAdmin && !m.otherRooms && m.personId !== p.myPersonId) {
      items.push({ label: 'Reset two-factor sign-in', onSelect: () => setDialog({ kind: 'twofa', member: m }) });
    }
    if (!ended && m.personId !== p.myPersonId) items.push({ label: 'Revoke access', danger: true, separated: items.length > 0, onSelect: () => setDialog({ kind: 'revokeMember', member: m, group: g }) });
    if (m.status === 'revoked' && !off && !g.revoked && !g.ended) {
      // never accepted: Restore refuses, needs a new link
      items.push(m.neverAccepted
        ? { label: 'Invite again', separated: items.length > 0, onSelect: () => setDialog({ kind: 'invite', groupId: g.id, mails: m.email }) }
        : { label: 'Restore access', separated: items.length > 0, onSelect: () => setDialog({ kind: 'restore', member: m, group: g }) });
    }
    return items;
  }

  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  function groupRow(g: Group): ReactNode {
    const isOpen = !!open[g.id];
    const waiting = g.revoked || g.ended ? 0 : waitingIn(g, p.roomTz, now);
    const parent = g.parentId ? groups.find((x) => x.id === g.parentId) : null;
    const sub = g.revoked
      ? <small style={{ color: 'var(--danger)' }}>Revoked {g.revokedAt ? formatDay(g.revokedAt, p.timeZone, now) : ''}{g.revokedBy ? ` by ${g.revokedBy}` : ''}{g.revokedReason ? `, ${g.revokedReason}` : ''}</small>
      : <small>{[g.organisation, parent ? `subgroup of ${parent.name}, never more than its rights` : null, g.note].filter(Boolean).join(' · ')}</small>;
    const menuOpen = menu?.key === g.id;
    let until = g.until ? `Access until ${longDay(g.until, p.roomTz)}` : 'No end date';
    if (g.revoked) until = '';
    else if (g.ended) until = `Access ended ${g.until ? longDay(g.until, p.roomTz) : ''}`;
    else if (g.admin) until = '';
    return (
      <div key={g.id} className={`grp${g.parentId ? ' sub' : ''}${g.revoked || g.ended ? ' revoked' : ''}`} data-group={g.name}>
        {/* chevron is the keyboard target; no nested buttons */}
        <div className="gh" onClick={(e) => { if (!(e.target as HTMLElement).closest('.icon-btn, .menu, .tg')) toggle(g.id); }}>
          <button type="button" className="tg" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the people in ${g.name}`}
            onClick={() => toggle(g.id)}>{isOpen ? I.chevD : I.chevR}</button>
          <span className="gn"><b><i style={{ background: g.colour }} />{g.name}</b>{sub}</span>
          <span className="cnts"><b>{g.members.length}</b> {g.members.length === 1 ? 'person' : 'people'}{waiting ? <> · <span style={{ color: 'var(--warn)' }}>{waiting} waiting</span></> : null}</span>
          <span className={`until${g.soon ? ' soon' : ''}`}>
            {until}
          </span>
          <span className="mwrap">
            <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`Actions for ${g.name}`}
              title={g.revoked || g.ended ? 'Invite people again' : 'Edit details, invite, add subgroup, revoke'}
              onClick={(e) => { e.stopPropagation(); if (menuOpen) setMenu(null); else groupMenu(g, e.currentTarget); }}>{I.more}</button>
          </span>
        </div>
        {isOpen ? (
          <div className="mem">
            <div className="mt" role="table" aria-label={`People in ${g.name}`}>
              <div className="mr h" role="row"><span role="columnheader">Person</span><span role="columnheader">Role</span><span role="columnheader">Status</span><span role="columnheader">Last signed in</span><span role="columnheader"><span className="sr-only">Actions</span></span></div>
              {g.members.length === 0 ? <div className="mr" role="row"><span className="st" role="cell" style={{ gridColumn: '1 / -1' }}>Nobody in {g.name} yet.</span></div> : null}
              {g.members.map((m) => {
                const st = statusOf(m, g, p.roomTz, now, p.timeZone);
                const mOpen = menu?.key === `${g.id}|${m.membershipId}`;
                const items = memberItems(m, g);
                const unnamed = noName(m);
                const lead = m.role === 'lead' && !g.parentId;
                let role = 'Member';
                if (lead) role = 'Lead';
                else if (m.role === 'admin') role = 'Admin';
                return (
                  <div className="mr" role="row" key={m.membershipId} data-person={m.email}>
                    <span className="pn" role="cell">
                      <b title={unnamed ? m.email : m.name}>{unnamed ? m.email : m.name}</b>
                      <small title={unnamed ? undefined : m.email}>{unnamed ? 'Gives their name when accepting' : m.email}</small>
                    </span>
                    <span role="cell" className={`role${lead ? ' lead' : ''}`}>{role}</span>
                    <span role="cell" className={`st ${st.kind}`}>
                      {st.text}
                      {st.remind && !g.revoked ? <> · <button type="button" className="linkbtn" style={{ fontSize: 12.5 }} disabled={busy === `rd-${m.membershipId}`}
                        onClick={() => remind(m)} aria-label={`Remind ${m.name}`}>Remind</button></> : null}
                    </span>
                    <span role="cell" className="st">{m.lastSignedInAt ? whenShort(m.lastSignedInAt, p.timeZone, now) : '–'}</span>
                    <span className="mwrap" role="cell">
                      {items.length ? (
                        <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={mOpen} aria-label={`Actions for ${noName(m) ? m.email : m.name}`}
                          title={g.parentId ? 'Change end date, edit details, revoke' : 'Make lead, change end date, edit details, revoke'}
                          onClick={(e) => { if (mOpen) setMenu(null); else setMenu({ anchor: e.currentTarget, items, key: `${g.id}|${m.membershipId}` }); }}>{I.more}</button>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
            {g.revoked || g.ended ? (
              <div className="gacts"><span className="cap">Their activity stays in the log. Restoring access needs a new invitation.</span></div>
            ) : (
              <div className="gacts">
                <button type="button" className="btn secondary sm" onClick={() => setDialog({ kind: 'invite', groupId: g.id })}>{I.mail}Invite people to {g.name}</button>
                <Link href={`${roomHref(p.ws, 'permissions')}?group=${g.id}`} className="btn secondary sm">{I.perm}What {g.name} can access</Link>
                <Link href={`${roomHref(p.ws, 'activity')}?group=${g.id}`} className="btn secondary sm">{I.act}Their activity</Link>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  const nReq = p.requests.length;
  return (
    <div className="e1">
      <div className="head">
        <div>
          <p className="over">Administration</p>
          <h1>People</h1>
          <p className="sub">Who is in the room, in which group, and until when. What each group can see is set in Permissions.</p>
        </div>
        <div className="acts">
          <button type="button" className="btn secondary" onClick={() => { const id = defaultInviteGroup(); if (id) setDialog({ kind: 'invite', groupId: id }); }}
            disabled={!defaultInviteGroup()}>{I.mail}Invite people</button>
          <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'new', start: { side } })}>{I.plus}New group</button>
        </div>
      </div>

      {nReq ? (
        <section className="req" aria-label="Access requests">
          <div className="req-h"><h2>{nReq} {nReq === 1 ? 'person is' : 'people are'} waiting for access</h2><span className="cap">The lead who asked is told by email either way</span></div>
          {p.requests.map((r) => (
            <div className="rq" key={r.id}>
              <div>
                <b>{r.name}</b> for {r.groupName}, requested by {r.requestedBy} · {whenShort(r.createdAt, p.timeZone, now)}
                <small>{[r.jobTitle && r.company ? `${r.jobTitle}, ${r.company}` : r.jobTitle || r.company, r.email].filter(Boolean).join(' · ')}</small>
                {r.reason ? <small><q>{r.reason}</q></small> : null}
              </div>
              <div className="btns">
                <button type="button" className="btn secondary sm" onClick={() => setDialog({ kind: 'decline', request: r })} disabled={busy === `rq-${r.id}`}>Decline</button>
                <button type="button" className="btn primary sm" onClick={() => approve(r)} disabled={busy === `rq-${r.id}`}>Approve and invite</button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {p.removals.length ? (
        <section className="req" aria-label="Requests to remove a colleague">
          <div className="req-h"><h2>{p.removals.length === 1 ? 'A lead asks to remove a colleague' : `Leads ask to remove ${p.removals.length} colleagues`}</h2>
            <span className="cap">They keep access until you decide. The lead is not emailed</span></div>
          {p.removals.map((r) => (
            <div className="rq" key={r.id}>
              <div>
                <b>{r.name}</b> in {r.groupName}, asked by {r.requestedBy} · {whenShort(r.createdAt, p.timeZone, now)}
                {r.reason ? <small><q>{r.reason}</q></small> : null}
              </div>
              <div className="btns">
                <button type="button" className="btn secondary sm" onClick={() => decideRemoval(r, 'decline')} disabled={busy === `rm-${r.id}`}>Keep access</button>
                <button type="button" className="btn primary sm" onClick={() => decideRemoval(r, 'approve')} disabled={busy === `rm-${r.id}`}>Revoke access</button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="panel tabbed">
        <div className="tabs">
          <div className="tabs-l" role="tablist" aria-label="Whose groups" onKeyDown={onTabListKeys}>
            <button type="button" role="tab" id="e1-tab-bid" aria-controls="e1-panel" aria-selected={side === 'bid'} tabIndex={side === 'bid' ? 0 : -1} onClick={() => setSide('bid')}>
              {I.bid}Bidders <span>{nb} {nb === 1 ? 'group' : 'groups'}{nr ? `, ${nr} revoked` : ''}</span></button>
            <button type="button" role="tab" id="e1-tab-sell" aria-controls="e1-panel" aria-selected={side === 'sell'} tabIndex={side === 'sell' ? 0 : -1} onClick={() => setSide('sell')}>
              {I.sell}Seller team <span>{ns} {ns === 1 ? 'group' : 'groups'}</span></button>
          </div>
          <span className="tabs-r">
            {list.length ? (list.every((g) => open[g.id])
              ? <button type="button" className="linkbtn" onClick={() => setOpen((o) => ({ ...o, ...Object.fromEntries(list.map((g) => [g.id, false])) }))}>Close all groups</button>
              : <button type="button" className="linkbtn" onClick={() => setOpen((o) => ({ ...o, ...Object.fromEntries(list.map((g) => [g.id, true])) }))}>Open all groups</button>) : null}
          </span>
        </div>
        <div role="tabpanel" id="e1-panel" aria-labelledby={side === 'bid' ? 'e1-tab-bid' : 'e1-tab-sell'}>
        {list.length ? list.map(groupRow) : (
          <div className="empty">
            <span className="ei">{I.bid}</span>
            <h2>No bidder groups yet</h2>
            <p>Create one group per bidder, such as Orrinby Capital. You then add its people and choose a lead, who can ask for colleagues to be added.</p>
            <div className="row"><button type="button" className="btn primary" onClick={() => setDialog({ kind: 'new', start: { side: 'bid' } })}>Create a bidder group</button></div>
          </div>
        )}
        </div>
      </section>

      {menu ? <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} /> : null}

      {dialog?.kind === 'new' ? (
        <NewGroupDialog ws={p.ws} start={dialog.start} groups={groups} folders={p.folders} sellerPartyId={sellerParty} roomTz={p.roomTz}
          standard={p.invitation.message} leadParagraph={p.invitation.leadParagraph} defaultUntil={defaultUntil} roomHolds={p.roomHolds}
          onClose={() => setDialog(null)} onCreated={() => router.refresh()} />
      ) : null}
      {dialog?.kind === 'invite' ? (
        <InviteDialog ws={p.ws} roomTz={p.roomTz} groups={groups} groupId={dialog.groupId} mails={dialog.mails} standard={p.invitation.message} leadParagraph={p.invitation.leadParagraph}
          roomHolds={p.roomHolds} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog?.kind === 'edit' ? <EditGroupDialog ws={p.ws} roomTz={p.roomTz} group={dialog.group} subgroups={subsOf(dialog.group)} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === 'decline' ? <DeclineDialog ws={p.ws} request={dialog.request} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === 'revokeGroup' ? <RevokeGroupDialog ws={p.ws} group={dialog.group} subgroups={subsOf(dialog.group)} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === 'revokeMember' ? <RevokeMemberDialog ws={p.ws} member={dialog.member} group={dialog.group} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === 'restore' ? <RestoreAccessDialog ws={p.ws} member={dialog.member} group={dialog.group} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === 'until' ? <EndDateDialog ws={p.ws} roomTz={p.roomTz} member={dialog.member} group={dialog.group} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === 'person' ? <EditPersonDialog ws={p.ws} member={dialog.member} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === 'email' ? <ChangeEmailDialog ws={p.ws} member={dialog.member} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === 'twofa' ? <ResetTwoFactorDialog ws={p.ws} member={dialog.member} onClose={() => setDialog(null)} onDone={done} /> : null}

      <Toast toast={toast} />
    </div>
  );
}
