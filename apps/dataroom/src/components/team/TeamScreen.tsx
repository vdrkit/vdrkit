// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import type { paths } from '@/api/client';
import { Avatar } from '@/components/shell';
import { useSeeAs } from '@/components/room/SeeAs';
import { initials } from '@/lib/avatar';
import { formatDay, formatWhen } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';

type MyTeam = paths['/v1/workspaces/{ws}/my-team']['get']['responses'][200]['content']['application/json'];
export type TeamGroup = MyTeam['groups'][number];
type Member = TeamGroup['members'][number];
export type ColleagueRequest = paths['/v1/workspaces/{ws}/team-requests']['get']['responses'][200]['content']['application/json']['items'][number];
type RoomAdmin = MyTeam['roomAdmins'][number];

export interface TeamScreenProps {
  ws: string;
  me: { personId: string; name: string; timeZone: string };
  group: TeamGroup;
  requests: ColleagueRequest[] | null;
  roomAdmins: RoomAdmin[];
  /** subgroup: no requests, the room admin adds people */
  subgroup: boolean;
  sees: { folders: number; documents: number };
  now: string;
}

const PLUS = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
const n = (x: number) => x.toLocaleString('en-GB');

function names(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
function roleAndCompany(jobTitle: string | null | undefined, company: string | null | undefined): string {
  return [jobTitle?.trim(), company?.trim()].filter(Boolean).join(', ');
}
const surname = (m: Member) => (m.familyName || m.name).toLocaleLowerCase('en-GB');
const waitingToSignIn = (m: Member) => m.status === 'invited' || m.status === 'link_expired';

const PERSONAL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|aol|proton|protonmail|gmx)\./;
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const detailOf = (error: unknown) => (error as { detail?: string }).detail;

function homeDomain(members: Member[], mePersonId: string): string | null {
  const own = members.find((m) => m.personId === mePersonId)?.email.split('@')[1]?.toLowerCase();
  if (own && !PERSONAL.test(own)) return own;
  const count = new Map<string, number>();
  for (const m of members) {
    const d = m.email.split('@')[1]?.toLowerCase();
    if (d && !PERSONAL.test(d)) count.set(d, (count.get(d) ?? 0) + 1);
  }
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

interface Form { fn: string; ln: string; e: string; co: string; r: string; why: string }
const EMPTY: Form = { fn: '', ln: '', e: '', co: '', r: '', why: '' };

export function TeamScreen(p: TeamScreenProps) {
  const router = useRouter();
  // See as is read only, whatever the stand-in's role
  const seeAs = !!useSeeAs();
  const lead = p.group.isLead && !seeAs;
  const zone = p.me.timeZone;
  const now = new Date(p.now);
  const day = (at: string) => formatDay(at, zone, now);

  const people = p.group.members.filter((m) => m.status === 'active' || waitingToSignIn(m));
  people.sort((a, b) =>
    Number(b.role === 'lead') - Number(a.role === 'lead')
    || Number(waitingToSignIn(a)) - Number(waitingToSignIn(b))
    || surname(a).localeCompare(surname(b), 'en-GB')
    || a.name.localeCompare(b.name, 'en-GB'));
  const leads = p.subgroup ? [] : people.filter((m) => m.role === 'lead' && m.status === 'active').map((m) => m.name);
  const admin = names(p.roomAdmins.map((a) => a.name)) || 'the room admin';
  const adminLine = p.roomAdmins.length ? p.roomAdmins.map((a) => (a.company ? `${a.name}, ${a.company}` : a.name)).join('; ') : null;
  const groupName = p.group.name;
  const ends = p.group.accessEndsAt;
  const requests = [...(p.requests ?? [])];
  requests.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt.localeCompare(a.createdAt));
  const home = homeDomain(people, p.me.personId);

  const [toast, setToast] = useState<{ title: string; line: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = useCallback((title: string, line: string) => {
    setToast({ title, line });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const [dialog, setDialog] = useState<{ kind: 'request'; prefill: boolean } | { kind: 'remove'; member: Member } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = (d: NonNullable<typeof dialog>, from: HTMLElement) => {
    opener.current = from;
    setDialog(d);
  };
  const close = useCallback(() => {
    setDialog(null);
    setTimeout(() => opener.current?.focus(), 0);
  }, []);

  const [form, setForm] = useState<Form>(EMPTY);
  const startRequest = (prefill: Partial<Form>, from: HTMLElement) => {
    setForm({ ...EMPTY, ...prefill });
    open({ kind: 'request', prefill: !!prefill.fn }, from);
  };

  const [busy, setBusy] = useState<string | null>(null);
  const withdrawing = useRef(new Set<string>());
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  async function withdraw(r: ColleagueRequest) {
    if (withdrawing.current.has(r.id)) return;
    withdrawing.current.add(r.id);
    setBusy(r.id);
    setRowError(null);
    const { error } = await browserApi().POST('/v1/workspaces/{ws}/team-requests/{id}/withdraw', { params: { path: { ws: p.ws, id: r.id } } });
    withdrawing.current.delete(r.id);
    setBusy(null);
    if (error) {
      setRowError({ id: r.id, text: detailOf(error) ?? 'That did not work. Try again.' });
      return;
    }
    say('Request withdrawn', `${r.name} will not be invited. The room admin sees it as withdrawn.`);
    router.refresh();
  }

  const count = people.length;
  const over = p.group.organisation ? `${groupName} · ${p.group.organisation}` : groupName;
  let howAdded = '.';
  if (lead) howAdded = '. As a lead you send them a request.';
  else if (leads.length) howAdded = ', at the request of your leads.';
  const sub = `The ${n(count)} ${count === 1 ? 'person' : 'people'} in ${groupName}. Everyone here sees the same documents at the same levels. `
    + `Only the room admin adds or removes people${howAdded}`;

  function status(m: Member): ReactNode {
    if (m.removalRequested) {
      return <div className="stat"><span className="badge b-neutral">Removal requested</span><small>Keeps access until the room admin acts</small></div>;
    }
    if (waitingToSignIn(m)) {
      return (
        <div className="stat"><span className="badge b-warn">Not signed in yet</span>
          {m.invitedAt ? <small>{`Invited ${day(m.invitedAt)}`}</small> : null}</div>
      );
    }
    const via = (p.requests ?? []).find((r) => r.status === 'approved' && r.email.toLowerCase() === m.email.toLowerCase());
    return (
      <div className="stat"><span className="badge b-ok">Active</span>
        {via ? <small>{`Added ${day(via.decidedAt ?? via.createdAt)} at ${via.requestedBy}'s request`}</small> : null}</div>
    );
  }

  const rows = people.map((m) => {
    const self = m.personId === p.me.personId;
    const roleCo = roleAndCompany(m.jobTitle, m.company);
    // wrap under the name, or Ask to remove falls off at 1280 px
    const person = (
      <div className="person" role="cell">
        <Avatar name={m.name} colourKey={m.personId} invited={waitingToSignIn(m)} />
        <div>
          <b>{m.name}{m.role === 'lead' ? <span className="badge b-lead">Lead</span> : null}{self ? <span className="you">You</span> : null}</b>
          {lead && roleCo ? <span className="firm">{roleCo}</span> : null}
          <small>{m.email}</small>
        </div>
      </div>
    );
    const firm = <span className="firm" role="cell">{roleCo}</span>;
    if (!lead) return <div className="tm member-view" role="row" key={m.membershipId} data-person={m.name}>{person}{firm}</div>;
    const act = self || m.role === 'lead' || m.removalRequested ? <span role="cell" />
      : (
        <span role="cell" className="rowact">
          <button type="button" className="btn ghost sm" title={`Asks the room admin to remove ${m.name}. They keep access until the room admin acts.`}
            onClick={(e) => open({ kind: 'remove', member: m }, e.currentTarget)}>Ask to remove</button>
        </span>
      );
    return (
      <div className="tm" role="row" key={m.membershipId} data-person={m.name}>
        {person}<div role="cell">{status(m)}</div>{act}
      </div>
    );
  });

  const head = lead
    ? <div className="tm h" role="row"><span role="columnheader">Person</span><span role="columnheader">Status</span><span role="columnheader" aria-label="Actions" /></div>
    : <div className="tm h member-view" role="row"><span role="columnheader">Person</span><span role="columnheader">Role and company</span></div>;

  function requestRow(r: ColleagueRequest) {
    const badge = r.status === 'pending' ? <span className="badge b-warn">Waiting</span>
      : r.status === 'approved' ? <span className="badge b-ok">Approved</span>
        : r.status === 'withdrawn' ? <span className="badge b-neutral">Withdrawn</span>
          : <span className="badge b-danger">Declined</span>;
    const by = r.decidedBy ? ` by ${r.decidedBy}` : '';
    const when = r.decidedAt ? day(r.decidedAt) : '';
    const line = r.status === 'pending' ? `Requested ${day(r.createdAt)} by ${r.requestedBy} · waiting for the room admin`
      : r.status === 'approved' ? `Approved ${when}${by}`
        : r.status === 'withdrawn' ? `Withdrawn ${when}${by}`
          : `Declined ${when}${by}`;
    const firm = roleAndCompany(r.jobTitle, r.company);
    return (
      <div className="req" key={r.id} data-request={r.name} data-status={r.status}>
        <span className="avatar">{initials(r.name)}</span>
        <div>
          <b>{r.name}</b>
          {firm ? <span className="m">{firm}</span> : null}
          <span className="m">{line}</span>
          {r.status === 'declined' && r.decisionNote ? <q>{r.decisionNote}</q> : null}
        </div>
        {badge}
        {r.status === 'pending' ? (
          <div className="ra">
            <button type="button" className="btn ghost sm" disabled={busy === r.id} onClick={() => void withdraw(r)}
              title={`Withdraws the request. ${r.name} is not invited.`}>Withdraw request</button>
            {rowError?.id === r.id ? <span className="cap err" role="alert">{rowError.text}</span> : null}
          </div>
        ) : r.status === 'declined' ? (
          <div className="ra">
            <button type="button" className="btn ghost sm" title="Opens a new request with their name, role and company filled in"
              onClick={(e) => startRequest({ fn: r.givenName, ln: r.familyName, e: r.email, r: r.jobTitle, co: r.company }, e.currentTarget)}>Request again with changes</button>
          </div>
        ) : null}
      </div>
    );
  }

  let fromLeads = `From the lead of ${groupName}`;
  if (leads.length === 2) fromLeads = `From both leads of ${groupName}`;
  else if (leads.length > 2) fromLeads = `From the leads of ${groupName}`;

  const sidePanel = lead ? (
    <section className="panel" aria-label="Requests to add colleagues">
      <div className="ph"><div><h2>Requests to add colleagues</h2>
        <span className="cap">{fromLeads}</span></div></div>
      {requests.length ? requests.map(requestRow) : <p className="cap none">No requests yet. Use Request to add a colleague above.</p>}
    </section>
  ) : (
    <section className="panel" aria-label="Adding colleagues">
      <div className="ph"><h2>Adding colleagues</h2></div>
      <p className="cap none">
        {leads.length
          ? `Your ${leads.length === 1 ? 'lead' : 'leads'}, ${names(leads)}, can request to add colleagues to ${groupName}. The room admin approves each request.`
          : `The room admin, ${admin}, adds people to ${groupName}. Ask them if a colleague needs access.`}
      </p>
    </section>
  );

  return (
    <div className="c6" data-team={lead ? 'lead' : 'member'}>
      <div className="head">
        <div>
          <p className="over">{over}</p>
          <h1>My team</h1>
          <p className="sub">{sub}</p>
        </div>
        {lead ? (
          <div className="cta">
            <button type="button" className="btn primary" onClick={(e) => startRequest({}, e.currentTarget)}
              title="Opens a form to ask the room admin to add a colleague to your group">{PLUS}Request to add a colleague</button>
            <span className="cap">The room admin decides on each request.</span>
          </div>
        ) : null}
      </div>

      <div className="grid">
        <div className="col">
          <section className="panel" aria-label={`People in ${groupName}`}>
            <div className="ph"><div><h2>People in {groupName}</h2>
              <span className="cap">{lead ? 'Status shows whether each person has signed in. Only room admins see what anyone reads.'
                : leads.length ? 'Your leads are marked Lead. Ask them if a colleague needs access.' : 'Ask the room admin if a colleague needs access.'}</span></div></div>
            <div className="tmwrap"><div role="table" aria-label={`People in ${groupName}`}>{head}{rows}</div></div>
          </section>
        </div>
        <div className="col">
          {sidePanel}
          <section className="panel" aria-label={`Access for ${groupName}`}>
            <div className="ph"><h2>Access for {groupName}</h2></div>
            <div className="facts">
              <span>Ends</span><b>{ends ? formatWhen(ends, zone, now) : 'No end date'}</b>
              <span>Sees</span><b>{`${n(p.sees.folders)} ${p.sees.folders === 1 ? 'folder' : 'folders'}, ${n(p.sees.documents)} ${p.sees.documents === 1 ? 'document' : 'documents'}`}</b>
              {adminLine ? <><span>Room admin</span><b>{adminLine}</b></> : null}
            </div>
            <div className="pfoot"><span className="cap">A new colleague gets this same access and end date.</span></div>
          </section>
        </div>
      </div>

      {dialog?.kind === 'request' ? (
        <RequestDialog ws={p.ws} groupName={groupName} admin={admin} ends={ends ? formatDay(ends, zone, now) : null} home={home}
          people={people} requests={p.requests ?? []} form={form} setForm={setForm} focusEmail={dialog.prefill}
          onClose={close}
          onSent={() => { close(); say('Request sent', 'You get an email when the room admin decides. Logged in Activity.'); router.refresh(); }} />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <RemoveDialog ws={p.ws} member={dialog.member} groupName={groupName} admin={admin} onClose={close}
          onSent={() => {
            close();
            say('Sent to the room admin', `${dialog.member.name} keeps access until ${admin} removes them. Logged in Activity.`);
            router.refresh();
          }} />
      ) : null}

      <div aria-live="polite">
        {toast ? <div className="toast"><i>✓</i><div><b>{toast.title}</b><span>{toast.line}</span></div></div> : null}
      </div>
    </div>
  );
}


function Dialog({ title, intro, onClose, children, footer }: { title: string; intro: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>('input, textarea, button:not([disabled])')];
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t" ref={box}>
        <div className="dh"><h2 id="dlg-t">{title}</h2><p className="cap">{intro}</p></div>
        {children}
        <div className="df">{footer}</div>
      </div>
    </div>
  );
}


interface Checks { err: Partial<Record<keyof Form, string>>; notes: ['warn' | 'info', ReactNode][] }

function check(f: Form, people: Member[], requests: ColleagueRequest[], groupName: string, home: string | null): Checks {
  const e = f.e.trim().toLowerCase();
  const out: Checks = { err: {}, notes: [] };
  if (!f.fn.trim()) out.err.fn = 'Write their first name. Emails greet them by it.';
  if (!f.ln.trim()) out.err.ln = 'Write their last name. Lists in the room sort by it.';
  if (!f.co.trim()) out.err.co = 'Write the company they work for, for example their advisory firm.';
  const inGroup = people.find((m) => m.email.toLowerCase() === e);
  if (!validEmail(e)) out.err.e = e ? 'This is not a complete email address.' : 'Write their work email address. The invitation goes there.';
  else if (inGroup) out.err.e = `${inGroup.name} is already in ${groupName}.`;
  else if (requests.some((r) => r.status === 'pending' && r.email.toLowerCase() === e)) out.err.e = 'There is already a request waiting for this address.';
  else {
    const dom = e.split('@')[1]!;
    if (PERSONAL.test(dom)) out.notes.push(['warn', <><b>This is a personal address.</b> Room admins usually decline these. Use the address at their firm if they have one.</>]);
    else if (home && dom !== home) out.notes.push(['info', <><b>This address is outside {home}.</b> That is fine for an adviser. Say in the reason which firm they are with and what they will review.</>]);
  }
  return out;
}

function RequestDialog(p: {
  ws: string; groupName: string; admin: string; ends: string | null; home: string | null; people: Member[]; requests: ColleagueRequest[];
  form: Form; setForm: (f: Form) => void; focusEmail: boolean; onClose: () => void; onSent: () => void;
}) {
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const once = useSendOnce();
  const [serverError, setServerError] = useState<{ field: 'e' | null; text: string } | null>(null);
  const f = p.form;
  const c = check(f, p.people, p.requests, p.groupName, p.home);
  const shown = (k: keyof Form) => (tried ? c.err[k] : undefined);
  const emailError = shown('e') ?? (serverError?.field === 'e' ? serverError.text : undefined);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (k === 'e') setServerError(null);
    p.setForm({ ...f, [k]: e.target.value });
  };
  const refs = { fn: useRef<HTMLInputElement>(null), ln: useRef<HTMLInputElement>(null), e: useRef<HTMLInputElement>(null), co: useRef<HTMLInputElement>(null) };
  useEffect(() => {
    if (p.focusEmail) {
      refs.e.current?.focus();
      refs.e.current?.select();
    } else {
      refs.fn.current?.focus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- focus once, when the form opens

  const send = once(async () => {
    setTried(true);
    if (Object.keys(c.err).length) {
      const k = (['fn', 'ln', 'e'] as const).find((x) => c.err[x]) ?? 'co';
      refs[k].current?.focus();
      return;
    }
    setSending(true);
    setServerError(null);
    const { error, response } = await browserApi().POST('/v1/workspaces/{ws}/team-requests', {
      params: { path: { ws: p.ws } },
      body: { givenName: f.fn.trim(), familyName: f.ln.trim(), email: f.e.trim().toLowerCase(), company: f.co.trim(), jobTitle: f.r.trim(), reason: f.why.trim() },
    });
    setSending(false);
    const status = response.status;
    if (error) {
      const detail = detailOf(error);
      if (status === 409) {
        setServerError({ field: 'e', text: detail ?? 'There is already a request waiting for this address.' });
        refs.e.current?.focus();
      } else {
        setServerError({ field: null, text: detail ?? 'The request was not sent. Try again.' });
      }
      return;
    }
    p.onSent();
  });

  const fld = (k: 'fn' | 'ln' | 'co', label: ReactNode, extra: { placeholder?: string } = {}) => (
    <label className="fld">
      <span>{label}</span>
      <input className="tin" id={`c-${k}`} ref={refs[k]} value={f[k]} onChange={set(k)} autoComplete="off" {...extra}
        aria-invalid={shown(k) ? true : undefined} aria-describedby={shown(k) ? `c-${k}-err` : undefined} />
      {shown(k) ? <p className="hint err" id={`c-${k}-err`}>{shown(k)}</p> : null}
    </label>
  );

  return (
    <Dialog title="Request to add a colleague" intro={`To ${p.groupName}. The room admin, ${p.admin}, decides.`} onClose={p.onClose}
      footer={<>
        {serverError?.field === null ? <span className="cap err" role="alert">{serverError.text}</span> : null}
        <button type="button" className="btn secondary" onClick={p.onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={sending} onClick={() => void send()}
          title="Sends the request to the room admin, who decides">Send request</button>
      </>}>
      <div className="db">
        {fld('fn', 'First name')}
        {fld('ln', 'Last name')}
        <label className="fld wide">
          <span>Work email</span>
          <input className="tin" id="c-e" ref={refs.e} type="email" value={f.e} onChange={set('e')} autoComplete="off"
            aria-invalid={emailError ? true : undefined} aria-describedby={emailError ? 'c-e-err' : undefined} />
          {emailError ? <p className="hint err" id="c-e-err">{emailError}</p> : null}
        </label>
        {fld('co', 'Company', { placeholder: 'For example: Orrinby Capital' })}
        <label className="fld">
          <span>Role <i>(optional)</i></span>
          <input className="tin" id="c-r" value={f.r} onChange={set('r')} placeholder="For example: Tax manager" autoComplete="off" />
        </label>
        <label className="fld wide">
          <span>Why they need access <i>(optional, for the room admin)</i></span>
          <textarea className="tarea" id="c-why" value={f.why} onChange={set('why')} placeholder="For example: reviews the tax folder for our offer" />
        </label>
        {c.notes.map(([kind, text], i) => <div className={`note ${kind}`} key={i} role="status"><div>{text}</div></div>)}
        <p className="hint wide fld">
          {`Once approved, they get an invitation by email and see exactly what ${p.groupName} sees${p.ends ? `, until ${p.ends}` : ''}. You get an email when the room admin decides.`}
        </p>
      </div>
    </Dialog>
  );
}


function RemoveDialog(p: { ws: string; member: Member; groupName: string; admin: string; onClose: () => void; onSent: () => void }) {
  const [why, setWhy] = useState('');
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const missing = tried && !why.trim();

  const send = once(async () => {
    setTried(true);
    if (!why.trim()) { box.current?.focus(); return; }
    setSending(true);
    setError(null);
    const { error: e } = await browserApi().POST('/v1/workspaces/{ws}/removal-requests', {
      params: { path: { ws: p.ws } }, body: { membershipId: p.member.membershipId, reason: why.trim() },
    });
    setSending(false);
    if (e) { setError(detailOf(e) ?? 'The request was not sent. Try again.'); return; }
    p.onSent();
  });

  return (
    <Dialog title={`Ask to remove ${p.member.name}`} intro={`The room admin removes them from ${p.groupName}. Until then they keep their access.`} onClose={p.onClose}
      footer={<>
        {error ? <span className="cap err" role="alert">{error}</span> : null}
        <button type="button" className="btn secondary" onClick={p.onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={sending} onClick={() => void send()}
          title={`Asks ${p.admin} to remove ${p.member.name}`}>Send to the room admin</button>
      </>}>
      <div className="db">
        <label className="fld wide">
          <span>Reason <i>(for the room admin)</i></span>
          <textarea className="tarea" id="rm-why" ref={box} value={why} onChange={(e) => setWhy(e.target.value)}
            placeholder={`For example: left ${p.member.company || 'our firm'} on 12 November`}
            aria-invalid={missing ? true : undefined} aria-describedby={missing ? 'rm-why-err' : undefined} />
          {missing ? <p className="hint err" id="rm-why-err">Write a reason. The room admin needs it to decide.</p> : null}
        </label>
        <div className="note info"><div><b>If they have left your firm, say so.</b> The room admin can then end their access at once.</div></div>
      </div>
    </Dialog>
  );
}
