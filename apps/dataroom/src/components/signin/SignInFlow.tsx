// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CodeBoxes } from '@/components/outside/CodeBoxes';
import { MailIcon } from '@/components/outside/icons';
import { useToast } from '@/components/outside/Toast';
import { authCall, getPolicy, looksLikeEmail, safeNext } from '@/lib/auth-client';
import { useSendOnce } from '@/lib/send-once';
import { TwoFactorSetup } from './TwoFactorSetup';

export type SignInStep = 'email' | 'code' | 'totp' | 'setup';

const RESEND_S = 60;

// full load so server components see the new session
export function enter(next: string) {
  window.location.assign(safeNext(next));
}

export async function sendSignInEmail(email: string, next: string) {
  const callbackURL = safeNext(next);
  const body: { email: string; callbackURL?: string } = { email };
  if (callbackURL !== '/') body.callbackURL = callbackURL;
  return authCall('/sign-in/magic-link', body);
}

// same answer for every address, EMAIL_NOT_SENT included
export function sendFailure(r: { ok: boolean; status: number; code?: string | null }): string | null {
  if (r.ok) return null;
  if (r.status === 429) return 'Too many sign-in emails were asked for. Wait a minute and try again.';
  if (r.code === 'EMAIL_NOT_SENT') return 'We could not send the email right now. Try again in a few minutes.';
  return 'The email could not be sent because of a fault on the site. Try again in a minute.';
}

export async function afterSignIn(next: string, setStep: (s: SignInStep) => void, onSignedIn?: () => void) {
  const p = await getPolicy();
  if (p.ok && p.data?.twoFactorSetupRequired) { setStep('setup'); return; }
  if (onSignedIn) onSignedIn(); else enter(next);
}

export function SignInFlow(p: {
  next: string;
  initialStep?: SignInStep;
  initialEmail?: string;
  before?: (step: SignInStep) => ReactNode;
  onSignedIn?: () => void;
  sentAlready?: boolean;
  initialError?: string;
}) {
  const [step, setStep] = useState<SignInStep>(p.initialStep ?? 'email');
  const [email, setEmail] = useState(p.initialEmail ?? '');
  const [code, setCode] = useState('');
  const [err, setErr] = useState(p.initialError ?? '');
  // after too many tries Better Auth drops the code and says "invalid"
  const [codeDead, setCodeDead] = useState(false);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [reset, setReset] = useState(0);
  const [resendIn, setResendIn] = useState(p.sentAlready ? RESEND_S : 0);
  const [trust, setTrust] = useState(true);
  const [trustPolicy, setTrustPolicy] = useState<{ allowTrustedBrowser: boolean; trustedBrowserDays: number } | null>(null);
  const toast = useToast();
  const emailInput = useRef<HTMLInputElement>(null);

  const go = (s: SignInStep) => {
    setStep(s);
    setErr('');
    setCode('');
    setReset((x) => x + 1);
  };

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((x) => x - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (step === 'email') emailInput.current?.focus({ preventScroll: true });
    if (step !== 'totp') return;
    // default period until the policy is known
    void authCall<{ allowTrustedBrowser: boolean; trustedBrowserDays: number }>('/v1/public/sign-in/pending', undefined, 'GET')
      .then((r) => { if (r.ok && r.data) setTrustPolicy(r.data); });
  }, [step]);

  const send = once(async () => {
    const v = email.trim();
    if (!looksLikeEmail(v)) { setErr('Enter a complete email address, such as name@firm.com.'); return; }
    setBusy(true);
    const r = await sendSignInEmail(v, p.next);
    setBusy(false);
    const failed = sendFailure(r);
    if (failed) { setErr(failed); return; }
    setCodeDead(false);
    setEmail(v);
    setResendIn(RESEND_S);
    go('code');
  });

  const resend = once(async () => {
    const r = await sendSignInEmail(email, p.next);
    const failed = sendFailure(r);
    if (failed) { setErr(failed); return; }
    setCodeDead(false);
    setResendIn(RESEND_S);
    setErr('');
    setReset((x) => x + 1);
    toast.show('New email sent', 'The earlier link and code no longer work.');
  });

  const verify = once(async () => {
    if (code.length < 6) { setErr('Type all six digits from the email.'); return; }
    setBusy(true);
    const r = await authCall<{ twoFactorRedirect?: boolean }>('/sign-in/email-otp', { email, otp: code });
    setBusy(false);
    if (r.ok && r.data?.twoFactorRedirect) { go('totp'); return; }
    if (r.ok) { await afterSignIn(p.next, go, p.onSignedIn); return; }
    if (r.code === 'TOO_MANY_ATTEMPTS' || r.code === 'OTP_EXPIRED' || (codeDead && r.code === 'INVALID_OTP')) {
      setCodeDead(true);
      setErr('This code no longer works. Send a new email to get a new link and code.');
    } else if (r.status === 429) {
      setErr('Too many tries. Wait a minute and try again.');
    } else if (r.status === 0 || r.status >= 500) {
      setErr('The code could not be checked because of a fault on the site. Try again in a minute.');
    } else {
      setErr('This code is not right. Check the email and type the six digits again.');
    }
    setReset((x) => x + 1);
  });

  const signInWithApp = once(async () => {
    if (code.length < 6) { setErr('Type the six digits your app shows. They change every 30 seconds.'); return; }
    setBusy(true);
    const allowTrust = trustPolicy?.allowTrustedBrowser ?? true;
    const r = await authCall('/two-factor/verify-totp', { code, trustDevice: allowTrust && trust });
    setBusy(false);
    if (r.ok) { await afterSignIn(p.next, go, p.onSignedIn); return; }
    if (r.code === 'INVALID_TWO_FACTOR_COOKIE') {
      // pending sign-in expired
      setErr('This sign-in has expired. Reload the page and start again with your email address.');
    } else if (r.status === 429 || r.code === 'ACCOUNT_TEMPORARILY_LOCKED' || r.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') {
      setErr('Too many wrong codes. Wait 15 minutes and try again, or ask the room admin to reset your two-factor sign-in.');
    } else if (r.status === 0 || r.status >= 500) {
      setErr('The code could not be checked because of a fault on the site. Try again in a minute.');
    } else {
      setErr('This code is not right. Type the six digits your app shows now. They change every 30 seconds.');
    }
    setReset((x) => x + 1);
  });

  const before = p.before?.(step);
  const days = trustPolicy?.trustedBrowserDays ?? 30;
  const allowTrust = trustPolicy?.allowTrustedBrowser ?? true;
  const errLine = err ? <p className="hint err" id="f-err" style={{ marginTop: -10 }}>{err}</p> : null;

  return (
    <>
      {step === 'email' && (
        <>
          {before}
          <div>
            <h1>Sign in to your data room</h1>
            <p className="lead">Enter the email address your invitation was sent to. We email you a sign-in link and a six-digit code. Use whichever is easier.</p>
          </div>
          <label className="fld">
            <span>Work email</span>
            <input ref={emailInput} className="tin" id="f-email" type="email" autoComplete="email" value={email}
              aria-invalid={err ? true : undefined} aria-describedby={err ? 'f-err' : undefined}
              onChange={(e) => { setEmail(e.target.value); setErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }} />
          </label>
          {errLine}
          <button type="button" className="btn primary block" onClick={send} disabled={busy}>Email me a link and a code</button>
          <p className="hint">There is no password. On a new browser we also ask for the code from your authenticator app.</p>
        </>
      )}
      {step === 'code' && (
        <>
          {before}
          <div>
            <h1>Check your email</h1>
            <p className="lead">If this address has access to a data room, the email arrives within a minute.</p>
          </div>
          <div className="mailbox">
            <MailIcon />
            <div><b>{email}</b><span>Click the link in the email, or type the code here. Both work once, within 15 minutes.</span></div>
          </div>
          <div className="fld">
            <span aria-hidden="true">Code from the email</span>
            <CodeBoxes label="Code from the email" onChange={(v) => { setCode(v); if (v) setErr(''); }} onEnter={verify} bad={!!err} reset={reset} errorId={err ? 'f-err' : undefined} />
          </div>
          {errLine}
          <button type="button" className="btn primary block" onClick={verify} disabled={busy}>Continue</button>
          <div className="alt">
            {p.initialEmail && p.sentAlready ? <span /> : <button type="button" className="linkbtn" onClick={() => go('email')}>Use a different email address</button>}
            <button type="button" className="linkbtn" onClick={resend} disabled={resendIn > 0}>
              {resendIn > 0 ? `Send again in ${resendIn} s` : 'Send a new email'}
            </button>
          </div>
        </>
      )}
      {step === 'totp' && (
        <>
          {before}
          <div>
            <h1>Enter the code from your authenticator app</h1>
            <p className="lead">Open the app you set up for this data room and type the six digits it shows for <b>VDRkit</b>.</p>
          </div>
          <div className="fld">
            <span aria-hidden="true">Authenticator code</span>
            <CodeBoxes label="Authenticator code" onChange={(v) => { setCode(v); if (v) setErr(''); }} onEnter={signInWithApp} bad={!!err} reset={reset} errorId={err ? 'f-err' : undefined} />
          </div>
          {errLine}
          {allowTrust ? (
            <label className="chk">
              <input type="checkbox" id="f-trust" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
              <span>Trust this browser for {days} {days === 1 ? 'day' : 'days'}<br /><span className="hint">On this browser you then sign in with the email alone. Leave it off on a shared computer.</span></span>
            </label>
          ) : null}
          <button type="button" className="btn primary block" onClick={signInWithApp} disabled={busy}>Sign in</button>
          <div className="note info"><div><b>New phone, or lost it?</b> Ask the room admin to reset your two-factor sign-in. You then set it up again at your next sign-in.</div></div>
        </>
      )}
      {step === 'setup' && (
        <TwoFactorSetup
          before={before}
          onDone={() => {
            toast.show('Two-factor sign-in is on', 'If you change or lose your phone, the room admin can reset it.');
            if (p.onSignedIn) p.onSignedIn(); else setTimeout(() => enter(p.next), 600);
          }}
        />
      )}
      {toast.node}
    </>
  );
}
