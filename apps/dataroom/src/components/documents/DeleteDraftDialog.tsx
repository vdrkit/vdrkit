// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState } from 'react';
import { browserApi } from '@/api/browser';
import { useSendOnce } from '@/lib/send-once';
import { Dialog } from './Dialog';
import { displayName } from './format';
import type { Item } from './types';

export function deleteTarget(d: Item): { versionId: string; whole: boolean; label: string; hint: string } | null {
  const v = d.version;
  if (!v) return null;
  if (d.state === 'draft') {
    return { versionId: v.id, whole: true, label: 'Delete draft', hint: 'Deletes it and its file. It was never published.' };
  }
  if (d.state === 'published' && d.releasedVersion && d.releasedVersion.id !== v.id) {
    return { versionId: v.id, whole: false, label: `Delete version ${v.number}`, hint: 'Deletes the new version. Bidders keep the version they have.' };
  }
  return null;
}

export function DeleteDraftDialog({ ws, doc, onClose }: {
  ws: string;
  doc: Item;
  onClose: (notice: { title: string; line: string } | null) => void;
}) {
  const t = deleteTarget(doc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const once = useSendOnce();
  const label = [doc.indexNumber, displayName(doc.name)].filter(Boolean).join(' ');
  if (!t) return null;
  const versionNo = doc.version!.number;
  const title = t.whole ? `Delete ${label}?` : `Delete version ${versionNo} of ${label}?`;

  const remove = once(async () => {
    setBusy(true);
    setError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/versions/{id}/remove-draft', { params: { path: { ws, id: t!.versionId } }, body: {} });
    setBusy(false);
    if (!r.data) {
      setError((r.error as { detail?: string } | undefined)?.detail ?? 'The draft could not be deleted. Try again.');
      return;
    }
    onClose(r.data.removed === 'document'
      ? { title: `${label} is deleted`, line: 'Its file is gone. The upload and the deletion stay in Activity.' }
      : { title: `Version ${versionNo} of ${label} is deleted`, line: 'Bidders keep the version they have. The deletion stays in Activity.' });
  });

  return (
    <Dialog over={t.whole ? 'Delete draft' : 'Delete new version'} title={title} narrow busy={busy} onClose={() => onClose(null)}
      foot={(
        <>
          <button type="button" className="btn ghost" onClick={() => onClose(null)} disabled={busy} data-autofocus>Cancel</button>
          <button type="button" className="btn danger" onClick={() => void remove()} aria-disabled={busy ? true : undefined}>
            {busy ? 'Deleting…' : t.whole ? 'Delete draft' : `Delete version ${versionNo}`}
          </button>
        </>
      )}>
      <div className="dw-sec">
        <ul className="facts">
          {t.whole
            ? <li>It was never published, so nobody outside the seller team has seen it.</li>
            : <li>Bidders keep seeing the version they have. Only the new version goes.</li>}
          <li>The file is deleted and cannot be brought back.</li>
          <li>The upload and the deletion stay in the activity log.</li>
        </ul>
      </div>
      {error ? <div className="ask" role="alert"><p>{error}</p></div> : null}
    </Dialog>
  );
}
