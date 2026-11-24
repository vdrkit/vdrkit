// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState } from 'react';
import { browserApi } from '@/api/browser';
import { useSendOnce } from '@/lib/send-once';
import { Dialog } from './Dialog';

export interface Place {
  key: 'top' | 'parent' | 'sel';
  parentId: string | null;
  title: string;
  becomes: string;
  note: string;
}

export function NewFolderDialog({ ws, places, openLabel, example, onClose }: {
  ws: string;
  places: Place[];
  openLabel: string | null;
  example: string | null;
  onClose: (created: { id: string } | null) => void;
}) {
  const [name, setName] = useState('');
  const [where, setWhere] = useState<Place['key']>(places.find((p) => p.key === 'sel')?.key ?? places[0]!.key);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const pick = places.find((p) => p.key === where) ?? places[0]!;

  const create = once(async () => {
    // Enter lands here too; no second folder
    if (busy || !name.trim()) return;
    setBusy(true);
    const r = await browserApi().POST('/v1/workspaces/{ws}/folders', { params: { path: { ws } }, body: { parentId: pick.parentId, name: name.trim() } });
    if (r.data) { onClose({ id: r.data.id }); return; }
    setError((r.error as { detail?: string } | undefined)?.detail ?? 'The folder could not be created.');
    setBusy(false);
  });

  return (
    <Dialog
      narrow
      over="Edit index"
      title="New folder"
      onClose={() => onClose(null)}
      busy={busy}
      foot={(
        <>
          <button type="button" className="btn ghost" onClick={() => onClose(null)} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={create} disabled={busy || !name.trim()}>Create folder {pick.becomes}</button>
        </>
      )}
    >
      <div className="dw-sec">
        <h3><label htmlFor="nf-name">Name</label></h3>
        <input className="tin" id="nf-name" placeholder="For example: Customer contracts" value={name} autoComplete="off" data-autofocus
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
      </div>
      <div className="dw-sec">
        <h3>Where should it go?</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {places.map((p) => (
            <label key={p.key} className="opt">
              <input type="radio" name="nfloc" value={p.key} checked={where === p.key} onChange={() => setWhere(p.key)} />
              <div><b>{p.title} <span className="k k-new">becomes {p.becomes}</span></b><span>{p.note}</span></div>
            </label>
          ))}
        </div>
        {openLabel ? (
          <div className="elsewhere">
            <b>Want it somewhere else?</b>
            <span>These places follow the folder that is open now, {openLabel}. To put the new folder inside another folder{example ? `, for example ${example}` : ''}, close this, open that folder in the index on the left, and press New folder again.</span>
          </div>
        ) : null}
      </div>
      {error ? <div className="ask" role="alert"><p>{error}</p></div> : null}
    </Dialog>
  );
}
