// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CodeBoxes } from '@/components/outside/CodeBoxes';
import { authCall, manualKey } from '@/lib/auth-client';
import { useSendOnce } from '@/lib/send-once';
import { QrCode } from './QrCode';

export function TwoFactorSetup({ before, onDone }: { before?: ReactNode; onDone: () => void }) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [reset, setReset] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    // once only: a second call issues a new secret
    if (started.current) return;
    started.current = true;
    void authCall<{ totpURI: string }>('/two-factor/enable', {}).then((r) => {
      if (r.ok && r.data?.totpURI) setUri(r.data.totpURI);
      else setFailed(true);
    });
  }, []);

  const turnOn = once(async () => {
    if (code.length < 6) { setErr('Type the six digits your app shows. They change every 30 seconds.'); return; }
    setBusy(true);
    const r = await authCall('/two-factor/verify-totp', { code });
    setBusy(false);
    if (r.ok) { onDone(); return; }
    setErr('This code does not match. Type the six digits your app shows now. They change every 30 seconds.');
    setReset((x) => x + 1);
  });

  return (
    <>
      {before}
      <div>
        <h1>Set up two-factor sign-in</h1>
        <p className="lead">Every data room on this site asks for a code from an authenticator app when you sign in on a new browser, on top of the email. Setting it up takes a minute, once.</p>
      </div>
      {failed ? (
        <p className="hint err">The set-up could not start. Reload the page to try again.</p>
      ) : (
        <>
          <div className="tfa">
            {uri ? <QrCode value={uri} /> : <div className="qr" aria-hidden="true" />}
            <ol className="ol">
              <li>Open an authenticator app on your phone, such as Microsoft Authenticator, Google Authenticator or 1Password.</li>
              <li>Add an account and scan this code.</li>
              <li>Type the six digits the app shows.</li>
            </ol>
          </div>
          <p className="hint">Cannot scan? Add the account by hand with this key: <span className="key" data-testid="manual-key">{uri ? manualKey(uri) : ''}</span></p>
          <div className="fld">
            <span aria-hidden="true">Code from the app</span>
            <CodeBoxes label="Code from the app" onChange={(v) => { setCode(v); if (v) setErr(''); }} onEnter={turnOn} bad={!!err} reset={reset} errorId={err ? 'f-err' : undefined} />
          </div>
          {err ? <p className="hint err" id="f-err" style={{ marginTop: -10 }}>{err}</p> : null}
          <button type="button" className="btn primary block" onClick={turnOn} disabled={busy || !uri}>Turn on two-factor sign-in</button>
        </>
      )}
    </>
  );
}
