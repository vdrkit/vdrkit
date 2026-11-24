// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import type { Problem } from '@/api/client';
import { Dialog } from '@/components/documents/Dialog';
import { CodeBoxes } from '@/components/outside/CodeBoxes';
import { QrCode } from '@/components/signin/QrCode';
import { manualKey } from '@/lib/auth-client';
import { useSendOnce } from '@/lib/send-once';

export function MovePhoneDialog({ onClose, onMoved }: { onClose: () => void; onMoved: (at: string) => void }) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [oldCode, setOldCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [err, setErr] = useState<{ which: 'old' | 'new' | 'both'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [reset, setReset] = useState(0);
  const started = useRef(false);

  const start = once(async () => {
    setFailed(null);
    setUri(null);
    setErr(null);
    const r = await browserApi().POST('/v1/me/two-factor/new-phone');
    if (!r.data) {
      setFailed((r.error as Problem | undefined)?.detail ?? 'The move could not start. Try again in a moment.');
      return;
    }
    setUri(r.data.totpURI);
    setReset((x) => x + 1);
  });

  useEffect(() => {
    // once only: a second start issues a new secret
    if (started.current) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, []);

  const confirm = once(async () => {
    if (oldCode.length < 6 || newCode.length < 6) {
      setErr({ which: oldCode.length < 6 ? 'old' : 'new', text: 'Type the six digits from each phone. They change every 30 seconds.' });
      return;
    }
    setBusy(true);
    const r = await browserApi().POST('/v1/me/two-factor/new-phone/confirm', { body: { oldCode, newCode } });
    setBusy(false);
    if (r.data) { onMoved(r.data.movedAt); return; }
    const text = (r.error as Problem | undefined)?.detail ?? 'The codes were not accepted. Try again.';
    if (r.response.status === 409) { setFailed(text); return; }
    let which: 'old' | 'new' | 'both' = 'both';
    if (/old phone/.test(text)) which = 'old';
    else if (/new phone/.test(text)) which = 'new';
    setErr({ which, text });
    setReset((x) => x + 1);
  });

  return (
    <Dialog
      over="Sign-in"
      title="Move to a new phone"
      onClose={onClose}
      busy={busy}
      foot={failed ? (
        <>
          <button type="button" className="btn secondary" onClick={onClose}>Keep the old phone</button>
          <button type="button" className="btn primary" onClick={() => void start()}>Start again</button>
        </>
      ) : (
        <>
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Keep the old phone</button>
          <button type="button" className="btn primary" onClick={() => void confirm()} disabled={busy || !uri}>Move to the new phone</button>
        </>
      )}
    >
      <div className="a5-phone" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p className="hint" style={{ fontSize: 13.5, lineHeight: '21px', color: 'var(--fg)' }}>Scan a new code with your new phone. Then type the code from the old phone and the new one to confirm.</p>
        {failed ? (
          <p className="hint err" role="alert">{failed}</p>
        ) : (
          <>
            <div className="tfa">
              {uri ? <QrCode value={uri} /> : <div className="qr" aria-hidden="true" />}
              <ol className="ol">
                <li>Open the authenticator app on your new phone.</li>
                <li>Add an account and scan this code.</li>
                <li>Type the six digits each phone shows below.</li>
              </ol>
            </div>
            <p className="hint">Cannot scan? Add the account by hand with this key: <span className="key" data-testid="new-phone-key">{uri ? manualKey(uri) : ''}</span></p>
            <div className="fld">
              <span aria-hidden="true">Code from your old phone</span>
              <CodeBoxes label="Code from your old phone" onChange={(v) => { setOldCode(v); if (v) setErr(null); }} onEnter={() => void confirm()}
                bad={err?.which === 'old' || err?.which === 'both'} reset={reset} autoFocus={false} errorId={err && err.which !== 'new' ? 'mp-err' : undefined} />
            </div>
            <div className="fld">
              <span aria-hidden="true">Code from your new phone</span>
              <CodeBoxes label="Code from your new phone" onChange={(v) => { setNewCode(v); if (v) setErr(null); }} onEnter={() => void confirm()}
                bad={err?.which === 'new' || err?.which === 'both'} reset={reset} autoFocus={false} errorId={err && err.which !== 'old' ? 'mp-err' : undefined} />
            </div>
            {err ? <p className="hint err" id="mp-err" role="alert">{err.text}</p> : null}
            <p className="hint">Until you confirm, your old phone keeps working. Finish within 10 minutes.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
