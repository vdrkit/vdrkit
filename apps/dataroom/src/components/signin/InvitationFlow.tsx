// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import { InvitationInvalid, RoomCard, dayWithYear } from '@/components/errors/pages';
import { zoneAbbreviation } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import { sendFailure, sendSignInEmail, SignInFlow } from './SignInFlow';
import { browserZone, TimeZonePicker } from './TimeZonePicker';

export interface InvitationFacts {
  workspaceId: string;
  roomName: string;
  runBy: string;
  onBehalfOf: string | null;
  invitedBy: string | null;
  groupName: string;
  accessEndsAt: string | null;
  roomTimeZone: string;
  email: string;
  givenName: string | null;
  familyName: string | null;
  company: string | null;
  jobTitle: string | null;
  accepted: boolean;
  requireTwoFactor: boolean;
}

// stays current until the emailed code confirms the address
export function Steps({ current, twoFactor = true }: { current: 1 | 2 | 3; twoFactor?: boolean }) {
  const all = twoFactor ? ['Your details', 'Two-factor', 'NDA'] : ['Your details', 'NDA'];
  const at = !twoFactor && current === 3 ? 2 : current;
  return (
    <ol className="steps" aria-label="Steps to enter the room">
      {all.map((t, i) => {
        const n = i + 1;
        let cls = '';
        if (n === at) cls = 'on';
        else if (n < at) cls = 'done';
        return <li key={t} className={cls} aria-current={n === at ? 'step' : undefined}>{t}</li>;
      })}
    </ol>
  );
}

export function invitationLine(f: Pick<InvitationFacts, 'invitedBy' | 'runBy' | 'groupName' | 'onBehalfOf'>): string {
  const who = f.invitedBy ? `${f.invitedBy} of ${f.runBy}` : f.runBy;
  return `${who} invited you to ${f.groupName}${f.onBehalfOf ? `, on behalf of ${f.onBehalfOf}` : ''}`;
}

// the invitation link itself signs nobody in
export function InvitationFlow({ token, facts }: { token: string; facts: InvitationFacts }) {
  const [step, setStep] = useState<'details' | 'signin' | 'invalid'>(facts.accepted ? 'signin' : 'details');
  const [fn, setFn] = useState(facts.givenName ?? '');
  const [ln, setLn] = useState(facts.familyName ?? '');
  const [co, setCo] = useState(facts.company ?? '');
  const [ro, setRo] = useState(facts.jobTitle ?? '');
  const [tz, setTz] = useState(facts.roomTimeZone);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [sendError, setSendError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  // browser-only
  useEffect(() => { const z = browserZone(); if (z) setTz(z); }, []);
  useEffect(() => { if (step === 'details') firstField.current?.focus({ preventScroll: true }); }, [step]);

  const ndaPath = (twoFactor: boolean) => `/rooms/${facts.workspaceId}/nda?from=invite${twoFactor ? '' : '&tfa=0'}`;
  const card = <RoomCard name={facts.roomName} line={invitationLine(facts)} />;

  const saveDetails = once(async () => {
    const d = { givenName: fn.trim(), familyName: ln.trim(), company: co.trim(), jobTitle: ro.trim() };
    setFn(d.givenName);
    setLn(d.familyName);
    setCo(d.company);
    setRo(d.jobTitle);
    if (!d.givenName || !d.familyName || !d.company) {
      setErr('Enter your first name, last name and company. Your team and the room admin see them.');
      return;
    }
    setBusy(true);
    const r = await browserApi().POST('/v1/public/invitations/accept', {
      body: { token, ...d, jobTitle: d.jobTitle || undefined, timeZone: tz },
    });
    if (r.response.status === 410) { setBusy(false); setStep('invalid'); return; }
    if (!r.data) { setBusy(false); setErr('Your details could not be saved. Try again in a minute.'); return; }
    const me = await browserApi().GET('/v1/me');
    if (me.data && me.data.email.toLowerCase() === facts.email.toLowerCase()) {
      const p = await browserApi().GET('/v1/me/sign-in-policy');
      window.location.assign(ndaPath(!!p.data?.requireTwoFactor));
      return;
    }
    const sent = await sendSignInEmail(facts.email, ndaPath(facts.requireTwoFactor));
    setSendError(sendFailure(sent));
    setBusy(false);
    setStep('signin');
  });

  if (step === 'invalid') return <InvitationInvalid />;

  if (step === 'signin') {
    if (facts.accepted) {
      return <SignInFlow next={`/rooms/${facts.workspaceId}/dashboard`} initialEmail={facts.email} />;
    }
    return (
      <SignInFlow
        next={ndaPath(facts.requireTwoFactor)}
        initialStep="code"
        initialEmail={facts.email}
        sentAlready={!sendError}
        initialError={sendError ?? undefined}
        before={(s) => <>{card}<Steps current={s === 'setup' ? 2 : 1} twoFactor={facts.requireTwoFactor} /></>}
        onSignedIn={async () => {
          const p = await browserApi().GET('/v1/me/sign-in-policy');
          window.location.assign(ndaPath(!!p.data?.requireTwoFactor));
        }}
      />
    );
  }

  return (
    <>
      {card}
      <Steps current={1} twoFactor={facts.requireTwoFactor} />
      <div>
        <h1>Welcome to {facts.roomName}</h1>
        <p className="lead">
          Check your details and time zone. Deadlines in the room show in your time zone.{' '}
          {facts.accessEndsAt ? <>Your access runs until <b>{dayWithYear(facts.accessEndsAt, tz)}</b>.</> : <>Your access runs until the room closes.</>}
        </p>
      </div>
      <div className="row2">
        <label className="fld"><span>First name</span><input ref={firstField} className="tin" id="f-fn" autoComplete="given-name" aria-describedby={err ? 'f-err' : undefined} value={fn} onChange={(e) => setFn(e.target.value)} /></label>
        <label className="fld"><span>Last name</span><input className="tin" id="f-ln" autoComplete="family-name" value={ln} onChange={(e) => setLn(e.target.value)} /></label>
      </div>
      <div className="row2">
        <label className="fld"><span>Company</span><input className="tin" id="f-co" autoComplete="organization" value={co} onChange={(e) => setCo(e.target.value)} /></label>
        <label className="fld"><span>Role</span><input className="tin" id="f-ro" autoComplete="organization-title" value={ro} onChange={(e) => setRo(e.target.value)} placeholder="For example: Partner" /></label>
      </div>
      <p className="hint" style={{ marginTop: -8 }}>Your team and the room admin see your name, company and role. You can change them later in your profile, and every change is logged.</p>
      <label className="fld">
        <span>Email</span>
        <input className="tin" readOnly value={facts.email} />
        <span className="hint">The address you were invited at. Only the room admin can change it.</span>
      </label>
      <label className="fld">
        <span>Your time zone</span>
        <TimeZonePicker id="f-tz" value={tz} onChange={setTz} />
        <span className="hint">Taken from your browser. The room itself runs on {zoneAbbreviation(new Date(), facts.roomTimeZone)}.</span>
      </label>
      {err ? <p className="hint err" id="f-err">{err}</p> : null}
      <button type="button" className="btn primary block" onClick={saveDetails} disabled={busy}>Continue</button>
    </>
  );
}
