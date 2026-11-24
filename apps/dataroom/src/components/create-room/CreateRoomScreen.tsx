// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { browserApi } from '@/api/browser';
import type { Problem } from '@/api/client';
import { OrgMark, type Branding } from '@/components/outside/OutsideFrame';
import { useToast } from '@/components/outside/Toast';
import { roomHref } from '@/components/room/routes';
import { CREATE_ROOM_HREF, SITE_SETTINGS_HREF } from '@/components/rooms/routes';
import { OutsideShell, type NavEntry } from '@/components/shell';
import { adminNav } from '@/components/site/routes';
import { aboutMenuItem, privacyMenuItem } from '@/components/shell/AccountMenu';
import { Avatar } from '@/components/shell/Avatar';
import { browserZone, TimeZonePicker } from '@/components/signin/TimeZonePicker';
import { authCall } from '@/lib/auth-client';
import { useSendOnce } from '@/lib/send-once';

export const OUTSIDE_HREF = { rooms: '/', create: CREATE_ROOM_HREF, site: SITE_SETTINGS_HREF } as const;

export interface CreateRoomMe {
  personId: string;
  name: string;
  email: string;
  timeZone: string;
  organisation: string;
  isSiteAdmin: boolean;
}

export interface CreateRoomRoom { id: string; name: string; isAdmin: boolean; state: string }

export interface StandardIndex {
  folders: number;
  subfolders: number;
  items: { indexNumber: string; name: string; children: { indexNumber: string; name: string }[] }[];
}

type Start = 'standard' | 'copy' | 'empty';
type CopyKey = 'folders' | 'settings' | 'nda' | 'invitationEmail' | 'sellerGroups';
type LogoType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
interface LogoFile { contentType: LogoType; data: string; preview: string; fileName: string }

const LOGO_TYPES: LogoType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const LOGO_MAX_BYTES = 256 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

export function roomInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
}

function nameFromEmail(email: string): string {
  const words = email.split('@')[0]!.split(/[._-]+/).filter(Boolean);
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || email;
}

const nameKey = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function signOut() {
  await authCall('/sign-out', {});
  window.location.assign('/sign-in');
}

function UploadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" /></svg>;
}

function failureText(status: number, copying: boolean): string {
  if (status === 0) return 'The room was not created. Check your connection and try again.';
  if (status === 403 || (status === 404 && !copying)) return 'The room was not created. You cannot create rooms on this site.';
  if (status === 404) return 'The room was not created. The room to copy from is no longer available. Choose another.';
  if (status === 400 || status === 413) return 'The room was not created. Check the details above and try again.';
  return 'The room was not created. Try again in a moment.';
}

export function CreateRoomScreen({ me, rooms, template, branding }: {
  me: CreateRoomMe;
  rooms: CreateRoomRoom[];
  template: StandardIndex;
  branding: Branding;
}) {
  const router = useRouter();
  const toast = useToast();
  const org = branding.name ?? (me.organisation || 'VDRkit');
  const runs = useMemo(() => rooms.filter((r) => r.isAdmin), [rooms]);

  const [name, setName] = useState('');
  const [seller, setSeller] = useState('');
  const [tz, setTz] = useState(me.timeZone);
  const [start, setStart] = useState<Start>('standard');
  const [from, setFrom] = useState(runs[0]?.id ?? '');
  const [copy, setCopy] = useState<Record<CopyKey, boolean>>({ folders: true, settings: true, nda: true, invitationEmail: true, sellerGroups: false });
  const [logos, setLogos] = useState<{ light?: LogoFile; dark?: LogoFile }>({});
  const [logoError, setLogoError] = useState('');
  const [admins, setAdmins] = useState<string[]>([]);
  const [add, setAdd] = useState('');
  const [tried, setTried] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const nameInput = useRef<HTMLInputElement>(null);
  const lightInput = useRef<HTMLInputElement>(null);
  const darkInput = useRef<HTMLInputElement>(null);

  useEffect(() => { const z = browserZone(); if (z) setTz(z); }, []);

  // own rooms only
  useEffect(() => {
    const n = name.trim();
    if (n.length < 2) { setTaken(null); return; }
    let live = true;
    const t = setTimeout(() => {
      void browserApi().GET('/v1/workspaces/name-check', { params: { query: { name: n } } }).then((r) => {
        if (live && r.data) setTaken(r.data.available ? null : nameKey(n));
      }).catch(() => undefined);
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [name]);

  // revoke only once the image is off screen
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set([logos.light?.preview, logos.dark?.preview].filter((u): u is string => !!u));
    for (const u of shown.current) if (!now.has(u)) URL.revokeObjectURL(u);
    shown.current = now;
  }, [logos]);
  useEffect(() => () => { for (const u of shown.current) URL.revokeObjectURL(u); }, []);

  function nameError(): string {
    const n = name.trim();
    if (!tried) return '';
    if (taken && taken === nameKey(n)) return `There is already a room called ${n}. Choose another name.`;
    if (!n) return 'Give the room a name. Most deals use a code name.';
    if (n.length < 2) return 'Use at least two characters for the room name.';
    return '';
  }
  const nameErr = nameError();

  async function chooseLogo(variant: 'light' | 'dark', file: File | undefined) {
    if (!file) return;
    const what = variant === 'light' ? 'The logo' : 'The dark-mode logo';
    const type = (file.type || (file.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '')) as LogoType;
    if (!LOGO_TYPES.includes(type)) { setLogoError(`${what} must be a PNG, SVG, JPEG or WebP file.`); return; }
    if (file.size > LOGO_MAX_BYTES) { setLogoError(`${what} is larger than 256 KB. Use a smaller image.`); return; }
    const data = await readAsBase64(file);
    setLogoError('');
    setLogos((l) => ({ ...l, [variant]: { contentType: type, data, preview: URL.createObjectURL(file), fileName: file.name } }));
  }

  function removeLogo(variant: 'light' | 'dark') {
    setLogos((l) => { const next = { ...l }; delete next[variant]; return next; });
    setLogoError('');
  }

  function addAdmin() {
    const v = add.trim().toLowerCase();
    if (!EMAIL.test(v)) { toast.show('Enter a complete email address', 'For example: name@firm.com'); return; }
    if (v === me.email.toLowerCase() || admins.includes(v)) { toast.show(`${v} is already a room admin`, 'Each person gets one invitation.'); setAdd(''); return; }
    if (admins.length >= 20) { toast.show('Add more later in People', 'You can invite up to 20 room admins here.'); return; }
    setAdmins((a) => [...a, v]);
    setAdd('');
    toast.show(`${nameFromEmail(v)} added`, 'They get an invitation when you create the room.');
  }

  const fromRoom = runs.find((r) => r.id === from);
  let what = 'no folders';
  if (start === 'standard') what = 'the standard index';
  else if (start === 'copy') what = `a copy of ${fromRoom?.name ?? 'a room you run'}`;

  const create = once(async () => {
    setTried(true);
    setFailure('');
    const n = name.trim();
    if (!n || n.length < 2 || (taken && taken === nameKey(n))) { nameInput.current?.focus(); return; }
    setBusy(true);
    const { light, dark } = logos;
    const r = await browserApi().POST('/v1/workspaces', {
      body: {
        name: n,
        seller: seller.trim() || undefined,
        timeZone: tz,
        start,
        copyFrom: start === 'copy' && from ? { workspaceId: from, ...copy } : undefined,
        topFolders: [],
        logos: light || dark ? {
          light: light && { contentType: light.contentType, data: light.data },
          dark: dark && { contentType: dark.contentType, data: dark.data },
        } : undefined,
        admins: admins.map((email) => ({ email })),
      },
    }).catch(() => null);
    const id = r?.data?.id;
    if (!r || !id) {
      setBusy(false);
      const p = r?.error as Problem | undefined;
      const status = r ? r.response.status : 0;
      if (status === 409) { setTaken(nameKey(n)); nameInput.current?.focus(); return; }
      // server text is too technical, except logo errors
      if (status === 400 && /logo/i.test(p?.detail ?? '')) { setLogoError(p!.detail!); return; }
      setFailure(failureText(status, start === 'copy'));
      return;
    }
    toast.show(`${n} created`, "Bidders cannot enter until you open it. Opening its dashboard. Next: upload documents, invite the seller team, then open the room to bidders. Logged in the room's activity log.");
    router.push(roomHref(id, 'dashboard'));
  });

  let role = 'Room admin';
  if (me.isSiteAdmin) role = runs.length ? 'Room and site admin' : 'Site admin';
  role += ` · ${org}`;
  const nav: NavEntry[] = [
    { key: 'rooms', label: 'My rooms', icon: 'rooms', href: OUTSIDE_HREF.rooms, count: rooms.length ? String(rooms.length) : undefined },
    { key: 'create', label: 'Create a room', icon: 'plus', href: OUTSIDE_HREF.create, current: true },
  ];
  if (me.isSiteAdmin) nav.push(...adminNav(null));
  const firstRoom = rooms[0];
  const profileHref = firstRoom ? roomHref(firstRoom.id, 'profile') : undefined;

  const starts: Start[] = runs.length ? ['standard', 'copy', 'empty'] : ['standard', 'empty'];
  function onOptKey(e: KeyboardEvent<HTMLDivElement>) {
    let step: number;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') step = 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') step = -1;
    else return;
    e.preventDefault();
    const next = starts[(starts.indexOf(start) + step + starts.length) % starts.length]!;
    setStart(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-start="${next}"]`)?.focus();
  }
  const opt = (v: Start, title: string, line: string) => (
    <button type="button" className="opt" role="radio" aria-checked={start === v} tabIndex={start === v ? 0 : -1} data-start={v} onClick={() => setStart(v)}>
      <i className="rd" /><div><b>{title}</b><span>{line}</span></div>
    </button>
  );
  const ck = (k: CopyKey, title: string, line: string) => (
    <label className="chk">
      <input type="checkbox" checked={copy[k]} onChange={(e) => setCopy((c) => ({ ...c, [k]: e.target.checked }))} />
      <span>{title}<small>{line}</small></span>
    </label>
  );

  return (
    <OutsideShell
      instance={{ name: org, logo: <OrgMark b={{ ...branding, name: org }} />, homeHref: OUTSIDE_HREF.rooms }}
      person={{ avatarKey: me.personId, name: me.name, role, profileHref }}
      nav={nav}
      crumbs={[{ label: 'My rooms', href: OUTSIDE_HREF.rooms }, { label: 'Create a room' }]}
      unread={0}
      notificationSettingsHref={profileHref && `${profileHref}?tab=notifications`}
      accountMenu={[
        ...(profileHref ? [{ label: 'Profile and notifications', hint: 'Opens your profile and email settings', href: profileHref }] : []),
        ...privacyMenuItem(branding.privacy),
        aboutMenuItem(),
        { label: 'Sign out', hint: 'Ends your session on this browser', onSelect: () => { void signOut(); } },
      ]}
    >
      <div className="head">
        <div>
          <p className="over">{org}</p>
          <h1>Create a room</h1>
          <p className="sub">A new data room for one deal. Nothing is shared with bidders until you invite them and open the room.</p>
        </div>
      </div>

      <div className="one b2">
        <section className="panel" aria-labelledby="b2-room">
          <div className="ph"><div><h2 id="b2-room">The room</h2><span className="cap">Bidders see the name and logo in the room and in every email.</span></div></div>
          <div className="fields">
            <label className="fld">
              <span>Room name</span>
              <input ref={nameInput} className="tin" id="f-name" value={name} maxLength={120} placeholder="For example: Project Ibis" autoComplete="off"
                aria-invalid={nameErr ? true : undefined} aria-describedby="name-hint"
                onChange={(e) => setName(e.target.value)} />
              <span className={`hint${nameErr ? ' err' : ''}`} id="name-hint" aria-live="polite">
                {nameErr || 'Use a code name. It appears in emails, so it should not reveal the company.'}
              </span>
            </label>
            <label className="fld">
              <span>Seller</span>
              <input className="tin" id="f-seller" value={seller} maxLength={200} placeholder="For example: Ibis Packaging (Pty) Ltd" autoComplete="off"
                onChange={(e) => setSeller(e.target.value)} />
              <span className="hint">Seen by the seller team and room admins. Bidders see it only if you name it in the invitation.</span>
            </label>
            <div className="fld wide2">
              <span>Room logo <i>(optional)</i></span>
              <div className="logo-row">
                <div className={`logo-tile${logos.light ? ' img' : ''}`} id="logo-tile" title={logos.light ? `Logo: ${logos.light.fileName}` : 'Without a logo the room shows its initials'}>
                  {logos.light ? <img src={logos.light.preview} alt="Room logo" /> : roomInitials(name)}
                </div>
                {logos.dark ? (
                  <div className="logo-tile img dark" id="logo-tile-dark" title={`Dark-mode logo: ${logos.dark.fileName}`}>
                    <img src={logos.dark.preview} alt="Room logo for dark mode" />
                  </div>
                ) : null}
                <button type="button" className="btn secondary sm" data-act="logo-light" onClick={() => lightInput.current?.click()}>
                  <UploadIcon />{logos.light ? 'Replace the logo' : 'Upload a logo'}
                </button>
                <button type="button" className="btn secondary sm" data-act="logo-dark" onClick={() => darkInput.current?.click()}>
                  <UploadIcon />{logos.dark ? 'Replace the dark-mode version' : 'Upload a version for dark mode'}
                </button>
                {logos.light ? <button type="button" className="btn ghost sm" onClick={() => removeLogo('light')}>Remove the logo</button> : null}
                {logos.dark ? <button type="button" className="btn ghost sm" onClick={() => removeLogo('dark')}>Remove the dark-mode version</button> : null}
                <input ref={lightInput} type="file" hidden accept=".png,.svg,.jpg,.jpeg,.webp,image/png,image/svg+xml,image/jpeg,image/webp" data-logo="light"
                  onChange={(e) => { void chooseLogo('light', e.target.files?.[0]); e.target.value = ''; }} />
                <input ref={darkInput} type="file" hidden accept=".png,.svg,.jpg,.jpeg,.webp,image/png,image/svg+xml,image/jpeg,image/webp" data-logo="dark"
                  onChange={(e) => { void chooseLogo('dark', e.target.files?.[0]); e.target.value = ''; }} />
              </div>
              <span className={`hint${logoError ? ' err' : ''}`} aria-live="polite">
                {logoError || 'Square, PNG or SVG, at least 128 × 128 px. Without a logo the room shows its initials. You can also add or change it later in Room settings.'}
              </span>
            </div>
            <div className="fld">
              <label className="lab" htmlFor="f-tz">Room time zone</label>
              <TimeZonePicker id="f-tz" value={tz} onChange={setTz} />
              <span className="hint">Deadlines are set in room time. Everyone sees them in their own time zone.</span>
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="b2-start">
          <div className="ph"><div><h2 id="b2-start">Where to start</h2><span className="cap">Documents come later, by bulk import or by dropping files in Documents.</span></div></div>
          <div className="opts" role="radiogroup" aria-label="Where to start" onKeyDown={onOptKey}>
            {opt('standard', 'Standard M&A index', `${NUMBER_WORDS[template.folders] ?? template.folders} numbered folders that most sell-side deals use.`)}
            {runs.length ? opt('copy', 'Copy a room you run', 'Its folders and settings, without documents, people or activity.') : null}
            {opt('empty', 'Empty room', 'No folders. Build the structure yourself or bring it in with Bulk import.')}
          </div>
          {start === 'standard' ? (
            <div className="sub2">
              <b>Standard M&amp;A index: {template.folders} folders, {template.subfolders} subfolders</b>
              <ul className="tree">
                {template.items.map((f) => (
                  <li key={f.indexNumber} title={f.children.map((c) => `${c.indexNumber} ${c.name}`).join('\n')}>
                    <span className="n">{f.indexNumber}</span>{f.name} <small>· {f.children.length} subfolders</small>
                  </li>
                ))}
              </ul>
              <span className="hint">You can rename, add, move or remove folders in Documents afterwards.</span>
            </div>
          ) : null}
          {start === 'copy' && runs.length ? (
            <div className="sub2">
              <label className="fld">
                <span>Copy from</span>
                <select className="tsel" id="f-from" value={from} onChange={(e) => setFrom(e.target.value)}>
                  {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              {ck('folders', 'Folder structure and numbers', 'Folders only. No documents are copied.')}
              {ck('settings', 'Room settings', 'Sign-in, watermark, publishing and notification defaults.')}
              {ck('nda', 'NDA', 'The latest version, as version 1 of this room. You can replace it before anyone accepts it.')}
              {ck('invitationEmail', 'Invitation email', 'The standard message and the paragraph for leads.')}
              {ck('sellerGroups', 'Seller team groups', 'Group names and access per folder. People are not copied; you invite them yourself.')}
              <span className="hint">Bidder groups, people, documents and activity are never copied. Each room starts with a clean log.</span>
            </div>
          ) : null}
        </section>

        <section className="panel" aria-labelledby="b2-admins">
          <div className="ph"><div><h2 id="b2-admins">Room admins</h2><span className="cap">They manage everything in the room. Anyone can be one, for example a co-adviser at another firm. Add more later in People.</span></div></div>
          <div className="adm">
            <Avatar name={me.name} colourKey={me.personId} />
            <div>{me.name}<small>{me.email}</small></div>
            <span className="cap">You</span>
          </div>
          {admins.map((email) => (
            <div className="adm" key={email}>
              <Avatar name={nameFromEmail(email)} invited />
              <div>{nameFromEmail(email)}<small>{email}</small></div>
              <button type="button" className="btn ghost sm" onClick={() => setAdmins((a) => a.filter((x) => x !== email))} aria-label={`Remove ${email}`}>Remove</button>
            </div>
          ))}
          <div className="addadm">
            <input className="tin" id="f-add" type="email" value={add} placeholder="Email address" aria-label="Add a room admin by email" autoComplete="off"
              onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAdmin(); } }} />
            <button type="button" className="btn secondary sm" data-act="add" onClick={addAdmin}>Add as room admin</button>
          </div>
        </section>
      </div>

      <div className="b2 bar-slot">
        {failure ? <p className="b2-fail" role="alert">{failure}</p> : null}
        <div className="cbar" role="region" aria-label="Create the room">
          <div className="grow">
            <b>Bidders cannot enter yet</b>
            <span>{name.trim() || 'The room'} is created with {what}. Room admins and the seller team prepare it first. You open it to bidders in Room settings when it is ready.</span>
          </div>
          <button type="button" className="btn quiet" data-act="cancel" onClick={() => router.push(OUTSIDE_HREF.rooms)} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" data-act="create" onClick={() => { void create(); }} disabled={busy}>
            {busy ? 'Creating the room…' : 'Create room'}
          </button>
        </div>
      </div>
      {toast.node}
    </OutsideShell>
  );
}
