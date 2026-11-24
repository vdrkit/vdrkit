// SPDX-License-Identifier: AGPL-3.0-only
'use client';

// never leak one bidder group's dates to another
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import type { Problem } from '@/api/client';
import { TimelineCard } from '@/components/dashboard/TimelineCard';
import { groupColours, type Milestone } from '@/components/dashboard/model';
import { useToast } from '@/components/outside/Toast';
import { Icon } from '@/components/shell/icons';
import { utcOffsetMinutes, zoneAbbreviation } from '@/lib/time';
import { roomHref } from '@/components/room/routes';
import { useModal } from '@/lib/a11y';
import { useSendOnce } from '@/lib/send-once';
import {
  audienceText, dayIn, groupSees, lowerFirst, nextDay, phaseCards, phaseDates, phaseFor, timeIn, zonedInstant,
  type PhaseCard, type TimelineGroup,
} from './model';
import { PhaseStatus, When } from './TimelineView';

export interface TimelineScreenProps {
  ws: string;
  roomName: string;
  roomTimeZone: string;
  now: string;
  milestones: Milestone[];
  groups: TimelineGroup[];
}

type EventDlg = {
  kind: 'event'; isNew: boolean; id?: string; end: boolean; phaseName: string;
  title: string; day: string; time: string; vis: 'all' | 'some'; groups: string[]; tell: boolean; orig?: string; origGroups?: string[];
};
type PhaseDlg = {
  kind: 'phase'; isNew: boolean; id?: string; n?: number; name: string; from: string; title: string; day: string; time: string;
  tell: boolean; orig?: string; confirmRemove?: boolean;
};
type Dlg = (EventDlg | PhaseDlg) & { error?: string; busy?: boolean; snap0?: string };

// unchanged: no write, no emails
function snap(d: EventDlg | PhaseDlg): string {
  return d.kind === 'phase'
    ? JSON.stringify([d.name.trim(), d.from, d.title.trim(), d.day, d.time])
    : JSON.stringify([d.title.trim(), d.day, d.time, d.end || d.vis === 'all' ? [] : [...d.groups].sort()]);
}
const opened = (d: EventDlg | PhaseDlg): Dlg => ({ ...d, snap0: snap(d) });

const PLUS = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;

export function TimelineScreen(p: TimelineScreenProps) {
  const [items, setItems] = useState<Milestone[]>(p.milestones);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const once = useSendOnce();
  const [pv, setPv] = useState<string>(p.groups[0]?.id ?? '');
  const toast = useToast();
  const now = useMemo(() => new Date(p.now), [p.now]);
  const tz = p.roomTimeZone;
  const roomZone = zoneAbbreviation(now, tz);

  const { phases, loose } = useMemo(() => phaseCards(items, tz, now), [items, tz, now]);
  const colours = useMemo(() => groupColours(p.groups.map((g) => ({ groupId: g.id, groupName: g.name, parentGroupId: g.parentGroupId, partyKind: g.partyKind }))), [p.groups]);
  const byId = useMemo(() => new Map(p.groups.map((g) => [g.id, g])), [p.groups]);

  const mark = (id: string) => setChanged((s) => new Set(s).add(id));
  const put = (m: Milestone) => setItems((xs) => [...xs.filter((x) => x.id !== m.id), m]);

  const today = dayIn(now, tz);
  const openEvent = (m: Milestone, phase: PhaseCard | null, end: boolean) => {
    const ids = m.visibleToGroupIds ?? [];
    setDlg(opened({
      kind: 'event', isNew: false, id: m.id, end, phaseName: phase?.name ?? '', title: m.title, day: dayIn(m.dueAt, tz), time: timeIn(m.dueAt, tz),
      vis: ids.length ? 'some' : 'all', groups: ids, tell: true, orig: m.dueAt, origGroups: ids,
    }));
  };
  const addEvent = (phase: PhaseCard) => setDlg({
    kind: 'event', isNew: true, end: false, phaseName: phase.name, title: '', day: phase.from > today ? phase.from : today, time: '10:00',
    vis: 'all', groups: [], tell: true,
  });
  const editPhase = (phase: PhaseCard) => setDlg(opened({
    kind: 'phase', isNew: false, id: phase.end.id, n: phase.n, name: phase.name, from: phase.from, title: phase.end.title,
    day: dayIn(phase.end.dueAt, tz), time: timeIn(phase.end.dueAt, tz), tell: true, orig: phase.end.dueAt,
  }));
  const addPhase = () => {
    const last = phases[phases.length - 1];
    const from = last ? nextDay(dayIn(last.end.dueAt, tz)) : today;
    setDlg({ kind: 'phase', isNew: true, name: '', from, title: '', day: from, time: '17:00', tell: true });
  };

  const save = once(async () => {
    if (!dlg || dlg.busy) return;
    const api = browserApi();
    const path = { ws: p.ws };
    if (!dlg.isNew && dlg.snap0 !== undefined && snap(dlg) === dlg.snap0) {
      setDlg(null);
      toast.show('Nothing changed', 'Nobody is emailed.');
      return;
    }
    if (dlg.kind === 'phase') {
      const name = dlg.name.trim(), title = dlg.title.trim();
      if (!name || !title) { toast.show('Name the phase and its deadline', 'Both show on every bidder\'s dashboard.'); return; }
      if (dlg.from > dlg.day) { setDlg({ ...dlg, error: 'A phase starts on or before its deadline. Change the start or the deadline date.' }); return; }
      const dueAt = zonedInstant(dlg.day, dlg.time, tz).toISOString();
      const body = { title, dueAt, phase: { name, startsOn: dlg.from }, notify: dlg.tell };
      setDlg({ ...dlg, busy: true, error: undefined });
      const r = dlg.isNew
        ? await api.POST('/v1/workspaces/{ws}/milestones', { params: { path }, body })
        : await api.PATCH('/v1/workspaces/{ws}/milestones/{id}', { params: { path: { ...path, id: dlg.id! } }, body });
      if (!r.data) { setDlg({ ...dlg, busy: false, error: problemText(r.error) }); return; }
      put(r.data); mark(r.data.id); setDlg(null);
      const all = everyone(p.groups);
      toast.show(dlg.isNew ? 'Phase added' : 'Phase saved',
        `${all.text} ${all.one ? 'sees' : 'see'} it on ${all.one ? 'its' : 'their'} dashboard${dlg.tell ? ` and ${all.one ? 'is' : 'are'} told by email` : ''}. Logged in Activity.`);
      return;
    }
    const title = dlg.title.trim();
    if (title.length < 2) { document.getElementById('d-title')?.focus(); return; }
    if (dlg.vis === 'some' && dlg.groups.length === 0) { toast.show('Choose at least one group', 'Or set it to all bidder groups.'); return; }
    const dueAt = zonedInstant(dlg.day, dlg.time, tz).toISOString();
    const groups = dlg.end || dlg.vis === 'all' ? [] : dlg.groups;
    setDlg({ ...dlg, busy: true, error: undefined });
    const r = dlg.isNew
      ? await api.POST('/v1/workspaces/{ws}/milestones', { params: { path }, body: { title, dueAt, visibleToGroupIds: groups, notify: dlg.tell } })
      : await api.PATCH('/v1/workspaces/{ws}/milestones/{id}', {
        params: { path: { ...path, id: dlg.id! } },
        body: dlg.end ? { title, dueAt, notify: dlg.tell } : { title, dueAt, visibleToGroupIds: groups, notify: dlg.tell },
      });
    if (!r.data) { setDlg({ ...dlg, busy: false, error: problemText(r.error) }); return; }
    put(r.data); mark(r.data.id); setDlg(null);
    const who = groups.length ? audienceText(groups, p.groups) : everyone(p.groups);
    const moved = !dlg.isNew && dlg.orig !== undefined && new Date(dlg.orig).getTime() !== new Date(dueAt).getTime();
    toast.show(dlg.isNew ? 'Event added' : 'Saved',
      `${dlg.tell ? `${who.text} ${who.one ? 'is' : 'are'} told by email${moved ? ' that the date moved' : ''}.` : 'Nobody is emailed.'} Logged in Activity.`);
  });

  const remove = once(async () => {
    if (!dlg || dlg.busy || !dlg.id) return;
    if (dlg.kind === 'phase' && !dlg.confirmRemove) { setDlg({ ...dlg, confirmRemove: true }); return; }
    setDlg({ ...dlg, busy: true, error: undefined });
    const r = await browserApi().DELETE('/v1/workspaces/{ws}/milestones/{id}', {
      params: { path: { ws: p.ws, id: dlg.id }, query: { notify: dlg.tell ? 'true' : 'false' } },
    });
    if (r.response.status !== 204) { setDlg({ ...dlg, busy: false, error: problemText(r.error) }); return; }
    setItems((xs) => xs.filter((x) => x.id !== dlg.id));
    setDlg(null);
    if (dlg.kind === 'phase') {
      const all = everyone(p.groups);
      const told = dlg.tell ? `${all.text} ${all.one ? 'is' : 'are'} told by email.` : 'Nobody is emailed.';
      toast.show('Phase removed', `Its deadline no longer shows on any dashboard. Its events stay on the timeline. ${told} Logged in Activity.`);
    } else {
      const ids = dlg.origGroups ?? [];
      const who = ids.length ? audienceText(ids, p.groups) : everyone(p.groups);
      toast.show('Event removed', `${who.text} ${who.one ? 'no longer sees it' : 'no longer see it'}${dlg.tell ? ` and ${who.one ? 'is' : 'are'} told by email` : ''}. ${dlg.tell ? '' : 'Nobody is emailed. '}Logged in Activity.`);
    }
  });

  const who = (m: Milestone) => {
    const ids = m.visibleToGroupIds ?? [];
    if (!ids.length) return <span className="cap">All bidder groups</span>;
    return ids.map((id) => {
      const g = byId.get(id);
      if (!g) return null;
      return <span key={g.id} className="chip"><i style={{ background: colours.get(g.id) ?? 'var(--g-s)' }} />{g.name} only</span>;
    });
  };
  const eventRow = (m: Milestone, phase: PhaseCard | null) => {
    const done = new Date(m.dueAt) <= now;
    return (
      <div key={m.id} className={`trow${done ? ' done' : ''}${changed.has(m.id) ? ' changed' : ''}`} data-milestone={m.title}>
        <When m={m} tz={tz} />
        <div className="what"><b>{m.title}</b><div className="vis">{done ? <span className="cap">Done</span> : who(m)}</div></div>
        <button type="button" className="btn ghost sm" aria-label={`Edit ${m.title}`} onClick={() => openEvent(m, phase, false)}>Edit</button>
      </div>
    );
  };

  const phaseCard = (ph: PhaseCard) => {
    const { range, extra } = phaseDates(ph, today, tz);
    return (
      <section key={ph.end.id} className="panel" aria-label={`Phase ${ph.n}`} data-phase={ph.name}>
        <div className="phh">
          <div>
            <p className="over">Phase {ph.n} of {phases.length}</p>
            <h2>{ph.name}<PhaseStatus status={ph.status} /></h2>
            <span className="cap">{range}{extra}</span>
          </div>
          <button type="button" className="btn secondary sm" onClick={() => editPhase(ph)}>Edit phase</button>
        </div>
        {ph.events.map((e) => eventRow(e, ph))}
        <div className={`trow end${changed.has(ph.end.id) ? ' changed' : ''}`} data-milestone={ph.end.title}>
          <When m={ph.end} tz={tz} />
          <div className="what"><b>{ph.end.title}</b><span className="cap">End of phase {ph.n}, the date bidders count down to · all bidder groups</span></div>
          <button type="button" className="btn ghost sm" aria-label={`Edit ${ph.end.title}`} onClick={() => openEvent(ph.end, ph, true)}>Edit</button>
        </div>
        <div className="addrow">
          <button type="button" className="btn ghost sm" onClick={() => addEvent(ph)}>{PLUS}Add an event to {lowerFirst(ph.name)}</button>
        </div>
      </section>
    );
  };

  if (!items.length) {
    return (
      <div className="f2" data-screen="timeline">
        <div className="head"><div><p className="over">Administration</p><h1>Timeline</h1>
          <p className="sub">The dates of the sale process, shown to bidders on their dashboard in their own time zone.</p></div></div>
        <section className="panel">
          <div className="empty">
            <div className="ei"><Icon name="time" /></div>
            <h2>No dates yet</h2>
            <p>Add the dates bidders work towards, such as the first-round bid date or the end of the Q&amp;A. Bidders get a reminder before each one.</p>
            <div className="row"><button type="button" className="btn primary" onClick={addPhase}>Add a phase</button></div>
          </div>
        </section>
        {dlg ? <Dialog dlg={dlg} setDlg={setDlg} save={save} remove={remove} phases={phases} groups={p.groups} tz={tz} roomZone={roomZone} /> : null}
        {toast.node}
      </div>
    );
  }

  return (
    <div className="f2" data-screen="timeline">
      <div className="head">
        <div>
          <p className="over">Administration</p>
          <h1>Timeline</h1>
          <p className="sub">The phases of {p.roomName} and the dates inside them. Each phase ends with a deadline, which is what bidders count down to on their dashboard. You set times in room time, {roomZone}. Everyone sees them in their own time zone.</p>
        </div>
        <div className="cta"><button type="button" className="btn primary" onClick={addPhase}>{PLUS}Add a phase</button></div>
      </div>
      <div className="grid">
        <div className="col">
          {phases.map(phaseCard)}
          {loose.length ? (
            <section className="panel" aria-label="After the last phase" data-phase="">
              <div className="phh"><div>
                <p className="over">After the last phase</p>
                <h2>Not in a phase</h2>
                <span className="cap">These dates come after the last phase deadline. Bidders see them below the phases. Add a phase that ends after them, or move them.</span>
              </div></div>
              {loose.map((e) => eventRow(e, null))}
            </section>
          ) : null}
        </div>
        <div className="col">
          <Preview items={items} groups={p.groups} pv={pv} setPv={setPv} now={p.now} ws={p.ws} roomTimeZone={tz} />
        </div>
      </div>
      {dlg ? <Dialog dlg={dlg} setDlg={setDlg} save={save} remove={remove} phases={phases} groups={p.groups} tz={tz} roomZone={roomZone} /> : null}
      {toast.node}
    </div>
  );
}

function Preview({ items, groups, pv, setPv, now, ws, roomTimeZone }: {
  items: Milestone[]; groups: TimelineGroup[]; pv: string; setPv: (id: string) => void; now: string; ws: string; roomTimeZone: string;
}) {
  const g = groups.find((x) => x.id === pv) ?? groups[0];
  const zone = g?.timeZone ?? roomTimeZone;
  const abbr = zoneAbbreviation(new Date(now), zone);
  const seen = items.filter((m) => !g || groupSees(m, g)).map(({ visibleToGroupIds: _v, ...m }) => m);
  let footnote: ReactNode = <>No bidder groups yet, so this shows every date, in room time, {abbr}.</>;
  if (g) {
    let where = `Nobody in ${g.name} has joined yet, so this uses room time, ${abbr}`;
    if (g.zoneFrom === 'lead') where = `${g.name}'s lead works in ${abbr}`;
    else if (g.zoneFrom === 'members') where = `${g.name} works in ${abbr}`;
    footnote = <>{where}
      {g.zoneFrom === 'room' ? '' : `, so times show in ${abbr}`}. Events for other bidders do not appear.</>;
  }
  return (
    <div className="aside" aria-label="What bidders see on their dashboard">
      <div className="pv-sel"><p className="over" style={{ margin: 0 }}>What bidders see on their dashboard</p></div>
      {groups.length ? (
        <div className="pv-sel">
          <label htmlFor="pv" className="cap">Show it as</label>
          <select id="pv" value={g?.id} onChange={(e) => setPv(e.target.value)}>
            {groups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
      ) : null}
      <div className="c1">
        <TimelineCard milestones={seen} timeZone={zone} now={now} admin={false} timelineHref={roomHref(ws, 'timeline')} footnote={footnote} />
      </div>
    </div>
  );
}

function Dialog({ dlg, setDlg, save, remove, phases, groups, tz, roomZone }: {
  dlg: Dlg; setDlg: (d: Dlg | null) => void; save: () => void; remove: () => void; phases: PhaseCard[]; groups: TimelineGroup[]; tz: string; roomZone: string;
}) {
  const first = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useModal(box, { focusFirst: false });
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDlg(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setDlg]);
  const set = (patch: Partial<Omit<EventDlg, 'kind'> & Omit<PhaseDlg, 'kind'>>) => setDlg({ ...dlg, ...patch, error: undefined } as Dlg);
  const instant = dlg.day && dlg.time ? zonedInstant(dlg.day, dlg.time, tz) : null;
  const zoneAt = instant ? zoneAbbreviation(instant, tz) : roomZone;

  let title: string, body: ReactNode;
  if (dlg.kind === 'phase') {
    title = dlg.isNew ? 'Add a phase' : `Edit phase ${dlg.n}`;
    body = (
      <>
        <label className="fld wide"><span>Name</span><input ref={first} className="tin" id="d-name" value={dlg.name} placeholder="For example: Final round" onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="fld"><span>Starts</span><input className="tin" type="date" id="d-from" value={dlg.from} onChange={(e) => set({ from: e.target.value })} /></label><span />
        <label className="fld wide"><span>Ends with</span><input className="tin" id="d-title" value={dlg.title} placeholder="For example: Signing" onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="fld"><span>Deadline date</span><input className="tin" type="date" id="d-date" value={dlg.day} onChange={(e) => set({ day: e.target.value })} /></label>
        <label className="fld"><span>Time, {zoneAt}</span><input className="tin" type="time" id="d-time" value={dlg.time} onChange={(e) => set({ time: e.target.value })} /></label>
        <p className="hint fld wide">The deadline is what bidders count down to while this phase runs. Every bidder group sees the phase and its deadline.</p>
        <Tell checked={dlg.tell} isNew={dlg.isNew} onChange={(v) => set({ tell: v })} />
        {dlg.confirmRemove ? (
          <div className="note warn" role="alert"><span>Removing the phase removes its deadline, <b>{dlg.title}</b>, from every dashboard{dlg.tell ? ', and the groups that see it are told by email' : ''}. Its events stay on the timeline and join the next phase.</span></div>
        ) : null}
      </>
    );
  } else {
    if (dlg.isNew) title = `Add an event to ${lowerFirst(dlg.phaseName)}`;
    else if (dlg.end) title = `Edit the end of ${lowerFirst(dlg.phaseName)}`;
    else title = 'Edit event';
    const seeing = dlg.end || dlg.vis === 'all' ? groups : groups.filter((g) => dlg.groups.includes(g.id) || (!!g.parentGroupId && dlg.groups.includes(g.parentGroupId)));
    const other = instant ? seeing.find((g) => utcOffsetMinutes(instant, g.timeZone) !== utcOffsetMinutes(instant, tz)) : undefined;
    const target = instant && !dlg.end ? phaseFor(phases, instant) : null;
    const elsewhere = instant && !dlg.end && dlg.phaseName && target?.name !== dlg.phaseName
      ? (target ? `This date falls in ${lowerFirst(target.name)}, so the event moves there.` : 'This date is after the last phase deadline, so the event shows after the phases.')
      : null;
    body = (
      <>
        <label className="fld wide"><span>{dlg.end ? 'Deadline' : 'Event'}</span><input ref={first} className="tin" id="d-title" value={dlg.title} placeholder="For example: Management presentation" onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="fld"><span>Date</span><input className="tin" type="date" id="d-date" value={dlg.day} onChange={(e) => set({ day: e.target.value })} />
          {elsewhere ? <span className="hint">{elsewhere}</span> : null}</label>
        <label className="fld"><span>Time, {zoneAt}</span><input className="tin" type="time" id="d-time" value={dlg.time} onChange={(e) => set({ time: e.target.value })} />
          {other && instant ? <span className="hint">{other.name} sees {timeIn(instant, other.timeZone)} {zoneAbbreviation(instant, other.timeZone)}.</span> : null}</label>
        {dlg.end ? <p className="hint fld wide">A phase deadline is shown to every bidder group.</p> : (
          <div className="fld wide" role="group" aria-labelledby="d-vis-l">
            <span id="d-vis-l">Who sees it</span>
            <div className="radios">
              <label className="rad"><input type="radio" name="d-vis" value="all" checked={dlg.vis === 'all'} onChange={() => set({ vis: 'all', groups: [] })} />All bidder groups</label>
              <label className="rad"><input type="radio" name="d-vis" value="some" checked={dlg.vis === 'some'} disabled={!groups.length}
                onChange={() => set({ vis: 'some', groups: dlg.groups.length ? dlg.groups : groups.slice(0, 1).map((g) => g.id) })} />Only some bidder groups</label>
              {dlg.vis === 'some' ? (
                <div className="gpick">
                  {groups.map((g) => {
                    const viaParent = !!g.parentGroupId && dlg.groups.includes(g.parentGroupId);
                    const parent = viaParent ? groups.find((x) => x.id === g.parentGroupId) : undefined;
                    return (
                      <label key={g.id} className={`chk${viaParent ? ' off' : ''}`} title={parent ? `Sees what ${parent.name} sees` : undefined}>
                        <input type="checkbox" data-g={g.id} checked={viaParent || dlg.groups.includes(g.id)} disabled={viaParent}
                          onChange={(e) => set({ groups: e.target.checked ? [...dlg.groups, g.id] : dlg.groups.filter((x) => x !== g.id) })} />
                        {g.name}
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <span className="hint">The seller team and room admins always see every event. Other bidders do not learn it exists.</span>
          </div>
        )}
        <Tell checked={dlg.tell} isNew={dlg.isNew} onChange={(v) => set({ tell: v })} />
      </>
    );
  }

  const canRemove = !dlg.isNew && !(dlg.kind === 'event' && dlg.end);
  let removeLabel = 'Remove event';
  if (dlg.kind === 'phase') removeLabel = dlg.confirmRemove ? 'Yes, remove the phase' : 'Remove phase';
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setDlg(null); }}>
      <div ref={box} className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
        <div className="dh"><h2 id="dlg-t">{title}</h2></div>
        <form className="db" onSubmit={(e) => { e.preventDefault(); save(); }} id="dlg-form" noValidate>
          {body}
          {dlg.error ? <div className="note warn" role="alert"><span>{dlg.error}</span></div> : null}
        </form>
        <div className="df">
          {canRemove ? <button type="button" className="btn danger left" disabled={dlg.busy} onClick={remove}>{removeLabel}</button> : null}
          <button type="button" className="btn secondary" onClick={() => setDlg(null)}>Cancel</button>
          <button type="submit" form="dlg-form" className="btn primary" disabled={dlg.busy}>{dlg.isNew ? 'Add' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function Tell({ checked, isNew, onChange }: { checked: boolean; isNew: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="chk fld wide" style={{ flexDirection: 'row' }}>
      <input type="checkbox" id="d-tell" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>Email the groups that see it about this {isNew ? 'new date' : 'change'}<br />
        <span className="hint">In their next notification, or right away for a deadline that moves earlier.</span></span>
    </label>
  );
}

// no bidder groups: the seller team is the audience
function everyone(groups: TimelineGroup[]): { text: string; one: boolean } {
  return groups.length ? audienceText([], groups) : { text: 'The seller team', one: true };
}

function problemText(error: unknown): string {
  const pr = error as Problem | undefined;
  return pr?.status === 400 && pr.detail ? pr.detail : 'Not saved. Check your connection and try again.';
}
