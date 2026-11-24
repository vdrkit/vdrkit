// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import type { ReactNode } from 'react';
import { roomHref } from '@/components/room/routes';
import type { Milestone } from './model';
import { TimelineCard } from './TimelineCard';
import { noticeText, type WaitingNotice } from '@/lib/notice';

export { noticeText, type WaitingNotice };

export interface ReadyStep {
  done: boolean;
  title: string;
  text: string;
  action?: { label: string; href: string };
}

export function ReadyChecklist({ roomName, steps, extra }: { roomName: string; steps: ReadyStep[]; extra?: ReactNode }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <div className="c1" data-dashboard="new-room">
      <div className="head"><div>
        <h1>Get {roomName} ready</h1>
        <p className="sub">The room is in Preparing: only the seller team and room admins can enter. Work through these steps in any order, then open it to bidders.</p>
      </div></div>
      {extra ? <div className="attn">{extra}</div> : null}
      <section className="panel ready">
        <div className="ph">
          <h2>{done} of {steps.length} done</h2>
          <div className="bar" role="img" aria-label={`${done} of ${steps.length} steps done`}><i style={{ width: `${Math.round((done / steps.length) * 100)}%` }} /></div>
        </div>
        <ol className="steps2">
          {steps.map((s, i) => (
            <li key={s.title} className={s.done ? 'done' : ''}>
              <i className="n" aria-label={s.done ? 'Done' : `Step ${i + 1}`}>{s.done ? '✓' : i + 1}</i>
              <div><b>{s.title}</b><span>{s.text}</span></div>
              {s.action && !s.done ? <Link className="btn secondary sm" href={s.action.href}>{s.action.label}</Link> : null}
            </li>
          ))}
        </ol>
      </section>
      <p className="sub">This list disappears once the room is open. The dashboard then shows activity, new documents and deadlines.</p>
    </div>
  );
}

const MailIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5L12 13l8.5-6.5" /></svg>
);

export function BidderWaiting(p: {
  ws: string; roomName: string; groupName: string; timeZone: string; now: string; milestones: Milestone[];
  notice?: WaitingNotice | null; extra?: ReactNode;
}) {
  const panel = (
    <section className="panel">
      <div className="empty">
        <div className="ei"><MailIcon /></div>
        <h2>No documents shared with {p.groupName} yet</h2>
        <p>The seller is still preparing the documents. {noticeText(p.notice)}</p>
        <div className="row"><Link className="btn secondary" href={roomHref(p.ws, 'profile')}>Change how you are told</Link></div>
      </div>
    </section>
  );
  return (
    <div className="c1" data-dashboard="waiting">
      <div className="head"><div><p className="over">{p.roomName} · {p.groupName}</p><h1 className="sr-only">Dashboard</h1></div></div>
      {p.milestones.length ? (
        <div className="grid">
          <div className="col">{panel}</div>
          <div className="col">
            <TimelineCard milestones={p.milestones} timeZone={p.timeZone} now={p.now} admin={false}
              timelineHref={roomHref(p.ws, 'timeline')} />
            {p.extra}
          </div>
        </div>
      ) : <>{panel}{p.extra}</>}
    </div>
  );
}
