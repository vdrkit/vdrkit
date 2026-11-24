// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { browserApi, apiUrl } from '@/api/browser';
import type { paths, Problem } from '@/api/client';
import { useToast } from '@/components/outside/Toast';
import { looksLikeEmail } from '@/lib/auth-client';
import { useSendOnce } from '@/lib/send-once';

// token and step survive a reload; a server restart needs a new code

type Step = 'unlock' | 'checks' | 'you' | 'org' | 'mail' | 'done';
const ORDER: Step[] = ['unlock', 'checks', 'you', 'org', 'mail', 'done'];
const NAMES = ['Unlock', 'Checks', 'You', 'Organisation', 'Email'];
const STORE = 'vdrkit-setup';
const TOKEN_HEADER = 'x-vdrkit-setup-token';

type Draft = paths['/v1/setup/draft']['get']['responses'][200]['content']['application/json'];
type Check = paths['/v1/setup/checks']['get']['responses'][200]['content']['application/json']['items'][number];
type Variant = 'light' | 'dark';

interface Mail { host: string; port: string; security: 'starttls' | 'tls'; user: string; password: string; fromAddress: string }
const EMPTY_MAIL: Mail = { host: '', port: '587', security: 'starttls', user: '', password: '', fromAddress: '' };

interface Saved { token: string; step: Step }

function readSaved(): Saved | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as Saved | null;
    return v && typeof v.token === 'string' && ORDER.includes(v.step) ? v : null;
  } catch {
    return null;
  }
}

function writeSaved(v: Saved | null) {
  try {
    if (v) sessionStorage.setItem(STORE, JSON.stringify(v));
    else sessionStorage.removeItem(STORE);
  } catch {
    // storage blocked: reload starts at the code
  }
}

const detailOf = (e: unknown, fallback: string) => (e as Problem | undefined)?.detail ?? fallback;

function checkLine(c: Check): string {
  if (c.key === 'virus_scanner' && c.status === 'warning') return 'ClamAV is not installed, so uploads are not scanned. Add it later from the installation guide.';
  if (c.status === 'ok') {
    const first = c.detail.split(/(?<=\.)\s/)[0] ?? c.detail;
    return first.replace(/\.$/, '');
  }
  return c.detail;
}

function pillOf(c: Check): { cls: string; text: string } {
  if (c.status === 'ok') return { cls: 'ok', text: 'Working' };
  if (c.status === 'failing') return { cls: 'bad', text: 'Not working' };
  if (c.status === 'not_checked') return { cls: 'neutral', text: 'Not checked' };
  if (c.key === 'virus_scanner') return { cls: 'warn', text: 'Not installed' };
  if (c.key === 'web_address') return { cls: 'warn', text: 'No certificate' };
  return { cls: 'warn', text: 'Needs attention' };
}

function checksLead(items: Check[]): string {
  const base = 'These were set in the installation file.';
  const failing = items.filter((i) => i.status === 'failing');
  if (failing.length) return `${base} Fix what is not working, then check again.`;
  const warn = items.filter((i) => i.status === 'warning');
  if (!warn.length) return `${base} Everything works.`;
  if (warn.length === 1 && warn[0]!.key === 'virus_scanner') return `${base} Only the virus scanner is missing, which is optional.`;
  const names = warn.filter((w) => w.key !== 'virus_scanner').map((w) => w.label.toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]!;
  const scanner = warn.some((w) => w.key === 'virus_scanner') ? ' The virus scanner is optional.' : '';
  return `${base} You can go on. Fix the ${list} before you invite anyone.${scanner}`;
}

function logoType(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.png')) return 'image/png';
  return '';
}

function Steps({ step }: { step: Step }) {
  const n = ORDER.indexOf(step);
  const stepClass = (i: number) => {
    if (i === n) return 'on';
    return i < n ? 'done' : '';
  };
  return (
    <ol className="steps" aria-label="Setup steps">
      {NAMES.map((t, i) => (
        <li key={t} className={stepClass(i)} aria-current={i === n ? 'step' : undefined}>{t}</li>
      ))}
    </ol>
  );
}

export function SetupFlow() {
  const api = browserApi();
  const toast = useToast();
  const [ready, setReady] = useState(false);
  const [step, setStepState] = useState<Step>('unlock');
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();

  const [code, setCode] = useState('');
  const [checks, setChecks] = useState<{ items: Check[]; ready: boolean } | null>(null);
  const [admin, setAdmin] = useState({ givenName: '', familyName: '', company: '', email: '' });
  const [orgName, setOrgName] = useState('');
  const [logos, setLogos] = useState<Draft['organisation']['logos']>({ light: null, dark: null });
  const [previews, setPreviews] = useState<Partial<Record<Variant, string>>>({});
  const [mail, setMail] = useState<Mail>(EMPTY_MAIL);
  const [passwordHint, setPasswordHint] = useState('');
  const [test, setTest] = useState<{ status: 'accepted' | 'failed'; to: string; error?: string } | null>(null);
  const [tested, setTested] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);
  const fileInputs = { light: useRef<HTMLInputElement>(null), dark: useRef<HTMLInputElement>(null) };
  const card = useRef<HTMLElement>(null);

  const go = useCallback((s: Step, t: string | null = token) => {
    setStepState(s);
    setErr('');
    if (s === 'done') writeSaved(null);
    else if (t) writeSaved({ token: t, step: s });
  }, [token]);

  const auth = useCallback((t: string | null = token) => ({ params: { header: { [TOKEN_HEADER]: t ?? '' } } }), [token]);

  const lost = useCallback((status: number) => {
    if (status === 404) {
      writeSaved(null);
      window.location.assign('/setup');
      return true;
    }
    if (status === 401) {
      writeSaved(null);
      setToken(null);
      setStepState('unlock');
      setErr('Setup was locked again, for example by a server restart. Enter the new setup code from the server log.');
      return true;
    }
    return false;
  }, []);

  const applyDraft = useCallback((d: Draft) => {
    if (d.admin) setAdmin(d.admin);
    if (d.organisation.name) setOrgName(d.organisation.name);
    setLogos(d.organisation.logos);
    if (d.mail) {
      setMail({ host: d.mail.host, port: String(d.mail.port), security: d.mail.security, user: d.mail.user ?? '', password: '', fromAddress: d.mail.fromAddress });
      let hint = '';
      if (d.mail.passwordSet) hint = d.mail.source === 'env' ? 'From the installation file' : 'Saved. Leave empty to keep it';
      setPasswordHint(hint);
    }
    setTested(!!d.testEmail?.current);
    if (d.testEmail) setTest({ status: 'accepted', to: d.testEmail.sentTo });
  }, []);

  const loadDraft = useCallback(async (t: string) => {
    const r = await api.GET('/v1/setup/draft', auth(t));
    if (r.data) { applyDraft(r.data); return true; }
    lost(r.response.status);
    return false;
  }, [api, auth, applyDraft, lost]);

  useEffect(() => {
    const saved = readSaved();
    if (!saved) { setReady(true); return; }
    async function resume(s: Saved) {
      setToken(s.token);
      if (await loadDraft(s.token)) setStepState(s.step);
      setReady(true);
    }
    void resume(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  const runChecks = useCallback(async (t: string | null = token) => {
    setChecks(null);
    const r = await api.GET('/v1/setup/checks', auth(t));
    if (r.data) setChecks(r.data);
    else if (!lost(r.response.status)) setErr(detailOf(r.error, 'The checks could not be run. Try again.'));
  }, [api, auth, lost, token]);

  useEffect(() => {
    if (ready && step === 'checks' && token && !checks) void runChecks();
  }, [ready, step, token, checks, runChecks]);

  useEffect(() => {
    if (!ready) return;
    card.current?.querySelector<HTMLInputElement>('input:not([type=file])')?.focus({ preventScroll: true });
  }, [ready, step]);

  // needs the setup token
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    async function loadPreviews() {
      const next: Partial<Record<Variant, string>> = {};
      for (const v of ['light', 'dark'] as const) {
        if (!logos[v] || !token) continue;
        const res = await fetch(apiUrl(`/v1/setup/logos/${v}`), { headers: { [TOKEN_HEADER]: token }, cache: 'no-store' }).catch(() => null);
        if (!res?.ok) continue;
        const u = URL.createObjectURL(await res.blob());
        urls.push(u);
        next[v] = u;
      }
      if (alive) setPreviews(next);
      else urls.forEach((u) => URL.revokeObjectURL(u));
    }
    void loadPreviews();
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [logos, token]);

  const unlock = once(async () => {
    const c = code.trim();
    if (!c) { setErr('Enter the setup code. It has eight letters and digits, such as K7QM-4XWD.'); return; }
    setBusy(true);
    const r = await api.POST('/v1/setup/unlock', { body: { code: c } });
    setBusy(false);
    if (r.data) {
      const t = r.data.token;
      setToken(t);
      setCode('');
      await loadDraft(t);
      go('checks', t);
      return;
    }
    if (r.response.status === 404) { lost(404); return; }
    if (r.response.status === 429) { setErr('Too many tries. Wait a minute and try again.'); return; }
    setErr(detailOf(r.error, 'The setup code could not be checked. Try again.'));
  });

  const saveAdmin = once(async () => {
    const a = { givenName: admin.givenName.trim(), familyName: admin.familyName.trim(), company: admin.company.trim(), email: admin.email.trim() };
    if (!a.givenName || !a.familyName || !a.company || !looksLikeEmail(a.email)) {
      toast.show('Fill in all four fields', 'Your name, company and work email.');
      return;
    }
    setBusy(true);
    const r = await api.PUT('/v1/setup/admin', { ...auth(), body: a });
    setBusy(false);
    if (r.data) { applyDraft(r.data); go('org'); return; }
    if (!lost(r.response.status)) setErr(detailOf(r.error, 'Your account could not be saved. Try again.'));
  });

  const saveOrg = once(async () => {
    const name = orgName.trim();
    if (name.length < 2) { setErr('Give the name of your organisation, as people should see it.'); return; }
    setBusy(true);
    const r = await api.PUT('/v1/setup/organisation', { ...auth(), body: { name } });
    setBusy(false);
    if (r.data) { applyDraft(r.data); go('mail'); return; }
    if (!lost(r.response.status)) setErr(detailOf(r.error, 'The organisation could not be saved. Try again.'));
  });

  const uploadLogo = once(async (v: Variant, file: File | undefined) => {
    if (!file) return;
    const type = logoType(file);
    if (type !== 'image/png' && type !== 'image/svg+xml') { setErr('Choose a PNG or SVG file.'); return; }
    if (file.size > 600 * 1024) { setErr('That file is larger than 600 KB. Choose a smaller PNG or SVG.'); return; }
    setBusy(true);
    setErr('');
    const res = await fetch(apiUrl(`/v1/setup/logos/${v}?filename=${encodeURIComponent(file.name.slice(0, 200))}`), {
      method: 'PUT', headers: { 'content-type': type, [TOKEN_HEADER]: token ?? '' }, body: file, cache: 'no-store',
    }).catch(() => null);
    setBusy(false);
    if (!res) { setErr('The logo could not be uploaded. Try again.'); return; }
    const body = (await res.json().catch(() => null)) as Draft | Problem | null;
    if (res.ok && body) {
      setLogos((body as Draft).organisation.logos);
      toast.show(v === 'light' ? 'Logo uploaded' : 'Dark-mode logo uploaded', 'Shown at most 180 × 40 px.');
      return;
    }
    if (!lost(res.status)) setErr(detailOf(body, 'The logo could not be uploaded. Try again.'));
  });

  const removeLogo = once(async (v: Variant) => {
    setBusy(true);
    const r = await api.DELETE('/v1/setup/logos/{variant}', { params: { path: { variant: v }, header: { [TOKEN_HEADER]: token ?? '' } } });
    setBusy(false);
    if (r.data) { setLogos(r.data.organisation.logos); return; }
    if (!lost(r.response.status)) setErr(detailOf(r.error, 'The logo could not be removed. Try again.'));
  });

  function editMail(change: Partial<Mail>) {
    setMail((m) => {
      const next = { ...m, ...change };
      if (change.security && change.security !== m.security) next.port = change.security === 'tls' ? '465' : '587';
      return next;
    });
    setTested(false);
    setErr('');
  }

  async function saveMail(): Promise<boolean> {
    const port = Number(mail.port);
    if (!mail.host.trim()) { setErr('Fill in the mail server, such as smtp.example.com.'); return false; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { setErr('The port is a number such as 587 or 465.'); return false; }
    if (!looksLikeEmail(mail.fromAddress.trim())) { setErr('Fill in the sending address, such as dataroom@example.com.'); return false; }
    const body: { host: string; port: number; security: Mail['security']; user: string | null; fromAddress: string; password?: string } = {
      host: mail.host.trim(),
      port,
      security: mail.security,
      user: mail.user.trim() || null,
      fromAddress: mail.fromAddress.trim(),
    };
    if (mail.password) body.password = mail.password;
    const r = await api.PUT('/v1/setup/mail', { ...auth(), body });
    if (r.data) { applyDraft(r.data); return true; }
    if (!lost(r.response.status)) setErr(detailOf(r.error, 'The mail settings could not be saved. Try again.'));
    return false;
  }

  const sendTest = once(async () => {
    setBusy(true);
    setErr('');
    setTest(null);
    try {
      if (!(await saveMail())) return;
      const r = await api.POST('/v1/setup/test-email', { ...auth(), body: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      if (r.data) {
        const result: { status: 'accepted' | 'failed'; to: string; error?: string } = { status: r.data.status, to: r.data.sentTo };
        if (r.data.error) result.error = r.data.error;
        setTest(result);
        setTested(r.data.status === 'accepted');
        return;
      }
      if (!lost(r.response.status)) setErr(detailOf(r.error, 'The test email could not be sent. Try again.'));
    } finally {
      setBusy(false);
    }
  });

  const finish = once(async () => {
    setBusy(true);
    setErr('');
    const r = await api.POST('/v1/setup/finish', auth());
    setBusy(false);
    if (r.data) { setFinished(r.data.email); go('done'); return; }
    if (r.response.status === 409) setTested(false);
    if (!lost(r.response.status)) setErr(detailOf(r.error, 'Setup could not be finished. Try again.'));
  });

  const errLine = err ? <p className="hint err" role="alert">{err}</p> : null;
  const back = (to: Step) => <button type="button" className="btn secondary" onClick={() => go(to)} disabled={busy}>Back</button>;

  let body: ReactNode = null;
  if (!ready) {
    body = <div className="check"><span className="spin" aria-hidden="true" />Opening setup</div>;
  } else if (step === 'unlock') {
    body = (
      <form onSubmit={(e) => { e.preventDefault(); void unlock(); }} style={{ display: 'contents' }}>
        <Steps step={step} />
        <div>
          <h1>Set up VDRkit</h1>
          <p className="lead">VDRkit is installed and running. Whoever sets it up now becomes its first site admin, so we ask for the setup code that only the server shows.</p>
        </div>
        <label className="fld">
          <span>Setup code</span>
          <div className={`code${err ? ' bad' : ''}`}>
            <input id="f-code" maxLength={9} placeholder="XXXX-XXXX" autoComplete="off" spellCheck={false} aria-label="Setup code"
              aria-invalid={err ? true : undefined} aria-describedby={err ? 'f-code-err' : undefined}
              value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setErr(''); }} />
          </div>
        </label>
        {err ? <p className="hint err" id="f-code-err" role="alert" style={{ marginTop: -8 }}>{err}</p> : null}
        <p className="hint">Find it in the server log, or run this on the server:</p>
        <pre className="cmd">docker compose logs api | grep &quot;Setup code&quot;</pre>
        <p className="hint">The code works once and expires after 24 hours. A new one appears when the server restarts.</p>
        <div className="acts"><button type="submit" className="btn primary" disabled={busy}>Continue</button></div>
      </form>
    );
  } else if (step === 'checks') {
    body = (
      <>
        <Steps step={step} />
        <div>
          <h1>Everything VDRkit needs</h1>
          <p className="lead">{checks ? checksLead(checks.items) : 'Checking what was set in the installation file.'}</p>
        </div>
        {checks ? (
          <div className="chkl">
            {checks.items.map((c) => {
              const p = pillOf(c);
              return <div key={c.key} data-check={c.key}>{c.label}<small>{checkLine(c)}</small><span className={`pill ${p.cls}`}>{p.text}</span></div>;
            })}
          </div>
        ) : <div className="check"><span className="spin" aria-hidden="true" />Checking the database, file storage, document conversion, virus scanner and web address</div>}
        {errLine}
        <div className="acts">
          {checks && !checks.ready ? <span className="hint">Setup can go on once every check that is not optional works.</span> : null}
          {checks && !checks.ready ? <button type="button" className="btn secondary" onClick={() => void runChecks()}>Check again</button> : null}
          <button type="button" className="btn primary" onClick={() => go('you')} disabled={!checks?.ready}>Continue</button>
        </div>
      </>
    );
  } else if (step === 'you') {
    const set = (k: keyof typeof admin) => (e: ChangeEvent<HTMLInputElement>) => { setAdmin((a) => ({ ...a, [k]: e.target.value })); setErr(''); };
    body = (
      <form onSubmit={(e) => { e.preventDefault(); void saveAdmin(); }} style={{ display: 'contents' }}>
        <Steps step={step} />
        <div>
          <h1>Your account</h1>
          <p className="lead">You become the first site admin. You can add more site admins later in Site settings.</p>
        </div>
        <div className="row2">
          <label className="fld"><span>First name</span><input className="tin" id="f-fn" autoComplete="given-name" value={admin.givenName} onChange={set('givenName')} /></label>
          <label className="fld"><span>Last name</span><input className="tin" id="f-ln" autoComplete="family-name" value={admin.familyName} onChange={set('familyName')} /></label>
        </div>
        <div className="row2">
          <label className="fld"><span>Company</span><input className="tin" id="f-co" autoComplete="organization" value={admin.company} onChange={set('company')} /></label>
          <label className="fld"><span>Work email</span><input className="tin" id="f-em" type="email" autoComplete="email" value={admin.email} onChange={set('email')} /></label>
        </div>
        <p className="hint">You sign in with this email address. There is no password. After setup you get a sign-in code by email and set up two-factor sign-in.</p>
        {errLine}
        <div className="acts">{back('checks')}<button type="submit" className="btn primary" disabled={busy}>Continue</button></div>
      </form>
    );
  } else if (step === 'org') {
    const logoRow = (v: Variant) => {
      const l = logos[v];
      if (!l) return null;
      return (
        <figure className={v} key={v}>
          {previews[v] ? <img src={previews[v]} alt={v === 'light' ? 'Logo' : 'Logo for dark mode'} /> : null}
          <span>{v === 'light' ? 'Logo' : 'Dark mode'}</span>
          <button type="button" className="linkbtn" onClick={() => void removeLogo(v)} disabled={busy}>{v === 'light' ? 'Remove the logo' : 'Remove the dark-mode version'}</button>
        </figure>
      );
    };
    body = (
      <form onSubmit={(e) => { e.preventDefault(); void saveOrg(); }} style={{ display: 'contents' }}>
        <Steps step={step} />
        <div>
          <h1>Your organisation</h1>
          <p className="lead">Shown at the top of every room, on the sign-in pages and in every email. You can change it later in Site settings.</p>
        </div>
        <label className="fld"><span>Organisation name</span><input className="tin" id="f-org" autoComplete="organization" value={orgName} onChange={(e) => { setOrgName(e.target.value); setErr(''); }} /></label>
        <div className="fld">
          <span>Logo <i>(optional)</i></span>
          {logos.light || logos.dark ? <div className="logo-prev">{logoRow('light')}{logoRow('dark')}</div> : null}
          <div className="logo-btns">
            <button type="button" className="btn secondary" onClick={() => fileInputs.light.current?.click()} disabled={busy}>{logos.light ? 'Replace the logo' : 'Upload a logo'}</button>
            <button type="button" className="btn secondary" onClick={() => fileInputs.dark.current?.click()} disabled={busy}>{logos.dark ? 'Replace the dark-mode version' : 'Upload a version for dark mode'}</button>
          </div>
          {(['light', 'dark'] as const).map((v) => (
            <input key={v} ref={fileInputs[v]} type="file" accept="image/png,image/svg+xml,.png,.svg" className="visually-hidden" tabIndex={-1} aria-hidden="true"
              data-logo={v} onChange={(e) => { void uploadLogo(v, e.target.files?.[0]); e.target.value = ''; }} />
          ))}
          <span className="hint">Wide logos work best, shown at most 180 × 40 px. Without one, the VDRkit mark shows.</span>
        </div>
        {errLine}
        <div className="acts">{back('you')}<button type="submit" className="btn primary" disabled={busy}>Continue</button></div>
      </form>
    );
  } else if (step === 'mail') {
    const to = admin.email;
    body = (
      <>
        <Steps step={step} />
        <div>
          <h1>Outgoing email</h1>
          <p className="lead">VDRkit sends invitations and sign-in codes by email, so this has to work before anyone can sign in. Values from the installation file are already filled in.</p>
        </div>
        <div className="row3">
          <label className="fld"><span>Server</span><input className="tin" id="f-host" autoComplete="off" spellCheck={false} value={mail.host} onChange={(e) => editMail({ host: e.target.value })} /></label>
          <label className="fld"><span>Port</span><input className="tin" id="f-port" inputMode="numeric" autoComplete="off" value={mail.port} onChange={(e) => editMail({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })} /></label>
          <label className="fld"><span>Encryption</span>
            <select className="tsel" id="f-tls" value={mail.security} onChange={(e) => editMail({ security: e.target.value as Mail['security'] })}>
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
            </select>
          </label>
        </div>
        <div className="row2">
          <label className="fld"><span>Username</span><input className="tin" id="f-user" autoComplete="off" spellCheck={false} value={mail.user} onChange={(e) => editMail({ user: e.target.value })} /></label>
          <label className="fld"><span>Password</span><input className="tin" id="f-pw" type="password" autoComplete="new-password" placeholder={passwordHint} value={mail.password} onChange={(e) => editMail({ password: e.target.value })} /></label>
        </div>
        <label className="fld"><span>Sending address</span><input className="tin" id="f-from" type="email" autoComplete="off" spellCheck={false} value={mail.fromAddress} onChange={(e) => editMail({ fromAddress: e.target.value })} /></label>
        {tested && test?.status === 'accepted'
          ? <div className="note info"><div><b>Test email sent to {test.to}.</b> The mail server accepted it. Check that it arrived before you finish, and look in the spam folder too.</div></div>
          : test?.status === 'failed'
            ? <div className="note bad" role="alert"><div><b>The test email to {test.to} was not sent.</b> {test.error}</div></div>
            : <p className="hint">Send a test to {to} before you finish. Finishing needs a test that the server accepted.</p>}
        {errLine}
        <div className="acts">
          {back('org')}
          <button type="button" className="btn secondary" onClick={() => void sendTest()} disabled={busy}>Send a test email</button>
          <button type="button" className="btn primary" onClick={() => void finish()} disabled={!tested || busy}>Finish setup</button>
        </div>
      </>
    );
  } else {
    const email = finished ?? admin.email;
    body = (
      <>
        <div className="done-ico" style={{ background: 'var(--ok-bg)', color: 'var(--ok)' }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4L19 6" /></svg>
        </div>
        <div>
          <h1>VDRkit is ready</h1>
          <p className="lead">This page will not appear again. Sign in with {email} to set up two-factor sign-in, then create your first room.</p>
        </div>
        <div className="chkl"><div>Next in Site settings<small>Add a second site admin, so the site never depends on one person. Install the virus scanner. Ask your IT team to add a DMARC record if the domain check asks for one.</small></div></div>
        <a className="btn primary block" href={`/sign-in?email=${encodeURIComponent(email)}`}>Sign in</a>
      </>
    );
  }

  return (
    <>
      <section className="card wide" aria-live="polite" ref={card} data-step={ready ? step : 'loading'}>{body}</section>
      {toast.node}
    </>
  );
}
