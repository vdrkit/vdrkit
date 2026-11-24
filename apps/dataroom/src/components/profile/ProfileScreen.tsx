// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { browserApi } from '@/api/browser';
import type { paths, Problem } from '@/api/client';
import { roomHref } from '@/components/room/routes';
import { TimeZonePicker } from '@/components/signin/TimeZonePicker';
import { formatDay, zoneAbbreviation } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import { MovePhoneDialog } from './MovePhoneDialog';

type Json<T> = T extends { content: { 'application/json': infer J } } ? J : never;
export type Profile = Json<paths['/v1/me']['get']['responses'][200]>;
export type MyNotifications = Json<paths['/v1/workspaces/{ws}/me/notifications']['get']['responses'][200]>;
export type SignInPolicy = Json<paths['/v1/me/sign-in-policy']['get']['responses'][200]>;
export type TrustedBrowser = Json<paths['/v1/me/trusted-browsers']['get']['responses'][200]>['items'][number];
type Frequency = MyNotifications['events'][number]['frequency'];

export interface RoomNotifications { id: string; name: string; settings: MyNotifications }
export type ProfileTab = 'profile' | 'notif' | 'signin';

type Choice = { on: boolean; f: Frequency };
interface Draft { fn: string; ln: string; co: string; ro: string; tz: string; notif: Record<string, Record<string, Choice>> }

const FREQ: Record<Frequency, string> = { immediate: 'Right away', bundled: 'Bundled', digest: 'Daily summary' };
const DETAILS = ['fn', 'ln', 'co', 'ro', 'tz'] as const;
const LOGGED = ['fn', 'ln', 'co', 'ro'] as const;
const TABS: [ProfileTab, string, string][] = [['profile', 'Your details', 'details'], ['notif', 'Email notifications', 'notifications'], ['signin', 'Sign-in', 'sign-in']];

const LockIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
const LaptopIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></svg>;
const PhoneIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></svg>;

function choices(rooms: RoomNotifications[]): Draft['notif'] {
  return Object.fromEntries(rooms.map((r) => [r.id, Object.fromEntries(r.settings.events.map((e) => [e.key, { on: e.enabled, f: e.frequency }]))]));
}

function draftOf(p: Profile, rooms: RoomNotifications[]): Draft {
  return { fn: p.givenName, ln: p.familyName, co: p.company ?? '', ro: p.jobTitle ?? '', tz: p.timeZone, notif: choices(rooms) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function andList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function dayWithYear(at: string, tz: string): string {
  return formatDay(at, tz, new Date(Date.UTC(1970, 0, 1)));
}

function within(minutes: number): string {
  if (minutes === 60) return 'an hour';
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

function isPhone(browser: string): boolean {
  return /iPhone|iPad|Android|phone/i.test(browser);
}

export function ProfileScreen(p: {
  ws: string;
  initialTab: ProfileTab;
  profile: Profile;
  rooms: RoomNotifications[];
  loggedIn: string[];
  signIn: SignInPolicy;
  browsers: TrustedBrowser[] | null;
  /** dev: opened via View as, no session */
  viewAs?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<ProfileTab>(p.initialTab);
  const [rooms, setRooms] = useState(p.rooms);
  const [saved, setSaved] = useState<Draft>(() => draftOf(p.profile, p.rooms));
  const [w, setW] = useState<Draft>(saved);
  const [room, setRoom] = useState(p.ws);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const leaving = useSendOnce();
  const untrusting = useRef(new Set<string>());
  const [invalid, setInvalid] = useState<string[]>([]);
  const [browsers, setBrowsers] = useState(() => p.browsers && [...p.browsers].sort((a, b) => Number(b.thisBrowser) - Number(a.thisBrowser)));
  const [setUpAt, setSetUpAt] = useState(p.signIn.twoFactorSetUpAt);
  const [phone, setPhone] = useState(false);
  const [toast, setToast] = useState<{ title: string; line: string; err?: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((title: string, line: string, err = false) => {
    setToast({ title, line, err });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const tabDirty = (t: ProfileTab) => {
    if (t === 'profile') return DETAILS.some((k) => w[k] !== saved[k]);
    if (t === 'notif') return !same(w.notif, saved.notif);
    return false;
  };
  const dirty = tabDirty('profile') || tabDirty('notif');
  const whoChanged = LOGGED.some((k) => w[k] !== saved[k]);

  function tabKey(ev: KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.findIndex((x) => x[0] === tab);
    let to: number;
    switch (ev.key) {
      case 'ArrowRight': to = (i + 1) % TABS.length; break;
      case 'ArrowLeft': to = (i + TABS.length - 1) % TABS.length; break;
      case 'Home': to = 0; break;
      case 'End': to = TABS.length - 1; break;
      default: return;
    }
    ev.preventDefault();
    openTab(TABS[to]![0]);
    document.getElementById(`tab-${TABS[to]![0]}`)?.focus();
  }

  function openTab(t: ProfileTab) {
    setTab(t);
    const slug = TABS.find((x) => x[0] === t)![2];
    const url = new URL(window.location.href);
    url.searchParams.set('tab', slug);
    window.history.replaceState(null, '', url.toString());
  }

  function edit<K extends keyof Draft>(k: K, v: Draft[K]) {
    setW((x) => ({ ...x, [k]: v }));
    setInvalid((xs) => xs.filter((x) => x !== k));
  }

  function choose(roomId: string, key: string, c: Partial<Choice>) {
    setW((x) => ({ ...x, notif: { ...x.notif, [roomId]: { ...x.notif[roomId], [key]: { ...x.notif[roomId]![key]!, ...c } } } }));
  }

  const save = once(async () => {
    const missing: string[] = [];
    if (!w.fn.trim()) missing.push('fn');
    if (!w.ln.trim()) missing.push('ln');
    if (missing.length) {
      setInvalid(missing);
      openTab('profile');
      show('Enter your first and last name', 'Both are needed.', true);
      return;
    }
    // only on details changes, so accounts without a company can still save
    if (whoChanged && !w.co.trim()) {
      setInvalid(['co']);
      openTab('profile');
      show('Enter your company', 'The room admin and your team see it.', true);
      return;
    }

    setBusy(true);
    const api = browserApi();
    const logged = whoChanged;
    let next = saved;
    try {
      if (tabDirty('profile')) {
        const body: Record<string, string | null> = {};
        if (w.fn !== saved.fn) body.givenName = w.fn.trim();
        if (w.ln !== saved.ln) body.familyName = w.ln.trim();
        if (w.co !== saved.co) body.company = w.co.trim();
        if (w.ro !== saved.ro) body.jobTitle = w.ro.trim() || null;
        if (w.tz !== saved.tz) body.timeZone = w.tz;
        const r = await api.PATCH('/v1/me', { body });
        if (!r.data) throw (r.error as Problem | undefined) ?? new Error('Not saved');
        const d = r.data;
        next = { ...next, fn: d.givenName, ln: d.familyName, co: d.company ?? '', ro: d.jobTitle ?? '', tz: d.timeZone };
      }
      const changed = rooms.filter((r) => !same(w.notif[r.id], saved.notif[r.id]));
      const fresh = new Map<string, MyNotifications>();
      for (const r of changed) {
        const events: Record<string, { enabled: boolean; frequency: Frequency } | null> = {};
        for (const e of r.settings.events) {
          const now = w.notif[r.id]![e.key]!;
          const was = saved.notif[r.id]![e.key]!;
          if (same(now, was)) continue;
          // same as the room again: follow the room
          events[e.key] = now.on === e.roomDefault.enabled && now.f === e.roomDefault.frequency ? null : { enabled: now.on, frequency: now.f };
        }
        const res = await api.PUT('/v1/workspaces/{ws}/me/notifications', { params: { path: { ws: r.id } }, body: { events } });
        if (!res.data) throw (res.error as Problem | undefined) ?? new Error('Not saved');
        fresh.set(r.id, res.data);
        next = { ...next, notif: { ...next.notif, ...choices([{ ...r, settings: res.data }]) } };
      }
      if (fresh.size) setRooms((rs) => rs.map((r) => (fresh.has(r.id) ? { ...r, settings: fresh.get(r.id)! } : r)));
      setSaved(next);
      setW(next);
      show('Saved', logged ? `The change to your details is recorded in the activity log of ${andList(p.loggedIn)}.` : 'Your changes apply from now on.');
      router.refresh();
    } catch (e) {
      setSaved(next);
      const pr = e as Problem;
      show('Not saved', pr?.detail ?? pr?.title ?? 'Try again in a moment.', true);
    } finally {
      setBusy(false);
    }
  });

  function discard() {
    setW(saved);
    setInvalid([]);
  }

  async function stopTrusting(b: TrustedBrowser) {
    if (untrusting.current.has(b.id)) return;
    untrusting.current.add(b.id);
    const r = await browserApi().DELETE('/v1/me/trusted-browsers/{id}', { params: { path: { id: b.id } } });
    untrusting.current.delete(b.id);
    if (r.response.status !== 204 && r.response.status !== 404) { show('Not changed', (r.error as Problem | undefined)?.detail ?? 'Try again in a moment.', true); return; }
    setBrowsers((xs) => (xs ?? []).filter((x) => x.id !== b.id));
    show(`Stopped trusting ${b.browser}`, 'It asks for the authenticator code at the next sign-in.');
  }

  const signOutEverywhere = leaving(async () => {
    const r = await browserApi().POST('/v1/me/sign-out-everywhere');
    if (!r.data) { show('Not signed out', (r.error as Problem | undefined)?.detail ?? 'Try again in a moment.', true); return; }
    show('Signed out everywhere else', 'Other browsers ask you to sign in again. This one stays signed in.');
  });

  const tz = w.tz;

  function details() {
    const fld = (k: 'fn' | 'ln' | 'co' | 'ro', label: string, auto: string, placeholder?: string) => (
      <label className="fld">
        <span>{label}</span>
        <input className="tin" id={`f-${k}`} value={w[k]} autoComplete={auto} placeholder={placeholder}
          aria-invalid={invalid.includes(k) || undefined} onChange={(e) => edit(k, e.target.value)} />
      </label>
    );
    return (
      <section className="panel" aria-label="Your details">
        <div className="ph"><div><h2>Your details</h2></div></div>
        <div className="fields">
          {fld('fn', 'First name', 'given-name')}
          {fld('ln', 'Last name', 'family-name')}
          {fld('co', 'Company', 'organization')}
          {fld('ro', 'Role', 'organization-title', 'For example: Partner')}
          <label className="fld">
            <span>Email</span>
            <input className="tin" id="f-email" readOnly value={p.profile.email} />
            <span className="hint">You sign in with this address. Ask the room admin to change it.</span>
          </label>
          <div className="fld">
            <span><label htmlFor="f-tz">Time zone</label></span>
            <TimeZonePicker id="f-tz" value={w.tz} onChange={(v) => edit('tz', v)} />
          </div>
        </div>
        {whoChanged ? (
          <div className="note warn" style={{ margin: '0 16px 16px' }}>
            <div><b>A change to your name, company or role is logged.</b> The activity log of every room you are in records the old and the new value, and the room admin sees it. Nobody can quietly appear as someone else.</div>
          </div>
        ) : (
          <div className="pfoot"><span className="cap">Changes to your name, company or role are recorded in the activity log.</span></div>
        )}
      </section>
    );
  }

  function notifications() {
    const r = rooms.find((x) => x.id === room) ?? rooms[0]!;
    const s = r.settings;
    const several = rooms.length > 1;
    const abbr = zoneAbbreviation(new Date(), tz);
    const times = s.timing.summaryTimes;
    return (
      <section className="panel" aria-label="Email notifications">
        <div className="ph">
          <div>
            <h2>Email notifications{several ? '' : ` for ${r.name}`}</h2>
            <span className="cap">Set separately for each room, within the limits its room admin chose.</span>
          </div>
          {several ? (
            <div className="roomsel">
              <label className="cap" htmlFor="f-room">Room</label>
              <select className="tsel" id="f-room" value={r.id} onChange={(e) => setRoom(e.target.value)}>
                {rooms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
          ) : null}
        </div>
        <div className="ntwrap">
          <div className="nt" role="table" aria-label={`Email notifications in ${r.name}`}>
            <div className="nrow h" role="row"><span role="columnheader">Event</span><span role="columnheader">Email</span><span role="columnheader">How often</span><span role="columnheader"></span></div>
            {s.events.map((e) => {
              const v = w.notif[r.id]![e.key]!;
              const locked = !e.canSwitchOff;
              const def = e.roomDefault;
              const options = e.allowedFrequencies.includes(v.f) ? e.allowedFrequencies : [...e.allowedFrequencies, v.f];
              const note = e.mandatory && s.isRoomAdmin ? (
                <span className="lock"><LockIcon /><span>Mandatory for everyone else in this room. <Link href={roomHref(r.id, 'settings')} className="linkbtn" style={{ fontSize: 12 }}>Change in Room settings</Link></span></span>
              ) : locked ? (
                <span className="lock"><LockIcon />Required by the room admin. You choose how often.</span>
              ) : (
                <span className="dflt">{
                  !v.on ? (def.enabled ? `Off. Room default: on, ${FREQ[def.frequency].toLowerCase()}` : 'Room default')
                    : !def.enabled ? 'Your choice. Room default: off'
                      : v.f === def.frequency ? 'Room default' : `Your choice. Room default: ${FREQ[def.frequency].toLowerCase()}`
                }</span>
              );
              return (
                <div key={e.key} className={`nrow${v.on ? '' : ' off'}`} role="row" data-event={e.key}>
                  <div role="cell"><b>{e.label}</b><small>{e.description}</small></div>
                  <span className="onc" role="cell">
                    <button type="button" className="tg" role="switch" aria-checked={v.on} aria-label={`Email me about ${e.label}`}
                      disabled={locked} title={locked ? 'Required by the room admin' : undefined}
                      onClick={() => choose(r.id, e.key, { on: !v.on })}><i /></button>
                    <span className="tg-l">{v.on ? 'On' : 'Off'}</span>
                  </span>
                  <span role="cell">
                    <select className="tsel" id={`n-${e.key}`} aria-label={`How often to email you about ${e.label}`} disabled={!v.on}
                      value={v.f} onChange={(ev) => choose(r.id, e.key, { f: ev.target.value as Frequency })}>
                      {options.map((f) => <option key={f} value={f}>{FREQ[f]}</option>)}
                    </select>
                  </span>
                  <span role="cell">{note}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="when">
          <span>Right away</span><b>Within a few minutes of each event.</b>
          <span>Bundled</span><b>One email once things go quiet for {s.timing.bundleQuietMinutes} minutes, at most {within(s.timing.bundleMaxMinutes)} after the first event.</b>
          <span>Daily summary</span>
          <b>{times.length > 1
            ? `Two emails, at ${andList(times)} ${abbr}, each listing everything since the one before.`
            : `One email at ${times[0] ?? '08:00'} ${abbr}, listing everything since the last one.`}</b>
        </div>
        <div className="pfoot"><span className="cap">Every email we send you is recorded in the room’s activity log.</span></div>
      </section>
    );
  }

  function signin() {
    const on = p.signIn.twoFactorEnabled;
    const session = on !== null;
    const head = <div className="ph"><div><h2>Sign-in</h2><span className="cap">You sign in with a link or code sent to your email. There is no password.</span></div></div>;
    // no session (persona pill, or not a browser)
    if (!session) {
      return (
        <section className="panel" aria-label="Sign-in">
          {head}
          <div className="srow" data-row="no-session" style={{ borderBottom: 0 }}>
            <div>
              <b>Two-factor sign-in and trusted browsers</b>
              <p>{p.viewAs
                ? 'You opened this page with the prototype’s View as switcher. It works without signing in, so there is no sign-in to show. Sign in with your email to see your two-factor sign-in and trusted browsers, and to sign out everywhere.'
                : 'Shown when you sign in with your email in a browser.'}</p>
            </div>
          </div>
        </section>
      );
    }
    return (
      <section className="panel" aria-label="Sign-in">
        {head}
        <div className="srow" data-row="two-factor">
          <div>
            <b>Two-factor sign-in {on === true ? <span className="badge b-ok" style={{ marginLeft: 6, verticalAlign: 1 }}>On</span>
              : on === false ? <span className="badge b-neutral" style={{ marginLeft: 6, verticalAlign: 1 }}>Off</span> : null}</b>
            <p>{on === true
              ? `Authenticator app set up${setUpAt ? ` on ${dayWithYear(setUpAt, tz)}` : ''}. Got a new phone? Set it up there while you still have the old one, or ask the room admin to reset it.`
              : 'No authenticator app is set up. A room that asks for one has you set it up at your next sign-in.'}</p>
          </div>
          {on === true ? <div className="ctl"><button type="button" className="btn secondary sm" onClick={() => setPhone(true)}>Move to a new phone</button></div> : null}
        </div>
        <div className="srow" style={{ borderBottom: 0 }}><div><b>Trusted browsers</b><p>These skip the authenticator code until the date shown.</p></div></div>
        {browsers && browsers.length ? browsers.map((b) => (
          <div className="br" key={b.id} data-browser={b.id}>
            {isPhone(b.browser) ? <PhoneIcon /> : <LaptopIcon />}
            <div>
              <b style={{ fontWeight: 600 }}>{b.browser}</b>
              <small>{b.thisBrowser ? <span className="here">This browser</span> : null}Trusted until {formatDay(b.trustedUntil, tz)}{!b.thisBrowser && b.lastUsedAt ? `, last used ${formatDay(b.lastUsedAt, tz)}` : ''}</small>
            </div>
            <button type="button" className="btn ghost sm" onClick={() => void stopTrusting(b)}>Stop trusting</button>
          </div>
        )) : (
          <div className="br"><span></span><span className="cap">No trusted browsers. Every sign-in asks for the authenticator code.</span><span></span></div>
        )}
        <div className="pfoot">
          <span className="cap">Signed in somewhere you no longer use?</span>
          <button type="button" className="btn danger sm" onClick={() => void signOutEverywhere()}>Sign out everywhere</button>
        </div>
      </section>
    );
  }

  return (
    <div className="a5" data-a5>
      <div className="head">
        <div>
          <p className="over">Your account</p>
          <h1>Profile and notifications</h1>
        </div>
      </div>
      <div className="stabs" role="tablist" aria-label="Account sections">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className="stab" role="tab" id={`tab-${k}`} aria-controls="a5-panel" aria-selected={tab === k}
            tabIndex={tab === k ? 0 : -1} onClick={() => openTab(k)} onKeyDown={tabKey}>
            {label}{tabDirty(k) ? <em title="Unsaved changes" /> : null}
          </button>
        ))}
      </div>
      <div className="one" id="a5-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'profile' ? details() : tab === 'notif' ? notifications() : signin()}
      </div>
      {dirty ? (
        <div className="cbar" role="region" aria-label="Unsaved changes">
          <div className="grow"><b>Unsaved changes</b><span>Nothing changes until you save.</span></div>
          <button type="button" className="btn quiet" onClick={discard} disabled={busy}>Discard</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>Save changes</button>
        </div>
      ) : null}
      {phone ? (
        <MovePhoneDialog
          onClose={() => setPhone(false)}
          onMoved={(at) => { setPhone(false); setSetUpAt(at); show('Moved to your new phone', 'From now on only the codes of the new phone work.'); }}
        />
      ) : null}
      <div aria-live="polite">
        {toast ? <div className={`toast${toast.err ? ' err' : ''}`}><i>{toast.err ? '!' : '✓'}</i><div><b>{toast.title}</b><span>{toast.line}</span></div></div> : null}
      </div>
    </div>
  );
}
