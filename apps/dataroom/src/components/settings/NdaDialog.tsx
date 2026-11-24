// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import type { Problem } from '@/api/client';
import type { NdaOverview } from './model';
import { useModal } from '@/lib/a11y';
import { useSendOnce } from '@/lib/send-once';

// correction mode keeps people who accepted the current version
export function NdaDialog({ ws, nda, onClose, onPublished }: {
  ws: string;
  nda: NdaOverview;
  onClose: () => void;
  onPublished: (versionNo: number, mode: 'everyone' | 'correction', requiresNda: boolean) => void;
}) {
  const cur = nda.current;
  const next = (cur?.versionNo ?? 0) + 1;
  const [mode, setMode] = useState<'everyone' | 'correction'>('everyone');
  const [name, setName] = useState(cur?.name ?? nda.name ?? '');
  const [text, setText] = useState(cur?.body ?? '');
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useModal(box, { focusFirst: false });
  const stillToAccept = Math.max(0, nda.people.total - nda.people.accepted);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input, textarea')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close.current(); } };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); before?.focus?.(); };
  }, []);

  let intro = 'Bidders accept it at their first sign-in, before they see any document.';
  if (cur) intro = `Version ${cur.versionNo} stays on record with everyone who accepted it.`;
  else if (!nda.required) intro += ' Publishing it turns on Ask for the NDA.';

  const unchanged = !!cur && text.trim() === cur.body.trim();
  const tooShort = text.trim().length < 20;

  const publish = once(async () => {
    if (tooShort) { setError('The agreement needs at least 20 characters of text.'); return; }
    if (unchanged) { setError(`The text is the same as version ${cur!.versionNo}. Change it before publishing a new version.`); return; }
    setBusy(true);
    setError(null);
    const body: { body: string; mode: typeof mode; name?: string } = { body: text, mode: cur ? mode : 'everyone' };
    if (name.trim()) body.name = name.trim();
    const { data, error: failed } = await browserApi().PUT('/v1/workspaces/{ws}/nda', { params: { path: { ws } }, body });
    setBusy(false);
    if (!data) {
      const p = failed as unknown as Problem | undefined;
      setError(p?.detail ?? p?.title ?? 'The NDA could not be published. Try again.');
      return;
    }
    onPublished(data.versionNo, data.mode, data.requiresNda);
  });

  return (
    <div className="f3-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={box} className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
        <div className="dlg-h">
          <h2 id="dlg-t">Publish NDA version {next}</h2>
          <p className="cap" style={{ margin: '4px 0 0' }}>{intro}</p>
        </div>
        <div className="dlg-b">
          <label className="fld"><span>Name</span>
            <input className="tin" value={name} maxLength={120} placeholder="For example: Heron NDA 2026-11" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="fld"><span>Text of the agreement</span>
            <textarea className="tarea" value={text} onChange={(e) => { setText(e.target.value); setError(null); }} />
            <p className="hint">Paste the full text. People read it on screen before they accept, and can open it as a PDF.</p>
          </label>
          {cur ? (
            <div className="opts" role="radiogroup" aria-label={`Who accepts version ${next}`}>
              <button type="button" className="sopt" role="radio" aria-checked={mode === 'everyone'} onClick={() => setMode('everyone')}>
                <i className="rd" /><div><b>Everyone accepts version {next}</b><span>At their next sign-in, before they see any document. Use this when the terms changed.</span></div>
              </button>
              <button type="button" className="sopt" role="radio" aria-checked={mode === 'correction'} onClick={() => setMode('correction')}>
                <i className="rd" /><div><b>Only people who have not accepted yet</b><span>
                  {stillToAccept === 0 ? `Everyone has accepted, so only people invited from now on get version ${next}.`
                    : `${stillToAccept === 1 ? 'The 1 person still to accept' : `The ${stillToAccept} people still to accept`}, and everyone invited from now on, get version ${next}.`} People who accepted version {cur.versionNo} keep their access. Use this for a correction.</span></div>
              </button>
            </div>
          ) : null}
          {error ? <div className="note err" role="alert" style={{ margin: 0 }}><div>{error}</div></div> : null}
        </div>
        <div className="dlg-f">
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={publish} disabled={busy}>{busy ? 'Publishing…' : `Publish version ${next}`}</button>
        </div>
      </div>
    </div>
  );
}
