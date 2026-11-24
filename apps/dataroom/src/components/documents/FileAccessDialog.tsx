// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState } from 'react';
import { browserApi } from '@/api/browser';
import { useSendOnce } from '@/lib/send-once';
import { Dialog } from './Dialog';
import { displayName, LEVELS, levelLabel } from './format';
import type { GroupAccess, Item } from './types';

// subgroups still capped at the parent's level
export function FileAccessDialog({ ws, doc, folderLabel, groups, own, onClose }: {
  ws: string;
  doc: Item;
  folderLabel: string;
  groups: GroupAccess[];
  own: Record<string, number>;
  onClose: (changed: boolean) => void;
}) {
  const [draft, setDraft] = useState<Record<string, number>>({ ...own });
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const rows = groups.filter((g) => g.level > 0 || own[g.id] !== undefined);
  const n = Object.keys(draft).length;

  const save = once(async () => {
    type Change = { nodeId: string; groupId: string; reset?: boolean; level?: 0 | 20 | 30 | 40 | 50 | 60 };
    const changes = rows.flatMap((g): Change[] => {
      const before = own[g.id];
      const after = draft[g.id];
      if (before === after) return [];
      if (after === undefined) return [{ nodeId: doc.id, groupId: g.id, reset: true }];
      return [{ nodeId: doc.id, groupId: g.id, level: after as 0 | 20 | 30 | 40 | 50 | 60 }];
    });
    if (!changes.length) { onClose(false); return; }
    setBusy(true);
    const r = await browserApi().PUT('/v1/workspaces/{ws}/grants', { params: { path: { ws } }, body: { changes } });
    if (r.response.ok) { onClose(true); return; }
    setError((r.error as { detail?: string } | undefined)?.detail ?? 'The access could not be saved.');
    setBusy(false);
  });

  return (
    <Dialog
      narrow
      over="Access for one file"
      title="Set access for this file"
      onClose={() => onClose(false)}
      busy={busy}
      foot={(
        <>
          <button type="button" className="btn ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {n ? `Save, ${n} ${n === 1 ? 'group' : 'groups'} with own level` : 'Save, follows the folder'}
          </button>
        </>
      )}
    >
      <div className="dw-sec">
        <h3>{doc.indexNumber} {displayName(doc.name)}</h3>
        <p className="cap" style={{ margin: 0 }}>
          This file follows {folderLabel} unless you set a level for a group here. A level set here applies to this file only, for example to let one group download an Excel file in its original form while the rest of the folder stays view only.
        </p>
      </div>
      <div className="dw-sec">
        <h3>Level per group</h3>
        {rows.length ? rows.map((g) => {
          const cur = draft[g.id];
          return (
            <div className="fa" key={g.id}>
              <span>
                <span className="g"><i style={{ background: g.color }} />{g.name}</span>
                <small>Folder gives: {g.level > 0 ? levelLabel(g.level) : 'No access'}{g.parentName ? `. Subgroup of ${g.parentName}. Never more than ${g.parentName} has for this file.` : ''}</small>
              </span>
              <select
                className={cur !== undefined ? 'own' : ''}
                aria-label={`Level for ${g.name}`}
                value={cur === undefined ? '' : String(cur)}
                onChange={(e) => setDraft((d) => {
                  const x = { ...d };
                  if (e.target.value === '') delete x[g.id];
                  else x[g.id] = Number(e.target.value);
                  return x;
                })}
              >
                <option value="">Same as the folder</option>
                {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                <option value="0">Blocked for this file</option>
              </select>
            </div>
          );
        }) : <p className="cap" style={{ margin: 0 }}>No bidder group has access to {folderLabel}. Set the folder&apos;s access in Permissions first.</p>}
      </div>
      <ul className="facts">
        <li>Permissions shows this file as +1 file in the {folderLabel.split(' ')[0]} row, so the exception stays visible.</li>
        <li>Logged in Activity, with the old and new level.</li>
      </ul>
      {error ? <div className="ask" role="alert"><p>{error}</p></div> : null}
    </Dialog>
  );
}
