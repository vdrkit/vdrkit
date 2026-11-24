// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { browserApi } from '@/api/browser';
import { roomHref } from '@/components/room/routes';
import { useSendOnce } from '@/lib/send-once';
import { InviteFields, peopleToInvite, type InviteState } from './InviteFields';
import {
  dayInput, endOfDay, firstName, isEmail, longDay, noName, problemText, untilWords,
  type ApiMember, type ColleagueRequest, type Group,
} from './model';
import { Dlg, ErrorLine } from './ui';

type Done = (title: string, text: string) => void;

interface Common { ws: string; roomTz: string; onClose: () => void; onDone: Done }

export function InviteDialog({ ws, roomTz, onClose, onDone, groups, groupId, mails = '', standard, leadParagraph, roomHolds }: Common & {
  groups: Group[]; groupId: string; mails?: string; standard: string; leadParagraph: string;
  roomHolds: boolean;
}) {
  const open = groups.filter((g) => !g.revoked && !g.ended);
  const [gid, setGid] = useState(groupId);
  const g = open.find((x) => x.id === gid) ?? open[0]!;
  const leadsOf = (x: Group) => x.members.filter((m) => m.role === 'lead' && m.status !== 'revoked' && m.status !== 'expired').map((m) => m.name);
  const memberFirst = (x: Group) => !!(leadsOf(x).length || x.admin || x.parentId);
  const [inv, setInv] = useState<InviteState>({ mails, lead: '', tab: mails || memberFirst(g) ? 'member' : 'lead', msg: null });
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const filled = standard.split('{until}').join(untilWords(g.until, roomTz));
  const people = peopleToInvite(inv, !!g.parentId);
  const nl = people.filter((p) => p.role === 'lead').length;
  const waits = roomHolds && g.side === 'bid';

  const send = once(async () => {
    const bad = people.map((p) => p.email).filter((e) => !isEmail(e));
    if (bad.length) { setError(`Check these addresses: ${bad.join(', ')}.`); return; }
    setBusy(true);
    setError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/invitations', { params: { path: { ws } }, body: {
      groupId: g.id, people, role: 'member', accessExpiresAt: null, message: inv.msg !== null && inv.msg !== filled ? inv.msg : null } });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'The invitations could not be sent.')); return; }
    const n = r.data.invitations.length;
    const leads = nl ? `, ${nl} ${nl === 1 ? 'of them as lead' : 'of them as leads'}` : '';
    if (r.data.invitations.some((i) => i.waits)) {
      onDone(`${n} ${n === 1 ? 'invitation waits' : 'invitations wait'} for the room to open`, `To ${g.name}${leads}. They are sent when you open the room. Logged in Activity.`);
      return;
    }
    onDone(`${n} ${n === 1 ? 'invitation' : 'invitations'} sent`, `To ${g.name}${leads}. Logged in Activity.`);
  });

  return (
    <Dlg over="People" title="Invite people" onClose={onClose} busy={busy} focus={inv.tab === 'lead' ? '#iv-lead' : '#iv-mails'}
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={send} disabled={busy || !people.length}>
          {waits ? (people.length ? `Invite ${people.length} when the room opens` : 'Invite when the room opens')
            : people.length ? `Send ${people.length} ${people.length === 1 ? 'invitation' : 'invitations'}` : 'Send invitations'}</button></>}>
      <label className="fld"><span>Group</span>
        <select className="sel" id="iv-group" value={g.id} onChange={(e) => {
          const x = open.find((y) => y.id === e.target.value)!;
          setGid(x.id);
          setInv({ ...inv, tab: memberFirst(x) ? 'member' : 'lead', msg: inv.msg !== null && inv.msg !== filled ? inv.msg : null });
        }}>
          {open.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <p className="hint">They get exactly what {g.name} can see. {g.until ? `Access until ${longDay(g.until, roomTz)}, the end date of the group.` : `${g.name} has no end date.`}</p>
      </label>
      <InviteFields state={inv} onChange={setInv} groupName={g.name} leads={leadsOf(g)} standard={filled}
        leadParagraph={leadParagraph.split('{group}').join(g.name)} settingsHref={roomHref(ws, 'settings')} noLeads={!!g.parentId} />
      {g.parentId ? null : <p className="hint">To make someone already in {g.name} a lead, use the ⋯ menu beside their name.</p>}
      {waits ? <p className="hint" data-testid="invite-waits">The room is not open yet, so no email goes out now. The invitations are sent when you open the room in Settings.</p> : null}
      <ErrorLine text={error} />
    </Dlg>
  );
}

export function EditGroupDialog({ ws, roomTz, onClose, onDone, group, subgroups }: Common & { group: Group; subgroups: Group[] }) {
  const [name, setName] = useState(group.name);
  const [org, setOrg] = useState(group.organisation ?? '');
  const [until, setUntil] = useState(dayInput(group.until, roomTz));
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const people = group.members.filter((m) => m.status !== 'revoked' && m.status !== 'expired').length;

  const save = once(async () => {
    setBusy(true);
    setError(null);
    // only if the day changed, or a rename would move the end of access
    const dayChanged = !group.admin && until !== dayInput(group.until, roomTz);
    let accessEndsAt = group.until;
    if (dayChanged) accessEndsAt = until ? endOfDay(until, roomTz) : null;
    const body: { name: string; organisation: string | null; accessEndsAt?: string | null } = { name: name.trim(), organisation: org.trim() || null };
    if (dayChanged) body.accessEndsAt = accessEndsAt;
    const r = await browserApi().PATCH('/v1/workspaces/{ws}/groups/{id}', { params: { path: { ws, id: group.id } }, body });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'The group could not be saved.')); return; }
    onDone(`${name.trim()} updated`, group.admin ? 'Logged in Activity.' : `Access until ${accessEndsAt ? longDay(accessEndsAt, roomTz) : 'no end date'}. Logged in Activity.`);
  });

  return (
    <Dlg over="Edit details" title={group.name} onClose={onClose} busy={busy} focus={group.admin ? '#ed-name' : '#ed-until'}
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !name.trim()}>Save</button></>}>
      <label className="fld"><span>Name</span><input className="tin" id="ed-name" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="fld"><span>Organisation</span><input className="tin" id="ed-org" value={org} onChange={(e) => setOrg(e.target.value)} /></label>
      {group.admin ? null : (
        <label className="fld"><span>Access until</span>
          <input className="tin" type="date" id="ed-until" value={until} style={{ maxWidth: 220 }} onChange={(e) => setUntil(e.target.value)} /></label>
      )}
      <ul className="facts">
        {group.admin ? <li>Room admins keep access until the room closes, so the group has no end date.</li> : (
          <>
            <li>The end date applies to all {people} people in {group.name}{subgroups.length ? ` and to its subgroup ${subgroups.map((s) => s.name).join(', ')}` : ''}. Access stops at 23:59 room time that day.</li>
            <li>An extension is effective at once and is not announced.</li>
          </>
        )}
        <li>Logged in Activity, with the old and new values.</li>
      </ul>
      {group.side === 'bid' ? <p className="hint">What {group.name} can see is changed in <Link href={`${roomHref(ws, 'permissions')}?group=${group.id}`} className="linkbtn" style={{ fontSize: 12.5 }}>Permissions</Link>.</p> : null}
      <ErrorLine text={error} />
    </Dlg>
  );
}

export function DeclineDialog({ ws, onClose, onDone, request }: Omit<Common, 'roomTz'> & { request: ColleagueRequest }) {
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const by = request.requestedBy.split(' ')[0];
  const decline = once(async () => {
    setBusy(true);
    setError(null);
    const body: { decision: 'decline'; note?: string } = { decision: 'decline' };
    if (why.trim()) body.note = why.trim();
    const r = await browserApi().POST('/v1/workspaces/{ws}/team-requests/{id}/decide', { params: { path: { ws, id: request.id } }, body });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'The request could not be declined.')); return; }
    onDone('Request declined', `${request.requestedBy} gets an email that ${request.name} was not added.`);
  });
  return (
    <Dlg over="Access request" title={`Decline the request for ${request.name}?`} onClose={onClose} busy={busy} focus="#dc-why"
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={decline} disabled={busy}>Decline and tell {by}</button></>}>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: '20px' }}>{request.requestedBy} asked for <b>{request.name}</b> to join {request.groupName}.</p>
      <label className="fld"><span>Reason for {by} (optional)</span>
        <textarea className="tin" id="dc-why" placeholder="For example: the tax adviser can join once 3.4 Tax is open to bidders." value={why} onChange={(e) => setWhy(e.target.value)} /></label>
      <ul className="facts">
        <li>{request.requestedBy} gets an email that the request was declined, with your reason if you give one. The request also shows as declined under My team.</li>
        <li>{request.name} is not contacted.</li>
      </ul>
      <ErrorLine text={error} />
    </Dlg>
  );
}

export function RevokeGroupDialog({ ws, onClose, onDone, group, subgroups }: Omit<Common, 'roomTz'> & { group: Group; subgroups: Group[] }) {
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const people = [group, ...subgroups].reduce((k, g) => k + g.members.filter((m) => m.status === 'active' || m.status === 'invited' || m.status === 'link_expired').length, 0);
  const revoke = once(async () => {
    setBusy(true);
    setError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/groups/{id}/revoke', { params: { path: { ws, id: group.id } }, body: why.trim() ? { reason: why.trim() } : {} });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'Access could not be revoked.')); return; }
    onDone(`Access revoked for ${group.name}`, `${people} ${people === 1 ? 'person' : 'people'} lost access at once. Logged in Activity.`);
  });
  return (
    <Dlg over="Revoke access" title={`Revoke access for ${group.name}?`} onClose={onClose} busy={busy} focus="#rv-why"
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" style={{ background: 'var(--danger)' }} onClick={revoke} disabled={busy}>Revoke access for {group.name}</button></>}>
      <label className="fld"><span>Reason (optional)</span>
        <input className="tin" id="rv-why" placeholder="For example: withdrew from the process" value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} /></label>
      <ul className="facts">
        <li>Everyone in {group.name}{subgroups.length ? ` and its ${subgroups.length === 1 ? 'subgroup' : 'subgroups'} ${subgroups.map((s) => s.name).join(', ')}` : ''} loses access at once: {people} {people === 1 ? 'person' : 'people'}. Invitation links not yet used stop working.</li>
        <li>Their activity stays in the log. Restoring access needs a new invitation.</li>
        <li>The reason shows under the group&apos;s name in People, and the revocation is logged in Activity.</li>
      </ul>
      <ErrorLine text={error} />
    </Dlg>
  );
}

export function RevokeMemberDialog({ ws, onClose, onDone, member, group }: Omit<Common, 'roomTz'> & { member: ApiMember; group: Group }) {
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const first = noName(member) ? member.email : firstName(member);
  let linkNote = '';
  if (member.invitationWaits) linkNote = ' The invitation will not be sent.';
  else if (member.status === 'invited' || member.status === 'link_expired') linkNote = ' The invitation link stops working.';
  const revoke = once(async () => {
    setBusy(true);
    setError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/memberships/{id}/revoke', { params: { path: { ws, id: member.membershipId } } });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'Access could not be revoked.')); return; }
    onDone(`Access revoked for ${member.name}`, `${first} no longer has access to ${group.name}. Logged in Activity.`);
  });
  return (
    <Dlg over="Revoke access" title={`Revoke access for ${member.name}?`} onClose={onClose} busy={busy}
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" style={{ background: 'var(--danger)' }} onClick={revoke} disabled={busy}>Revoke access for {first}</button></>}>
      <ul className="facts">
        <li>{member.name} loses access to everything {group.name} can see, at once.{linkNote}</li>
        <li>Their activity stays in the log. You can give the access back later with Restore access in this menu.</li>
        <li>Logged in Activity.</li>
      </ul>
      <ErrorLine text={error} />
    </Dlg>
  );
}

export function RestoreAccessDialog({ ws, onClose, onDone, member, group }: Omit<Common, 'roomTz'> & { member: ApiMember; group: Group }) {
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const first = noName(member) ? member.email : firstName(member);
  const role = member.role === 'lead' && !group.parentId ? 'a lead' : 'a member';
  const restore = once(async () => {
    setBusy(true);
    setError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/memberships/{id}/restore', { params: { path: { ws, id: member.membershipId } } });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'Access could not be restored.')); return; }
    const groups = r.data.groups.join(' and ');
    const mail = r.data.email === 'accepted' ? `${first} got an email with a sign-in button.` : 'The email could not be sent. Check the outgoing email in Site settings.';
    const twoFactor = r.data.twoFactorAgain ? ' They set up two-factor sign-in again when they sign in.' : '';
    onDone(`Access restored for ${member.name}`, `${first} is back in ${groups}. ${mail}${twoFactor} Logged in Activity.`);
  });
  return (
    <Dlg over="Restore access" title={`Restore access for ${member.name}?`} onClose={onClose} busy={busy}
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={restore} disabled={busy}>Restore access for {first}</button></>}>
      <ul className="facts">
        <li>{member.name} is back in {group.name} as {role}, with the same access and end date as before.</li>
        <li>{first} gets an email that their access is back, with a sign-in button.</li>
        <li>If the room asks for two-factor sign-in and theirs was reset, they set it up again when they sign in.</li>
        <li>Logged in Activity.</li>
      </ul>
      <ErrorLine text={error} />
    </Dlg>
  );
}

export function EndDateDialog({ ws, roomTz, onClose, onDone, member, group }: Common & { member: ApiMember; group: Group }) {
  const [until, setUntil] = useState(dayInput(member.accessEndsAt ?? group.until, roomTz));
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const first = noName(member) ? member.email : firstName(member);
  const later = until && group.until && (endOfDay(until, roomTz) ?? '') > group.until;
  const save = once(async () => {
    setBusy(true);
    setError(null);
    const accessEndsAt = until ? endOfDay(until, roomTz) : null;
    const r = await browserApi().PATCH('/v1/workspaces/{ws}/memberships/{id}', { params: { path: { ws, id: member.membershipId } }, body: { accessEndsAt } });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'The end date could not be changed.')); return; }
    onDone(`End date changed for ${member.name}`, `Access until ${accessEndsAt ? longDay(accessEndsAt, roomTz) : 'no end date'}. Logged in Activity.`);
  });
  return (
    <Dlg over="Change end date" title={`Change end date for ${first}`} onClose={onClose} busy={busy} focus="#me-until"
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy}>Save end date</button></>}>
      <label className="fld"><span>Access until</span>
        <input className="tin" type="date" id="me-until" value={until} style={{ maxWidth: 220 }} onChange={(e) => setUntil(e.target.value)} /></label>
      <ul className="facts">
        <li>For {member.name} only. Access stops at 23:59 room time that day. Empty means no end date of their own.</li>
        {group.until ? <li>{group.name} itself has access until {longDay(group.until, roomTz)}. Nobody in it keeps access after that date.</li> : null}
        <li>Logged in Activity, with the old and new values.</li>
      </ul>
      {later ? <p className="hint" style={{ color: 'var(--warn)' }}>This is after the end date of {group.name}, so it has no effect unless the group is extended.</p> : null}
      <ErrorLine text={error} />
    </Dlg>
  );
}

export function EditPersonDialog({ ws, onClose, onDone, member }: Omit<Common, 'roomTz'> & { member: ApiMember }) {
  const [given, setGiven] = useState(noName(member) ? '' : member.givenName);
  const [family, setFamily] = useState(noName(member) ? '' : member.familyName);
  const [company, setCompany] = useState(member.company ?? '');
  const [role, setRole] = useState(member.jobTitle ?? '');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const save = once(async () => {
    setBusy(true);
    setError(null);
    const r = await browserApi().PATCH('/v1/workspaces/{ws}/people/{personId}', { params: { path: { ws, personId: member.personId } }, body: {
      givenName: given.trim(), familyName: family.trim(), company: company.trim() || null, jobTitle: role.trim() || null } });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'The details could not be saved.')); return; }
    onDone(`${r.data.name} updated`, 'Logged in Activity, with the old and new values.');
  });
  return (
    <Dlg over="Edit details" title={noName(member) ? member.email : member.name} onClose={onClose} busy={busy} focus="#ep-given"
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !given.trim() || !family.trim()}>Save details</button></>}>
      <div className="two">
        <label className="fld"><span>First name</span><input className="tin" id="ep-given" value={given} autoComplete="off" onChange={(e) => setGiven(e.target.value)} /></label>
        <label className="fld"><span>Last name</span><input className="tin" id="ep-family" value={family} autoComplete="off" onChange={(e) => setFamily(e.target.value)} /></label>
      </div>
      <div className="two">
        <label className="fld"><span>Company</span><input className="tin" id="ep-company" value={company} onChange={(e) => setCompany(e.target.value)} /></label>
        <label className="fld"><span>Role (optional)</span><input className="tin" id="ep-role" value={role} placeholder="For example: Tax adviser" onChange={(e) => setRole(e.target.value)} /></label>
      </div>
      <label className="fld"><span>Email</span><input className="tin" value={member.email} readOnly style={{ background: 'var(--surface-2)', color: 'var(--muted)' }} /></label>
      <ul className="facts">
        <li>The change shows everywhere this person appears, in every room they are in.</li>
        <li>Logged in Activity of each of those rooms, with the old and new values, so nobody can quietly appear as someone else.</li>
        {member.status === 'invited' || member.status === 'link_expired' ? <li>They confirm their name when they accept the invitation.</li> : null}
      </ul>
      <ErrorLine text={error} />
    </Dlg>
  );
}

export function ResetTwoFactorDialog({ ws, onClose, onDone, member }: Omit<Common, 'roomTz'> & { member: ApiMember }) {
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const first = firstName(member);
  const reset = once(async () => {
    setBusy(true);
    setError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/people/{personId}/reset-two-factor', { params: { path: { ws, personId: member.personId } } });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'Two-factor sign-in could not be reset.')); return; }
    onDone(`Two-factor sign-in reset for ${member.name}`, `${first} sets up an authenticator app again at the next sign-in. Logged in Activity.`);
  });
  return (
    <Dlg over="Sign-in" title={`Reset two-factor sign-in for ${member.name}?`} onClose={onClose} busy={busy}
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={reset} disabled={busy}>Reset two-factor sign-in</button></>}>
      <ul className="facts">
        <li>For someone who lost or changed their phone. Their authenticator app stops working for this room, and their trusted browsers are forgotten.</li>
        <li>{first} is signed out everywhere and sets up an authenticator app again at the next sign-in.</li>
        <li>Check that the request really comes from {first}, for example by phone. Logged in Activity.</li>
      </ul>
      <ErrorLine text={error} />
    </Dlg>
  );
}

type EmailChangeInfo = { name: string; email: string; otherRooms: number; needsApproval?: boolean;
  pending: { newEmail: string; expiresAt: string; awaitingApproval?: boolean } | null };

export function emailChangeFacts(first: string, info: EmailChangeInfo | null, inRoom: boolean): string[] {
  const facts: string[] = [];
  if (info?.needsApproval) {
    facts.push(`We first email ${first} at ${info.email}, and nothing happens unless ${first} agrees there.`);
    facts.push(`Then we send a code to the new address. The change takes effect once ${first} enters it.`);
  } else {
    facts.push(`We send a code to the new address. The change takes effect once ${first} enters it.`);
  }
  facts.push(info ? `Until then, ${first} signs in with ${info.email}.` : `Until then, ${first} signs in with the old address.`);
  facts.push(`${first} is then signed out everywhere and signs in again with the new address. Their authenticator app stays the same.`);
  if (info && info.otherRooms > 0) {
    facts.push(inRoom
      ? `${first} is also in ${info.otherRooms} other ${info.otherRooms === 1 ? 'room' : 'rooms'}. This changes their sign-in everywhere.`
      : `${first} is in ${info.otherRooms} ${info.otherRooms === 1 ? 'room' : 'rooms'}. This changes their sign-in everywhere.`);
  }
  facts.push('The old address gets a notice. Logged in Activity, with both addresses.');
  return facts;
}

export function ChangeEmailDialog({ ws, onClose, onDone, member }: Omit<Common, 'roomTz'> & { member: ApiMember }) {
  const [email, setEmail] = useState('');
  const [info, setInfo] = useState<EmailChangeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const first = noName(member) ? member.email : firstName(member);
  const path = { params: { path: { ws, personId: member.personId } } };

  useEffect(() => {
    let live = true;
    void browserApi().GET('/v1/workspaces/{ws}/people/{personId}/email-change', path).then((r) => { if (live && r.data) setInfo(r.data); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, member.personId]);

  const send = once(async () => {
    if (busy) return;
    const v = email.trim().toLowerCase();
    if (!isEmail(v)) { setError('Enter a complete email address.'); return; }
    setBusy(true);
    setError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/people/{personId}/email-change', { ...path, body: { email: v } });
    setBusy(false);
    if (!r.data) { setError(problemText(r.error, 'The code could not be sent.')); return; }
    if (r.data.needsApproval) {
      if (r.data.emailStatus === 'accepted') onDone(`Asked ${first} to agree`, `We emailed ${info?.email ?? member.email}. The code goes to ${r.data.newEmail} once ${first} agrees. Logged in Activity.`);
      else onDone(`The email to ${first} was not sent`, `Check the outgoing email in Site settings, then try again. Nothing has changed for ${first}.`);
      return;
    }
    if (r.data.emailStatus === 'accepted') onDone(`Code sent to ${r.data.newEmail}`, `The address changes once ${first} enters it. Logged in Activity.`);
    else onDone('The email with the code was not sent', `Check the outgoing email in Site settings, then try again. Nothing has changed for ${first}.`);
  });

  return (
    <Dlg over="Sign-in" title={`Change the sign-in email of ${noName(member) ? member.email : member.name}`} onClose={onClose} busy={busy} focus="#ce-email"
      foot={<><button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={send} disabled={busy || !email.trim()}>{info?.needsApproval ? `Ask ${first} to agree` : 'Send the code'}</button></>}>
      <label className="fld"><span>Current email</span><input className="tin" value={info?.email ?? member.email} readOnly style={{ background: 'var(--surface-2)', color: 'var(--muted)' }} /></label>
      <label className="fld"><span>New email</span>
        <input className="tin" id="ce-email" type="email" value={email} inputMode="email" autoComplete="off" spellCheck={false}
          aria-invalid={error ? true : undefined} onChange={(e) => { setEmail(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} /></label>
      {info?.pending?.awaitingApproval
        ? <p className="hint">A change to {info.pending.newEmail} is waiting for {first} to agree at {info.email}. A new request replaces it.</p>
        : info?.pending ? <p className="hint">A change to {info.pending.newEmail} is waiting for its code. Sending a new code replaces it.</p> : null}
      <ul className="facts">{emailChangeFacts(first, info, true).map((f) => <li key={f}>{f}</li>)}</ul>
      <ErrorLine text={error} />
    </Dlg>
  );
}
