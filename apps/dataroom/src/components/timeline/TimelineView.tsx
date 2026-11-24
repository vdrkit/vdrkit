// SPDX-License-Identifier: AGPL-3.0-only
import type { Milestone } from '@/components/dashboard/model';
import { Icon } from '@/components/shell/icons';
import { formatDay, zoneAbbreviation } from '@/lib/time';
import { dayIn, phaseCards, phaseDates, timeIn, type PhaseCard } from './model';

export function When({ m, tz }: { m: Milestone; tz: string }) {
  const due = new Date(m.dueAt);
  return <div className="when"><i /><div><b>{formatDay(m.dueAt, tz, due)}</b><small>{timeIn(m.dueAt, tz)} {zoneAbbreviation(due, tz)}</small></div></div>;
}

export function PhaseStatus({ status }: { status: PhaseCard['status'] }) {
  if (status === 'now') return <span className="st now">Now</span>;
  return <span className="st next">{status === 'done' ? 'Done' : 'Next'}</span>;
}

export function TimelineView({ roomName, timeZone, now: nowIso, milestones }: { roomName: string; timeZone: string; now: string; milestones: Milestone[] }) {
  const now = new Date(nowIso);
  const tz = timeZone;
  const zone = zoneAbbreviation(now, tz);
  const today = dayIn(now, tz);
  const { phases, loose } = phaseCards(milestones, tz, now);

  const row = (m: Milestone, end = false, n?: number) => (
    <div key={m.id} className={`trow${end ? ' end' : ''}${new Date(m.dueAt) <= now ? ' done' : ''}`} data-milestone={m.title}>
      <When m={m} tz={tz} />
      <div className="what"><b>{m.title}</b>{end ? <span className="cap">End of phase {n}</span> : null}</div>
      <span />
    </div>
  );
  const card = (ph: PhaseCard) => {
    const { range, extra } = phaseDates(ph, today, tz);
    return (
      <section key={ph.end.id} className="panel" aria-label={`Phase ${ph.n}`} data-phase={ph.name}>
        <div className="phh"><div>
          <p className="over">Phase {ph.n} of {phases.length}</p>
          <h2>{ph.name}<PhaseStatus status={ph.status} /></h2>
          <span className="cap">{range}{extra}</span>
        </div></div>
        {ph.events.map((e) => row(e))}
        {row(ph.end, true, ph.n)}
      </section>
    );
  };

  return (
    <div className="f2 f2-view" data-screen="timeline">
      <div className="head"><div>
        <h1>Timeline</h1>
        <p className="sub">The phases of {roomName} and the dates inside them that apply to you. Times are in your time zone, {zone}.</p>
      </div></div>
      {milestones.length ? (
        <div className="col">
          {phases.map(card)}
          {loose.length ? (
            <section className="panel" aria-label="After the last phase" data-phase="">
              <div className="phh"><div><p className="over">After the last phase</p><h2>Not in a phase</h2></div></div>
              {loose.map((e) => row(e))}
            </section>
          ) : null}
        </div>
      ) : (
        <section className="panel">
          <div className="empty">
            <div className="ei"><Icon name="time" /></div>
            <h2>No dates yet</h2>
            <p>The room admins have not set any dates yet. They appear here and on your dashboard once they do.</p>
          </div>
        </section>
      )}
    </div>
  );
}
