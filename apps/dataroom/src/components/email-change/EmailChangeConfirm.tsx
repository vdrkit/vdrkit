// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState } from 'react';
import { browserApi } from '@/api/browser';
import { CodeBoxes } from '@/components/outside/CodeBoxes';
import { ClockIcon, MailIcon } from '@/components/outside/icons';
import { useSendOnce } from '@/lib/send-once';

export function EmailChangeInvalid() {
  return (
    <>
      <div className="done-ico bad"><ClockIcon /></div>
      <div>
        <h1>This link does not work</h1>
        <p className="lead">This link no longer works. Ask your room admin to change your address again.</p>
      </div>
      <p className="hint">Already confirmed? <a className="linkbtn" href="/sign-in">Sign in</a> with your new address.</p>
    </>
  );
}

export function EmailChangeConfirm({ token, newEmail }: { token: string; newEmail: string }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [reset, setReset] = useState(0);
  const [state, setState] = useState<'ask' | 'done' | 'gone'>('ask');

  const confirm = once(async () => {
    if (busy) return;
    if (!/^\d{6}$/.test(code)) { setErr('Type the six digits from the email.'); return; }
    setBusy(true);
    setErr('');
    const r = await browserApi().POST('/v1/public/email-change/confirm', { body: { token, code } }).catch(() => null);
    setBusy(false);
    if (r?.data) { setState('done'); return; }
    if (r?.response.status === 410) { setState('gone'); return; }
    setErr((r?.error as { detail?: string } | undefined)?.detail ?? 'That did not work. Try again in a moment.');
    setReset((n) => n + 1);
  });

  if (state === 'gone') return <EmailChangeInvalid />;
  if (state === 'done') {
    return (
      <>
        <div className="done-ico ok"><MailIcon /></div>
        <div>
          <h1>Your sign-in address has changed</h1>
          <p className="lead">From now on you sign in with {newEmail}. You were signed out everywhere, so sign in again with this address. Your authenticator app stays the same.</p>
        </div>
        <a className="btn primary block" href="/sign-in">Sign in</a>
      </>
    );
  }
  return (
    <>
      <div>
        <h1>Confirm your new sign-in address</h1>
        <p className="lead">Type the code from the email we sent to this address. Your address changes once you do.</p>
      </div>
      <div className="mailbox">
        <MailIcon />
        <div><b>{newEmail}</b><span>The code works for three days. Until you confirm, you sign in with your old address.</span></div>
      </div>
      <div className="fld">
        <span aria-hidden="true">Code from the email</span>
        <CodeBoxes label="Code from the email" onChange={(v) => { setCode(v); if (v) setErr(''); }} onEnter={() => void confirm()} bad={!!err} reset={reset} errorId={err ? 'f-err' : undefined} />
      </div>
      {err ? <p className="hint err" id="f-err" role="alert" style={{ marginTop: -10 }}>{err}</p> : null}
      <button type="button" className="btn primary block" onClick={() => void confirm()} disabled={busy}>Confirm the new address</button>
    </>
  );
}
