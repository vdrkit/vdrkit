// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { browserApi } from '@/api/browser';
import { RoomLogo } from './RoomLogo';
import { useToast } from '@/components/outside/Toast';
import { roomHref } from '@/components/room/routes';
import { useSendOnce } from '@/lib/send-once';
import {
  companyLine, lastVisit, matches, pastFacts, roomFacts, roomInitials, statusBadge, youAre,
  type Fact, type MyRoomsResponse, type PastRoomCard, type RoomCard,
} from './model';

export function MyRooms({ data, timeZone, now: nowIso }: { data: MyRoomsResponse; timeZone: string; now: string }) {
  const now = new Date(nowIso);
  const [q, setQ] = useState('');
  const [home, setHome] = useState<string | null>(data.openAtSignInWorkspaceId);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const toast = useToast();
  const homeName = data.rooms.find((r) => r.id === home)?.name ?? null;

  const company = (r: { sellerName: string | null }) => companyLine(r.sellerName, data.runBy);
  const rooms = data.rooms.filter((r) => matches(q, r.name, company(r)));
  const past = data.past.filter((r) => matches(q, r.name, company(r)));

  const toggle = once(async (r: RoomCard) => {
    if (busy) return;
    const was = home;
    const next = was === r.id ? null : r.id;
    const wasName = data.rooms.find((x) => x.id === was)?.name ?? null;
    setHome(next);
    setBusy(true);
    const res = await browserApi().PUT('/v1/me/open-at-sign-in', { body: { workspaceId: next } }).catch(() => null);
    setBusy(false);
    if (!res || res.error || !res.data) {
      setHome(was);
      toast.show('Nothing changed', 'The setting could not be saved. Try again in a minute.');
      return;
    }
    if (next) toast.show(`${r.name} opens at sign-in`, `${wasName ? `Instead of ${wasName}. ` : ''}Use Switch in the room to come back here.`);
    else toast.show('You start on My rooms', 'Every sign-in shows your rooms first.');
  });

  // non-admins have lost access to a closed room too
  const archive = (r: PastRoomCard) => r.kind === 'closed' && r.canOpen;
  let pastNote = 'Closed rooms, and rooms where your access has ended';
  if (data.past.every(archive)) pastNote = 'Closed rooms stay here for the archive export';
  else if (!data.past.some(archive)) pastNote = 'Rooms where your access has ended';

  return (
    <div className="b1">
      <div className="head">
        <div>
          <p className="over">{data.runBy}</p>
          <h1>My rooms</h1>
          <p className="sub">
            {homeName
              ? <>You go straight to <b>{homeName}</b> when you sign in. Switch it off below to start here instead.</>
              : <>You start here when you sign in. Switch on “Open at sign-in” for the room you work in most, to go straight there.</>}
            {' '}The Switch button in a room brings you back here.
          </p>
        </div>
      </div>

      <div className="tools">
        <label className="fsearch">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a room by name or company" aria-label="Find a room" />
        </label>
      </div>

      <section aria-label="Your rooms">
        <div className="section-h"><h2>Your rooms</h2><span>{rooms.length}</span></div>
        {rooms.length
          ? <div className="rooms">{rooms.map((r) => (
            <Card key={r.id} r={r} company={company(r)} home={home === r.id} busy={busy} onToggle={() => { void toggle(r); }}
              facts={roomFacts(r, timeZone, now)} last={lastVisit(r.lastVisitAt, timeZone, now)} />
          ))}</div>
          : <p className="empty">{q.trim() ? `No rooms match “${q}”.` : 'You have no open rooms at the moment.'}</p>}
      </section>

      {past.length ? (
        <section className="past" aria-label="Past rooms">
          <div className="section-h"><h2>Past rooms</h2><span>{pastNote}</span></div>
          <div className="rooms">{past.map((r) => (
            <Past key={r.id} r={r} company={company(r)} facts={pastFacts(r, timeZone)} last={lastVisit(r.lastVisitAt, timeZone, now)} />
          ))}</div>
        </section>
      ) : null}
      {toast.node}
    </div>
  );
}

function Facts({ facts }: { facts: Fact[] }) {
  return (
    <span className="facts">
      {facts.map((f) => <div key={f.text} className={f.tone || undefined}><i></i><span>{f.text}</span></div>)}
    </span>
  );
}

function Logo({ r }: { r: { id: string; name: string; logos: RoomCard['logos'] } }) {
  return <RoomLogo roomId={r.id} initials={roomInitials(r.name)} logos={r.logos} className="rl" />;
}

function Card({ r, company, home, busy, onToggle, facts, last }: {
  r: RoomCard; company: string; home: boolean; busy: boolean; onToggle: () => void; facts: Fact[]; last: string;
}) {
  const st = statusBadge(r.state);
  return (
    <div className={`rc${home ? ' home' : ''}`} data-room={r.id}>
      <span className="rh">
        <Logo r={r} />
        <span className="nm"><b>{r.name}</b><span>{company}</span></span>
        <span className={`badge ${st.cls} st`}>{st.label}</span>
      </span>
      <span className="role">You are <b>{youAre(r)}</b></span>
      <Facts facts={facts} />
      <span className="lastv">{last}</span>
      <div className="acts">
        {r.canEnter
          ? <button type="button" className={`pin${home ? ' on' : ''}`} role="switch" aria-checked={home} disabled={busy} onClick={onToggle}
            title={home ? `Stop opening ${r.name} at sign-in` : `Open ${r.name} straight after signing in`}>
            <span className="tg"><i></i></span>Open at sign-in
          </button>
          : <span></span>}
        {r.canEnter
          ? <Link className="btn primary sm" href={roomHref(r.id, 'dashboard')} aria-label={`Open room ${r.name}`}>Open room</Link>
          : <span className="cap">Not open yet</span>}
      </div>
    </div>
  );
}

function Past({ r, company, facts, last }: { r: PastRoomCard; company: string; facts: Fact[]; last: string }) {
  const st = statusBadge(r.kind === 'access_ended' ? 'access_ended' : 'closed');
  return (
    <div className="rc" data-room={r.id}>
      <span className="rh">
        <Logo r={r} />
        <span className="nm"><b>{r.name}</b><span>{company}</span></span>
        <span className={`badge ${st.cls} st`}>{st.label}</span>
      </span>
      <span className="role">You are <b>{youAre(r)}</b></span>
      <Facts facts={facts} />
      <span className="lastv">{last}</span>
      <div className="acts">
        <span></span>
        {r.canOpen
          ? <Link className="btn secondary sm" href={roomHref(r.id, 'dashboard')} aria-label={`Open the archive of ${r.name}`}>Open the archive</Link>
          : <span className="cap">You can no longer open it</span>}
      </div>
    </div>
  );
}
