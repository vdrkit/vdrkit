// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiUrl, browserApi, followSignOut } from '@/api/browser';
import { PRIVACY_HREF } from '@/components/outside/OutsideFrame';
import { useToast } from '@/components/outside/Toast';
import { formatTime } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import { AccountsTab } from './AccountsTab';
import {
  atWords, detailOf, formFrom, MAIL_KEYS, mailBody, names, OWN, PRIVACY_KEYS, privacyBody, problems, samePrivacy,
  type Account, type PrivacyKind, type SettingsPatch, type DomainCheck, type Form, type Health, type LogoStage, type LogoVariant, type Settings, type SiteRooms, type TestResult,
} from './model';
import { RoomsTab } from './RoomsTab';
import { siteSettingsHref, type SiteTab } from './routes';

export interface SiteMe { personId: string; name: string; email: string; timeZone: string }

export interface SiteSettingsProps {
  initialTab: SiteTab;
  settings: Settings;
  rooms: SiteRooms;
  staff: { items: Account[]; total: number };
  everyoneTotal: number;
  me: SiteMe;
}

const TABS: [SiteTab, string][] = [['branding', 'Branding'], ['email', 'Outgoing email'], ['rooms', 'Rooms'], ['accounts', 'Accounts'], ['health', 'Health']];

const UP = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" /></svg>;

function Mark({ ink }: { ink: string }) {
  return (
    <svg viewBox="0 0 120 40" role="img" aria-label="VDRkit mark">
      <rect x="2" y="12" width="16" height="16" rx="4" fill={ink} opacity=".5" />
      <text x="26" y="27" fontFamily="Schibsted Grotesk, sans-serif" fontSize="17" fontWeight="700" fill={ink}>VDRkit</text>
    </svg>
  );
}

export function SiteSettings(p: SiteSettingsProps) {
  const [tab, setTab] = useState<SiteTab>(p.initialTab);
  const [saved, setSaved] = useState<Settings>(p.settings);
  const base = useMemo(() => formFrom(saved), [saved]);
  const [w, setW] = useState<Form>(base);
  const [logos, setLogos] = useState<Record<LogoVariant, LogoStage>>({ light: { kind: 'keep' }, dark: { kind: 'keep' } });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const once = useSendOnce();
  const testing = useSendOnce();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<{ busy: boolean; result?: TestResult; error?: string }>({ busy: false });
  const [dns, setDns] = useState<{ loading: boolean; data?: DomainCheck; error?: string } | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [siteAdmins, setSiteAdmins] = useState<string[]>(p.staff.items.filter((a) => a.isSiteAdmin && !a.disabledAt).map((a) => a.name));
  const toast = useToast();
  const fileFor = useRef<LogoVariant>('light');
  const fileInput = useRef<HTMLInputElement>(null);
  const tz = p.me.timeZone;

  const changed = (Object.keys(w) as (keyof Form)[]).filter((k) => {
    if (PRIVACY_KEYS.includes(k)) return false;
    return k === 'pw' ? w.pw !== '' : w[k] !== base[k];
  });
  if (!samePrivacy(w, base)) changed.push('privacyKind');
  const logoChanges = (['light', 'dark'] as const).filter((v) => logos[v].kind !== 'keep');
  const count = changed.length + logoChanges.length;
  const dirtyTabs = new Set<SiteTab>(changed.map((k) => OWN[k]));
  if (logoChanges.length) dirtyTabs.add('branding');
  const errs = tried ? problems(w, new Set(changed)) : {};

  useEffect(() => {
    if (!count) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [count]);

  const loadHealth = useCallback(async () => {
    const r = await browserApi().GET('/v1/site/health').catch(() => null);
    if (!r?.data) {
      setHealthError(detailOf(r?.error, 'The health checks could not be run. Try again in a moment.'));
      return;
    }
    setHealth(r.data);
    setHealthError(null);
  }, []);
  useEffect(() => { void loadHealth(); }, [loadHealth]);

  const checkDomain = useCallback(async (selector?: string, announce = false) => {
    setDns((d) => ({ ...d, loading: true }));
    const r = await browserApi().GET('/v1/site/mail/domain-check', { params: { query: selector ? { selector } : {} } }).catch(() => null);
    if (!r?.data) {
      setDns({ loading: false, error: detailOf(r?.error, 'The domain could not be checked. Try again in a moment.') });
      return;
    }
    setDns({ loading: false, data: r.data });
    if (!announce) return;
    const pass: string[] = [];
    const missing: string[] = [];
    const records = { SPF: r.data.spf, DKIM: r.data.dkim, DMARC: r.data.dmarc };
    for (const [name, rec] of Object.entries(records)) {
      if (rec.status === 'pass') pass.push(name);
      else missing.push(name);
    }
    const lines: string[] = [];
    if (pass.length) lines.push(`${names(pass)} ${pass.length === 1 ? 'passes' : 'pass'}.`);
    if (missing.length) lines.push(`${names(missing)} ${missing.length === 1 ? 'is' : 'are'} still missing.`);
    toast.show('Checked again', lines.join(' '));
  }, [toast]);
  // nothing to check without a sending address
  const canCheck = !!saved.mail.fromAddress;
  useEffect(() => { if (tab === 'email' && !dns && canCheck) void checkDomain(); }, [tab, dns, canCheck, checkDomain]);

  function open(t: SiteTab) {
    setTab(t);
    window.history.replaceState(null, '', siteSettingsHref(t));
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setW((x) => ({ ...x, [k]: v })); setSaveError(null); };

  function discard() {
    setW(base);
    for (const v of ['light', 'dark'] as const) {
      const s = logos[v];
      if (s.kind === 'new') URL.revokeObjectURL(s.url);
    }
    setLogos({ light: { kind: 'keep' }, dark: { kind: 'keep' } });
    setTried(false);
    setSaveError(null);
  }

  const save = once(async () => {
    setTried(true);
    const bad = problems(w, new Set(changed));
    const first = (Object.keys(bad) as (keyof Form)[])[0];
    if (first) { open(OWN[first]); setSaveError('Check the fields marked in red. Nothing was saved.'); return; }
    setSaving(true);
    setSaveError(null);
    const api = browserApi();
    const keys = new Set(changed);
    const body: SettingsPatch = {};
    if (keys.has('org')) body.organisationName = w.org.trim();
    if (keys.has('privacyKind')) body.privacyNotice = privacyBody(w);
    if (MAIL_KEYS.some((k) => keys.has(k))) body.mail = mailBody(w);
    if (keys.has('dkim')) body.dkimSelector = w.dkim.trim();
    const alertsChanged = keys.has('alertAdmins') || keys.has('alertTo') || keys.has('alertMin');
    if (alertsChanged) {
      const alerts: NonNullable<SettingsPatch['alerts']> = {};
      if (keys.has('alertAdmins')) alerts.notifySiteAdmins = w.alertAdmins;
      if (keys.has('alertTo')) alerts.extraEmail = w.alertTo.trim() || null;
      if (keys.has('alertMin')) alerts.afterMinutes = Number(w.alertMin) as 5 | 15 | 60;
      body.alerts = alerts;
    }
    let latest: Settings | null = null;
    let failed: string | null = null;
    try {
      if (Object.keys(body).length) {
        const r = await api.PATCH('/v1/site/settings', { body });
        if (r.data) latest = r.data;
        else failed = detailOf(r.error, 'The settings could not be saved.');
      }
      for (const v of failed ? [] : logoChanges) {
        const stage = logos[v];
        let res: Response;
        let src: string;
        if (stage.kind === 'new') {
          const { file } = stage;
          const type = file.type || (file.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png');
          src = apiUrl(`/v1/site/branding/logos/${v}?filename=${encodeURIComponent(file.name)}`);
          res = await fetch(src, { method: 'PUT', body: file, headers: { 'content-type': type } });
        } else {
          src = apiUrl(`/v1/site/branding/logos/${v}`);
          res = await fetch(src, { method: 'DELETE' });
        }
        await followSignOut(src, res);
        const json = await res.json().catch(() => null);
        if (!res.ok) { failed = `The ${v === 'light' ? 'light-mode' : 'dark-mode'} logo: ${detailOf(json, 'it could not be stored.')}`; break; }
        latest = json as Settings;
        if (stage.kind === 'new') URL.revokeObjectURL(stage.url);
        setLogos((l) => ({ ...l, [v]: { kind: 'keep' } }));
      }
    } catch {
      failed = 'The server could not be reached. Nothing more was saved.';
    }
    setSaving(false);
    if (latest) {
      const next = formFrom(latest);
      setSaved(latest);
      setW(next);
      if (keys.has('dkim') || MAIL_KEYS.some((k) => keys.has(k))) void checkDomain();
      if (alertsChanged) void loadHealth();
    }
    if (failed) { setSaveError(failed); return; }
    setTried(false);
    toast.show(`${count} ${count === 1 ? 'change' : 'changes'} saved`, 'Logged in the site log.');
  });

  const sendTest = testing(async () => {
    const mailChanged = MAIL_KEYS.some((k) => changed.includes(k));
    if (mailChanged) {
      setTried(true);
      const bad = problems(w, new Set(MAIL_KEYS));
      if (Object.keys(bad).length) { setTest({ busy: false, error: 'Fill in the mail server fields marked in red first. Nothing was sent.' }); return; }
    }
    setTest({ busy: true });
    const r = await browserApi().POST('/v1/site/mail/test', { body: mailChanged ? { mail: mailBody(w) } : {} }).catch(() => null);
    if (r?.data) setTest({ busy: false, result: r.data });
    else setTest({ busy: false, error: detailOf(r?.error, 'The test email could not be sent. Try again in a moment.') });
  });

  function chooseLogo(v: LogoVariant) {
    fileFor.current = v;
    fileInput.current?.click();
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    const v = fileFor.current;
    const name = file.name.toLowerCase();
    const ok = ['image/png', 'image/svg+xml'].includes(file.type) || name.endsWith('.png') || name.endsWith('.svg');
    if (!ok) { toast.show('Choose a PNG or SVG file', 'Other file types cannot be used as a logo.'); return; }
    if (file.size > 512 * 1024) { toast.show('This file is too large', 'A logo can be at most 512 KB.'); return; }
    setLogos((l) => {
      const prev = l[v];
      if (prev.kind === 'new') URL.revokeObjectURL(prev.url);
      return { ...l, [v]: { kind: 'new', file, url: URL.createObjectURL(file) } };
    });
    setSaveError(null);
  }

  function removeLogo(v: LogoVariant) {
    setLogos((l) => {
      const prev = l[v];
      if (prev.kind === 'new') URL.revokeObjectURL(prev.url);
      return { ...l, [v]: saved.organisation.logos[v] ? { kind: 'remove' } : { kind: 'keep' } };
    });
  }

  function shown(v: LogoVariant): { src: string; name: string } | null {
    const s = logos[v];
    if (s.kind === 'new') return { src: s.url, name: s.file.name };
    const l = s.kind === 'keep' ? saved.organisation.logos[v] : null;
    // ?v= is the logo checksum, so a replaced logo skips the cache
    return l ? { src: apiUrl(l.url), name: l.filename } : null;
  }

  function field(k: keyof Form, label: ReactNode, hint: ReactNode, extra: { type?: string; placeholder?: string; autoComplete?: string; inputMode?: 'numeric' | 'email' | 'url' } = {}) {
    const err = errs[k];
    return (
      <div className="fld">
        <span><label htmlFor={`f-${k}`}>{label}</label></span>
        <input
          className="tin" id={`f-${k}`} value={String(w[k])} type={extra.type ?? 'text'} placeholder={extra.placeholder} autoComplete={extra.autoComplete ?? 'off'}
          inputMode={extra.inputMode} aria-invalid={err ? true : undefined} spellCheck={false}
          aria-describedby={err || hint ? `f-${k}-hint` : undefined}
          onChange={(e) => set(k, e.target.value as never)}
        />
        {err || hint ? <span className={err ? 'hint err' : 'hint'} id={`f-${k}-hint`}>{err || hint}</span> : null}
      </div>
    );
  }

  function logoBox(v: LogoVariant) {
    const dark = v === 'dark';
    const own = shown(v);
    const light = shown('light');
    const src = own ?? (dark ? light : null);
    let note = 'None, showing the VDRkit mark';
    if (own) note = own.name;
    else if (dark && light) note = 'None, using the light logo';
    return (
      <div className={`pvs${dark ? ' dark' : ''}`} data-logo={v}>
        <small>{dark ? 'Dark mode' : 'Light mode'}</small>
        {src ? <img src={src.src} alt={`${saved.organisation.name ?? 'Organisation'} logo, ${dark ? 'dark' : 'light'} mode`} /> : <Mark ink={dark ? '#E4EBF2' : '#1A2531'} />}
        <span className="hint">{note}</span>
        <div className="acts">
          <button type="button" className="btn secondary sm" onClick={() => chooseLogo(v)}>{UP}{own ? 'Replace' : 'Upload'}</button>
          {own ? <button type="button" className="btn ghost sm" onClick={() => removeLogo(v)}>Remove</button> : null}
        </div>
      </div>
    );
  }

  const branding = (
    <section className="panel">
      <div className="ph"><div><h2>Your organisation</h2><span className="cap">Shown at the top of the menu in every room, on the sign-in pages and in every email.</span></div></div>
      <div className="fields">
        {field('org', 'Organisation name', `Used in emails: “Data rooms run by ${w.org.trim() || 'your organisation'}”.`)}
        <span></span>
        <div className="fld wide"><span>Logo</span><span className="hint">Wide logos work best. Shown at most 180 × 40 px. PNG or SVG.</span></div>
      </div>
      <div className="pv">{logoBox('light')}{logoBox('dark')}</div>
      <div className="pfoot"><span className="cap">Without a logo the VDRkit mark shows. Without a dark-mode version, dark mode uses the light one.</span></div>
    </section>
  );

  const savedPrivacy = saved.organisation.privacyNotice;
  const orgName = saved.organisation.name ?? 'your organisation';
  const PRIVACY_OPTS: [PrivacyKind, string, string][] = [
    ['none', 'No privacy notice', 'The sign-in pages show no link.'],
    ['url', 'A web address', 'Links to the privacy notice on your own website.'],
    ['text', 'Text shown on its own page', 'Paste the text. VDRkit shows it on a public page of this site.'],
  ];
  const privacy = (
    <section className="panel" data-privacy>
      <div className="ph"><div><h2>Privacy notice</h2><span className="cap">Linked at the foot of the sign-in pages, next to “Data rooms run by {orgName}”. Without one, no link shows.</span></div></div>
      <div className="opts" role="radiogroup" aria-label="Privacy notice">
        {PRIVACY_OPTS.map(([k, title, line]) => (
          <button key={k} type="button" className="opt" role="radio" aria-checked={w.privacyKind === k} data-privacy-kind={k} onClick={() => set('privacyKind', k)}>
            <i className="rd" aria-hidden="true"></i>
            <div><b>{title}</b><span>{line}</span></div>
          </button>
        ))}
      </div>
      {w.privacyKind === 'url' ? (
        <div className="fields">
          {field('privacyUrl', 'Web address', 'Opens in a new tab from the sign-in pages.', { placeholder: 'https://www.example.com/privacy', inputMode: 'url' })}
        </div>
      ) : null}
      {w.privacyKind === 'text' ? (
        <div className="fields">
          <label className="fld wide">
            <span>Text</span>
            <textarea className="tarea privacy-in" id="f-privacyText" value={w.privacyText} aria-invalid={errs.privacyText ? true : undefined}
              onChange={(e) => set('privacyText', e.target.value)} />
            {errs.privacyText ? <span className="hint err">{errs.privacyText}</span> : <span className="hint">Plain text. A blank line starts a new paragraph.</span>}
          </label>
        </div>
      ) : null}
      {savedPrivacy.kind !== 'none' ? (
        <div className="pfoot">
          <span className="cap">{savedPrivacy.kind === 'url' ? 'Saved link:' : 'Saved text, shown at /privacy.'}</span>
          <a className="linkbtn" href={savedPrivacy.kind === 'url' ? savedPrivacy.url : PRIVACY_HREF} target="_blank" rel="noopener noreferrer">
            {savedPrivacy.kind === 'url' ? savedPrivacy.url : 'Open the privacy notice'}
          </a>
        </div>
      ) : null}
    </section>
  );

  const d = dns?.data;
  const t = test.result;
  let testNote: ReactNode = null;
  if (test.error) {
    testNote = <div className="note warn" data-test-result="failed"><div><b>{test.error}</b></div></div>;
  } else if (t?.status === 'accepted') {
    testNote = <div className="note info" data-test-result="accepted"><div><b>Test email sent to {t.sentTo} at {formatTime(t.sentAt, tz)}.</b> The mail server accepted it. Check that it arrived, and not in the spam folder.</div></div>;
  } else if (t) {
    testNote = <div className="note warn" data-test-result="failed"><div><b>{t.error ?? 'The mail server refused the message.'}</b> Nothing else was changed.</div></div>;
  }

  let domainCap: ReactNode = 'Checking the sending domain…';
  if (d) domainCap = <>Checked for {d.domain} {atWords(d.checkedAt, tz, formatTime(d.checkedAt, tz))}. These records are set where the domain is managed, not here.</>;
  else if (!canCheck) domainCap = 'Set a sending address first and save it. The check looks at its domain.';
  else if (dns?.error) domainCap = dns.error;

  const dnsRows = d ? [
    { k: 'SPF', c: d.spf, code: d.spf.record ?? 'No record found' },
    { k: 'DKIM', c: d.dkim, code: d.dkim.status === 'pass' ? `selector ${d.dkim.selector}._domainkey` : `No record found for selector ${d.dkim.selector}._domainkey` },
    { k: 'DMARC', c: d.dmarc, code: d.dmarc.record ?? 'No record found' },
  ] : [];

  const email = (
    <>
      <section className="panel">
        <div className="ph"><div><h2>Mail server</h2><span className="cap">Every email from every room leaves through this server: invitations, sign-in codes and notifications. Values from the installation file (.env) fill these fields at first; a change saved here takes their place.</span></div></div>
        <div className="fields">
          {field('host', 'Server', '', { placeholder: 'smtp.example.com' })}
          <div className="fld port-enc">
            {field('port', 'Port', 'Changes with the encryption. You can still type another.', { inputMode: 'numeric' })}
            <label className="fld">
              <span>Encryption</span>
              <select className="tsel" id="f-security" value={w.security} onChange={(e) => {
                const s = e.target.value as Form['security'];
                setW((x) => ({ ...x, security: s, port: s === 'tls' ? '465' : '587' }));
                setSaveError(null);
              }}>
                <option value="starttls">STARTTLS, usually port 587</option>
                <option value="tls">TLS, usually port 465</option>
              </select>
            </label>
          </div>
          {field('user', 'Username', '', { autoComplete: 'off' })}
          {field('pw', 'Password', 'Stored encrypted. Nobody can read it back, so leave the field empty to keep the saved password.',
            { type: 'password', autoComplete: 'new-password', placeholder: saved.mail.passwordSet ? 'Saved. Type a new one to replace it' : '' })}
          {field('from', 'Sending address', 'Emails come from this address. It must belong to a domain this server may send for.', { inputMode: 'email' })}
        </div>
        <div className="pfoot">
          <span className="cap">Send a test to yourself after any change.</span>
          <button type="button" className="btn secondary sm" onClick={() => void sendTest()} disabled={test.busy}>{test.busy ? 'Sending…' : 'Send a test email'}</button>
        </div>
        {testNote}
      </section>

      <section className="panel" data-domain-check>
        <div className="ph">
          <div>
            <h2>Will the emails arrive?</h2>
            <span className="cap">
              {domainCap}
            </span>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => void checkDomain(w.dkim.trim() || undefined, true)} disabled={dns?.loading || !canCheck}>Check again</button>
        </div>
        {dnsRows.map((r) => (
          <div className="dns" key={r.k} data-record={r.k}><b>{r.k}</b><code>{r.code}</code><span className={`pill ${r.c.status === 'pass' ? 'ok' : 'warn'}`}>{r.c.status === 'pass' ? 'Pass' : 'Missing'}</span></div>
        ))}
        {d ? (
          <div className="sel-row">
            <label htmlFor="f-dkim">DKIM selector</label>
            <input className="tin" id="f-dkim" value={w.dkim} spellCheck={false} aria-invalid={errs.dkim ? true : undefined} onChange={(e) => set('dkim', e.target.value)} />
            <span>{errs.dkim ?? 'The name your mail provider gave the DKIM key. Saved with the other changes.'}</span>
          </div>
        ) : null}
        {dnsRows.filter((r) => r.c.status !== 'pass' && r.c.fix).map((r) => <FixNote key={r.k} fix={r.c.fix!} />)}
      </section>
    </>
  );

  const healthRows = health?.items.filter((i) => i.key !== 'version') ?? [];
  const pillOf = (i: Health['items'][number]) => {
    if (i.status === 'ok') return { cls: 'ok', text: 'Working' };
    if (i.status === 'failing') return { cls: 'bad', text: 'Not working' };
    if (i.status === 'warning') return { cls: 'warn', text: i.key === 'virus_scanner' ? 'Not installed' : 'Needs attention' };
    return { cls: 'off', text: 'Not checked' };
  };
  const u = health?.update;
  let versionLine = '';
  if (u?.available && u.latest) versionLine = `VDRkit ${u.current}. Version ${u.latest} is available. Whoever installed VDRkit updates it with docker compose pull.`;
  else if (u) versionLine = `VDRkit ${u.current}. ${u.latest ? 'This is the latest version.' : u.note ?? ''}`;
  const alertMinLabel = { '5': '5 minutes', '15': '15 minutes', '60': '1 hour' } as const;

  const healthTab = (
    <>
      <section className="panel" data-health>
        <div className="ph"><div><h2>Health</h2><span className="cap">{health ? `Checked every minute. Last check ${atWords(health.checkedAt, tz, formatTime(health.checkedAt, tz))}.` : healthError ?? 'Checking…'}</span></div></div>
        {healthRows.map((i) => {
          const pill = pillOf(i);
          return (
            <div className="srow" key={i.key} data-check={i.key}>
              <div><b>{i.label}</b><p>{i.detail}{i.failingSince ? ` Not working since ${atWords(i.failingSince, tz, formatTime(i.failingSince, tz))}.` : ''}</p></div>
              <span className={`pill ${pill.cls}`}>{pill.text}</span>
            </div>
          );
        })}
        {health ? <div className="pfoot"><span className="cap">{versionLine}</span></div> : null}
      </section>
      <section className="panel">
        <div className="ph"><div><h2>When something stops working</h2><span className="cap">An email goes out when a check fails, and again when it works again.</span></div></div>
        <div className="srow">
          <div><b>Tell the site admins</b><p>{siteAdmins.length ? `${names(siteAdmins)}. ` : ''}They also see a red notice at the top of every page.</p></div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <button type="button" className="tg" role="switch" aria-checked={w.alertAdmins} aria-label="Tell the site admins" onClick={() => set('alertAdmins', !w.alertAdmins)}><i></i></button>
            <span className="cap">{w.alertAdmins ? 'On' : 'Off'}</span>
          </span>
        </div>
        <div className="fields" style={{ paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          {field('alertTo', <>Also tell <i>(optional)</i></>, 'An IT person or a shared support mailbox.', { placeholder: 'For example: it@firm.com', inputMode: 'email' })}
          <label className="fld">
            <span>After it has failed for</span>
            <select className="tsel" id="f-alertMin" value={w.alertMin} onChange={(e) => set('alertMin', e.target.value as Form['alertMin'])}>
              {(['5', '15', '60'] as const).map((m) => <option key={m} value={m}>{alertMinLabel[m]}</option>)}
            </select>
            <span className="hint">Short failures, such as a restart, send nothing.</span>
          </label>
        </div>
        <div className="note info"><div><b>If outgoing email itself fails, these alerts cannot be emailed.</b> For that case, point an outside uptime monitor at <code>{health?.monitorUrl ?? '/health'}</code>, which answers “ok” only when every check passes.</div></div>
      </section>
    </>
  );

  const body: Record<SiteTab, ReactNode> = {
    branding: <>{branding}{privacy}</>,
    email,
    rooms: <RoomsTab saved={saved} rooms={p.rooms} tz={tz} toast={toast.show}
      onCreators={(creators) => setSaved((s) => ({ ...s, rooms: { ...s.rooms, creators } }))} />,
    accounts: <AccountsTab staff={p.staff} everyoneTotal={p.everyoneTotal} me={p.me} toast={toast.show} onSiteAdmins={setSiteAdmins} />,
    health: healthTab,
  };

  return (
    <div className="g2">
      <div className="head">
        <div>
          <p className="over">Instance</p>
          <h1>Site settings</h1>
          <p className="sub">Settings for every room on this VDRkit site. Only site admins see this page. Each change is logged.</p>
        </div>
      </div>
      <div className="stabs" role="tablist" aria-label="Site settings">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className="stab" role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls={`panel-${k}`} onClick={() => open(k)}>
            {label}
            {dirtyTabs.has(k) ? <em aria-label="Unsaved changes"></em> : null}
            {k === 'health' && health && health.problems > 0
              ? <span className="pill warn" style={{ padding: '0 7px' }} title={`${health.problems} ${health.problems === 1 ? 'check needs' : 'checks need'} attention`}>{health.problems}</span>
              : null}
          </button>
        ))}
      </div>
      {TABS.map(([k]) => (
        // all tabs stay mounted so their state survives switching
        <div key={k} className="one" role="tabpanel" id={`panel-${k}`} aria-labelledby={`tab-${k}`} hidden={tab !== k}>{body[k]}</div>
      ))}
      {count > 0 ? (
        <div className="cbar" data-save-bar>
          <div className="grow">
            <b>{count} unsaved {count === 1 ? 'change' : 'changes'}</b>
            <span>Nothing changes for anyone until you save.</span>
            {saveError ? <span className="err" role="alert">{saveError}</span> : null}
          </div>
          <button type="button" className="btn quiet" onClick={discard} disabled={saving}>Discard</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      ) : null}
      <input ref={fileInput} type="file" accept="image/png,image/svg+xml,.png,.svg" hidden data-logo-input
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
      {toast.node}
    </div>
  );
}

function FixNote({ fix }: { fix: string }) {
  const m = /^(.*?\.)\s+(.*)$/.exec(fix);
  const lead = m && m[2] ? m[1] : null;
  const rest = lead ? m![2]! : fix;
  const ex = /^(.*for example )(.+?)\.?$/.exec(rest);
  return (
    <div className="note warn">
      <div>
        {lead ? <><b>{lead}</b> </> : null}
        {ex ? <>{ex[1]}<code>{ex[2]}</code>.</> : rest}
      </div>
    </div>
  );
}
