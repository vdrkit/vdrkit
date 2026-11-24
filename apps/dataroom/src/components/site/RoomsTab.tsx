// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import { Avatar } from '@/components/shell/Avatar';
import { useSendOnce } from '@/lib/send-once';
import { count, detailOf, EMAIL, formatBytes, formatCreated, names, STATE, type Settings, type SiteRoom, type SiteRooms } from './model';
import { SiteDialog } from './SiteDialog';

type Creator = Settings['rooms']['creators'][number];

export function RoomsTab({ saved, rooms: initial, tz, toast, onCreators }: {
  saved: Settings;
  rooms: SiteRooms;
  tz: string;
  toast: (title: string, line: string) => void;
  onCreators: (c: Creator[]) => void;
}) {
  const [rooms, setRooms] = useState(initial);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const joining = useSendOnce();
  const removing = useRef(new Set<string>());
  const [join, setJoin] = useState<{ room: SiteRoom; reason: string; busy: boolean; error: string | null } | null>(null);
  const creators = saved.rooms.creators;

  async function refreshCreators() {
    const r = await browserApi().GET('/v1/site/settings').catch(() => null);
    if (r?.data) onCreators(r.data.rooms.creators);
  }

  const allow = once(async () => {
    const v = email.trim().toLowerCase();
    if (!EMAIL.test(v)) { toast('Enter a complete email address', 'Of someone who already has an account, or they get an invitation.'); return; }
    setBusy(true);
    const r = await browserApi().POST('/v1/site/room-creators', { body: { email: v } }).catch(() => null);
    setBusy(false);
    if (!r?.data) { toast('Not added', detailOf(r?.error, 'Try again in a moment.')); return; }
    setEmail('');
    await refreshCreators();
    toast(`${r.data.name} may now create rooms`, r.data.emailStatus === 'accepted'
      ? 'They see Create a room in My rooms. Logged in the site log.'
      : 'The email to them could not be sent, so tell them yourself. Logged in the site log.');
  });

  async function remove(c: Creator) {
    if (removing.current.has(c.personId)) return;
    removing.current.add(c.personId);
    const r = await browserApi().DELETE('/v1/site/room-creators/{personId}', { params: { path: { personId: c.personId } } }).catch(() => null);
    removing.current.delete(c.personId);
    if (!r || !r.response.ok) { toast('Not removed', detailOf((r as { error?: unknown } | null)?.error, 'Try again in a moment.')); return; }
    await refreshCreators();
    toast(`${c.name} can no longer create rooms`, 'Rooms they created stay theirs. Logged in the site log.');
  }

  const confirmJoin = joining(async () => {
    if (!join) return;
    const reason = join.reason.trim();
    if (reason.length < 3) {
      setJoin({ ...join, error: 'Give a reason. The room’s admins see it in their email.' });
      document.getElementById('join-why')?.focus();
      return;
    }
    setJoin({ ...join, busy: true, error: null });
    const r = await browserApi().POST('/v1/site/rooms/{ws}/join', { params: { path: { ws: join.room.id } }, body: { reason } }).catch(() => null);
    if (!r?.data) { setJoin({ ...join, busy: false, error: detailOf(r?.error, 'You could not join the room. Try again in a moment.') }); return; }
    const room = join.room;
    const byId = new Map(room.roomAdmins.map((a) => [a.personId, a.name]));
    const sent: string[] = [];
    const notSent: string[] = [];
    for (const x of r.data.notified) {
      if (x.status === 'accepted') sent.push(byId.get(x.personId) ?? 'The room admin');
      else notSent.push(byId.get(x.personId) ?? 'a room admin');
    }
    setRooms((rs) => ({ ...rs, items: rs.items.map((x) => (x.id === room.id ? { ...x, youAreAdmin: true } : x)) }));
    setJoin(null);
    const lines: string[] = [];
    if (sent.length) lines.push(`${names(sent)} ${sent.length === 1 ? 'has' : 'have'} been emailed.`);
    if (notSent.length) lines.push(`The email to ${names(notSent)} could not be sent.`);
    lines.push('Logged in the room’s activity log.');
    toast(`You joined ${room.name} as room admin`, lines.join(' '));
  });

  const admins = join ? join.room.roomAdmins.map((a) => a.name) : [];

  return (
    <>
      <section className="panel" data-room-creators>
        <div className="ph"><div><h2>Who can create rooms</h2><span className="cap">Someone who may create rooms becomes room admin of each room they create, and sees only the rooms they belong to. Only site admins see every room and this page.</span></div></div>
        <div className="srow">
          <div><b>Site admins can always create rooms.</b></div>
        </div>
        <div className="srow">
          <div><b>Other people who may create rooms <i>(optional)</i></b>
            <p>{creators.length ? 'Each one sees Create a room in My rooms.' : 'Nobody else yet, so only site admins can create rooms.'}</p></div>
        </div>
        <div className="crl">
          {creators.map((c) => (
            <div className="cr" key={c.personId} data-creator={c.email}>
              <Avatar name={c.name} colourKey={c.personId} />
              <div>{c.name}<small>{c.email}</small></div>
              <button type="button" className="btn ghost sm" onClick={() => void remove(c)} aria-label={`Remove ${c.name}: they can no longer create rooms`}>Remove</button>
            </div>
          ))}
          <form className="cr add" onSubmit={(e) => { e.preventDefault(); void allow(); }}>
            <input className="tin" id="f-cr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address"
              aria-label="Email address of someone who may create rooms" inputMode="email" autoComplete="off" spellCheck={false} />
            <button type="submit" className="btn secondary sm" disabled={busy} title="Lets this person create rooms straight away. They get an email.">Add</button>
          </form>
        </div>
      </section>

      <section className="panel" data-site-rooms>
        <div className="ph"><div><h2>All rooms on this site</h2><span className="cap">You see each room’s name, admins and size. To open a room, a room admin invites you, or you join it yourself, which its admins are told about.</span></div></div>
        <div className="tbl">
          <div className="tr h rooms-t"><span>Room</span><span>Room admins</span><span>State</span><span className="r">People</span><span className="r">Storage</span><span>Created</span><span></span></div>
          {rooms.items.map((r) => {
            const st = STATE[r.state] ?? { label: r.state, tone: 'off' as const };
            return (
              <div className="tr rooms-t" key={r.id} data-room={r.name}>
                <div>{r.name}{r.seller ? <small>{r.seller}</small> : null}</div>
                <span>{r.roomAdmins.length ? names(r.roomAdmins.map((a) => a.name)) : <span className="cap">None</span>}</span>
                <span><span className={`pill ${st.tone}`}>{st.label}</span></span>
                <span className="r">{count(r.people)}</span>
                <span className="r">{formatBytes(r.storageBytes)}</span>
                <span>{formatCreated(r.createdAt, tz)}</span>
                <span className="end">
                  {r.youAreAdmin ? <span className="cap">You are an admin</span>
                    : <button type="button" className="btn ghost sm" onClick={() => setJoin({ room: r, reason: '', busy: false, error: null })}>Join this room</button>}
                </span>
              </div>
            );
          })}
        </div>
        <div className="pfoot"><span className="cap">{count(rooms.totals.rooms)} {rooms.totals.rooms === 1 ? 'room' : 'rooms'} · {formatBytes(rooms.totals.storageBytes)} of documents</span></div>
      </section>

      {join ? (
        <SiteDialog title={`Join ${join.room.name} as room admin`} busy={join.busy} onClose={() => setJoin(null)}
          foot={<>
            <button type="button" className="btn secondary" onClick={() => setJoin(null)} disabled={join.busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void confirmJoin()} disabled={join.busy}>{join.busy ? 'Joining…' : 'Join as room admin'}</button>
          </>}>
          <p>You can then open every document in {join.room.name} and change its settings. Use this when the room’s admins cannot be reached, for example when one has left the firm.</p>
          <p><b>This is not silent.</b> It is recorded in the room’s activity log{admins.length
            ? <>, and {names(admins)} {admins.length === 1 ? 'gets' : 'get'} an email straight away with your name and reason.</>
            : '. The room has no other admins to email.'}</p>
          <label className="fld">
            <span>Reason <i>(required, shown to the room’s admins)</i></span>
            <textarea className="tarea" id="join-why" value={join.reason} aria-invalid={join.error ? true : undefined}
              placeholder={`For example: ${admins[0] ?? 'the room admin'} is on leave and the seller needs a document withdrawn today`}
              onChange={(e) => setJoin({ ...join, reason: e.target.value, error: null })} />
            {join.error ? <span className="hint err" role="alert">{join.error}</span> : null}
          </label>
        </SiteDialog>
      ) : null}
    </>
  );
}
