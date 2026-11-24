// SPDX-License-Identifier: AGPL-3.0-only
import { ClockIcon, ClosedIcon, LeaveIcon, LockIcon, NotFoundIcon } from '@/components/outside/icons';
import { formatDay } from '@/lib/time';

export function describeMinutes(m: number): string {
  if (m % 60 === 0) return `${m / 60} ${m === 60 ? 'hour' : 'hours'}`;
  return `${m} minutes`;
}

export function dayWithYear(at: string, timeZone: string): string {
  return formatDay(at, timeZone, new Date('1970-01-01T00:00:00Z'));
}

export function roomAdmin(contact: string | null | undefined, org: string | null | undefined): string {
  if (!contact) return 'the room admin';
  return `the room admin, ${contact}${org ? ` at ${org}` : ''}`;
}

export function RoomCard({ name, line }: { name: string; line: string }) {
  const initials = name.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('').slice(0, 2);
  return <div className="inv"><div className="room-logo">{initials}</div><div><b>{name}</b><span>{line}</span></div></div>;
}

export function LinkExpired() {
  return (
    <>
      <div className="done-ico bad"><ClockIcon /></div>
      <div>
        <h1>This sign-in link has expired</h1>
        <p className="lead">Sign-in links work once and for 15 minutes, so a forwarded or old email cannot open the room. Ask for a new one below.</p>
      </div>
      <a className="btn primary block" href="/sign-in">Get a new sign-in email</a>
    </>
  );
}

// the API doesn't return ended rooms
export function AccessEnded(p: { room?: string; group?: string; endedAt?: string; timeZone?: string; contact?: string | null; org?: string | null }) {
  if (!p.room) {
    return (
      <>
        <div className="done-ico bad"><LockIcon /></div>
        <div>
          <h1>Your access has ended</h1>
          <p className="lead">You are not in any data room on this site at the moment. If you still need access, ask your lead or the room admin to extend it.</p>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="done-ico bad"><LockIcon /></div>
      <div>
        <h1>Your access to {p.room} has ended</h1>
        <p className="lead">
          {p.group && p.endedAt && p.timeZone ? <>Access for {p.group} ended on <b>{dayWithYear(p.endedAt, p.timeZone)}</b>. </> : null}
          If you still need it, ask your lead or {roomAdmin(p.contact, p.org)}, to extend it.
        </p>
      </div>
      <p className="hint">Other data rooms you belong to are not affected.</p>
    </>
  );
}

// non-members and missing rooms get the plain page: don't leak the room
// See as records nothing
export function NotAvailable({ room, seeAs = false }: { room?: { id: string; name: string }; seeAs?: boolean }) {
  if (!room) {
    return (
      <>
        <div className="done-ico"><NotFoundIcon /></div>
        <div>
          <h1>This page is not available</h1>
          <p className="lead">Check the link, or ask the person who sent it.</p>
        </div>
        <a className="btn primary block" href="/rooms">Go to my rooms</a>
      </>
    );
  }
  return (
    <>
      <div className="done-ico"><NotFoundIcon /></div>
      <div>
        <h1>This page is not available</h1>
        <p className="lead">The link may be mistyped, the document may have been withdrawn, or it is not shared with your group.</p>
      </div>
      <div className="acts">
        <a className="btn secondary" href={`/rooms/${room.id}/search`}>Search {room.name}</a>
        <a className="btn primary" href={`/rooms/${room.id}/dashboard`}>Go to {room.name}</a>
      </div>
      {seeAs ? null : <p className="hint">If someone sent you this link, ask them to check it. Room admins see every attempt in Activity.</p>}
    </>
  );
}

export interface RoomFacts { name: string; runBy: string | null; onBehalfOf: string | null; contactName: string | null; stateSince: string | null }

function runByLine(r: RoomFacts): string {
  const parts: string[] = [];
  if (r.runBy) parts.push(`Run by ${r.runBy}`);
  if (r.onBehalfOf) parts.push(`on behalf of ${r.onBehalfOf}`);
  return parts.join(', ');
}

const askWho = (r: RoomFacts) => (r.contactName ? `${r.contactName}${r.runBy ? ` at ${r.runBy}` : ''}` : 'the room admin');

export function RoomNotOpen({ room }: { room: RoomFacts }) {
  const line = runByLine(room);
  return (
    <>
      {line ? <RoomCard name={room.name} line={line} /> : null}
      <div className="done-ico info"><ClockIcon /></div>
      <div>
        <h1>{room.name} is not open yet</h1>
        <p className="lead">{room.runBy ?? 'The room admin'} is still preparing the room. We email you when it opens, and your invitation stays valid until then.</p>
      </div>
      <a className="btn secondary block" href="/rooms">Go to my rooms</a>
      <p className="hint">Questions go to {room.contactName ? `the room admin, ${askWho(room)}` : 'the room admin'}.</p>
    </>
  );
}

export function RoomClosed({ room, timeZone }: { room: RoomFacts; timeZone: string }) {
  const line = runByLine(room);
  return (
    <>
      {line ? <RoomCard name={room.name} line={line} /> : null}
      <div className="done-ico"><ClosedIcon /></div>
      <div>
        <h1>{room.name} is closed</h1>
        <p className="lead">
          The room admin closed the room{room.stateSince ? <> on <b>{dayWithYear(room.stateSince, timeZone)}</b></> : null}. Documents can no longer be opened or downloaded. Your activity in the room stays on record.
        </p>
      </div>
      <a className="btn secondary block" href="/rooms">Go to my rooms</a>
      <p className="hint">Other data rooms you belong to are not affected. Questions go to {askWho(room)}.</p>
    </>
  );
}

export function SignedOut({ room, minutes, next }: { room?: string | null; minutes?: number | null; next: string }) {
  const href = `/sign-in${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;
  return (
    <>
      <div className="done-ico"><LeaveIcon /></div>
      <div>
        <h1>You have been signed out</h1>
        <p className="lead">
          {minutes ? `${room ?? 'This data room'} signs people out after ${describeMinutes(minutes)} without activity. ` : 'You were signed out after a time without activity. '}
          Sign in again to carry on where you were.
        </p>
      </div>
      <a className="btn primary block" href={href}>Sign in again</a>
      <p className="hint">On a browser you trust, the email code is enough. Your authenticator app is not needed.</p>
    </>
  );
}

export function InvitationInvalid() {
  return (
    <>
      <div className="done-ico bad"><ClockIcon /></div>
      <div>
        <h1>This invitation link does not work</h1>
        <p className="lead">The invitation link is no longer valid. Ask the room administrator to invite you again.</p>
      </div>
      <p className="hint">Already accepted it? <a className="linkbtn" href="/sign-in">Sign in</a> with the email address you were invited at.</p>
    </>
  );
}
