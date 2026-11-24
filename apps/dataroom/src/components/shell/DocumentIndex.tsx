// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Icon, Mark } from './icons';
import type { IndexFolder } from './types';

export type IndexViewer = 'admin' | 'seller' | 'buyer';

export interface IndexEdit {
  moving?: string[];
  onMove: (ix: string, aboveIx: string) => void;
  onSave: (ix: string, change: { ix: string; name: string }) => void;
  onNewFolder: () => void;
}

export function DocumentIndex({
  folders,
  viewer,
  currentIx,
  onSelect,
  edit,
}: {
  folders: IndexFolder[];
  viewer: IndexViewer;
  currentIx?: string;
  onSelect?: (ix: string) => void;
  edit?: IndexEdit;
}) {
  const [current, setCurrent] = useState(currentIx);
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(folders.filter((f) => f.children).map((f) => [f.ix, !!f.open])),
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);
  const admin = viewer === 'admin';
  const seller = viewer === 'seller';

  // The open folder can change without a click here (Back), and the index stays mounted
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  useEffect(() => {
    setCurrent(currentIx);
    const parent = foldersRef.current.find((f) => f.children?.some((k) => k.ix === currentIx));
    if (parent) setOpen((o) => (o[parent.ix] ? o : { ...o, [parent.ix]: true }));
  }, [currentIx]);

  useEffect(() => { if (!edit) setEditing(null); }, [edit]);

  function click(f: IndexFolder) {
    if (edit) {
      if (f.children) setOpen((o) => ({ ...o, [f.ix]: !o[f.ix] }));
      setEditing(f.ix);
      return;
    }
    if (f.children) setOpen((o) => ({ ...o, [f.ix]: current === f.ix ? !o[f.ix] : true }));
    setCurrent(f.ix);
    onSelect?.(f.ix);
  }

  const drag = (f: IndexFolder) => edit ? {
    draggable: true,
    onDragStart: (e: DragEvent) => { dragged.current = f.ix; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-vdrkit-folder', f.ix); },
    onDragEnd: () => { dragged.current = null; setOver(null); },
    onDragOver: (e: DragEvent) => { if (dragged.current && dragged.current !== f.ix) { e.preventDefault(); setOver(f.ix); } },
    onDragLeave: () => setOver((o) => (o === f.ix ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragged.current;
      dragged.current = null;
      setOver(null);
      if (from && from !== f.ix) edit.onMove(from, f.ix);
    },
  } : {};

  function row(f: IndexFolder, parent: IndexFolder | null, last = false) {
    if (edit && editing === f.ix) return <EditRow key={f.ix} f={f} parent={parent} onCancel={() => setEditing(null)} onSave={(c) => { setEditing(null); edit.onSave(f.ix, c); }} />;
    const on = f.ix === current;
    const up = admin || !!f.canUpload || !!parent?.canUpload;
    const marks = [];
    if (f.noBidderAccess && admin) marks.push(<span key="lock" className="lock" title="No bidder access yet">{Mark.lock}</span>);
    if (seller && up && !parent) marks.push(<span key="up" className="upb" title="You can add files here">{Mark.up}</span>);
    if (f.drafts && (admin || (seller && up))) marks.push(<span key="dc" className="dc" title={`${f.drafts} drafts`}>{f.drafts}</span>);
    if (edit) marks.push(<span key="grip" className="grip" title={`Drag to move ${f.ix} ${f.name}`} aria-hidden="true">{Mark.grip}</span>);
    let cls = 'sf';
    if (parent) cls += last ? ' l1 last' : ' l1';
    if (on) cls += ' on';
    if (edit?.moving?.includes(f.ix)) cls += ' moving';
    if (seller && !up) cls += ' no-up';
    if (over === f.ix) cls += ' drop-above';
    let chev = null;
    if (!parent) chev = f.children ? <span className="chev">{open[f.ix] ? Mark.chevD : Mark.chevR}</span> : <span />;
    return (
      <button
        key={f.ix}
        type="button"
        className={cls}
        aria-expanded={f.children ? !!open[f.ix] : undefined}
        aria-current={on ? 'true' : undefined}
        title={`${f.ix} ${f.name} · ${f.documents.toLocaleString('en-GB')} documents`}
        onClick={() => click(f)}
        {...drag(f)}
      >
        {chev}
        <span className="ix">{f.ix}</span>
        <span className="nm">{f.name}</span>
        <span className="mk">{marks}</span>
      </button>
    );
  }

  const rows = [];
  let separated = false;
  for (const f of folders) {
    if (f.noBidderAccess && !admin) continue;
    if (f.noBidderAccess && !separated) {
      rows.push(<div key="sep" className="tsep" />);
      separated = true;
    }
    rows.push(row(f, null));
    const kids = f.children;
    if (kids && open[f.ix]) kids.forEach((k, i) => rows.push(row(k, f, i === kids.length - 1)));
  }

  if (!edit) return <div className="stree" role="group" aria-label="Folder index">{rows}</div>;
  return (
    <div className="stree editing" role="group" aria-label="Folder index, edit mode">
      <div className="tnote">Drag a folder by its handle to move it. Click a folder to rename it or type a new number. A folder can take any free number, such as 100.</div>
      {rows}
      <div className="newrow">
        <button type="button" className="btn secondary sm" onClick={edit.onNewFolder}><Icon name="plus" />New folder</button>
      </div>
    </div>
  );
}

function EditRow({ f, parent, onSave, onCancel }: { f: IndexFolder; parent: IndexFolder | null; onSave: (c: { ix: string; name: string }) => void; onCancel: () => void }) {
  const [ix, setIx] = useState(f.ix);
  const [name, setName] = useState(f.name);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);
  const changed = (ix.trim() !== f.ix || name.trim() !== f.name) && !!ix.trim() && !!name.trim();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (changed) onSave({ ix: ix.trim(), name: name.trim() }); else onCancel();
  }
  return (
    <form className={`sf-edit${parent ? ' l1' : ''}`} onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <input className="ixe" value={ix} onChange={(e) => setIx(e.target.value)} aria-label={`Index number for ${f.name}`} />
      <input className="nme" ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} aria-label={`Name of ${f.ix}`} />
      <span className="sf-edit-b">
        <button type="submit" className="btn primary sm" disabled={!changed}>Save {f.ix}</button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}
