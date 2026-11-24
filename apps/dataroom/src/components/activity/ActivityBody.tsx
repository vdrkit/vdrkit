// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { apiUrl, browserApi, followSignOut } from '@/api/browser';
import { useToast } from '@/components/outside/Toast';
import { formatDay, formatTime } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import {
  clockTime, coverageText, dayHeading, duration, entryColour, filterSearch, groupColours, KINDS, lastSeen, logQuery, n, NO_FILTERS, PERIODS,
  type Chain, type Filters, type GroupPeople, type KindKey, type LogEntry, type LogPage, type PeriodKey, type Summary, type SummaryGroup,
} from './model';

const A: Record<string, ReactNode> = {
  view: <><path d="M2.5 12S6 5.5 12 5.5S21.5 12 21.5 12S18 18.5 12 18.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></>,
  down: <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" />,
  up: <path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" />,
  pub: <path d="M5 12l4 4L19 6" />,
  perm: <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10c-4-1.7-7-5.5-7-10V6z" />,
  in: <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l4-4l-4-4M14 12H4" />,
  nda: <><path d="M7 3h8l4 4v14H7z" /><path d="M15 3v4h4M10 13h6M10 17h4" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10c-4-1.7-7-5.5-7-10V6z" /><path d="M9 12l2 2l4-4" /></>,
  warn: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5v.5" /></>,
  csv: <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" />,
  find: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  filter: <path d="M4 5h16l-6 8v6l-4-2v-4z" />,
  other: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2.5" /></>,
};
const Svg = ({ k }: { k: string }) => <svg viewBox="0 0 24 24" aria-hidden="true">{A[k] ?? A.other}</svg>;

const TONE: Record<string, string> = { view: 'view', down: 'down', up: 'up', perm: 'perm', access: 'access', risk: 'risk' };

export interface ActivityBodyProps {
  ws: string;
  roomName: string;
  timeZone: string;
  isAdmin: boolean;
  summary: Summary;
  initialLog: LogPage;
  initialPeople: GroupPeople | null;
  chain: Chain;
  initialFilters: Filters;
}

const NOT_DONE: Record<Exclude<KindKey, 'all'>, string> = {
  view: 'has not viewed anything', download: 'has not downloaded anything', upload: 'has not uploaded or published anything',
  access: 'has had no access changes', signin: 'has no sign-ins or blocked links',
};
const DURING: Record<PeriodKey, string> = { '7d': ' in the last 7 days', today: ' today', '30d': ' in the last 30 days', all: '', custom: ' in these dates' };

const detailOf = (problem: unknown) => (problem as { detail?: string } | null | undefined)?.detail;

export function ActivityBody(p: ActivityBodyProps) {
  const [f, setF] = useState<Filters>(p.initialFilters);
  const [log, setLog] = useState<LogPage>(p.initialLog);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  // failed filter: show nothing, not stale rows
  const [failed, setFailed] = useState<string | null>(null);
  const [moreFailed, setMoreFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [people, setPeople] = useState<GroupPeople | null>(p.initialPeople);
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const reminding = useRef(new Set<string>());
  const exporting = useSendOnce();
  const [q, setQ] = useState(p.initialFilters.q);
  const toast = useToast();
  const first = useRef(true);
  const seq = useRef(0);

  const colours = useMemo(() => groupColours(p.summary.groups), [p.summary.groups]);
  const groupOf = (id: string) => p.summary.groups.find((g) => g.id === id);
  const query = useMemo(() => logQuery(f, p.timeZone), [f, p.timeZone]);

  useEffect(() => {
    if (q === f.q) return;
    const t = setTimeout(() => setF((x) => ({ ...x, q })), 250);
    return () => clearTimeout(t);
  }, [q, f.q]);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.history.replaceState(null, '', `${window.location.pathname}${filterSearch(f)}`);
    const mine = ++seq.current;
    setBusy(true);
    const page = browserApi().GET('/v1/workspaces/{ws}/events', { params: { path: { ws: p.ws }, query: { ...query, limit: 100 } } });
    void page.catch(() => null).then((r) => {
      if (mine !== seq.current) return;
      setBusy(false);
      setMoreFailed(false);
      if (r?.data) { setLog(r.data); setFailed(null); return; }
      const fallback = r ? 'Try again in a minute.' : 'The server could not be reached. Check your connection and try again.';
      setFailed(detailOf(r?.error) ?? fallback);
    });
  }, [query, f, p.ws, attempt]);

  useEffect(() => {
    if (!f.group || !p.isAdmin) { setPeople(null); return; }
    if (people?.group.id === f.group) return;
    void browserApi().GET('/v1/workspaces/{ws}/activity/groups/{group}/people', { params: { path: { ws: p.ws, group: f.group } } })
      .then((r) => setPeople(r.data ?? null));
  }, [f.group, p.ws, p.isAdmin, people?.group.id]);

  const loadMore = useCallback(async () => {
    if (more || failed || log.nextBeforeSeq === null) return;
    setMore(true);
    setMoreFailed(false);
    const mine = seq.current;
    const r = await browserApi().GET('/v1/workspaces/{ws}/events', {
      params: { path: { ws: p.ws }, query: { ...query, limit: 100, beforeSeq: log.nextBeforeSeq } },
    }).catch(() => null);
    setMore(false);
    if (mine !== seq.current) return;
    if (r?.data) setLog((l) => ({ ...r.data!, items: [...l.items, ...r.data!.items] }));
    else setMoreFailed(true);
  }, [more, failed, log.nextBeforeSeq, p.ws, query]);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    // after a failure only the button loads
    if (!el || log.nextBeforeSeq === null || moreFailed) return;
    const io = new IntersectionObserver((xs) => { if (xs.some((x) => x.isIntersecting)) void loadMore(); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, log.nextBeforeSeq, moreFailed]);

  const pickGroup = (id: string) => setF((x) => ({ ...x, group: x.group === id ? '' : id, person: '' }));
  const pickPerson = (id: string) => setF((x) => ({ ...x, person: x.person === id ? '' : id }));
  const atDefault = !f.group && !f.person && f.kind === 'all' && !f.q.trim() && f.period === '7d';
  const clearAll = () => {
    setQ('');
    setF(atDefault ? { ...NO_FILTERS, period: 'all' } : NO_FILTERS);
  };

  async function remind(membershipId: string, name: string) {
    if (reminding.current.has(membershipId)) return;
    reminding.current.add(membershipId);
    const r = await browserApi().POST('/v1/workspaces/{ws}/memberships/{id}/remind', { params: { path: { ws: p.ws, id: membershipId } } });
    reminding.current.delete(membershipId);
    if (r.data) {
      setReminded((s) => new Set(s).add(membershipId));
      toast.show(`Reminder sent to ${name}`, r.data.reason === 'nda'
        ? 'They get an email asking them to sign in and accept the NDA. Logged in Activity.'
        : 'They get the invitation link again by email. Logged in Activity.');
    } else {
      toast.show('Reminder not sent', detailOf(r.error) ?? 'Try again in a minute.');
    }
  }

  const exportCsv = exporting(async (href: string) => {
    const res = await fetch(href, { credentials: 'include', cache: 'no-store' }).catch(() => null);
    if (res && await followSignOut(href, res)) return;
    if (!res?.ok) {
      const problem = res ? await res.json().catch(() => null) : undefined;
      toast.show('Export not started', detailOf(problem) ?? 'Try again in a minute.');
      return;
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
    const plain = /filename="([^"]+)"/i.exec(cd)?.[1];
    let name = plain ?? 'activity.csv';
    try {
      if (utf8) name = decodeURIComponent(utf8);
    } catch (err) {
      if (!(err instanceof URIError)) throw err;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast.show('Export started', 'The CSV holds the entries the filters show, with each document named as it was at the time. The export itself is logged.');
  });

  const search = new URLSearchParams(query).toString();
  const exportHref = apiUrl(`/v1/workspaces/${p.ws}/events/export.csv${search ? `?${search}` : ''}`);
  const group = f.group ? groupOf(f.group) : undefined;
  let personName = '';
  if (f.person) {
    personName = people?.people.find((x) => x.personId === f.person)?.name
      ?? log.items.find((e) => e.person?.id === f.person)?.person?.name
      ?? '';
  }
  // observers see a partial log; never claim inactivity
  const observer = !p.isAdmin;
  const who = f.person ? personName || undefined : group?.name;
  let emptyHead = 'No activity matches these filters';
  let emptyWhy = 'Nothing in the log fits every filter you chose. Clear a filter to see more.';
  if (atDefault) {
    emptyHead = observer ? 'No activity you can see in the last 7 days' : 'No activity in the last 7 days';
    emptyWhy = observer ? `Nothing you can see was logged in ${p.roomName} in the last 7 days.` : `Nothing was logged in ${p.roomName} in the last 7 days.`;
  } else if (who && !observer && f.kind !== 'all' && !f.q.trim()) {
    emptyWhy = `${who} ${NOT_DONE[f.kind]}${DURING[f.period]}.`;
  }

  return (
    <div className="f1">
      <Header {...p} exportHref={exportHref}
        onExport={(e) => { e.preventDefault(); void exportCsv(exportHref); }} />
      <Engagement summary={p.summary} colours={colours} selected={f.group} onPick={pickGroup} timeZone={p.summary.timeZone} />
      {group && people && people.group.id === group.id ? (
        <PeoplePanel group={group} people={people} colour={colours.get(group.id) ?? 'var(--g-s)'} selected={f.person} onPick={pickPerson}
          isAdmin={p.isAdmin} timeZone={p.timeZone} reminded={reminded} onRemind={remind} />
      ) : null}

      <section className="panel" aria-label="Activity log">
        <div className="filters">
          <label className="fsearch">
            <Svg k="find" />
            <input id="q" placeholder="Person, document or index number" aria-label="Filter by person, document or index number"
              value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="chips" role="group" aria-label="Kind of activity">
            {KINDS.map(([k, label]) => (
              <button key={k} type="button" className="chip" aria-pressed={f.kind === k} onClick={() => setF((x) => ({ ...x, kind: k as KindKey }))}>{label}</button>
            ))}
          </div>
          <select className="sel" id="range" aria-label="Period" value={f.period}
            onChange={(e) => setF((x) => ({ ...x, period: e.target.value as PeriodKey }))}>
            {PERIODS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {f.period === 'custom' ? (
            <span className="dates">
              <label>From <input type="date" aria-label="From" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} /></label>
              <label>to <input type="date" aria-label="To" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} /></label>
            </span>
          ) : null}
        </div>
        {group ? (
          <div className="active-f">
            Showing{' '}
            <span className="tag">{group.name}<button type="button" aria-label="Show all groups" onClick={() => setF((x) => ({ ...x, group: '', person: '' }))}><Svg k="x" /></button></span>
            {f.person ? <span className="tag">{personName}<button type="button" aria-label="Show everyone in the group" onClick={() => setF((x) => ({ ...x, person: '' }))}><Svg k="x" /></button></span> : null}
            {group.parentGroupId ? null : <span className="cap">Subgroups are listed separately.</span>}
          </div>
        ) : null}
        <div className="logwrap" aria-busy={busy}>
          {failed ? (
            <div className="empty es" role="alert">
              <div className="ei"><Svg k="warn" /></div>
              <h2>The activity for these filters could not be loaded</h2>
              <p>{failed}</p>
              <div className="row"><button type="button" className="btn secondary" onClick={() => setAttempt((a) => a + 1)} disabled={busy}>Try again</button></div>
            </div>
          ) : log.items.length ? <div role="table" aria-label="Activity entries"><Entries items={log.items} timeZone={p.timeZone} colours={colours} /></div> : (
            <div className="empty es">
              <div className="ei"><Svg k="filter" /></div>
              <h2>{emptyHead}</h2>
              <p>{emptyWhy}</p>
              <div className="row"><button type="button" className="btn secondary" onClick={clearAll}>{atDefault ? 'Show since the room opened' : 'Clear the filters'}</button></div>
            </div>
          )}
          <div ref={sentinel} />
        </div>
        {log.nextBeforeSeq !== null && !failed ? (
          <div className="more">
            {moreFailed ? <span className="cap" role="alert">The older entries could not be loaded. Try again.</span> : null}
            <button type="button" className="btn ghost sm" onClick={() => void loadMore()} disabled={more}>{more ? 'Loading older entries…' : 'Load older entries'}</button>
          </div>
        ) : null}
        <div className="lfoot">
          <span>{failed ? 'No entries shown.' : <>Showing {n(log.items.length)} of {n(log.total)} entries.{log.nextBeforeSeq !== null ? ' Older entries load as you scroll.' : ''}</>}</span>
          {p.isAdmin ? <span>The export contains exactly what the filters show.</span> : <span>Observers can read the log. Export is for room admins.</span>}
        </div>
      </section>
      {toast.node}
    </div>
  );
}

function Header(p: ActivityBodyProps & { exportHref: string; onExport: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  const c = p.chain;
  const at = formatTime(c.checkedAt, p.timeZone).split(' ')[0];
  const title = c.intact
    ? `Each entry is sealed with a link to the entry before it, so a changed or removed entry would show. Checked today at ${at}${c.checked !== null ? ` across ${n(c.checked)} entries` : ''}.`
    : `The seal between two entries does not hold${c.firstBroken !== null ? ` at entry ${n(c.firstBroken)}` : ''}: an entry was changed or removed outside VDRkit. Tell the site admin.`;
  return (
    <div className="head">
      <div>
        <p className="over">Administration</p>
        <h1>Activity</h1>
        <p className="sub">Every view, download, upload and access change in {p.roomName}, in your time zone. Nobody can edit or delete an entry. Every opening is recorded here, so you can show who saw which document and when. The dashboard counts differently: there, ‘Opened’ counts each document once per person per day, to show how active a group is.</p>
      </div>
      <div className="acts">
        <span className={`chain${c.intact ? '' : ' broken'}`} title={title}>
          <Svg k={c.intact ? 'shield' : 'warn'} />{c.intact ? `Log intact · checked ${at}` : 'Log changed · tell the site admin'}
        </span>
        {p.isAdmin ? (
          <a className="btn secondary sm" href={p.exportHref} download onClick={p.onExport} data-export><Svg k="csv" />Export to CSV</a>
        ) : null}
      </div>
    </div>
  );
}

function Engagement({ summary, colours, selected, onPick, timeZone }: {
  summary: Summary; colours: Map<string, string>; selected: string; onPick: (id: string) => void; timeZone: string;
}) {
  const max = Math.max(1, ...summary.groups.flatMap((g) => g.pagesPerDay));
  const days = summary.days.map((d, i) => {
    const label = formatDay(d, timeZone);
    const [weekday, day] = label.split(' ');
    return { weekday: i === 6 ? 'Today' : weekday!, day: day!, full: label };
  });
  return (
    <section className="panel" aria-label="Engagement by bidder">
      <div className="eng-h"><h2>Bidders in the last 7 days</h2><span className="cap">Click a bidder to see its people and only its activity</span></div>
      <div className="engwrap">
        <div className="eng" role="table" aria-label="Bidders in the last 7 days">
          <div className="ehead" role="row">
            <div className="h" role="columnheader">Bidder</div>
            <div className="h" role="columnheader"><span className="sr-only">Pages read per day</span><div className="dayhead" aria-hidden="true">{days.map((d, i) => <span key={i} className={i === 6 ? 'today' : ''}>{d.weekday}<em>{d.day}</em></span>)}</div></div>
            <div className="h r" role="columnheader">People active</div><div className="h r" role="columnheader">Docs opened</div><div className="h r" role="columnheader">Downloads</div><div className="h" role="columnheader">Reads most</div>
          </div>
          {summary.groups.map((g) => <EngRow key={g.id} g={g} colour={colours.get(g.id) ?? 'var(--g-s)'} on={selected === g.id} max={max} days={days} onPick={onPick} />)}
          {summary.groups.length === 0 ? <div className="ehead" role="row"><div style={{ gridColumn: '1 / -1' }} className="quiet" role="cell">No bidder groups yet. Create them in People.</div></div> : null}
        </div>
      </div>
      <div className="eng-f"><span>Bars: pages read per day, on one scale for every bidder. Days run in the room's time zone ({timeZone}).</span><span>Docs opened counts only what each bidder can see.</span></div>
    </section>
  );
}

function EngRow({ g, colour, on, max, days, onPick }: {
  g: SummaryGroup; colour: string; on: boolean; max: number; days: { full: string }[]; onPick: (id: string) => void;
}) {
  const pick = () => onPick(g.id);
  return (
    <div className={`erow${on ? ' on' : ''}`} role="row" onClick={pick} data-group={g.id}>
      <div role="cell">
        <button type="button" className="rowbtn" aria-pressed={on} onClick={(e) => { e.stopPropagation(); pick(); }}>
          <span className={`gname${g.parentGroupId ? ' sub' : ''}`}><i style={{ background: colour }} /><b>{g.name}</b>{g.parentName ? <span>of {g.parentName}</span> : null}</span>
          <span className="sr-only">, show only this group in the log below</span>
        </button>
      </div>
      <div role="cell">
        <div className="bars" role="img" aria-label={`Pages read per day: ${g.pagesPerDay.map((v, i) => `${days[i]!.full} ${n(v)}`).join(', ')}`}>
          {g.pagesPerDay.map((v, i) => (
            <span key={i} className={i === 6 ? 'today' : ''} title={`${g.name}, ${days[i]!.full}: ${n(v)} ${v === 1 ? 'page' : 'pages'} read`}>
              <b style={{ height: `${v ? Math.max(8, Math.round((v / max) * 100)) : 0}%` }} />
            </span>
          ))}
        </div>
      </div>
      <div className="r" role="cell">{g.active}<small>of {g.members}</small></div>
      <div className="r" role="cell">{n(g.docsOpened)}<small>of {n(g.docsVisible)}</small></div>
      <div className={`r${g.downloads ? '' : ' quiet'}`} role="cell">{n(g.downloads)}</div>
      <div role="cell">
        <span className="tops">
          {g.readsMost.length ? g.readsMost.map((f) => (
            <span key={`${f.indexNumber}${f.name}`} className="fold">{f.indexNumber ? <span className="n">{f.indexNumber}</span> : null}{f.name}<small>{f.share}%</small></span>
          )) : <span className="quiet">Nothing read</span>}
        </span>
      </div>
    </div>
  );
}

function PeoplePanel({ group, people, colour, selected, onPick, isAdmin, timeZone, reminded, onRemind }: {
  group: SummaryGroup; people: GroupPeople; colour: string; selected: string; onPick: (id: string) => void; isAdmin: boolean; timeZone: string;
  reminded: Set<string>; onRemind: (membershipId: string, name: string) => void;
}) {
  const signed = people.people.filter((x) => x.status !== 'invited').length;
  return (
    <section className="panel" aria-label={`People in ${group.name}`}>
      <div className="eng-h">
        <h2><i className="gdot" style={{ background: colour }} />People in {group.name}</h2>
        <span className="cap">{signed} of {people.people.length} have signed in · since the room opened · click a person to show only them in the log</span>
      </div>
      <div className="engwrap">
        <div className="ptab" role="table" aria-label={`People in ${group.name}`}>
          <div className="prow h" role="row"><span role="columnheader">Person</span><span role="columnheader">Last signed in</span><span className="r" role="columnheader">Docs read</span><span className="r" role="columnheader">Pages read</span><span className="r" role="columnheader">Downloads</span><span className="r" role="columnheader">Time in room</span></div>
          {people.people.map((x) => {
            const sub = [x.lead ? 'Lead' : null, x.company].filter(Boolean).join(' · ');
            if (x.status !== 'active') {
              const line = x.status === 'invited'
                ? `Invited ${x.invitedAt ? formatDay(x.invitedAt, timeZone) : ''}`.trim()
                : `Signed in ${x.joinedAt || x.lastSeenAt ? formatDay((x.joinedAt ?? x.lastSeenAt)!, timeZone) : ''}, has not accepted the NDA`.replace(' ,', ',');
              const done = x.membershipId ? reminded.has(x.membershipId) : false;
              return (
                <div key={x.personId} className="prow never" role="row">
                  <span className="pname" role="cell"><b>{x.name}</b><small>{sub}</small></span>
                  <span className="pstat" role="cell">{line}</span>
                  <span role="cell">{isAdmin && x.membershipId ? (
                    <button type="button" className="btn ghost sm" disabled={done} onClick={() => onRemind(x.membershipId!, x.name)}>{done ? 'Reminder sent' : 'Send reminder'}</button>
                  ) : null}</span>
                </div>
              );
            }
            const on = selected === x.personId;
            const pick = () => onPick(x.personId);
            const seen = x.lastSeenAt ? lastSeen(x.lastSeenAt, timeZone) : null;
            return (
              <div key={x.personId} className={`prow${on ? ' on' : ''}`} role="row" data-person={x.personId} onClick={pick}>
                <span className="pname" role="cell">
                  <button type="button" className="rowbtn" aria-pressed={on} onClick={(e) => { e.stopPropagation(); pick(); }}>
                    <b>{x.name}</b><small>{sub}</small><span className="sr-only">, show only this person in the log</span>
                  </button>
                </span>
                <span className={seen?.startsWith('Today') ? '' : 'quiet'} role="cell">{seen ?? 'Not yet'}</span>
                <span className="r" role="cell">{n(x.docsRead)}<small>of {n(people.docsVisible)}</small></span>
                <span className="r" role="cell">{n(x.pagesRead)}</span>
                <span className={`r${x.downloads ? '' : ' quiet'}`} role="cell">{n(x.downloads)}</span>
                <span className="r" role="cell">{duration(x.minutes)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Entries({ items, timeZone, colours }: { items: LogEntry[]; timeZone: string; colours: Map<string, string> }) {
  const now = new Date();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((o) => {
    const next = new Set(o);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const out: ReactNode[] = [];
  let day = '';
  for (const e of items) {
    const h = dayHeading(e.occurredAt, timeZone, now);
    if (h !== day) {
      day = h;
      out.push(<div key={`d${e.id}`} className="day" role="row"><span role="rowheader" aria-colspan={6}>{h}</span></div>);
    }
    const who = e.person?.name ?? (e.actorName || 'VDRkit');
    let groupName = e.person ? '' : 'System';
    if (e.group) groupName = e.group.isAdmin ? 'Room admin' : e.group.name;
    const doc = e.node && e.resourceType === 'node';
    const label = doc ? e.node!.name : e.item ?? e.verb.label;
    const proof = e.proof?.length ? e.proof : null;
    const isOpen = !!proof && open.has(e.id);
    out.push(
      <div key={e.id} className={`ev${proof ? ' has-proof' : ''}${isOpen ? ' open' : ''}`} role="row" data-kind={e.kind}
        onClick={proof ? (ev) => { if (!(ev.target as HTMLElement).closest('button, a') && !window.getSelection()?.toString()) toggle(e.id); } : undefined}>
        <span className="t" role="cell" title={`${formatDay(e.occurredAt, timeZone, now)}, ${formatTime(e.occurredAt, timeZone)}`}>{clockTime(e.occurredAt, timeZone)}</span>
        <span className="pers" role="cell"><i style={{ background: entryColour(e, colours) }} /><b>{who}</b>{groupName ? <span>{groupName}</span> : null}</span>
        <span className={`act ${TONE[e.verb.tone] ?? 'access'}`} role="cell"><Svg k={e.verb.icon} /><span>{e.verb.label}</span></span>
        <span className="item" role="cell">
          {doc && e.node!.indexNumber ? <span className="n">{e.node!.indexNumber}</span> : null}
          <span className="it" title={label}>{label}</span>
        </span>
        {e.coverage ? (
          <span className="det cov" role="cell"><s aria-hidden="true"><b style={{ width: `${e.coverage.pageCount ? Math.round((e.coverage.pagesSeen / e.coverage.pageCount) * 100) : 0}%` }} /></s>{coverageText(e.coverage)}</span>
        ) : <span className="det" role="cell">{e.detail}</span>}
        <span className="xp" role="cell">
          {proof ? (
            <button type="button" className="icon-btn" aria-expanded={isOpen} aria-controls={`proof-${e.id}`}
              aria-label={`${isOpen ? 'Hide' : 'Show'} the proof details of this entry`} title={isOpen ? 'Hide the details' : 'Show the details kept as proof'}
              onClick={() => toggle(e.id)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={isOpen ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg>
            </button>
          ) : null}
        </span>
      </div>,
    );
    if (isOpen) {
      out.push(
        <div key={`p${e.id}`} className="proof" role="row" id={`proof-${e.id}`}>
          <div role="cell" aria-colspan={6}>
            <p className="ph">Kept as proof</p>
            <dl>
              {proof!.map((x, i) => (
                <div key={i}><dt>{x.label}</dt><dd className={x.mono ? 'mono' : undefined}>{x.value}</dd></div>
              ))}
            </dl>
          </div>
        </div>,
      );
    }
  }
  return <>{out}</>;
}
