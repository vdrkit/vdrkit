// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState } from 'react';
import { browserApi } from '@/api/browser';
import { ClockIcon, MailIcon } from '@/components/outside/icons';
import { useSendOnce } from '@/lib/send-once';

export function EmailChangeApprovalInvalid() {
  return (
    <>
      <div className="done-ico bad"><ClockIcon /></div>
      <div>
        <h1>This link does not work</h1>
        <p className="lead">This link no longer works, and nothing changed. Ask your room admin to change your address again if you still want that.</p>
      </div>
    </>
  );
}

export function EmailChangeApproval({ token, oldEmail, newEmail, requestedBy }: { token: string; oldEmail: string; newEmail: string; requestedBy: string }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [state, setState] = useState<'ask' | 'agreed' | 'not_sent' | 'refused' | 'gone'>('ask');

  const answer = once(async (yes: boolean) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    const api = browserApi();
    const r = yes
      ? await api.POST('/v1/public/email-change/approve', { body: { token } }).catch(() => null)
      : await api.POST('/v1/public/email-change/decline', { body: { token } }).catch(() => null);
    setBusy(false);
    if (r?.response.ok) {
      if (!yes) { setState('refused'); return; }
      const sent = (r.data as { emailStatus?: string } | undefined)?.emailStatus;
      setState(sent === 'accepted' ? 'agreed' : 'not_sent');
      return;
    }
    if (r?.response.status === 410) { setState('gone'); return; }
    setErr((r?.error as { detail?: string } | undefined)?.detail ?? 'That did not work. Try again in a moment.');
  });

  if (state === 'gone') return <EmailChangeApprovalInvalid />;
  if (state === 'agreed') {
    return (
      <>
        <div className="done-ico ok"><MailIcon /></div>
        <div>
          <h1>A code is on its way to {newEmail}</h1>
          <p className="lead">Open the email we sent to {newEmail} and type its code on the page it links to. Your address changes once you do. Until then you sign in with {oldEmail}.</p>
        </div>
      </>
    );
  }
  if (state === 'not_sent') {
    return (
      <>
        <div className="done-ico bad"><MailIcon /></div>
        <div>
          <h1>The code could not be sent</h1>
          <p className="lead">You agreed, but the email to {newEmail} could not be sent. Nothing changed: you still sign in with {oldEmail}. Ask your room admin to change your address again.</p>
        </div>
      </>
    );
  }
  if (state === 'refused') {
    return (
      <>
        <div className="done-ico ok"><MailIcon /></div>
        <div>
          <h1>Nothing changed</h1>
          <p className="lead">You still sign in with {oldEmail}. If you did not expect this request, tell your room admin or the site admin.</p>
        </div>
        <a className="btn secondary block" href="/sign-in">Sign in</a>
      </>
    );
  }
  return (
    <>
      <div>
        <h1>Change your sign-in address?</h1>
        <p className="lead">{requestedBy} asked to change the address you sign in with. Nothing changes unless you agree.</p>
      </div>
      <div className="mailbox">
        <MailIcon />
        <div><b>{newEmail}</b><span>The new address. Now you sign in with {oldEmail}. If you agree, we send a code to the new address, and your address changes once you type it.</span></div>
      </div>
      {err ? <p className="hint err" role="alert">{err}</p> : null}
      <button type="button" className="btn primary block" onClick={() => void answer(true)} disabled={busy}>Yes, change my sign-in address</button>
      <button type="button" className="btn secondary block" onClick={() => void answer(false)} disabled={busy}>No, keep {oldEmail}</button>
    </>
  );
}
