// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { apiUrl, browserApi } from '@/api/browser';
import type { Problem } from '@/api/client';
import { useToast } from '@/components/outside/Toast';
import { roomHref } from '@/components/room/routes';
import { TimeZonePicker } from '@/components/signin/TimeZonePicker';
import { formatDayWithYear, groupColours } from '@/components/dashboard/model';
import { formatDay, formatWhen } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import {
  changedKeys, idleText, LABEL, OWNER, patchFor, problems, TABS, workingFrom,
  type Cat, type Frequency, type Key, type LogoChange, type NdaOverview, type Settings, type SettingsTab, type Working,
} from './model';
import { NdaDialog } from './NdaDialog';

export type { SettingsTab } from './model';

const UP = <path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" />;
const EYE = <><path d="M2.5 12S6 5.5 12 5.5S21.5 12 21.5 12S18 18.5 12 18.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></>;
const Icon = ({ d }: { d: ReactNode }) => <svg viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;

const STATES: [string, string, string][] = [
  ['preparing', 'Preparing', 'Only the seller team and room admins can enter. Bidders cannot sign in yet.'],
  ['open', 'Open', 'Bidders read what their access allows. Documents can be uploaded and published.'],
  ['frozen', 'Frozen', 'Everyone keeps reading. Nobody can upload or publish. Publishers can still withdraw a document.'],
  ['closed', 'Closed', 'Only room admins can enter, to export the archive. Bidders and the seller team lose access.'],
];

const OPENS = ['open', 'frozen'];

const IDLE_OPTS: [number, string][] = [[30, 'After 30 minutes'], [60, 'After 1 hour'], [120, 'After 2 hours'], [240, 'After 4 hours'], [480, 'After 8 hours'], [1440, 'After 24 hours']];

const WMF: [keyof Working['wm'], string, string][] = [
  ['name', 'Name', "The person's name as it appears in People."],
  ['email', 'Email address', 'The address they sign in with.'],
  ['group', 'Group', 'The bidder group or seller team they belong to.'],
  ['dateTime', 'Date and time', 'When they opened or downloaded the page, in their own time zone.'],
  ['ip', 'IP address', 'The address their browser connects from. Behind a company network this is usually the company’s address.'],
];

const EVENT_TEXT: Record<string, { label?: string; text: string; who: string }> = {
  documents: { text: 'Published in a folder they can see', who: 'Bidders and the seller team' },
  versions: { text: 'A document they can see has a new version', who: 'Bidders and the seller team' },
  access: { label: 'Their access changed', text: 'A level raised, lowered or ended', who: 'The person affected' },
  deadlines: { text: 'A deadline or event added or moved', who: 'Groups that can see the event' },
  agreements: { text: 'A new NDA to read and accept', who: 'People who must accept it' },
  requests: { text: 'A lead asks to add someone', who: 'Room admins, and the lead when it is decided' },
  drafts: { text: 'Uploads waiting in Release review', who: 'Publishers' },
  processing_failed: { text: 'An upload could not be read', who: 'Room admins' },
  publish_dropped: { text: 'A Publish now that could not go ahead, with the reason', who: 'The person who asked' },
};
const EVENT_ORDER = ['documents', 'versions', 'access', 'deadlines', 'agreements', 'requests', 'drafts', 'processing_failed', 'publish_dropped'];
const MODES: [Frequency, string][] = [['immediate', 'Right away'], ['bundled', 'Bundled'], ['digest', 'Daily summary']];

const roomInitials = (name: string) => (name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('') || 'R').toUpperCase();

const readFile = (f: File) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => fail(r.error);
  r.readAsDataURL(f);
});

export interface SettingsScreenProps {
  ws: string;
  initial: Settings;
  nda: NdaOverview;
  logos: { light: boolean; dark: boolean };
  runBy: string;
  myName: string;
  timeZone: string;
  initialTab: SettingsTab;
}

export function SettingsScreen(p: SettingsScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const [settings, setSettings] = useState(p.initial);
  const [saved, setSaved] = useState(() => workingFrom(p.initial));
  const [w, setW] = useState(saved);
  const [tab, setTab] = useState<SettingsTab>(p.initialTab);
  const [nda, setNda] = useState(p.nda);
  const [logos, setLogos] = useState(p.logos);
  const [logoVersion, setLogoVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const [ndaOpen, setNdaOpen] = useState(false);

  const changed = useMemo(() => changedKeys(w, saved), [w, saved]);
  const dirtyTabs = useMemo(() => new Set(changed.map((k) => OWNER[k])), [changed]);
  const bad = useMemo(() => problems(w, saved), [w, saved]);
  const badChanged = changed.map((k) => bad[k]).find(Boolean) ?? null;

  useEffect(() => {
    if (!changed.length) return;
    const stop = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', stop);
    return () => window.removeEventListener('beforeunload', stop);
  }, [changed.length]);

  const put = <K extends Key>(k: K, v: Working[K]) => {
    setError(null);
    setW((x) => ({ ...x, [k]: v }));
  };

  const strip = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<'' | 'left' | 'right' | 'both'>('');
  function edges() {
    const el = strip.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    if (left && right) setMore('both');
    else if (left) setMore('left');
    else if (right) setMore('right');
    else setMore('');
  }
  useEffect(() => {
    edges();
    window.addEventListener('resize', edges);
    return () => window.removeEventListener('resize', edges);
  }, []);
  useEffect(() => {
    const el = strip.current;
    const b = document.getElementById(`tab-${tab}`);
    if (!el || !b) return;
    const l = b.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    const r = l + b.offsetWidth;
    if (l < el.scrollLeft) el.scrollLeft = Math.max(0, l - 24);
    else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth + 24;
    edges();
  }, [tab]);

  function openTab(t: SettingsTab) {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === 'general') url.searchParams.delete('tab');
    else url.searchParams.set('tab', t);
    window.history.replaceState(null, '', url);
  }

  function tabKeys(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex(([k]) => k === tab);
    const moves = new Map([['ArrowRight', i + 1], ['ArrowLeft', i - 1], ['Home', 0], ['End', TABS.length - 1]]);
    const to = moves.get(e.key);
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length]![0];
    openTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  const save = once(async () => {
    if (badChanged) { setError(badChanged); return; }
    setBusy(true);
    setError(null);
    const api = browserApi();
    const n = changed.length;
    const sending = w.state !== saved.state && OPENS.includes(w.state) ? settings.waitingInvitations : 0;
    try {
      for (const variant of ['light', 'dark'] as const) {
        const c = variant === 'light' ? w.logoLight : w.logoDark;
        if (c.kind === 'new') {
          const { error: failed, response } = await api.PUT('/v1/workspaces/{ws}/logo/{variant}', { params: { path: { ws: p.ws, variant } },
            body: { contentType: c.contentType as 'image/png', data: c.data } });
          if (!response.ok) throw failed;
        } else if (c.kind === 'remove') {
          const { error: failed, response } = await api.DELETE('/v1/workspaces/{ws}/logo/{variant}', { params: { path: { ws: p.ws, variant } } });
          if (!response.ok && response.status !== 404) throw failed;
        }
      }
      const body = patchFor(w, saved, settings);
      let next = settings;
      if (Object.keys(body).length) {
        const { data, error: failed } = await api.PATCH('/v1/workspaces/{ws}/settings', { params: { path: { ws: p.ws } }, body });
        if (!data) throw failed;
        next = data;
      }
      const lights = w.logoLight.kind === 'keep' ? logos.light : w.logoLight.kind === 'new';
      const darks = w.logoDark.kind === 'keep' ? logos.dark : w.logoDark.kind === 'new';
      setLogos({ light: lights, dark: darks });
      if (w.logoLight.kind !== 'keep' || w.logoDark.kind !== 'keep') setLogoVersion((v) => v + 1);
      const fresh = workingFrom(next);
      setSettings(next);
      setSaved(fresh);
      setW(fresh);
      if (w.nda !== saved.nda) setNda((x) => ({ ...x, required: w.nda }));
      const sendingNote = sending ? ` ${sending} ${sending === 1 ? 'invitation is' : 'invitations are'} being sent.` : '';
      toast.show(`${n} ${n === 1 ? 'change' : 'changes'} saved`, `They apply to everyone from now on.${sendingNote} Logged in Activity.`);
      router.refresh();
    } catch (e) {
      const prob = e as Problem | undefined;
      setError(prob?.detail ?? prob?.title ?? 'The changes could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  });

  function discard() {
    setError(null);
    setW(saved);
  }

  async function ndaPublished(versionNo: number, mode: 'everyone' | 'correction', requiresNda: boolean) {
    setNdaOpen(false);
    // first NDA switches Ask for the NDA on
    const turnedOn = requiresNda && !saved.nda;
    if (turnedOn) {
      setSettings((s) => ({ ...s, requiresNda: true }));
      setSaved((s) => ({ ...s, nda: true }));
      setW((x) => ({ ...x, nda: true }));
    }
    const r = await browserApi().GET('/v1/workspaces/{ws}/nda/overview', { params: { path: { ws: p.ws } } });
    if (r.data) setNda(r.data);
    toast.show(`NDA version ${versionNo} published`, turnedOn
      ? 'Ask for the NDA is now on: bidders accept it at their first sign-in. Logged in Activity.'
      : mode === 'everyone'
        ? 'Everyone accepts it at their next sign-in. Logged in Activity.'
        : 'People still to accept, and new people, get version ' + versionNo + '. Logged in Activity.');
    if (turnedOn) router.refresh();
  }

  const view: Record<SettingsTab, () => ReactNode> = {
    general: () => <General w={w} saved={saved} put={put} bad={bad} runBy={p.runBy} ws={p.ws} logos={logos} logoVersion={logoVersion} waiting={settings.waitingInvitations} />,
    nda: () => <Nda w={w} saved={saved} put={put} nda={nda} ws={p.ws} timeZone={p.timeZone} onPublish={() => setNdaOpen(true)} />,
    signin: () => <SignIn w={w} saved={saved} put={put} bad={bad} />,
    wm: () => <Watermark w={w} put={put} timeZone={p.timeZone} />,
    pub: () => <Publishing w={w} saved={saved} put={put} settings={settings} ws={p.ws} />,
    notif: () => <Notifications w={w} put={put} bad={bad} settings={settings} />,
    invite: () => <Invitation w={w} put={put} settings={settings} runBy={p.runBy} myName={p.myName} roomName={saved.name} bad={bad} />,
  };

  const labels = [...new Set(changed.map((k) => LABEL[k]))];
  return (
    <div className="f3">
      <div className="head">
        <div>
          <p className="over">Administration</p>
          <h1>Room settings</h1>
          <p className="sub">Settings for {saved.name}. A change applies to everyone in the room once you save it, and is logged in Activity.</p>
        </div>
      </div>
      <div className="stabs" role="tablist" aria-label="Settings areas" onKeyDown={tabKeys} ref={strip} onScroll={edges} data-more={more || undefined}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className="stab" role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls="settings-panel"
            tabIndex={tab === k ? 0 : -1} onClick={() => openTab(k)}>
            {label}{dirtyTabs.has(k) ? <em title="Unsaved changes" aria-label="unsaved changes" /> : null}
          </button>
        ))}
      </div>
      <div id="settings-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>{view[tab]()}</div>
      {changed.length ? (
        <div className="cbar" role="region" aria-label="Unsaved changes">
          <div className="grow">
            <b>{changed.length} unsaved {changed.length === 1 ? 'change' : 'changes'}</b>
            <span>{labels.join(', ').replace(/^./, (x) => x.toUpperCase())}. Nothing changes for anyone until you save.</span>
            {error ? <span className="err" role="alert">{error}</span> : null}
          </div>
          <button type="button" className="btn quiet" onClick={discard} disabled={busy}>Discard</button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      ) : null}
      {ndaOpen ? <NdaDialog ws={p.ws} nda={nda} onClose={() => setNdaOpen(false)} onPublished={ndaPublished} /> : null}
      {toast.node}
    </div>
  );
}

type Put = <K extends Key>(k: K, v: Working[K]) => void;

function Panel({ title, cap, children }: { title: string; cap?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="ph"><div><h2>{title}</h2>{cap ? <span className="cap">{cap}</span> : null}</div></div>
      {children}
    </section>
  );
}

function Switch({ on, label, onChange, disabled, title }: { on: boolean; label: string; onChange?: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <>
      <button type="button" className="tg" role="switch" aria-checked={on} aria-label={label} disabled={disabled} title={title}
        onClick={() => onChange?.(!on)}><i /></button>
      <span className="tg-l">{on ? 'On' : 'Off'}</span>
    </>
  );
}

function Opt({ checked, title, text, now, onPick }: { checked: boolean; title: string; text: string; now?: boolean; onPick: () => void }) {
  return (
    <button type="button" className="sopt" role="radio" aria-checked={checked} onClick={onPick}>
      <i className="rd" />
      <div><b>{title}{now ? <span className="now">Now</span> : null}</b><span>{text}</span></div>
    </button>
  );
}

function Err({ text, id }: { text?: string; id?: string }) {
  return text ? <p className="hint err" role="alert" id={id}>{text}</p> : null;
}

const numberOf = (v: string) => (v.trim() === '' ? NaN : Number(v));


function LogoImg({ ws, variant, change, has, version }: { ws: string; variant: 'light' | 'dark'; change: LogoChange; has: boolean; version: number }) {
  if (change.kind === 'new') return <img src={change.preview} alt="" />;
  if (change.kind === 'remove' || !has) return null;
  return <img src={`${apiUrl(`/v1/workspaces/${ws}/logo/${variant}`)}?v=${version}`} alt="" />;
}

function RoomMark({ w, ws, logos, version, className }: { w: Working; ws: string; logos: { light: boolean; dark: boolean }; version: number; className: string }) {
  const light = w.logoLight.kind === 'new' || (w.logoLight.kind === 'keep' && logos.light);
  const dark = w.logoDark.kind === 'new' || (w.logoDark.kind === 'keep' && logos.dark);
  if (!light && !dark) return <div className={className} aria-hidden="true">{roomInitials(w.name)}</div>;
  return (
    <div className={`${className} img`} aria-hidden="true">
      <span className={dark ? 'lg-light' : undefined}>
        {light ? <LogoImg ws={ws} variant="light" change={w.logoLight} has={logos.light} version={version} /> : roomInitials(w.name)}
      </span>
      {dark ? <span className="lg-dark"><LogoImg ws={ws} variant="dark" change={w.logoDark} has={logos.dark} version={version} /></span> : null}
    </div>
  );
}

function General({ w, saved, put, bad, runBy, ws, logos, logoVersion, waiting }: {
  w: Working; saved: Working; put: Put; bad: Partial<Record<Key, string>>; runBy: string; ws: string; logos: { light: boolean; dark: boolean }; logoVersion: number;
  waiting: number;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<'light' | 'dark'>('light');
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const st = w.state !== saved.state ? STATES.find((s) => s[0] === w.state) : null;
  const savedState = STATES.find((s) => s[0] === saved.state);

  async function pick(f: File | undefined) {
    if (!f) return;
    setLogoErr(null);
    const types = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
    if (!types.includes(f.type)) { setLogoErr('Choose a PNG, JPEG, WebP or SVG file.'); return; }
    if (f.size > 256 * 1024) { setLogoErr('The logo is larger than 256 KB. Use a smaller image.'); return; }
    const url = await readFile(f);
    const change: LogoChange = { kind: 'new', contentType: f.type, data: url.slice(url.indexOf(',') + 1), preview: url, fileName: f.name };
    put(target === 'light' ? 'logoLight' : 'logoDark', change);
  }
  const has = (v: 'light' | 'dark') => {
    const c = v === 'light' ? w.logoLight : w.logoDark;
    return c.kind === 'new' || (c.kind === 'keep' && logos[v]);
  };
  const choose = (v: 'light' | 'dark') => { setTarget(v); if (file.current) { file.current.value = ''; file.current.click(); } };

  const warn = st ? (
    <div className="note warn" role="status"><div><b>When you save, the room becomes {st[1].toLowerCase()}.</b>{' '}
      {w.state === 'frozen' ? 'Uploading and publishing stop for everyone at once. Bidders get no email about it.'
        : w.state === 'closed' ? 'Everyone except room admins is signed out and loses access. You can open the room again later.'
          : w.state === 'preparing' ? 'Bidders who are signed in lose access until you open the room again.'
            : 'Bidders with access can sign in again, and invitations work again.'}
      {OPENS.includes(w.state) && waiting ? <>{' '}<b>{waiting} {waiting === 1 ? 'invitation' : 'invitations'} will be sent.</b></> : null}
    </div></div>
  ) : null;

  return (
    <div className="sgrid">
      <div className="scol">
        <Panel title="Room" cap="Shown in the room card, in every email and in the browser tab">
          <div className="fields">
            <label className="fld"><span>Room name</span>
              <input className="tin" value={w.name} aria-invalid={!!bad.name} aria-describedby={w.name !== saved.name && bad.name ? 'f3-name-err' : undefined} onChange={(e) => put('name', e.target.value)} />
              <Err id="f3-name-err" text={w.name !== saved.name ? bad.name : undefined} />
            </label>
            <label className="fld"><span>Seller</span>
              <input className="tin" value={w.seller} aria-invalid={!!bad.seller} aria-describedby={bad.seller ? 'f3-seller-err' : undefined} onChange={(e) => put('seller', e.target.value)} />
              <p className="hint">Named in the invitation email. Bidders see it on their dashboard.</p>
              <Err id="f3-seller-err" text={bad.seller} />
            </label>
            <div className="fld wide"><span>Room logo</span>
              <div className="logo-row">
                <RoomMark w={w} ws={ws} logos={logos} version={logoVersion} className="logo-tile" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="logo-btns">
                    <button type="button" className="btn secondary sm" onClick={() => choose('light')}><Icon d={UP} />{has('light') ? 'Replace the logo' : 'Upload a logo'}</button>
                    <button type="button" className="btn secondary sm" onClick={() => choose('dark')}><Icon d={UP} />{has('dark') ? 'Replace the version for dark mode' : 'Upload a version for dark mode'}</button>
                    {has('light') || has('dark') ? (
                      <button type="button" className="btn ghost sm" onClick={() => {
                        if (has('light')) put('logoLight', logos.light ? { kind: 'remove' } : { kind: 'keep' });
                        if (has('dark')) put('logoDark', logos.dark ? { kind: 'remove' } : { kind: 'keep' });
                      }}>Remove the logo</button>
                    ) : null}
                  </div>
                  <p className="hint">Square, PNG or SVG, at least 128 × 128 px. Without a logo the room shows its first two letters, as now.</p>
                  {logoErr ? <p className="hint err" role="alert">{logoErr}</p> : null}
                  <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml" aria-label="Choose a logo file"
                    data-testid="logo-file" onChange={(e) => void pick(e.target.files?.[0])} />
                </div>
              </div>
            </div>
            <div className="fld"><label htmlFor="f-tz" style={{ fontSize: 12.5, fontWeight: 600 }}>Room time zone</label>
              <TimeZonePicker id="f-tz" value={w.tz} onChange={(tz) => put('tz', tz)} />
              <p className="hint">Deadlines are set in room time. Each person sees them in their own time zone.</p>
            </div>
          </div>
        </Panel>
        <Panel title="Room state" cap={`Who can enter and what they can do. Today the room is ${(savedState?.[1] ?? saved.state).toLowerCase()}.`}>
          <div className="opts four" role="radiogroup" aria-label="Room state">
            {STATES.map((s) => <Opt key={s[0]} checked={w.state === s[0]} title={s[1]} text={s[2]} now={saved.state === s[0]} onPick={() => put('state', s[0])} />)}
          </div>
          {warn}
        </Panel>
      </div>
      <div className="aside">
        <p className="over">What people see in the menu</p>
        <div className="pv">
          <div className="room">
            <RoomMark w={w} ws={ws} logos={logos} version={logoVersion} className="room-logo" />
            <div><b>{w.name || 'Untitled room'}</b><span>Run by {runBy}</span></div>
          </div>
          <p className="hint">The {runBy} logo above the room card comes from the instance settings, which the instance admin manages.</p>
        </div>
      </div>
    </div>
  );
}


function Nda({ w, saved, put, nda, ws, timeZone, onPublish }: {
  w: Working; saved: Working; put: Put; nda: NdaOverview; ws: string; timeZone: string; onPublish: () => void;
}) {
  const cur = nda.current;
  const colours = groupColours(nda.groups.map((g) => ({ groupId: g.id, groupName: g.name, parentGroupId: g.parentGroupId, partyKind: g.partyKind })));
  const pct = nda.people.total ? Math.round((nda.people.accepted / nda.people.total) * 100) : 0;
  return (
    <div className="sgrid">
      <div className="scol">
        <Panel title="Confidentiality agreement">
          <div className="srow">
            <div><b>Ask for the NDA before anyone sees a document</b>
              <p>Each person accepts it once, at their first sign-in. The seller team and room admins skip it, because they own the documents.</p></div>
            <div className="ctl"><Switch on={w.nda} label="Ask for the NDA" onChange={(v) => put('nda', v)} disabled={!cur && !w.nda}
              title={!cur ? 'Publish the NDA text before asking for it' : undefined} /></div>
          </div>
          {!w.nda && saved.nda ? (
            <div className="note warn" role="status"><div><b>Without the NDA, bidders go straight to the documents.</b> Nobody is asked to accept anything, and Activity shows no acceptances from now on.</div></div>
          ) : null}
          {cur ? (
            <>
              <div className="nver">
                <div className="doc-i">PDF</div>
                <div>
                  <b>Version {cur.versionNo} · {cur.name}</b>
                  <span className="cap">{cur.pages} {cur.pages === 1 ? 'page' : 'pages'} · published {formatWhenYear(cur.publishedAt, timeZone)}{cur.publishedBy ? ` by ${cur.publishedBy}` : ''}{cur.mode === 'correction' ? ' · a correction' : ''}</span>
                  <div className="meter"><s aria-hidden="true"><b style={{ width: `${pct}%` }} /></s>
                    {nda.people.total
                      ? cur.mode === 'correction'
                        ? `${nda.people.accepted} of ${nda.people.total} people have accepted the NDA`
                        : `${nda.people.accepted} of ${nda.people.total} people accepted version ${cur.versionNo}`
                      : 'Nobody outside the seller team has to accept it yet'}
                  </div>
                </div>
                <div className="acts">
                  <a className="btn secondary sm" href={apiUrl(`/v1/workspaces/${ws}/nda/pdf`)} target="_blank" rel="noreferrer"><Icon d={EYE} />Preview</a>
                  <button type="button" className="btn primary sm" onClick={onPublish}><Icon d={UP} />Publish a new version</button>
                </div>
              </div>
              {nda.history.map((h) => (
                <div className="hist" key={h.versionNo}>
                  <span className="cap">Version {h.versionNo}</span>
                  <span>{h.name} · published {formatDayWithYear(h.publishedAt, timeZone)}</span>
                  <span className="cap">Replaced on {formatDay(h.replacedAt, timeZone)} · {h.accepted} accepted</span>
                </div>
              ))}
            </>
          ) : (
            <div className="nda-empty">
              <span>No NDA has been published in this room yet. Publish the text before asking bidders to accept it.</span>
              <button type="button" className="btn primary sm" onClick={onPublish}><Icon d={UP} />Publish the first version</button>
            </div>
          )}
        </Panel>
      </div>
      <div className="aside">
        <p className="over">{cur ? (cur.mode === 'correction' ? 'Accepted the NDA' : `Accepted version ${cur.versionNo}`) : 'Accepted'}</p>
        <section className="panel">
          {nda.groups.length ? nda.groups.map((g) => (
            <div className="acc" key={g.id}>
              <span className="gname"><i style={{ background: colours.get(g.id) ?? 'var(--g-s)' }} />{g.name}</span>
              <span className={`r${g.accepted === g.total ? ' full' : ''}`}>{g.accepted} of {g.total}</span>
            </div>
          )) : <div className="acc"><span className="cap">No bidder groups have people yet.</span></div>}
          <div className="pfoot"><span className="cap">People who have not accepted see no documents.</span>
            <a href={roomHref(ws, 'activity')} className="linkbtn" style={{ fontSize: 12.5 }}>See who in Activity</a></div>
        </section>
      </div>
    </div>
  );
}

function formatWhenYear(at: string, timeZone: string): string {
  const parts = formatWhen(at, timeZone, new Date(at)).split(', ');
  return `${formatDayWithYear(at, timeZone)}, ${parts.slice(1).join(', ')}`;
}

function SignIn({ w, saved, put, bad }: { w: Working; saved: Working; put: Put; bad: Partial<Record<Key, string>> }) {
  const on = w.tfa;
  const tr = on && w.trust;
  const idle = IDLE_OPTS.find((o) => o[0] === w.idle)?.[1] ?? `After ${idleText(w.idle)}`;
  const steps = ['Email link or code'];
  if (tr) steps.push(`Authenticator code, once every ${Number.isFinite(w.trustDays) ? w.trustDays : '…'} days on a trusted browser`);
  else if (on) steps.push('Authenticator code, every time');
  steps.push(`Stays signed in while working. ${idle} without activity, a warning, then signed out`);
  return (
    <div className="sgrid">
      <div className="scol">
        <Panel title="Sign-in" cap="Everyone signs in with a link or code sent to their email. There are no passwords.">
          <div className="srow">
            <div><b>Require two-factor sign-in</b>
              <p>After the email, people type a code from an authenticator app on their phone. They set it up once, when they accept the invitation. Whoever loses their phone asks a room admin to reset it.</p></div>
            <div className="ctl"><Switch on={w.tfa} label="Require two-factor sign-in" onChange={(v) => put('tfa', v)} /></div>
          </div>
          {!w.tfa && saved.tfa ? (
            <div className="note warn" role="status"><div><b>Without two-factor sign-in, the email alone opens the room.</b> Anyone who can read a bidder’s mailbox can then read the documents. People who already set up an authenticator app keep using it.</div></div>
          ) : null}
          {w.tfa && !saved.tfa ? (
            <div className="note info" role="status"><div><b>People without an authenticator app set one up at their next sign-in.</b> Until they do, they see no documents.</div></div>
          ) : null}
          <div className="srow">
            <div><b style={on ? undefined : { color: 'var(--muted)' }}>Let people trust their browser</b>
              <p>On a trusted browser people sign in with the email alone. A new browser asks for the authenticator code again.{on ? '' : ' Only applies when two-factor sign-in is required.'}</p></div>
            <div className="ctl">{on ? <Switch on={w.trust} label="Let people trust their browser" onChange={(v) => put('trust', v)} /> : <span className="tg-l">Not used</span>}</div>
          </div>
          {tr ? (
            <div className="srow">
              <div><b>Trust a browser for</b>
                <p>After this many days the authenticator code is asked again. People can always leave the box unticked, for example on a shared computer.</p>
                <Err text={bad.trustDays} /></div>
              <div className="ctl inl">
                <input className="tin num" type="number" min={1} max={90} value={Number.isFinite(w.trustDays) ? w.trustDays : ''} aria-invalid={!!bad.trustDays}
                  aria-label="Days a browser stays trusted" onChange={(e) => put('trustDays', numberOf(e.target.value))} />days
              </div>
            </div>
          ) : null}
          <div className="srow">
            <div><b>Sign people out after inactivity</b>
              <p>Nobody is signed out while they work: every click or scroll restarts the clock. Two minutes before the end, a message asks whether they are still there, and one click keeps them signed in. This protects a laptop left open in a meeting room.</p></div>
            <div className="ctl">
              <select className="tsel" value={w.idle} aria-label="Sign people out after this long without activity" onChange={(e) => put('idle', Number(e.target.value))}>
                {IDLE_OPTS.map((o) => <option key={o[0]} value={o[0]}>{o[1]}</option>)}
              </select>
            </div>
          </div>
          <div className="pfoot"><span className="cap">Someone in several rooms gets the strictest of their rooms’ settings, the shortest trust period and the shortest sign-out time.</span></div>
        </Panel>
      </div>
      <div className="aside">
        <p className="over">What a bidder does to sign in</p>
        <section className="panel">
          <ol className="ol" style={{ margin: 0, padding: '14px 16px 14px 34px', fontSize: 13.5, lineHeight: '21px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {steps.map((x) => <li key={x}>{x}</li>)}
          </ol>
          <div className="pfoot"><span className="cap">The first time, they also confirm their name{on ? ', set up the authenticator app' : ''} and accept the NDA.</span></div>
        </section>
      </div>
    </div>
  );
}


function Watermark({ w, put, timeZone }: { w: Working; put: Put; timeZone: string }) {
  const now = useMemo(() => new Date(), []);
  const sample: Record<keyof Working['wm'], string> = {
    name: 'Jan de Vries', email: 'jan@bidder-a.example.com', group: 'Bidder A',
    dateTime: `${formatDayWithYear(now, timeZone).replace(/^\w+ /, '')} ${formatWhen(now, timeZone, now).split(', ').pop()}`, ip: '198.51.100.14',
  };
  const txt = WMF.filter(([k]) => w.wm[k]).map(([k]) => sample[k]).join('  ·  ');
  return (
    <div className="sgrid">
      <div className="scol">
        <Panel title="What the watermark shows" cap="The items switched on, joined into one line, repeat diagonally across every page">
          {WMF.map(([k, label, text]) => (
            <div className="srow" key={k}>
              <div><b>{label}</b><p>{text}</p></div>
              <div className="ctl"><Switch on={w.wm[k]} label={label} onChange={(v) => put('wm', { ...w.wm, [k]: v })} /></div>
            </div>
          ))}
          {txt ? null : <div className="note warn" role="status"><div><b>With every item off, pages carry no watermark.</b> A leaked page can then not be traced to a person.</div></div>}
        </Panel>
        <Panel title="Where it appears" cap="By access level, as set in Permissions">
          <div className="where"><span className="lv">View</span><span>On every page image in the viewer. Bidders never receive the file itself.</span></div>
          <div className="where"><span className="lv">Print</span><span>On every printed page.</span></div>
          <div className="where"><span className="lv">Download PDF</span><span>Stamped into each page of the PDF when it is downloaded.</span></div>
          <div className="where"><span className="lv orig">Original</span><span>None. The file goes out exactly as it was uploaded, so an Excel model still works. Give this level only where that matters.</span></div>
        </Panel>
      </div>
      <div className="aside">
        <p className="over">Preview, as {sample.name} sees it</p>
        <div className="page" role="img" aria-label={`Example page with the watermark: ${txt || 'none'}`}>
          <div className="l h" /><div className="l" /><div className="l" style={{ width: '92%' }} /><div className="l" style={{ width: '96%' }} /><div className="l" style={{ width: '70%' }} />
          <div className="l gap" /><div className="l" style={{ width: '88%' }} /><div className="l" style={{ width: '94%' }} /><div className="l" style={{ width: '60%' }} />
          <div className="l gap" /><div className="l" /><div className="l" style={{ width: '90%' }} /><div className="l" style={{ width: '78%' }} />
          <div className="l gap" /><div className="l" style={{ width: '84%' }} /><div className="l" style={{ width: '66%' }} />
          <div className={`wm${txt ? '' : ' none'}`} aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <span key={i}>{txt || '·'}</span>)}</div>
        </div>
        <p className="hint">The watermark is added when a page is served, so a change here applies to every page from the next view on. PDFs already downloaded keep the old one.</p>
      </div>
    </div>
  );
}


function Publishing({ w, saved, put, settings, ws }: { w: Working; saved: Working; put: Put; settings: Settings; ws: string }) {
  const who = ['Room admins everywhere.', ...settings.publishers.map((p) => `${p.name} in ${listOf(p.folders)}.`)].join(' ');
  return (
    <div className="sgrid one">
      <div className="scol" style={{ maxWidth: 980 }}>
        <Panel title="Who publishes">
          <div className="srow">
            <div><b>Four-eyes rule</b>
              <p>A publisher cannot publish a document they uploaded themselves, so every document is seen by a second person before bidders get it. Room admins are exempt.</p></div>
            <div className="ctl"><Switch on={w.fourEyes} label="Four-eyes rule" onChange={(v) => put('fourEyes', v)} /></div>
          </div>
          {w.fourEyes && !saved.fourEyes ? (
            <div className="note info" role="status"><div><b>Drafts already waiting are covered too.</b> A publisher cannot publish a waiting draft they uploaded themselves. Another publisher or a room admin must publish those.</div></div>
          ) : null}
          <div className="srow">
            <div><b>Who may publish</b><p>{who} The publish right is set per folder.</p></div>
            <div className="ctl"><a href={roomHref(ws, 'permissions')} className="linkbtn" style={{ fontSize: 13 }}>Change who publishes in Permissions</a></div>
          </div>
          {/* per-person setting unless mandatory */}
          <div className="srow">
            <div><b>How people hear about new documents</b>
              <p>Each person hears about new documents and new versions as they chose in their own notification settings. To email everyone, make these emails mandatory on the Notifications tab. Whoever publishes can release a small fix quietly, without email.</p></div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function listOf(xs: string[]): string {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}


function Notifications({ w, put, bad, settings }: { w: Working; put: Put; bad: Partial<Record<Key, string>>; settings: Settings }) {
  const keys = [...EVENT_ORDER.filter((k) => w.cats[k]), ...Object.keys(w.cats).filter((k) => !EVENT_ORDER.includes(k))];
  const setCat = (k: string, c: Cat) => put('cats', { ...w.cats, [k]: c });
  return (
    <div className="sgrid one">
      <div className="scol">
        <Panel title="What people are told, and when" cap="The room’s defaults. Each person can change the timing in their own notification settings.">
          <div className="ntwrap">
            <div className="nt" role="table" aria-label="Notification defaults">
              <div className="nrow h" role="row">
                <span role="columnheader">Event</span><span role="columnheader">Who gets it</span><span role="columnheader">Default</span>
                <span role="columnheader">How often</span><span role="columnheader">Mandatory</span>
              </div>
              {keys.map((k) => {
                const c = w.cats[k]!;
                const t = EVENT_TEXT[k];
                const label = t?.label ?? settings.notifications[k]?.label ?? labelOf(k);
                return (
                  <div className="nrow" role="row" key={k} data-event={k}>
                    <div role="cell"><b>{label}</b><small>{t?.text ?? ''}</small></div>
                    <span className="who" role="cell">{t?.who ?? 'Room admins'}</span>
                    <span className="mand" role="cell">
                      {c.mandatory
                        ? <Switch on label={`On by default: ${label}`} disabled title="Mandatory events are always on" />
                        : <Switch on={c.enabled} label={`On by default: ${label}`} onChange={(v) => setCat(k, { ...c, enabled: v })} />}
                    </span>
                    <span role="cell">
                      <select className="tsel" value={c.mode} aria-label={`How often by default for ${label}`} disabled={!c.enabled && !c.mandatory}
                        onChange={(e) => setCat(k, { ...c, mode: e.target.value as Frequency })}>
                        {MODES.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
                      </select>
                    </span>
                    <span className="mand" role="cell">
                      <Switch on={c.mandatory} label={`Mandatory: ${label}`} onChange={(v) => setCat(k, { ...c, mandatory: v, enabled: v ? true : c.enabled })} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="pfoot">
            <span className="cap">Default: what people get until they change it in their profile. Mandatory: always on for everyone except room admins, who choose only how often.</span>
            <span className="cap">Every email sent is logged in Activity, with recipient, time and delivery status.</span>
          </div>
        </Panel>
        <Panel title="Timing">
          <div className="srow">
            <div><b>Bundled</b>
              <p>Sends one email once things go quiet, so a burst of 40 uploads gives one email. A busy afternoon still sends at least one email per hour.</p>
              <Err text={bad.quiet ?? bad.max} /></div>
            <div className="ctl inl">Send after
              <input className="tin num" type="number" min={1} max={60} value={Number.isFinite(w.quiet) ? w.quiet : ''} aria-invalid={!!bad.quiet}
                aria-label="Quiet minutes before sending" onChange={(e) => put('quiet', numberOf(e.target.value))} />min quiet, at most
              <input className="tin num" type="number" min={10} max={240} value={Number.isFinite(w.max) ? w.max : ''} aria-invalid={!!bad.max}
                aria-label="Most minutes to wait" onChange={(e) => put('max', numberOf(e.target.value))} />min after the first
            </div>
          </div>
          <div className="srow">
            <div><b>Daily summary</b>
              <p>Sent at this time in each person’s own time zone. Add a second time for an afternoon summary.</p>
              <Err text={bad.d1 ?? bad.d2} /></div>
            <div className="ctl inl">
              <input className="tin num" type="time" value={w.d1} style={{ width: 110 }} aria-label="First summary time" onChange={(e) => put('d1', e.target.value)} />and
              <input className="tin num" type="time" value={w.d2} style={{ width: 110 }} aria-label="Second summary time, optional" onChange={(e) => put('d2', e.target.value)} />
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

const labelOf = (k: string) => k.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());


function Invitation({ w, put, settings, runBy, myName, roomName, bad }: {
  w: Working; put: Put; settings: Settings; runBy: string; myName: string; roomName: string; bad: Partial<Record<Key, string>>;
}) {
  const [asLead, setAsLead] = useState(false);
  const body = useRef<HTMLTextAreaElement>(null);
  const d = settings.invitationDefault;
  const send = settings.sendingAddress;
  const inv = (patch: Partial<Working['inv']>) => put('inv', { ...w.inv, ...patch });
  // empty sender: the sending admin, with the firm
  const mine = `${myName}, ${runBy}`;
  const fromName = w.inv.from.trim() || mine;
  const until = useMemo(() => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: settings.timeZone })
    .format(new Date(Date.now() + 76 * 86_400_000)).replace(/,/g, ''), [settings.timeZone]);

  function insertUntil() {
    const ta = body.current;
    const s = ta?.selectionStart ?? w.inv.body.length;
    const e = ta?.selectionEnd ?? s;
    inv({ body: w.inv.body.slice(0, s) + '{until}' + w.inv.body.slice(e) });
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(s + 7, s + 7); });
  }

  // key includes the part: {until} can sit on both sides of {signature}
  const fillAll = (text: string) => text.split('{signature}').flatMap((part, i) => (i ? [<span className="fill" key={`s${i}`}>{`${myName}\n${runBy}`}</span>, ...fill(part, '{until}', until, `p${i}`)] : fill(part, '{until}', until, `p${i}`)));
  const fill = (text: string, token: string, value: string, at = 't') => text.split(token).flatMap((part, i) => (i ? [<span className="fill" key={`${at}-${i}`}>{value}</span>, part] : [part]));
  return (
    <div className="sgrid">
      <div className="scol">
        <Panel title="Standard invitation" cap="Every invitation in People starts with this text. The person inviting can edit it for that invitation only.">
          <div className="fields">
            <label className="fld"><span>Sender name</span>
              <input className="tin" value={w.inv.from} placeholder={mine} onChange={(e) => inv({ from: e.target.value })} />
              <p className="hint">Leave it empty to use the name of the room admin who sends the invitation, such as {mine}. {send
                ? `Sent from ${send.address} through the ${runBy} mail server. The instance admin sets the address and server in instance settings.`
                : 'No outgoing email is set up yet. The instance admin sets the sending address and mail server in instance settings.'}</p>
            </label>
            <label className="fld"><span>Replies go to</span>
              <input className="tin" type="email" value={w.inv.reply} placeholder={send?.address ?? 'The sending address'} onChange={(e) => inv({ reply: e.target.value })} />
            </label>
            <label className="fld wide"><span>Subject</span>
              <input className="tin" value={w.inv.subject} onChange={(e) => inv({ subject: e.target.value })} />
            </label>
            <label className="fld wide"><span>Message</span>
              <textarea ref={body} className="tarea" value={w.inv.body} onChange={(e) => inv({ body: e.target.value })} />
              <p className="hint">Write <code>{'{until}'}</code> where the access end date goes. Each invitation fills in its own date. Write <code>{'{signature}'}</code> where the room admin who sends it signs, with their name and firm. The sign-in button and the line about who the invitation is for are added below the message.</p>
            </label>
            <Err text={bad.inv} />
            <div className="fld wide" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn secondary sm" onClick={insertUntil}>Insert the access end date</button>
              {w.inv.body.trim() === d.message ? null : <button type="button" className="btn ghost sm" onClick={() => inv({ body: d.message })}>Go back to the VDRkit default text</button>}
            </div>
          </div>
        </Panel>
        <Panel title="Added for leads" cap="Below the message, only when someone is invited as a lead. Leave it empty to add nothing.">
          <div className="fields">
            <label className="fld wide"><span>Paragraph for leads</span>
              <textarea className="tarea" style={{ minHeight: 110 }} value={w.inv.lead} onChange={(e) => inv({ lead: e.target.value })} />
              <p className="hint">Write <code>{'{group}'}</code> where the group name goes. The person inviting cannot change this paragraph per invitation, so every lead in this room reads the same text.</p>
            </label>
            {w.inv.lead.trim() === d.leadParagraph ? null : (
              <div className="fld wide" style={{ flexDirection: 'row' }}>
                <button type="button" className="btn ghost sm" onClick={() => inv({ lead: d.leadParagraph })}>Go back to the VDRkit default text</button>
              </div>
            )}
          </div>
        </Panel>
      </div>
      <div className="aside">
        <p className="over">Preview</p>
        <div className="seg2" role="group" aria-label="Preview the invitation for">
          <button type="button" aria-pressed={!asLead} onClick={() => setAsLead(false)}>As a team member</button>
          <button type="button" aria-pressed={asLead} onClick={() => setAsLead(true)}>As a lead</button>
        </div>
        <div className="mail" data-testid="mail-preview">
          <div className="mh">
            <span>From</span><b>{fromName}{send ? ` <${send.address}>` : ''}</b>
            <span>Reply to</span><b>{w.inv.reply.trim() || send?.address || 'The sending address'}</b>
            <span>Subject</span><b>{w.inv.subject}</b>
          </div>
          <div className="mb">
            <p>{fillAll(w.inv.body)}</p>
            {asLead && w.inv.lead.trim() ? <p className="leadp">{fill(w.inv.lead, '{group}', 'Bidder A')}</p> : null}
            <span className="go">Open the data room</span>
          </div>
          <div className="mf">This invitation is for jan@bidder-a.example.com only and expires after 14 days. Sent from the {roomName} data room, run by {runBy}.</div>
        </div>
        <p className="hint">The highlighted {asLead ? 'date and group are examples' : 'date is an example'}. Each invitation uses the access end date set in People.</p>
      </div>
    </div>
  );
}
