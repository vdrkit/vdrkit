// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import { roomHref, viewHref } from '@/components/room/routes';
import { useSeeAs } from '@/components/room/SeeAs';
import { initials } from '@/lib/avatar';
import { formatDay, formatWhen } from '@/lib/time';
import { fileType, n, NEW_PER_FOLDER, newCount, plural, splitFolder, type Coverage, type Milestone, type NewFolder, type NotPublished, type TeamCoverage } from './model';
import { DraftsCard, NotPublishedCard } from './AdminDashboard';
import { TimelineCard } from './TimelineCard';

export interface OwnRequest { id: string; name: string; status: string; createdAt: string; decidedAt?: string | null }

export interface BidderDashboardProps {
  ws: string;
  roomName: string;
  groupName: string;
  kind: 'lead' | 'member' | 'seller';
  timeZone: string;
  now: string;
  personId: string;
  previousVisitAt: string | null;
  newSinceLastVisit: NewFolder[];
  teamCoverage?: TeamCoverage | null;
  myCoverage?: Coverage | null;
  teamSize?: number | null;
  leads?: string[];
  requests?: OwnRequest[] | null;
  toPublish?: { count: number; oldestAt: string | null; byFolder: { folder: string; count: number }[] } | null;
  notPublished?: NotPublished[] | null;
  milestones: Milestone[];
  folderIds: Record<string, string>;
  live?: boolean;
}

const MAX_ROWS = 40;

function clearedKey(ws: string, personId: string) {
  return `vdrkit:c1-cleared:${ws}:${personId}`;
}

// Local to this browser, logs nothing. Only opening a document counts as read.
export function BidderDashboard(p: BidderDashboardProps) {
  const now = new Date(p.now);
  const live = p.live ?? true;
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [sinceCleared, setSinceCleared] = useState<NewFolder[] | null>(null);
  const seeAs = useSeeAs();

  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(clearedKey(p.ws, p.personId)); } catch { /* storage blocked: the list stays */ }
    setClearedAt(stored);
    if (!stored || !live) return;
    // API sends only 5 per folder: ask it, filter locally until it answers
    let gone = false;
    void browserApi().GET('/v1/workspaces/{ws}/dashboard', { params: { path: { ws: p.ws }, query: { after: stored } } })
      .then((r) => { if (!gone && r.data?.newSinceLastVisit) setSinceCleared(r.data.newSinceLastVisit); })
      .catch(() => { /* the filtered rows stay */ });
    return () => { gone = true; };
  }, [p.ws, p.personId, live]);

  function clearList() {
    const at = new Date().toISOString();
    setClearedAt(at);
    setSinceCleared([]);
    try { window.localStorage.setItem(clearedKey(p.ws, p.personId), at); } catch { /* cleared for this page view only */ }
  }

  const all = p.newSinceLastVisit ?? [];
  const total = newCount(all);
  let shown: NewFolder[] = all;
  if (clearedAt && sinceCleared) shown = sinceCleared;
  else if (clearedAt) {
    shown = all.map((f) => {
      const items = f.items.filter((d) => d.publishedAt > clearedAt);
      return { ...f, count: items.length, items };
    });
    shown = shown.filter((f) => f.items.length > 0);
  }
  const shownCount = newCount(shown);
  const cleared = clearedAt && shownCount < total;

  let budget = MAX_ROWS;
  const rows = shown.reduce((s, f) => s + Math.min(f.items.length, NEW_PER_FOLDER), 0);
  const capped = shown.map((f) => {
    const items = f.items.slice(0, Math.max(0, Math.min(budget, NEW_PER_FOLDER)));
    budget -= items.length;
    return { ...f, items };
  }).filter((f) => f.items.length > 0);

  const [first, second] = [...all].sort((a, b) => b.count - a.count);
  const most = first && second && first.count > second.count ? splitFolder(first.folder).name : null;

  let h1 = plural(total, 'new document', 'new documents');
  if (total === 0) h1 = 'Nothing new since your last visit';
  else if (cleared && shownCount === 0) h1 = 'Nothing new since you cleared the list';
  else if (cleared) h1 = `${plural(shownCount, 'new document', 'new documents')} since you cleared the list`;
  else if (p.previousVisitAt) h1 += ' since your last visit';

  let sub: ReactNode;
  if (cleared) sub = <>You cleared the list {formatWhen(clearedAt, p.timeZone, now)}.</>;
  else if (p.previousVisitAt) sub = <>Your last visit was {formatWhen(p.previousVisitAt, p.timeZone, now)}.{most ? <> Most of what is new is in {most}.</> : null}</>;
  else sub = <>This is your first visit, so everything shared with you is new.{most ? <> Most of it is in {most}.</> : null}</>;

  return (
    <div className="c1" data-dashboard={p.kind}>
      <div className="head">
        <div>
          <p className="over">{p.roomName} · {p.groupName}</p>
          <h1>{h1}</h1>
          {sub ? <p className="sub">{sub}</p> : null}
        </div>
      </div>
      <div className="grid">
        <div className="col">
          {((p.toPublish && p.toPublish.count > 0) || p.notPublished?.length) && !seeAs ? (
            <>
              <div className="section-h"><h2>To do</h2></div>
              <div className="attn">
                {p.notPublished?.length ? <NotPublishedCard ws={p.ws} items={p.notPublished} now={now} timeZone={p.timeZone} /> : null}
                {p.toPublish && p.toPublish.count > 0 ? <DraftsCard ws={p.ws} drafts={p.toPublish} now={now} timeZone={p.timeZone}
                  why="Bidders cannot see these until you publish them. These are the drafts in the folders where you may publish." /> : null}
              </div>
              <div className="section-h"><h2>New for you</h2></div>
            </>
          ) : null}
          <section className="panel" aria-label="New since your last visit">
            <div className="ph"><h2>New since your last visit</h2><span className="cap">Grouped by index folder</span></div>
            {capped.map((f) => {
              const folder = splitFolder(f.folder);
              const more = f.items.length < f.count;
              const folderId = f.folderId ?? (f.folder ? p.folderIds[f.folder] : undefined);
              return (
                <div className="fgroup" key={f.folder ?? '-'}>
                  <div className="fhead"><span className="n">{folder.ix}</span>{folder.name}<em>{more ? `${n(f.items.length)} of ${n(f.count)} new` : `${n(f.count)} new`}</em></div>
                  {f.items.map((d) => {
                    const ft = fileType(d.name);
                    return (
                      <Link key={d.id} className="doc" href={viewHref(p.ws, d.id)} aria-label={`Open ${d.indexNumber ?? ''} ${d.name}`.replace('  ', ' ')}>
                        <span className="n">{d.indexNumber}</span>
                        <span className={`ft ${ft || 'none'}`}>{ft.toUpperCase()}</span>
                        <span className="nm">{d.read ? null : <span className="tag-new">NEW</span>}<span>{d.name}</span></span>
                        <span className="when">{formatDay(d.publishedAt, p.timeZone, now)}</span>
                      </Link>
                    );
                  })}
                  {more && folderId ? (
                    <div className="fmore">
                      <Link href={roomHref(p.ws, 'documents', folderId)} aria-label={`Show all of ${f.folder} in Documents`}>Show all</Link>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {shownCount === 0 && total > 0 ? <p className="cap listnote" style={{ margin: 0 }}>You cleared this list. Documents published after that appear here.</p> : null}
            {total === 0 ? <p className="cap listnote" style={{ margin: 0 }}>Nothing has been published since your last visit.</p> : null}
            {rows > MAX_ROWS ? (
              <div className="pfoot"><span className="cap">Showing {MAX_ROWS} of {n(shownCount)}. Browse Documents for the rest.</span>
                <Link className="btn ghost sm" href={roomHref(p.ws, 'documents')}>Go to Documents</Link></div>
            ) : null}
            {shownCount > 0 && !seeAs ? (
              <div className="pfoot">
                <span className="cap">Opening a document marks it read, and the room logs that you opened it. Clearing the list only empties it here and logs nothing.</span>
                <button type="button" className="btn ghost sm" id="clear-new" onClick={clearList}>Clear this list</button>
              </div>
            ) : null}
          </section>
          {p.kind === 'lead' && p.teamCoverage ? <TeamReading {...p} coverage={p.teamCoverage} /> : null}
          {p.kind === 'member' && p.myCoverage ? <OwnReading {...p} coverage={p.myCoverage} /> : null}
        </div>
        <div className="col">
          <TimelineCard milestones={p.milestones} timeZone={p.timeZone} now={p.now} admin={false}
            timelineHref={roomHref(p.ws, 'timeline')} />
          {p.kind === 'lead' ? <Requests {...p} /> : null}
          {p.kind === 'member' ? <AddingColleagues {...p} /> : null}
        </div>
      </div>
    </div>
  );
}

function TeamReading(p: BidderDashboardProps & { coverage: TeamCoverage }) {
  const unread = p.coverage.folders.find((f) => f.opened === 0 && f.total > 0);
  const unreadId = unread ? p.folderIds[unread.folder] : undefined;
  return (
    <section className="panel" aria-label="Your team's reading by folder">
      <div className="ph">
        <h2>Your team has opened {n(p.coverage.opened)} of {n(p.coverage.total)} documents</h2>
        <span className="cap">{p.groupName}{p.teamSize ? `, all ${p.teamSize} members` : ''} · only leads see this</span>
      </div>
      <CoverageBars coverage={p.coverage} />
      {unread ? (
        <div className="pfoot">
          <span className="cap">Nobody in your team has opened {unread.folder} yet: {plural(unread.total, 'document', 'documents')}.</span>
          {unreadId ? <Link className="btn ghost sm" href={roomHref(p.ws, 'documents', unreadId)}>Go to {unread.folder}</Link> : null}
        </div>
      ) : null}
    </section>
  );
}

function CoverageBars({ coverage }: { coverage: Coverage }) {
  return (
    <div className="cov">
      {coverage.folders.map((f) => {
        const folder = splitFolder(f.folder);
        const pct = f.total ? Math.round((f.opened / f.total) * 100) : 0;
        return (
          <div key={f.folder} className={f.opened === 0 ? 'zero' : ''}>
            <span className="n">{folder.ix}</span>
            <span className="lab"><span>{folder.name}</span><span className="track"><i style={{ width: `${pct}%` }} /></span></span>
            <span className="r num">{n(f.opened)} / {n(f.total)}</span>
          </div>
        );
      })}
    </div>
  );
}

function OwnReading(p: BidderDashboardProps & { coverage: Coverage }) {
  const leads = p.leads?.length ?? 0;
  let who: ReactNode = null;
  if (leads === 1) who = <>Your lead sees how {p.groupName} reads as a team. </>;
  else if (leads > 1) who = <>Your leads see how {p.groupName} reads as a team. </>;
  return (
    <section className="panel" aria-label="Your reading by folder">
      <div className="ph">
        <h2>You have opened {n(p.coverage.opened)} of {n(p.coverage.total)} documents</h2>
        <span className="cap">Only you see this</span>
      </div>
      <CoverageBars coverage={p.coverage} />
      <div className="pfoot"><span className="cap">
        {who}
        Nobody else in your team sees your figures.</span></div>
    </section>
  );
}

function Requests(p: BidderDashboardProps) {
  const now = new Date(p.now);
  const seeAs = useSeeAs();
  const day = (iso: string) => formatDay(iso, p.timeZone, now);
  return (
    <section className="panel" aria-label="Your requests">
      <div className="ph">
        <h2>Your requests to add colleagues</h2>
        {seeAs ? null : <Link className="btn ghost sm" href={roomHref(p.ws, 'team')}>Request to add a colleague</Link>}
      </div>
      {p.requests?.length === 0 ? <p className="cap" style={{ margin: 0, padding: '0 16px 14px' }}>You have not asked to add anyone yet.</p> : null}
      {p.requests?.map((r) => {
        let line = `Declined ${day(r.decidedAt ?? r.createdAt)} by the room admin`;
        let badge = 'Declined';
        let cls = 'b-danger';
        if (r.status === 'pending') {
          line = `Requested ${day(r.createdAt)} · waiting for the room admin`;
          badge = 'Pending';
          cls = 'b-warn';
        } else if (r.status === 'approved') {
          line = `Approved ${day(r.decidedAt ?? r.createdAt)} · now in ${p.groupName}`;
          badge = 'Active';
          cls = 'b-ok';
        }
        return (
          <div className="req" key={r.id}>
            <span className="avatar">{initials(r.name)}</span>
            <div className="who"><b>{r.name}</b><span className="m">{line}</span></div>
            <span className={`badge ${cls}`}>{badge}</span>
          </div>
        );
      })}
    </section>
  );
}

function AddingColleagues(p: BidderDashboardProps) {
  const leads = p.leads ?? [];
  let who = <>The leads of {p.groupName} can request to add colleagues. </>;
  if (leads.length === 1) who = <>Your lead, {leads[0]}, can request to add colleagues to {p.groupName}. </>;
  else if (leads.length > 1) who = <>Your leads, {`${leads.slice(0, -1).join(', ')} and ${leads.at(-1)}`}, can request to add colleagues to {p.groupName}. </>;
  return (
    <section className="panel" aria-label="Adding colleagues">
      <div className="ph"><h2>Adding colleagues</h2></div>
      <p className="cap" style={{ margin: 0, padding: '0 18px 16px' }}>
        {who}
        The room admin approves each request.
      </p>
    </section>
  );
}
