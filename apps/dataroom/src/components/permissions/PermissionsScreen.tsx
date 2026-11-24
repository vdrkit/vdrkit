// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import { roomHref } from '@/components/room/routes';
import { seeAsRoomPart } from '@/components/room/see-as';
import { formatDay, formatTime } from '@/lib/time';
import {
  dayIn, Matrix, key, label, LEVELS, LV, LV_DESC, nextDay, personLine, plural, R2, same, startOfDay, VERB,
  type Eff, type Group, type Pending, type PendingValue, type PermissionsData, type Row, type Setting, type Side,
} from './model';
import '@/styles/permissions.css';
import { onTabListKeys, useModal } from '@/lib/a11y';
import { useSendOnce } from '@/lib/send-once';

const Svg = ({ box = '0 0 24 24', children }: { box?: string; children: ReactNode }) => <svg viewBox={box} aria-hidden="true">{children}</svg>;
const ChevR = () => <Svg box="0 0 12 12"><path d="M4 2.5L7.5 6L4 9.5" /></Svg>;
const ChevD = () => <Svg box="0 0 12 12"><path d="M2.5 4L6 7.5L9.5 4" /></Svg>;
const Close = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
const Clock = () => <Svg box="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 1.5" /></Svg>;
const Pub = () => <Svg><path d="M5 12l4 4L19 6" /></Svg>;
const Lock = () => <Svg><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>;
const Hist = () => <Svg><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4M12 8v4l3 2" /></Svg>;
const Snow = () => <Svg><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /></Svg>;
const TeamIcon = () => <Svg><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.8a3.5 3.5 0 0 1 0 6.4M21 20c0-2.6-1.6-4.8-4-5.6" /></Svg>;
const PersonIcon = () => <Svg><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" /></Svg>;
const FolderIcon = () => <Svg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5" /></Svg>;
const SellerIcon = () => <Svg><path d="M4 20V8l8-4l8 4v12M9 20v-6h6v6M4 20h16" /></Svg>;

const fmt = (n: number) => n.toLocaleString('en-GB');
const dayWithYear = (at: string | Date, tz: string) => formatDay(at, tz, new Date(0));
const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

type PopSpec = { kind: 'cell'; f: string; g: string; rect: DOMRect } | { kind: 'col'; g: string; rect: DOMRect };

export interface PermissionsScreenProps {
  ws: string;
  initial: PermissionsData;
  timeZone: string;
  runBy: string;
}

// saving is allowed in a frozen room
export function PermissionsScreen({ ws, initial, timeZone, runBy }: PermissionsScreenProps) {
  const router = useRouter();
  const [today, setToday] = useState(initial);
  // failed save: the refresh brings back the stored rights
  const [stale, setStale] = useState(false);
  const [shown, setShown] = useState(initial);
  if (shown !== initial) {
    setShown(initial);
    if (stale) {
      setToday(initial);
      setStale(false);
    }
  }
  const [past, setPast] = useState<PermissionsData | null>(null);
  const [atChoice, setAtChoice] = useState('now');
  const [loadingAt, setLoadingAt] = useState(false);
  const data = past ?? today;
  const m = useMemo(() => new Matrix(data, timeZone), [data, timeZone]);
  const todayM = useMemo(() => new Matrix(today, timeZone), [today, timeZone]);
  const isPast = past !== null;

  const [side, setSide] = useState<Side>('bidders');
  const [viewAs, setViewAs] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Pending>({});
  const [pop, setPopState] = useState<PopSpec | null>(null);
  /** ignore the scroll that brought the cell into view */
  const popAt = useRef(0);
  const setPop = useCallback((v: PopSpec | null) => { popAt.current = Date.now(); setPopState(v); }, []);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const once = useSendOnce();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ title: string; text: string } | null>(null);
  const P = isPast ? null : pending;
  const todayDay = dayIn(new Date(), timeZone);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const rvBox = useRef<HTMLElement>(null);
  useModal(rvBox, { active: review });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pop) setPop(null);
      // stays open while saving, or an edit behind it is lost
      else if (review && !saving) setReview(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pop, review, saving]);

  // leaving drops changes, sign-in redirects included
  const unsaved = Object.keys(pending).length > 0;
  useEffect(() => {
    if (!unsaved) return;
    const stop = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', stop);
    return () => window.removeEventListener('beforeunload', stop);
  }, [unsaved]);

  const cols = m.cols(side);
  const groupsAll = m.groups;

  async function chooseAt(value: string) {
    const before = atChoice;
    setAtChoice(value);
    setPop(null);
    if (value === 'now') { setPast(null); return; }
    setLoadingAt(true);
    const r = await browserApi().GET('/v1/workspaces/{ws}/permissions', { params: { path: { ws }, query: { at: value } } });
    setLoadingAt(false);
    if (r.data) setPast(r.data);
    // not loaded: the choice goes back to the date the table shows
    else setAtChoice(before);
  }

  const put = useCallback((fid: string, gid: string, val: Setting | null, into: Pending): Pending => {
    const base = todayM.stored.get(key(fid, gid));
    const k = key(fid, gid);
    const next = { ...into };
    if (val === null ? !base : same(val, base)) delete next[k];
    else next[k] = val === null ? { inherit: true } : val;
    return next;
  }, [todayM]);

  function chip(e: Eff, ownSetting: Setting | undefined, quiet: boolean, forceOwn?: boolean) {
    const own = forceOwn ?? e.own;
    if (e.l === 0) {
      if (own && ownSetting?.l === 0) return <span className="lvl deny">Blocked</span>;
      return quiet ? <span className="lvl none" aria-hidden="true">None</span> : <span className="lvl none">No access</span>;
    }
    return <span className={`lvl l${e.l}${own ? '' : ' inh'}`}>{LV[e.l]}</span>;
  }

  const sideOf = (gid: string) => m.byGroup.get(gid)?.side;
  const pendingCount = (s: Side) => Object.keys(pending).filter((k) => todayM.byGroup.get(k.split('|')[1]!)?.side === s).length;
  const anyOpen = m.tops.some((t) => open[t]);

  function notes() {
    const out: ReactNode[] = [];
    if (isPast) {
      out.push(
        <div className="note past" key="past"><Hist />
          <span className="grow"><b>The room as it stood on {dayWithYear(data.at, timeZone)} at {formatTime(data.at, timeZone)}.</b> Folders, names and rights are shown as they were then. Read only.</span>
          <button type="button" className="linkbtn" onClick={() => void chooseAt('now')}>Back to today</button>
        </div>,
      );
    }
    if (viewAs && m.byGroup.has(viewAs)) {
      const g = m.byGroup.get(viewAs)!;
      const s = m.sees(g.id, P);
      out.push(
        <div className="note view" key="view" data-testid="view-as-note"><i className="dot" style={{ background: g.color }} />
          <span className="grow"><b>{g.name} sees {s.folders} of {s.total} folders and {fmt(s.published)} published {s.published === 1 ? 'document' : 'documents'}.</b>{' '}
            {s.hidden.length ? `Hidden from them: ${s.hidden.join(', ')}.` : 'Nothing is hidden from them.'}{' '}
            <span className="cap">Only room admins can open Permissions. Members of {g.name} never see this page or other groups&apos; rights.</span></span>
          {isPast ? null : <Link className="linkbtn" href={roomHref(seeAsRoomPart(ws, g.id), 'documents')} data-testid="see-as-link">See the room as {g.name}</Link>}
          <button type="button" className="linkbtn" onClick={() => setViewAs('')}>Stop checking</button>
        </div>,
      );
    }
    if (!isPast && data.room.state === 'frozen') {
      out.push(
        <div className="note" key="frozen"><Snow />
          <span>The room is frozen. Permission changes still take effect when you save. Nobody adds or publishes files until the room is opened again.</span>
          <Link href={roomHref(ws, 'settings')} className="linkbtn">Change in Settings</Link>
        </div>,
      );
    }
    if (!isPast && side === 'seller') {
      const pubs: string[] = [];
      for (const g of todayM.cols('seller')) {
        for (const [k, s] of todayM.stored) {
          if (!k.endsWith(`|${g.id}`) || !s.p || s.later) continue;
          const row = todayM.rows.get(k.split('|')[0]!);
          if (row?.kind === 'folder') pubs.push(`${g.name} in ${label(row)}`);
        }
      }
      for (const pg of data.personGrants) {
        const row = todayM.rows.get(pg.nodeId);
        if (pg.effect === 'allow' && pg.canPublish && row) pubs.push(`${pg.name} in ${label(row)}`);
      }
      out.push(
        <div className="note" key="seller"><Pub />
          <span>Room admins of {runBy} see and manage every folder. Publishing: room admins everywhere{pubs.length ? `, ${pubs.join(', ')}` : ''}. Four-eyes rule is {data.room.fourEyesPublish ? 'on' : 'off'}.</span>
          <Link href={roomHref(ws, 'settings')} className="linkbtn">Change in Settings</Link>
        </div>,
      );
    }
    {
      // person grants don't show in the group columns
      const persons = m.peopleOn(side);
      if (persons.length) {
        out.push(
          <div className="note" key="people" data-testid="people-note"><PersonIcon />
            <span className="grow">{persons.length === 1 ? 'One right is set for a named person' : `${persons.length} rights are set for named people`}, not a group: {persons.map((pg) => personLine(pg, m.rows.get(pg.nodeId)!)).join('; ')}. A block for a person beats every group level; an allow adds to what their groups give. Permissions shows these but does not change them.</span>
          </div>,
        );
      }
    }
    if (!isPast && side === 'bidders') {
      const none = todayM.noBidderAccess();
      if (none.length) {
        out.push(
          <div className="note warn" key="none"><Lock />
            <span>{none.length} {none.length === 1 ? 'folder has' : 'folders have'} no bidder access yet: {none.map((id) => todayM.rows.get(id)!.ix || todayM.rows.get(id)!.name).join(', ')}. Bidders see nothing in {none.length === 1 ? 'it' : 'them'} until you give access here.</span>
          </div>,
        );
      }
    }
    return out;
  }

  function visibleRows(): { row: Row; last: boolean }[] {
    const out: { row: Row; last: boolean }[] = [];
    const walk = (ids: string[]) => ids.forEach((id, i) => {
      const r = m.rows.get(id)!;
      out.push({ row: r, last: i === ids.length - 1 });
      if (r.kids.length && open[id]) walk(r.kids);
    });
    walk(m.tops);
    return out;
  }
  const noBidder = useMemo(() => new Set(todayM.noBidderAccess()), [todayM]);
  const todayNames = useMemo(() => new Map(today.nodes.map((n) => [n.id, n.name])), [today]);

  function cell(row: Row, g: Group) {
    const e = m.eff(row.id, g.id, P);
    const own = m.rec(row.id, g.id, P);
    const changed = !isPast && key(row.id, g.id) in pending;
    const parts: ReactNode[] = [<Fragment key="l">{chip(e, own, true)}</Fragment>];
    if (e.u) parts.push(<span key="u" className={`pill on${e.own ? '' : ' inh'}`} title="May add files">U</span>);
    if (e.p) parts.push(<span key="p" className={`pill on${e.own ? '' : ' inh'}`} title="May publish drafts">P</span>);
    const closed = row.kids.length > 0 && !open[row.id];
    if (closed) {
      const diff = m.descendants(row.id).filter((k) => m.rec(k.id, g.id, P));
      if (diff.length) {
        parts.push(<span key="more" className="more" title={`${diff.length} ${diff.length === 1 ? 'subfolder sets' : 'subfolders set'} its own level: ${diff.map((k) => k.ix).join(', ')}`}>+{diff.length}</span>);
      }
    }
    const files = m.files(row.id, g.id, closed);
    if (files.length && !isPast) {
      const t = files.map((f) => `${label(f)}: ${LV[m.stored.get(key(f.id, g.id))!.l]} for ${g.name}`).join('; ');
      parts.push(<span key="fx" className="fx" title={`${t}. Set in Documents, from the file's ⋯ menu.`}>+{plural(files.length, 'file', 'files')}</span>);
    }
    const persons = m.people(row.id, g.id, closed);
    if (persons.length) {
      const blocked = persons.some((pg) => pg.effect === 'deny');
      parts.push(<span key="pp" className={`fx pp${blocked ? ' deny' : ''}`} data-testid="person-mark"
        title={`Set for a named person in ${g.name}: ${persons.map((pg) => personLine(pg, m.rows.get(pg.nodeId)!)).join('; ')}.`}>+{plural(persons.length, 'person', 'people')}</span>);
    }
    if (e.until) parts.push(<span key="until" className="until" title={`Ends on ${dayLabel(e.until)}`}><Clock /></span>);
    const later = m.stored.get(key(row.id, g.id));
    if (later?.later && !changed) parts.push(<span key="later" className="until later" title={`Starts on ${dayLabel(later.from!)}: ${LV[later.l]}`}><Clock /></span>);
    let aria = `${g.name}, ${label(row)}: ${LV[e.l]}`;
    if (!e.own) aria += ', same as the folder above';
    if (e.capped) aria += ', capped';
    if (e.u) aria += ', may add files';
    if (e.p) aria += ', may publish';
    if (persons.length) aria += `, ${plural(persons.length, 'person', 'people')} set apart`;
    if (changed) aria += ', unsaved change';
    return (
      <td key={g.id} className={`${viewAs === g.id ? 'hl ' : ''}${changed ? 'chg' : ''}`}>
        <button type="button" className="cell" aria-label={aria} disabled={isPast} data-f={row.id} data-g={g.id}
          onClick={(ev) => { ev.stopPropagation(); setPop({ kind: 'cell', f: row.id, g: g.id, rect: ev.currentTarget.getBoundingClientRect() }); }}>
          {parts}
        </button>
      </td>
    );
  }

  function matrix() {
    return (
      <table className="mx">
        <thead>
          <tr>
            <th className="fc" scope="col">Folder</th>
            {cols.map((g) => {
              const parent = g.parentGroupId ? m.byGroup.get(g.parentGroupId) : undefined;
              return (
                <th key={g.id} scope="col" className={viewAs === g.id ? 'hl' : ''}>
                  <div className={`gh${g.side === 'seller' ? ' sel-col' : ''}`}>
                    {parent ? <span className="party">Subgroup of {parent.name}</span> : null}
                    <button type="button" className="gn" disabled={isPast} title={isPast ? '' : `Set every folder for ${g.name}`}
                      onClick={(ev) => setPop({ kind: 'col', g: g.id, rect: ev.currentTarget.getBoundingClientRect() })}>
                      <i style={{ background: g.color }} />{g.name}{isPast ? null : <ChevD />}
                    </button>
                    <small>{g.who}</small>
                  </div>
                </th>
              );
            })}
            <th className="fill" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {visibleRows().map(({ row, last }) => {
            const sub = row.depth > 0;
            const was = isPast && todayNames.has(row.id) && todayNames.get(row.id) !== row.name ? todayNames.get(row.id) : null;
            return (
              <tr key={row.id} className={sub ? `sub${last ? ' sub-last' : ''}` : 'top-row'}>
                <th className="fc" scope="row">
                  <div className={`rh${sub ? ' l1' : ''}`} style={sub ? ({ '--d': row.depth - 1 } as React.CSSProperties) : undefined}>
                    {row.kids.length ? (
                      <button type="button" className="tg" aria-expanded={!!open[row.id]} aria-label={`${open[row.id] ? 'Close' : 'Open'} ${row.name}`}
                        onClick={() => setOpen((o) => ({ ...o, [row.id]: !o[row.id] }))}>
                        {open[row.id] ? <ChevD /> : <ChevR />}
                      </button>
                    ) : (sub ? null : <span className="sp" />)}
                    <span className="ix">{row.ix}</span>
                    <span className="nmw">
                      <span className="nm" title={row.name}>{row.name}</span>
                      {was ? <span className="was">now {was}</span> : null}
                      {!sub && !isPast && side === 'bidders' && noBidder.has(row.id) ? <span className="k-lock">No bidder access</span> : null}
                    </span>
                  </div>
                </th>
                {cols.map((g) => cell(row, g))}
                <td className="fill" />
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  function effects(fid: string, gid: string): string[] {
    const f = todayM.rows.get(fid)!, g = todayM.byGroup.get(gid)!;
    const o = todayM.eff(fid, gid, null), n = todayM.eff(fid, gid, pending);
    const gained = todayM.documents(fid, gid, null, (l) => l === 0);
    const now = todayM.documents(fid, gid, pending, (l) => l > 0);
    const docs = Math.min(gained.published, now.published), dr = Math.min(gained.drafts, now.drafts);
    const lost = todayM.documents(fid, gid, null, (l) => l > 0).published - now.published;
    const out: string[] = [];
    if (o.l === 0 && n.l > 0) {
      if (docs) out.push(`${g.name} will see ${fmt(docs)} published ${docs === 1 ? 'document' : 'documents'} here, at ${LV[n.l]} level.`);
      if (dr && docs) out.push(`${dr} ${dr === 1 ? 'draft here reaches them when it is' : 'drafts here reach them when they are'} published.`);
      if (dr && !docs) out.push(`Nothing becomes visible yet: all ${dr} documents here are drafts. ${g.name} sees them once they are published in Release review.`);
      if (!dr && !docs) out.push(`Nothing becomes visible yet: there are no documents here. ${g.name} sees what is published here later.`);
      if (g.side === 'bidders' && docs) out.push(`Members are told in their next ${today.room.summaryTimes[0] ?? '08:00'} digest.`);
    } else if (n.l === 0 && o.l > 0) {
      out.push(`${g.name} loses access to ${fmt(Math.max(lost, 0))} ${lost === 1 ? 'document' : 'documents'} at once, including any document open on screen. Nobody is told.`);
    } else if (n.l > o.l) {
      out.push(`${g.name} may now ${VERB[n.l]} here.`);
    } else if (n.l < o.l) {
      out.push(`${g.name} can no longer ${VERB[o.l]} here. Files they downloaded before stay with them, and the activity log shows which.`);
    }
    const parent = g.parentGroupId ? todayM.byGroup.get(g.parentGroupId) : undefined;
    if (n.capped && parent) out.push(`${g.name} can never exceed ${parent.name}. They get ${LV[n.l]} here until ${parent.name} is raised.`);
    if (n.u && !o.u) out.push(`${g.name} may add files here. Their uploads arrive as drafts.`);
    if (!n.u && o.u) out.push(`${g.name} can no longer add files here. Drafts they added stay.`);
    if (n.p && !o.p) out.push(`${g.name} may publish drafts here, only to groups that already have access. ${today.room.fourEyesPublish ? 'The four-eyes rule is on, so they may not publish their own uploads.' : 'The four-eyes rule is off, so they may publish their own uploads.'}`);
    if (!n.p && o.p) out.push(`${g.name} can no longer publish here.`);
    const pv = pending[key(fid, gid)];
    if (pv && !('inherit' in pv)) {
      if (pv.from && pv.from > todayDay) out.push(`Takes effect on ${dayLabel(pv.from)}. Until then the folder above applies.`);
      if (pv.until && pv.until !== todayM.stored.get(key(fid, gid))?.until) out.push(`Access ends on ${dayLabel(pv.until)}.`);
    }
    const follow = todayM.descendants(fid).filter((k) => todayM.eff(k.id, gid, pending).from === fid).length;
    if (follow && (n.l !== o.l || n.u !== o.u || n.p !== o.p)) out.push(`Also applies to ${follow} ${follow === 1 ? 'subfolder that follows' : 'subfolders that follow'} ${label(f)}.`);
    if (!out.length) out.push('No practical change: the result is the same as before.');
    return out;
  }

  const save = once(async () => {
    type Level = 0 | 10 | 20 | 30 | 40 | 50 | 60;
    const changes = Object.entries(pending).map(([k, v]) => {
      const [nodeId, groupId] = k.split('|') as [string, string];
      if ('inherit' in v) return { nodeId, groupId, reset: true };
      return {
        nodeId, groupId, level: v.l as Level, canUpload: v.u, canPublish: v.p, canManage: v.m,
        validFrom: v.from && v.from > todayDay ? startOfDay(v.from, timeZone) : null,
        validTo: v.until ? startOfDay(nextDay(v.until), timeZone) : null,
      };
    });
    if (!changes.length) return;
    setSaving(true);
    setSaveError(null);
    const r = await browserApi().PUT('/v1/workspaces/{ws}/grants', { params: { path: { ws } }, body: { changes } });
    if (!r.response.ok) {
      setSaving(false);
      setSaveError((r.error as { detail?: string } | undefined)?.detail ?? 'The changes could not be saved. Nothing has changed. Try again.');
      return;
    }
    const fresh = await browserApi().GET('/v1/workspaces/{ws}/permissions', { params: { path: { ws } } });
    if (fresh.data) setToday(fresh.data);
    else setStale(true);
    const n = changes.length;
    const starts = [...new Set(Object.values(pending).flatMap((v) => ('inherit' in v || !v.from || v.from <= todayDay ? [] : [v.from])))].sort();
    const later = Object.values(pending).filter((v) => !('inherit' in v) && v.from && v.from > todayDay).length;
    const when = !later ? 'In effect now'
      : later === n ? `In effect from ${starts.map(dayLabel).join(', ')}`
        : `In effect now, except ${later === 1 ? 'one that starts' : `${later} that start`} on ${starts.map(dayLabel).join(', ')}`;
    setPending({});
    setReview(false);
    setSaving(false);
    setToast({ title: `${n} ${n === 1 ? 'change' : 'changes'} saved`, text: `${when}, and logged in Activity as one entry.` });
    router.refresh();
  });

  function reviewDrawer() {
    const keys = Object.keys(pending);
    if (!review || !keys.length) return null;
    return (
      <>
        <div className="rv-scrim" onClick={() => { if (!saving) setReview(false); }} />
        <aside ref={rvBox} className="rv" role="dialog" aria-modal="true" aria-labelledby="rv-h">
          <div className="rv-h">
            <div><p className="over">Review before saving</p><h2 id="rv-h">{keys.length} {keys.length === 1 ? 'change takes' : 'changes take'} effect together when you save</h2></div>
            <button type="button" className="icon-btn" aria-label="Close" onClick={() => setReview(false)} disabled={saving}><Close /></button>
          </div>
          <div className="rv-b">
            {keys.map((k) => {
              const [fid, gid] = k.split('|') as [string, string];
              const f = todayM.rows.get(fid), g = todayM.byGroup.get(gid);
              if (!f || !g) return null;
              const o = todayM.eff(fid, gid, null), n = todayM.eff(fid, gid, pending);
              const oo = todayM.rec(fid, gid, null), no = todayM.rec(fid, gid, pending);
              return (
                <div className="ci" key={k}>
                  <h3><i style={{ background: g.color }} />{g.name} <span className="cap">in</span> <span className="n">{f.ix}</span>{f.name}
                    <button type="button" className="btn ghost sm rm" onClick={() => setPending((p) => { const x = { ...p }; delete x[k]; return x; })}>Undo</button></h3>
                  <div className="fromto">
                    {chip(o, oo, false, true)}{o.u ? <span className="pill on">U</span> : null}{o.p ? <span className="pill on">P</span> : null}
                    <span className="arr" aria-label="becomes">→</span>
                    {chip(n, no, false, true)}{n.u ? <span className="pill on">U</span> : null}{n.p ? <span className="pill on">P</span> : null}
                  </div>
                  <ul className="facts">{effects(fid, gid).map((t) => <li key={t}>{t}</li>)}</ul>
                </div>
              );
            })}
          </div>
          <div className="rv-f">
            <span className="cap">Logged in Activity as one entry, with you as the author.</span>
            {saveError ? <p className="err" role="alert">{saveError}</p> : null}
            <button type="button" className="btn secondary" onClick={() => setReview(false)} disabled={saving}>Keep editing</button>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving} autoFocus>
              {saving ? 'Saving…' : `Save ${keys.length} ${keys.length === 1 ? 'change' : 'changes'}`}
            </button>
          </div>
        </aside>
      </>
    );
  }

  const nPending = Object.keys(pending).length;
  const noteList = notes();
  const bidderTops = m.cols('bidders').filter((g) => !g.parentGroupId).length;
  const bidderSubs = m.cols('bidders').length - bidderTops;
  const sellerN = m.cols('seller').length;

  return (
    <div className="e3">
      <div className="head">
        <div>
          <p className="over">Administration</p>
          <h1>Permissions</h1>
          <p className="sub">What each group may see and do, folder by folder. Nothing changes for anyone until you save.</p>
        </div>
        <div className="acts">
          <div className="ctl"><label htmlFor="at">Show the room as at</label>
            <select className="sel" id="at" value={atChoice} disabled={loadingAt} onChange={(e) => void chooseAt(e.target.value)}>
              <option value="now">Today, {formatDay(new Date(), timeZone)}</option>
              {today.history.map((h) => (
                <option key={h.at} value={h.at}>{dayIn(h.at, timeZone) === todayDay ? `Today, ${formatTime(h.at, timeZone)}` : dayWithYear(h.at, timeZone)}{h.opened ? ', room opened' : ''}</option>
              ))}
            </select>
          </div>
          <div className="ctl"><label htmlFor="viewas">Check what a group sees</label>
            <select className="sel" id="viewas" value={viewAs} onChange={(e) => {
              const v = e.target.value;
              setViewAs(v);
              const s = sideOf(v);
              if (s) setSide(s);
            }}>
              <option value="">Choose a group</option>
              {groupsAll.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </div>
      </div>
      {noteList.length ? <div className="notes">{noteList}</div> : null}
      <section className="panel" aria-label="Permission matrix">
        <div className="tabs">
          <div className="tabs-l" role="tablist" aria-label="Whose permissions" onKeyDown={onTabListKeys}>
          <button type="button" role="tab" id="tab-bidders" aria-controls="e3-panel" aria-selected={side === 'bidders'} tabIndex={side === 'bidders' ? 0 : -1} onClick={() => { setSide('bidders'); setPop(null); }}>
            <TeamIcon />Bidders <span>{bidderSubs ? `${plural(bidderTops, 'group', 'groups')} and ${plural(bidderSubs, 'subgroup', 'subgroups')}` : plural(bidderTops, 'group', 'groups')}</span>
            {!isPast && pendingCount('bidders') ? <em title="Unsaved changes">{pendingCount('bidders')}</em> : null}
          </button>
          <button type="button" role="tab" id="tab-seller" aria-controls="e3-panel" aria-selected={side === 'seller'} tabIndex={side === 'seller' ? 0 : -1} onClick={() => { setSide('seller'); setPop(null); }}>
            <SellerIcon />Seller team <span>{plural(sellerN, 'group', 'groups')}</span>
            {!isPast && pendingCount('seller') ? <em title="Unsaved changes">{pendingCount('seller')}</em> : null}
          </button>
          </div>
          <span className="tabs-r">
            {cols.length && m.tops.length ? (
              <button type="button" className="linkbtn" onClick={() => setOpen(anyOpen ? {} : Object.fromEntries([...m.rows.values()].filter((r) => r.kids.length).map((r) => [r.id, true])))}>
                {anyOpen ? 'Close all subfolders' : 'Open all subfolders'}
              </button>
            ) : null}
          </span>
        </div>
        <div className="mxwrap" role="tabpanel" id="e3-panel" aria-labelledby={side === 'bidders' ? 'tab-bidders' : 'tab-seller'} onScroll={() => { if (pop && Date.now() - popAt.current > 250) setPop(null); }}>
          {cols.length && m.tops.length ? matrix() : !m.tops.length ? (
            <div className="empty">
              <div className="ei"><FolderIcon /></div>
              <h2>No folders yet</h2>
              <p>Access is set per folder. Create the folders in Documents first, then choose here what each group sees.</p>
              <div className="row"><Link className="btn primary" href={roomHref(ws, 'documents')}>Go to Documents</Link></div>
            </div>
          ) : (
            <div className="empty">
              <div className="ei"><TeamIcon /></div>
              {side === 'bidders' ? (
                <>
                  <h2>No bidder groups yet</h2>
                  <p>Access is set per group. Create one group per bidder in People, then choose here what each one sees.</p>
                </>
              ) : (
                <>
                  <h2>No seller team groups yet</h2>
                  <p>Room admins see everything, so they are not listed here. Create a seller team group in People, such as contributors who add documents.</p>
                </>
              )}
              <div className="row"><Link className="btn primary" href={roomHref(ws, 'people')}>Go to People</Link></div>
            </div>
          )}
        </div>
        {cols.length && m.tops.length ? <div className="lg">
          <span className="scale" aria-label="Levels from fewest to most rights"><span className="lvl l20">View</span><span className="lvl l40">Print</span><span className="lvl l50">Download PDF</span><span className="lvl l60">Original</span></span>
          <span>Filled: set on this folder</span>
          <span><span className="lvl l20 inh">View</span>Outlined: follows the folder above</span>
          <span><span className="lvl deny">Blocked</span>Blocked here, even if the folder above gives access</span>
          <span><span className="lvl none">None</span>No access given</span>
          <span><span className="more">+2</span>Subfolders with their own level</span>
          <span><span className="fx">+1 file</span>A single file with custom access, set in Documents</span>
          {data.personGrants.length ? <span><span className="fx pp">+1 person</span>A right set for one named person in the group</span> : null}
          <span><span className="pill on">U</span>May add files as drafts</span>
          <span><span className="pill on">P</span>May publish drafts</span>
        </div> : null}
      </section>
      {nPending && !isPast ? (
        <div className="cbar-slot">
          <div className="cbar" role="region" aria-label="Unsaved changes">
            <div className="grow"><b>{nPending} unsaved {nPending === 1 ? 'change' : 'changes'}</b><span>Nothing changes for anyone until you save.</span></div>
            <button type="button" className="btn quiet" onClick={() => setPending({})}>Discard</button>
            <button type="button" className="btn primary" onClick={() => { setSaveError(null); setReview(true); }}>Review and save</button>
          </div>
        </div>
      ) : null}
      {pop && !isPast ? (
        <Popover
          key={pop.kind === 'cell' ? `${pop.f}:${pop.g}` : `col:${pop.g}`}
          spec={pop} m={todayM} pending={pending} todayDay={todayDay}
          onClose={() => setPop(null)}
          onApply={(changes) => {
            setPending((cur) => changes.reduce((acc, [f, g, v]) => put(f, g, v, acc), cur));
            setPop(null);
          }}
        />
      ) : null}
      {reviewDrawer()}
      {/* mounted before the toast so it gets announced */}
      <div role="status">{toast ? (
        <div className="toast"><i aria-hidden="true">✓</i><div><b>{toast.title}</b><span>{toast.text}</span></div></div>
      ) : null}</div>
    </div>
  );
}


function Popover({ spec, m, pending, todayDay, onClose, onApply }: {
  spec: PopSpec;
  m: Matrix;
  pending: Pending;
  todayDay: string;
  onClose: () => void;
  onApply: (changes: [string, string, Setting | null][]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const g = m.byGroup.get(spec.g)!;
  const parent = g.parentGroupId ? m.byGroup.get(g.parentGroupId) : undefined;
  const f = spec.kind === 'cell' ? m.rows.get(spec.f)! : null;
  const own = f ? m.rec(f.id, g.id, pending) : undefined;
  const e = f ? m.eff(f.id, g.id, pending) : null;
  const parentRow = f?.parentId ? m.rows.get(f.parentId) : undefined;
  const parentE = f && parentRow ? m.eff(parentRow.id, g.id, pending) : null;
  const cap = f && parent ? m.eff(f.id, parent.id, pending).l : 60;
  let initialPick = parentRow ? 'inherit' : '0';
  if (spec.kind === 'col') initialPick = '';
  else if (own) initialPick = String(own.l);
  const [pick, setPick] = useState(initialPick);
  const [u, setU] = useState(own ? own.u : !!e?.u);
  const [p, setP] = useState(own ? own.p : !!e?.p);
  const [from, setFrom] = useState(own?.from ?? todayDay);
  const [until, setUntil] = useState(own?.until ?? '');
  const [branch, setBranch] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = spec.rect;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
    if (top + h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - h - 12);
    setPos({ left, top });
  }, [spec]);

  // focus() is a no-op while hidden
  const placed = pos !== null;
  useEffect(() => {
    const el = ref.current;
    if (!placed || !el) return;
    const first = el.querySelector<HTMLInputElement>('input:checked') ?? el.querySelector<HTMLInputElement>('input:not(:disabled)');
    first?.focus();
    first?.closest('label')?.scrollIntoView({ block: 'center' });
  }, [placed, spec]);

  useEffect(() => {
    const down = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest('.cell') || t.closest('.gn')) return;
      onClose();
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [onClose]);

  const overridden = f ? m.descendants(f.id).filter((k) => m.rec(k.id, g.id, pending)) : [];
  const persons = f ? m.people(f.id, g.id, false) : [];
  const meter = (l: number) => <span className={`swl l${l}`} aria-hidden="true" />;

  function apply() {
    if (spec.kind === 'col') {
      if (!pick) { onClose(); return; }
      const l = Number(pick);
      onApply(m.tops.map((t) => {
        const cur = m.rec(t, g.id, pending);
        const v: Setting = { l, u: cur?.u ?? false, p: cur?.p ?? false, m: cur?.m ?? false, from: cur?.from ?? null, until: cur?.until ?? null };
        return [t, g.id, l === 0 && !v.u && !v.p && !v.m ? null : v];
      }));
      return;
    }
    if (!f) return;
    if (until && until < todayDay) { setErr('Until cannot be in the past.'); return; }
    if (until && from && from > todayDay && until < from) { setErr('Until must be on or after From.'); return; }
    const changes: [string, string, Setting | null][] = [];
    if (pick === 'inherit') changes.push([f.id, g.id, null]);
    else {
      const v: Setting = {
        l: Number(pick), u: g.side === 'seller' && u, p: g.side === 'seller' && p, m: own?.m ?? false,
        from: from && from > todayDay ? from : null, until: until || null,
      };
      changes.push([f.id, g.id, !f.parentId && v.l === 0 && !v.u && !v.p && !v.m && !v.from && !v.until ? null : v]);
    }
    if (branch) for (const k of overridden) changes.push([k.id, g.id, null]);
    onApply(changes);
  }

  const title = g.name;
  const sub = f ? label(f) : 'Every folder';
  return (
    <div className="pop" role="dialog" aria-modal="false" aria-label={`${title}, ${sub}`} ref={ref}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}>
      <div className="pop-h"><div><b>{title}</b><span>{sub}</span></div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Close /></button></div>
      <div className="pop-b">
        {spec.kind === 'cell' && f ? (
          <>
            <fieldset>
              <legend>Access</legend>
              {parent ? (
                <div className="capbox"><b>Why some levels are capped</b>
                  <p>{g.name} is a subgroup of {parent.name}. A subgroup works for its parent group, so it can never see or download more than the parent itself.</p>
                  <p>The cap depends on {parent.name}&apos;s level in this folder, which is {LV[cap]}. {g.name} can go up to {LV[cap]} here. To give them more, raise {parent.name} in this folder first.</p>
                  {own && own.l > cap ? <p>This folder is set to {LV[own.l]} for {g.name}. It applies as {LV[cap]} until {parent.name} is raised, then the higher level takes effect.</p> : null}
                </div>
              ) : null}
              {parentRow && parentE ? (
                <LvRow value="inherit" pick={pick} setPick={setPick} meter={meter(parentE.l)} name={`Same as ${label(parentRow)}`}
                  desc={`${LV[parentE.l]}${parentE.u ? ', may add files' : ''}${parentE.p ? ', may publish' : ''}`} />
              ) : null}
              {LEVELS.map((l) => {
                const over = l > cap;
                const stored = over && own?.l === l;
                let desc = LV_DESC[l]!;
                if (stored) desc = `Set here. Applies as ${LV[cap]} until ${parent!.name} is raised`;
                else if (over) desc = `Higher than ${parent!.name} has here`;
                let tag: ReactNode = null;
                if (over) tag = <span className="capt" title={`${g.name} can never exceed ${parent!.name}`}>Capped</span>;
                else if (R2[l]) tag = <span className="rtag" title="Available from release 2">R2</span>;
                return (
                  <LvRow key={l} value={String(l)} pick={pick} setPick={setPick} meter={meter(l)} name={LV[l]!}
                    desc={desc} disabled={over && !stored} tag={tag} />
                );
              })}
            </fieldset>
            {persons.length ? (
              <div className="capbox" data-testid="person-box"><b>Set for {persons.length === 1 ? 'a named person' : 'named people'}</b>
                {persons.map((pg) => <p key={`${pg.personId}|${pg.nodeId}`}>{personLine(pg, m.rows.get(pg.nodeId)!)}.</p>)}
                <p>{persons.some((pg) => pg.effect === 'deny') ? 'A block for a person beats this level for them. ' : ''}{persons.some((pg) => pg.effect === 'allow') ? 'An allow for a person adds to what this group gives them. ' : ''}This panel does not change it.</p>
              </div>
            ) : null}
            {g.side === 'seller' && pick !== 'inherit' ? (
              <div><p className="lh">Contributing</p>
                <label className="swr"><input type="checkbox" role="switch" className="tgl" checked={u} onChange={(ev) => setU(ev.target.checked)} />
                  <span><b>May add files</b><small>Uploads arrive as drafts. Someone with the publish right releases them.</small></span></label>
                <label className="swr" style={{ marginTop: 8 }}><input type="checkbox" role="switch" className="tgl" checked={p} onChange={(ev) => setP(ev.target.checked)} />
                  <span><b>May publish drafts</b><small>Releases drafts to the groups that already have access here. Cannot change who sees the folder.</small></span></label>
              </div>
            ) : null}
            {overridden.length ? (
              <label className="chk"><input type="checkbox" checked={branch} onChange={(ev) => setBranch(ev.target.checked)} />
                <span>Also reset {overridden.length} {overridden.length === 1 ? 'subfolder that sets' : 'subfolders that set'} its own level for {g.name} ({overridden.map((k) => k.ix).join(', ')}), so {overridden.length === 1 ? 'it follows' : 'they follow'} this folder.</span></label>
            ) : f.kids.length ? (
              <p className="hint">All {f.kids.length} subfolders follow this folder for {g.name}.</p>
            ) : null}
            {pick !== 'inherit' ? (
              <div><p className="lh">Dates</p>
                <div className="dates">
                  <label>From<input type="date" value={from} min={todayDay} onChange={(ev) => { setFrom(ev.target.value); setErr(null); }} /></label>
                  <label>Until<input type="date" value={until} min={todayDay} onChange={(ev) => { setUntil(ev.target.value); setErr(null); }} /></label>
                </div>
                <p className="hint" style={{ marginTop: 6 }}>Leave Until empty for no end date.</p>
                {err ? <p className="hint err" role="alert">{err}</p> : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <fieldset>
              <legend>Set every top-level folder to</legend>
              {LEVELS.map((l) => (
                <LvRow key={l} value={String(l)} pick={pick} setPick={setPick} meter={meter(l)} name={LV[l]!} desc={LV_DESC[l]!}
                  tag={R2[l] ? <span className="rtag" title="Available from release 2">R2</span> : null} />
              ))}
            </fieldset>
            <p className="hint">Subfolders that set their own level for {g.name} keep it. Upload and publish switches stay as they are.{parent ? ` ${g.name} stays capped at ${parent.name}'s level in each folder.` : ''}</p>
          </>
        )}
      </div>
      <div className="pop-f">
        <button type="button" className="btn secondary sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary sm" onClick={apply}>Apply</button>
      </div>
    </div>
  );
}

function LvRow({ value, pick, setPick, meter, name, desc, disabled, tag }: {
  value: string; pick: string; setPick: (v: string) => void; meter: ReactNode; name: string; desc: string; disabled?: boolean; tag?: ReactNode;
}) {
  return (
    <label className={`lv${disabled ? ' dis' : ''}`}>
      <input type="radio" name="pop-lv" value={value} checked={pick === value} disabled={disabled} onChange={() => setPick(value)} />
      {meter}
      <span><b>{name}</b><small>{desc}</small></span>
      {tag ?? <span />}
    </label>
  );
}

export type { PendingValue };
