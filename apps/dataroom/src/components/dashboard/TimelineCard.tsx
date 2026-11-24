// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import type { ReactNode } from 'react';
import { calendarDays, formatDayWithYear, phasesOf, type Milestone, type Phase, zoneName } from './model';
import { formatDay, formatTime, partsIn } from '@/lib/time';
import { lowerFirst } from '@/components/timeline/model';

export interface TimelineCardProps {
  milestones: Milestone[];
  timeZone: string;
  now: string;
  admin: boolean;
  groups?: Record<string, { name: string; colour: string }>;
  timelineHref: string;
  footnote?: ReactNode;
}

function rowDate(at: string, timeZone: string, now: Date): string {
  const d = new Date(at);
  const day = formatDay(d, timeZone, d);
  return d <= now ? day : `${day}, ${formatTime(d, timeZone)}`;
}

function startDay(isoDate: string): string {
  const noon = new Date(`${isoDate}T12:00:00Z`);
  return formatDay(noon, 'UTC', noon);
}

function daysFromDate(isoDate: string, to: Date, timeZone: string): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const p = partsIn(to, timeZone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(y, m - 1, d)) / 86_400_000);
}

// the API already filters events for bidders
export function TimelineCard({ milestones, timeZone, now: nowIso, admin, groups = {}, timelineHref, footnote: ownFootnote }: TimelineCardProps) {
  const now = new Date(nowIso);
  const { phases, loose } = phasesOf(milestones);

  if (!milestones.length) {
    if (!admin) return null;
    return (
      <section className="panel ms" aria-label="Process timeline">
        <p className="over">Process timeline</p>
        <p className="cap" style={{ margin: '6px 0 0' }}>No phases yet. Add the phases of the process and the deadline that ends each one, such as non-binding offers due.</p>
        <div style={{ marginTop: 10 }}><Link className="btn secondary sm" href={timelineHref}>Edit timeline</Link></div>
      </section>
    );
  }

  const footnote = ownFootnote ?? (admin
    ? <>Times in your time zone, {zoneName(timeZone, now)}.</>
    : <>Times in your time zone, {zoneName(timeZone, now)}. Change it in your profile.</>);

  const vis = (m: Milestone) => {
    if (!admin) return null;
    const ids = m.visibleToGroupIds ?? [];
    return (
      <span className="vis">
        {ids.length === 0 ? <span className="cap">All groups</span> : null}
        {ids.map((id) => {
          const g = groups[id];
          if (!g) return null;
          return <span key={g.name} className="chip"><i style={{ background: g.colour }} />{ids.length === 1 ? `${g.name} only` : g.name}</span>;
        })}
      </span>
    );
  };
  const event = (m: Milestone) => (
    <div key={m.id} className={`ev${new Date(m.dueAt) <= now ? ' done' : ''}`} data-milestone={m.title}>
      <i /><span>{m.title}{vis(m)}</span><span className="d">{rowDate(m.dueAt, timeZone, now)}</span>
    </div>
  );

  const current = phases.find((p) => new Date(p.end.dueAt) > now) ?? null;
  const head = current ? <Headline phase={current} count={phases.length} timeZone={timeZone} now={now} /> : (
    <>
      <p className="over">Process timeline</p>
      <div className="ms-what" style={{ marginTop: 6 }}>{phases.length ? 'Every phase has ended' : 'No phases yet'}</div>
    </>
  );

  return (
    <section className="panel ms" aria-label={current ? 'Current phase' : 'Process timeline'}>
      {head}
      <div className="tl">
        {phases.map((p) => {
          const isNow = p === current;
          const ended = new Date(p.end.dueAt) <= now;
          let label = '';
          let pend = 'pend';
          if (isNow) {
            label = 'now';
            pend += ' next';
          } else if (ended) {
            label = 'done';
            pend += ' done';
          } else if (p.startsOn) {
            label = `from ${startDay(p.startsOn)}`;
          }
          return [
            <div key={`phase-${p.n}`} className={`phase${isNow ? ' now' : ''}`} data-phase={p.name}>
              <i /><span><b>Phase {p.n} · {p.name}</b></span><span className="d">{label}</span>
            </div>,
            ...p.events.map(event),
            <div key={p.end.id} className={pend} data-milestone={p.end.title}>
              <i />
              <span>{isNow ? <b>{p.end.title}</b> : p.end.title}<span className="cap" style={{ display: 'block' }}>End of phase {p.n}</span></span>
              <span className="d">{rowDate(p.end.dueAt, timeZone, now)}</span>
            </div>,
          ];
        })}
        {loose.map(event)}
      </div>
      <p className="cap" style={{ margin: '12px 0 0' }}>{footnote}</p>
      {admin ? <div style={{ marginTop: 10 }}><Link className="btn secondary sm" href={timelineHref}>Edit timeline</Link></div> : null}
    </section>
  );
}

function Headline({ phase, count, timeZone, now }: { phase: Phase; count: number; timeZone: string; now: Date }) {
  const end = new Date(phase.end.dueAt);
  const left = Math.max(0, calendarDays(now, end, timeZone));
  const start = phase.startsOn;
  const total = start ? Math.max(1, daysFromDate(start, end, timeZone)) : null;
  const day = start ? daysFromDate(start, now, timeZone) + 1 : null;
  const started = day === null || day >= 1;
  return (
    <>
      <p className="over">Phase {phase.n} of {count} · {phase.name}</p>
      <div className="big" data-testid="days-left">{left}<small>{left === 1 ? 'day left in this phase' : 'days left in this phase'}</small></div>
      <div className="ms-what">Ends with: {lowerFirst(phase.end.title)}</div>
      <div className="cap">{formatDayWithYear(end, timeZone)}, {formatTime(end, timeZone)}</div>
      {total !== null && day !== null ? (
        <>
          <div className="bar" aria-hidden="true"><i style={{ width: `${Math.round((Math.min(Math.max(day, 0), total) / total) * 100)}%` }} /></div>
          <div className="cap num">{started ? `Day ${Math.min(day, total)} of ${total} in this phase` : `Starts ${startDay(start!)}`}</div>
        </>
      ) : null}
    </>
  );
}
