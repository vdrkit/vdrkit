// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import { roomHref } from '@/components/room/routes';
import { DeclineDialog } from '@/components/people/dialogs';
import { useToast } from '@/components/outside/Toast';
import { SeeAsPicker } from '@/components/room/SeeAs';
import { formatDay, zoneAbbreviation } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import {
  formatAsked, groupColours, lastSeen, n, pastDay, plural, seriesDays, slowdown, splitFolder, waited, word,
  type GroupActivity, type Milestone, type NotPublished, type TeamRequest, type ToDo,
} from './model';
import { TimelineCard } from './TimelineCard';

export interface AdminDashboardProps {
  ws: string;
  roomName: string;
  timeZone: string;
  roomTimeZone: string;
  now: string;
  toDo: ToDo;
  requests: TeamRequest[];
  activity: GroupActivity[];
  milestones: Milestone[];
  notPublished?: NotPublished[];
  folderIds: Record<string, string>;
  demo?: boolean;
}

type Card = { key: string; since: string | null; node: ReactNode };

const earliest = (times: string[]) => times.sort()[0] ?? null;

export function AdminDashboard(p: AdminDashboardProps) {
  const now = new Date(p.now);
  const colours = groupColours(p.activity);
  const chip = (name: string, groupId?: string) => (
    <span className="chip"><i style={{ background: (groupId && colours.get(groupId)) || 'var(--g-s)' }} />{name}</span>
  );
  const groupById = Object.fromEntries(p.activity.map((g) => [g.groupId, { name: g.groupName, colour: colours.get(g.groupId) ?? 'var(--g-s)' }]));
  const groupIdByName = new Map(p.activity.map((g) => [g.groupName, g.groupId]));

  const { drafts, failedProcessing: failed } = p.toDo;
  const requests = [...p.requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const cards: Card[] = [];
  const toast = useToast();
  if (drafts.count > 0) {
    cards.push({ key: 'drafts', since: drafts.oldestAt, node: <DraftsCard key="drafts" ws={p.ws} drafts={drafts} now={now} timeZone={p.timeZone} /> });
  }
  if (requests.length > 0) {
    cards.push({ key: 'requests', since: requests[0]!.createdAt, node: (
      <section className="panel task" aria-label="Access requests to decide" key="requests">
        <div className="ph"><div><p className="over">Access requests</p><div className="k">{n(requests.length)}</div></div>
          <span className="badge b-info">{waited(requests[0]!.createdAt, now, p.timeZone)}</span></div>
        {requests.map((r) => (
          <AccessRequest key={r.id} ws={p.ws} request={r} demo={p.demo} onDeclined={toast.show}
            chip={chip(r.groupName, groupIdByName.get(r.groupName))} asked={formatAsked(r.createdAt, p.timeZone, now)} />
        ))}
        <div className="pfoot"><span className="cap">Approving gives them the group&apos;s current rights</span></div>
      </section>
    ) });
  }
  if (failed.length > 0) {
    const one = failed.length === 1 ? failed[0]! : null;
    const parentIx = one?.indexNumber?.split('.').slice(0, -1).join('.');
    const parentId = parentIx ? p.folderIds[parentIx] : undefined;
    cards.push({ key: 'failed', since: earliest(failed.map((f) => f.uploadedAt)), node: (
      <section className="panel task" aria-label={failed.length === 1 ? 'File that failed processing' : 'Files that failed processing'} key="failed">
        <div className="ph"><div><p className="over">Failed processing</p><div className="k">{n(failed.length)}</div></div>
          <span className="badge b-danger">Failed</span></div>
        <ul>
          {failed.map((f) => (
            <Fragment key={f.nodeId}>
              <li><span className="n">{f.indexNumber}</span><span className="t"><b style={{ fontWeight: 600 }}>{f.name}</b></span></li>
              <li><span className="t cap">{f.error ?? 'VDRkit could not convert the file for viewing.'}{' '}
                {`Uploaded${f.uploadedBy ? ` by ${f.uploadedBy}` : ''} ${formatAsked(f.uploadedAt, p.timeZone, now)}.`}</span></li>
            </Fragment>
          ))}
        </ul>
        <div className="pfoot"><div className="btns" style={{ marginLeft: 0 }}>
          <Link className="btn secondary sm" href={roomHref(p.ws, 'documents', parentId)}>{one ? 'Upload a new copy' : 'Go to Documents'}</Link>
          {one?.uploadedBy && one.uploadedById ? <AskUploader ws={p.ws} nodeId={one.nodeId} name={one.uploadedBy} demo={p.demo} /> : null}
        </div></div>
      </section>
    ) });
  }
  if (p.notPublished?.length) {
    cards.push({ key: 'not-published', since: earliest(p.notPublished.map((d) => d.at)), node: <NotPublishedCard key="not-published" ws={p.ws} items={p.notPublished} now={now} timeZone={p.timeZone} /> });
  }
  cards.sort((a, b) => (a.since ?? '9999').localeCompare(b.since ?? '9999'));

  let h1 = 'Nothing needs your action';
  if (cards.length === 1) h1 = 'One task needs your action';
  else if (cards.length > 1) h1 = `${word(cards.length)} tasks need your action`;

  return (
    <div className="c1" data-dashboard="admin">
      <div className="head">
        <div>
          <h1>{h1}</h1>
        </div>
        <div className="cta"><SeeAsPicker ws={p.ws} /></div>
      </div>

      <div className="grid c1-grid">
        <div className="col">
          {cards.length ? (
            <>
              <div className="section-h"><h2>To do</h2></div>
              <div className="attn">{cards.map((c) => c.node)}</div>
            </>
          ) : null}
          <div className="section-h"><h2>Insights</h2></div>
          <Activity {...p} colours={colours} />
        </div>
        <div className="col c1-side">
          <TimelineCard milestones={p.milestones} timeZone={p.timeZone} now={p.now} admin groups={groupById}
            timelineHref={roomHref(p.ws, 'timeline')} />
        </div>
      </div>
      {toast.node}
    </div>
  );
}

export function DraftsCard({ ws, drafts, now, timeZone, why = 'Bidders cannot see these until you publish them.' }: {
  ws: string;
  drafts: { count: number; oldestAt: string | null; byFolder: { folder: string; count: number }[] };
  now: Date;
  timeZone: string;
  why?: string;
}) {
  const wait = waited(drafts.oldestAt, now, timeZone);
  return (
    <section className="panel task" aria-label="Drafts to review and publish">
      <div className="ph"><div><p className="over">Drafts to publish</p><div className="k">{n(drafts.count)}</div></div>
        {wait ? <span className="badge b-warn">{wait}</span> : null}</div>
      <p className="why">{why}</p>
      <ul>
        {drafts.byFolder.slice(0, 4).map((f) => {
          const folder = splitFolder(f.folder);
          return <li key={f.folder}><span className="n">{folder.ix}</span><span className="t">{folder.name}</span><em>{plural(f.count, 'file', 'files')}</em></li>;
        })}
      </ul>
      <div className="pfoot">
        <div className="btns"><Link className="btn primary sm" href={roomHref(ws, 'release')}>Review and publish</Link></div></div>
    </section>
  );
}

const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function NotPublishedCard({ ws, items, now, timeZone }: { ws: string; items: NotPublished[]; now: Date | string; timeZone: string }) {
  const folders = new Set(items.map((d) => d.folderId));
  const folder = folders.size === 1 ? items[0]!.folderId : null;
  const newest = items.map((d) => d.at).sort().at(-1)!;
  return (
    <section className="panel task" aria-label={items.length === 1 ? 'A file you asked to publish was not published' : 'Files you asked to publish were not published'}
      data-card="not-published">
      <div className="ph"><div><p className="over">Not published</p><div className="k">{n(items.length)}</div></div>
        <span className="badge b-danger">{capitalise(formatAsked(newest, timeZone, new Date(now)))}</span></div>
      <p className="why">{items.length === 1 ? 'You asked to publish this file with Publish now.' : 'You asked to publish these files with Publish now.'}</p>
      <ul>
        {items.map((d) => <li key={`${d.nodeId}:${d.versionNo ?? 0}`}><span className="t">{d.text}</span></li>)}
      </ul>
      <div className="pfoot"><span className="cap">{items.length === 1 ? 'This notice goes once the file is published, replaced or deleted.' : 'Each notice goes once its file is published, replaced or deleted.'}</span>
        <div className="btns"><Link className="btn secondary sm" href={roomHref(ws, 'documents', folder ?? undefined)}>{folder ? 'Open the folder' : 'Go to Documents'}</Link></div></div>
    </section>
  );
}

function AccessRequest({ ws, request: r, chip, asked, demo, onDeclined }: {
  ws: string; request: TeamRequest; chip: ReactNode; asked: string; demo?: boolean; onDeclined?: (title: string, line: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);

  const decide = once(async (decision: 'approve' | 'decline') => {
    if (demo) return;
    setBusy(decision);
    setError(null);
    const { error: e } = await browserApi().POST('/v1/workspaces/{ws}/team-requests/{id}/decide', {
      params: { path: { ws, id: r.id } }, body: { decision },
    });
    if (e) {
      setBusy(null);
      setError((e as { detail?: string }).detail ?? 'That did not work. Try again.');
      return;
    }
    router.refresh();
  });

  return (
    <div className="ask" data-request={r.name}>
      <div className="l1"><b>{r.name}</b> to join {chip}</div>
      <div className="l2">Asked by {r.requestedBy} · {asked}{r.reason ? <> · &ldquo;{r.reason}&rdquo;</> : null}</div>
      <div className="btns">
        <button type="button" className="btn secondary sm" disabled={busy !== null} onClick={() => decide('approve')}
          title={`Adds ${r.name} to ${r.groupName} and sends the invitation`}>Approve</button>
        <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => { if (!demo) setDeclining(true); }}
          aria-haspopup="dialog" title={`Asks for a reason, then declines the request. ${r.requestedBy} is told.`}>Decline</button>
        {error ? <span className="cap err" role="alert">{error}</span> : null}
      </div>
      {declining ? (
        <div className="e1 e1-host">
          <DeclineDialog ws={ws} request={r} onClose={() => setDeclining(false)}
            onDone={(title, line) => { setDeclining(false); onDeclined?.(title, line); router.refresh(); }} />
        </div>
      ) : null}
    </div>
  );
}

function AskUploader({ ws, nodeId, name, demo }: { ws: string; nodeId: string; name: string; demo?: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle');
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);

  const ask = once(async () => {
    if (demo) { setState('sent'); return; }
    setState('busy');
    setError(null);
    const { data, error: e } = await browserApi().POST('/v1/workspaces/{ws}/nodes/{id}/ask-for-copy', { params: { path: { ws, id: nodeId } } });
    if (e || !data || data.status !== 'accepted') {
      setState('failed');
      setError((e as { detail?: string } | undefined)?.detail ?? `The email to ${name} could not be sent. Try again later.`);
      return;
    }
    setState('sent');
  });

  if (state === 'sent') return <span className="cap" role="status">Email sent to {name}, asking for a copy without a password. Logged in Activity.</span>;
  return (
    <>
      <button type="button" className="btn ghost sm" disabled={state === 'busy'} onClick={ask}
        title={`Emails ${name} to ask for a new copy of the file. Logged in Activity.`}>Ask {name}</button>
      {error ? <span className="cap err" role="alert">{error}</span> : null}
    </>
  );
}

function Spark({ values, fall, label }: { values: number[]; fall: boolean; label: string }) {
  const w = 150, h = 32, pad = 3, max = Math.max(...values, 10);
  const step = (w - 2 * pad) / Math.max(1, values.length - 1);
  const pts = values.map((y, i) => [pad + i * step, h - pad - (y / max) * (h - 2 * pad)] as const);
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');
  const last = pts[pts.length - 1]!;
  const area = `${line}L${last[0].toFixed(1)} ${h - pad}L${pad} ${h - pad}Z`;
  // never colour alone
  const full = fall ? `${label}. Slowed down: shown in yellow, as in the note below the table.` : label;
  return (
    <svg className={`spark${fall ? ' fall' : ''}`} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={full}>
      {fall ? <title>Slowed down. See the note below the table.</title> : null}
      <line className="base" x1={pad} x2={w - pad} y1={h - pad} y2={h - pad} />
      <path className="area" d={area} />
      <path className="ln" d={line} />
      <circle className="dot" cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="2.6" />
    </svg>
  );
}

function Activity(p: AdminDashboardProps & { colours: Map<string, string> }) {
  const now = new Date(p.now);
  const seller = (g: GroupActivity) => g.partyKind === 'seller';
  const tops = p.activity.filter((g) => !g.parentGroupId);
  tops.sort((a, b) => Number(seller(a)) - Number(seller(b)) || b.openedToday - a.openedToday || a.groupName.localeCompare(b.groupName));
  const rows = tops.flatMap((g) => [g, ...p.activity.filter((s) => s.parentGroupId === g.groupId)]);

  const bidders = p.activity.filter((g) => !seller(g));
  const leader = bidders.sort((a, b) => b.openedToday - a.openedToday)[0];
  let title = 'No bidder has opened a document today';
  if (leader && leader.openedToday > 0) title = `${leader.groupName} opened the most documents today`;

  const slow = slowdown(p.activity);
  const days = seriesDays(now);
  const range = `${formatDay(days[0]!, p.roomTimeZone, now)} to ${formatDay(days.at(-1)!, p.roomTimeZone, now)}`;
  const peakDay = slow ? days[slow.peakIndex]! : null;

  return (
    <section className="panel" aria-label="Bidder activity">
      <div className="ph"><h3>{title}</h3><span className="cap">Today so far, {zoneAbbreviation(now, p.roomTimeZone)}</span></div>
      {/* scrollable on phones */}
      <div className="tbl" role="table" aria-label="Bidder activity today" tabIndex={0}>
        <div className="trow thead" role="row"><span role="columnheader">Group</span><span className="r" role="columnheader">Active</span><span className="r" role="columnheader">Opened</span><span role="columnheader">Last 7 days</span><span role="columnheader">Last seen</span></div>
        {rows.length === 0 ? <div className="trow" role="row"><span className="m" role="cell">No bidder groups yet</span></div> : null}
        {rows.map((g) => (
          <div key={g.groupId} className={`trow${g.parentGroupId ? ' subrow' : ''}`} data-group={g.groupName} role="row">
            <span className="gname" role="cell"><b><i style={{ background: p.colours.get(g.groupId) }} />{g.groupName}</b>
              <span>{plural(g.members, 'member', 'members')}{g.parentGroupId ? ', subgroup' : ''}</span></span>
            <span className="r" role="cell">{n(g.activeToday)}</span>
            <span className="r" role="cell">{n(g.openedToday)}</span>
            <span role="cell"><Spark values={g.lastSevenDays} fall={slow?.group.groupId === g.groupId}
              label={`Documents opened per day, ${range}: ${g.lastSevenDays.join(', ')}`} /></span>
            <span className="m" role="cell">{lastSeen(g.lastSeenAt, p.timeZone, now)}</span>
          </div>
        ))}
      </div>
      {slow && peakDay ? (
        <div className="note"><i /><span><b style={{ fontWeight: 600 }}>{slow.group.groupName} has slowed down.</b>{' '}
          {plural(slow.peak, 'document', 'documents')} opened {pastDay(peakDay, now, p.roomTimeZone)}, {n(slow.today)} so far today
          {slow.group.quietThisWeek > 0 && slow.group.members > 1
            ? <>, and nothing from {n(slow.group.quietThisWeek)} of its {n(slow.group.members)} members this week</> : null}.</span></div>
      ) : null}
      <div className="pfoot">
        <Link className="btn ghost sm" href={roomHref(p.ws, 'activity')}>Open activity log</Link></div>
    </section>
  );
}
