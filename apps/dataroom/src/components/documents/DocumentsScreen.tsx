// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { browserApi } from '@/api/browser';
import { useIndexEdit } from '@/components/room/index-edit';
import { detailsHref, roomHref, viewHref } from '@/components/room/routes';
import type { IndexEdit } from '@/components/shell/DocumentIndex';
import { noticeText } from '@/lib/notice';
import { formatDay } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import { AddFilesDialog, type UploaderRole } from './AddFilesDialog';
import { FileAccessDialog } from './FileAccessDialog';
import { FloatMenu, type MenuItem } from './FloatMenu';
import { useSeeAs } from '@/components/room/SeeAs';
import { useToast } from '@/components/outside/Toast';
import { DeleteDraftDialog, deleteTarget } from './DeleteDraftDialog';
import { displayName, join, lastSeg, levelLabel, nextFolderNumber, plural, publishersLine, typeTag } from './format';
import { NewFolderDialog, type Place } from './NewFolderDialog';
import { NewVersionDialog } from './NewVersionDialog';
import { VisibilityLine, visibleGroups } from './parts';
import { canReleaseQuietly, QUIET_HINT, QUIET_LABEL, releaseBlocked, releaseHint, releaseLabel } from './release-one';
import type { DocumentsData, IndexEntry, Item } from './types';
import { hasFiles, pickedFromDrop, pickedFromInput, type Picked } from './upload';
import { useReleaseOne } from './useReleaseOne';

const Grip = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 3h.01M8 3h.01M4 6h.01M8 6h.01M4 9h.01M8 9h.01" /></svg>;
const Lock = () => <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="5.5" width="7" height="5" rx="1" /><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" /></svg>;
const ChevR = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5L7.5 6L4 9.5" /></svg>;
const More = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18.5" cy="12" r="1" /></svg>;
const Pen = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>;
const Up = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" /></svg>;
const FolderPlus = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5" /></svg>;
const Mail = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5L12 13l8.5-6.5" /></svg>;

const Renumbered = ({ from }: { from: string }) => <span className="badge b-info" title={`Was ${from}`} data-renumbered-from={from}>Renumbered</span>;

const prefixOf = (ix: string) => (ix.includes('.') ? ix.slice(0, ix.lastIndexOf('.')) : '');
const labelOf = (x: { indexNumber: string | null; name: string }) => (x.indexNumber ? `${x.indexNumber} ${x.name}` : x.name);
const docLabel = (d: Item) => labelOf({ indexNumber: d.indexNumber, name: displayName(d.name) });
const detailOf = (problem: unknown, fallback: string) => (problem as { detail?: string } | undefined)?.detail ?? fallback;

type Origin = { indexNumber: string | null; parentId: string | null; name: string };
type Destination = { parentId: string | null; number: number } | { parentId: string | null; beforeId: string };

type Dialogs =
  | { kind: 'add'; initial: Picked[] | null; root?: boolean }
  | { kind: 'delete'; doc: Item }
  | { kind: 'version'; doc: Item; picked: Picked }
  | { kind: 'access'; doc: Item }
  | { kind: 'newfolder'; topOnly?: boolean };

type Move = { name?: string; parentId?: string | null; position?: number; beforeId?: string; number?: number };

interface Pending {
  id: string; body: Move; title: string; items: { id: string; from: string | null; to: string }[]; undo: Undo;
  tagDays: number;
}
// undo via index/restore: folder numbers can have gaps
interface Undo { id: string; body: Move; from?: { parentId: string | null; moved: boolean }; changes?: { id: string; from: string | null; to: string }[] }

export function DocumentsScreen({ data }: { data: DocumentsData }) {
  const router = useRouter();
  const { ws, folder, items, index, me } = data;
  const admin = me.isAdmin;
  const seller = me.viewer !== 'buyer';
  const subfolders = items.filter((i) => i.kind === 'folder');
  const docs = items.filter((i) => i.kind === 'document');
  // time-boxed: demo rows stay Processing forever
  const fresh = docs.some((d) => previewOf(d) === 'processing' && !!d.version && Date.now() - Date.parse(d.version.uploadedAt) < 15 * 60_000);
  useEffect(() => {
    if (!fresh) return;
    const t = window.setTimeout(() => router.refresh(), 3_000);
    return () => window.clearTimeout(t);
  }, [fresh, items, router]);
  const entry = folder ? index.find((f) => f.id === folder.id) : undefined;
  const folderLabel = folder ? labelOf(folder) : data.roomName;
  const readOnly = !!useSeeAs();
  const mayUpload = folder ? folder.allowed.includes('upload') : admin;
  const canUpload = mayUpload && !readOnly;
  const canPublish = !!folder?.allowed.includes('publish');
  const role: UploaderRole = admin ? 'admin' : canPublish ? 'publisher' : 'contributor';
  const tz = me.timeZone;

  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [renumbered, setRenumbered] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyIndex, setBusyIndex] = useState(false);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const indexing = useSendOnce();
  const [fileOver, setFileOver] = useState(false);
  const [hotRow, setHotRow] = useState<string | null>(null);
  const [ixEdit, setIxEdit] = useState<string | null>(null);
  const [dragDoc, setDragDoc] = useState<string | null>(null);
  const [dropAbove, setDropAbove] = useState<string | null>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const versionFor = useRef<Item | null>(null);
  const toast = useToast();
  const releaser = useReleaseOne(ws, data.release, toast.show, setError);

  let mode: 'overview' | 'folder' | 'empty-room' | 'empty-folder';
  if (folder && docs.length) mode = 'folder';
  else if (subfolders.length) mode = 'overview';
  else mode = folder ? 'empty-folder' : 'empty-room';
  const dropTarget = canUpload && (mode === 'folder' || mode === 'empty-folder' || mode === 'empty-room');

  const byId = useMemo(() => new Map(index.map((f) => [f.id, f])), [index]);
  const byIx = useMemo(() => new Map(index.map((f) => [f.indexNumber ?? f.name, f])), [index]);
  const parent = folder?.parentId ? byId.get(folder.parentId) : undefined;
  const nameOf = (id: string) => {
    const f = byId.get(id);
    if (f) return `${f.name}, ${plural(f.documents, 'document', 'documents')}`;
    const d = docs.find((x) => x.id === id);
    return d ? displayName(d.name) : null;
  };

  async function patch(id: string, body: Move, title: string, inverse: Undo, confirmed = false): Promise<void> {
    setBusy(true);
    setError(null);
    const r = await browserApi().PATCH('/v1/workspaces/{ws}/nodes/{id}', { params: { path: { ws, id } }, body: { ...body, confirmRenumberPublished: confirmed } });
    setBusy(false);
    if (r.response.status === 409) {
      const p = r.error as { items?: Pending['items']; tagDays?: number } | undefined;
      setPending({ id, body, title, items: p?.items ?? [], undo: inverse, tagDays: p?.tagDays ?? 3 });
      return;
    }
    if (!r.response.ok) {
      setError(detailOf(r.error, 'The change could not be saved.'));
      return;
    }
    setPending(null);
    const changed = r.data?.renumbered ?? [];
    setUndo((u) => [...u, inverse.from ? { ...inverse, changes: changed } : inverse]);
    const moved = changed.filter((c) => byId.has(c.id) || docs.some((d) => d.id === c.id));
    if (confirmed && moved.length) {
      const names = moved.slice(0, 3).map((c) => {
        const name = byId.get(c.id)?.name ?? displayName(docs.find((d) => d.id === c.id)?.name ?? '');
        return `${c.to} ${name}`;
      });
      let line = names.join(moved.length === 2 ? ' and ' : ', ');
      if (moved.length > 3) line += ` and ${moved.length - 3} more`;
      setRenumbered(`${line}.`);
    }
    router.refresh();
  }

  function placeFor(typed: string, own: { parentId: string | null }): { parentId: string | null; number: number } | string {
    if (!/^\d+(\.\d+)*$/.test(typed)) return `${typed} is not an index number. Use numbers and dots, such as 2.4.5.`;
    const prefix = prefixOf(typed);
    const parentEntry = prefix ? byIx.get(prefix) : null;
    if (prefix && !parentEntry) return `There is no folder ${prefix} to put it in.`;
    const n = lastSeg(typed);
    if (n < 1) return 'Numbers start at 1.';
    if (n > 999_999) return 'Use a number below 1,000,000.';
    return { parentId: parentEntry ? parentEntry.id : null, number: n };
  }

  function moveItem(id: string, from: Origin, to: Destination, title: string, rename?: string) {
    const body: Move = 'number' in to ? { number: to.number } : { beforeId: to.beforeId };
    if (to.parentId !== from.parentId) body.parentId = to.parentId;
    if (rename && rename !== from.name) body.name = rename;
    const inverse: Undo = { id, body: body.name ? { name: from.name } : {}, from: { parentId: from.parentId, moved: to.parentId !== from.parentId } };
    void patch(id, body, title, inverse);
  }

  const handlers = useRef({ move: (_a: string, _b: string) => {}, save: (_ix: string, _c: { ix: string; name: string }) => {}, newFolder: () => {} });
  handlers.current = {
    move(srcIx, aboveIx) {
      const src = byIx.get(srcIx);
      const target = byIx.get(aboveIx);
      if (!src || !target) return;
      moveItem(src.id, src, { parentId: target.parentId, beforeId: target.id }, `Move ${labelOf(src)} above ${labelOf(target)}?`);
    },
    save(ix, change) {
      const src = byIx.get(ix);
      if (!src) return;
      if (change.ix === (src.indexNumber ?? '')) {
        void patch(src.id, { name: change.name }, '', { id: src.id, body: { name: src.name } });
        return;
      }
      const place = placeFor(change.ix, src);
      if (typeof place === 'string') { setError(place); return; }
      moveItem(src.id, src, place, `Give ${labelOf(src)} the number ${change.ix}?`, change.name);
    },
    newFolder() { setDialog({ kind: 'newfolder' }); },
  };

  const movingIx = useMemo(() => {
    if (!pending) return [];
    return pending.items.map((c) => byId.get(c.id)?.indexNumber).filter((x): x is string => !!x);
  }, [pending, byId]);
  const movingKey = movingIx.join(',');
  const indexEdit = useMemo<IndexEdit | null>(() => (editing ? {
    moving: movingKey ? movingKey.split(',') : [],
    onMove: (a, b) => handlers.current.move(a, b),
    onSave: (ix, c) => handlers.current.save(ix, c),
    onNewFolder: () => handlers.current.newFolder(),
  } : null), [editing, movingKey]);
  useIndexEdit(indexEdit);

  function leaveEdit() { setEditing(false); setPending(null); setRenumbered(null); setUndo([]); setIxEdit(null); }
  const undoLast = once(async () => {
    const last = undo[undo.length - 1];
    if (!last) return;
    setBusy(true);
    const api = browserApi();
    let ok = true;
    let problem: unknown;
    if (last.from && last.changes) {
      const r = await api.POST('/v1/workspaces/{ws}/index/restore', { params: { path: { ws } }, body: {
        ...(last.from.moved ? { moved: { id: last.id, parentId: last.from.parentId } } : {}),
        items: last.changes.filter((c) => c.from).map((c) => ({ id: c.id, indexNumber: c.from! })),
      } });
      ok = r.response.ok;
      problem = r.error;
    }
    if (ok && (last.body.name || !last.from)) {
      const r = await api.PATCH('/v1/workspaces/{ws}/nodes/{id}', { params: { path: { ws, id: last.id } }, body: { ...last.body, confirmRenumberPublished: true } });
      ok = r.response.ok;
      problem = r.error;
    }
    setBusy(false);
    if (!ok) { setError(detailOf(problem, 'The change could not be undone.')); return; }
    setUndo((u) => u.slice(0, -1));
    setRenumbered(null);
    router.refresh();
  });

  function typedNumber(d: Item, typed: string) {
    setIxEdit(null);
    const t = typed.trim();
    if (!t || t === d.indexNumber) return;
    const place = placeFor(t, d);
    if (typeof place === 'string') { setError(place); return; }
    moveItem(d.id, d, place, `Give ${docLabel(d)} the number ${t}?`);
  }

  const dialogOpen = !!dialog;
  useEffect(() => {
    if (!dropTarget || dialogOpen) return;
    let depth = 0;
    const enter = (e: globalThis.DragEvent) => { if (!hasFiles(e)) return; depth += 1; setFileOver(true); };
    const over = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const row = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.dr[data-doc]');
      setHotRow(row && row.dataset.upload === '1' ? row.dataset.doc ?? null : null);
    };
    const leave = (e: globalThis.DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) { setFileOver(false); setHotRow(null); } };
    const drop = (e: globalThis.DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      const row = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.dr[data-doc]');
      setFileOver(false);
      setHotRow(null);
      void pickedFromDrop(e.dataTransfer).then((picked) => {
        if (!picked.length) return;
        const doc = row?.dataset.upload === '1' ? docs.find((d) => d.id === row.dataset.doc) : undefined;
        if (doc && picked.length === 1 && !picked[0]!.path.includes('/')) setDialog({ kind: 'version', doc, picked: picked[0]! });
        else setDialog({ kind: 'add', initial: picked, root: !folder });
      });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
    // re-runs on refresh via data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropTarget, dialogOpen, data]);

  // stray drops would navigate away from the dialog
  useEffect(() => {
    if (!dialogOpen) return;
    const hold = (e: globalThis.DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    window.addEventListener('dragover', hold);
    window.addEventListener('drop', hold);
    return () => {
      window.removeEventListener('dragover', hold);
      window.removeEventListener('drop', hold);
    };
  }, [dialogOpen]);

  function closeDialog(changed: boolean, notice?: { title: string; line: string }) {
    setDialog(null);
    if (notice) toast.show(notice.title, notice.line);
    if (changed) router.refresh();
  }
  const rules = data.release?.rules;
  const canPublishNow = !readOnly && !!folder && !!rules && (admin || canPublish) && !(rules.fourEyes && !admin)
    && !['frozen', 'closed', 'archived'].includes(rules.state);

  const applyStandardIndex = indexing(async () => {
    setBusyIndex(true);
    setError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/standard-index', { params: { path: { ws } } });
    if (r.data) { router.refresh(); return; }
    setError(detailOf(r.error, 'The standard index could not be created. Try again.'));
    setBusyIndex(false);
  });

  function ownText(doc: Item): string | null {
    const own = data.ownAccess[doc.id];
    const groups = data.groups;
    if (!own || !groups) return null;
    const parts = Object.entries(own).map(([g, l]) => `${groups.find((x) => x.id === g)?.name ?? 'A group'}: ${levelLabel(l)}`);
    return parts.length ? `${parts.join(', ')}. The rest follows the folder.` : null;
  }
  function releaseItems(d: Item): MenuItem[] {
    const t = data.release?.items[d.id];
    if (!t || !data.release || readOnly || releaser.released.has(d.id) || !d.allowed.includes('publish')) return [];
    const no = t.versionId ? data.pending[d.id] ?? d.version?.number ?? null : null;
    const rules = data.release.rules;
    const why = releaseBlocked(rules, t);
    if (why) return [{ label: releaseLabel(t, no), hint: why, disabled: true, onSelect: () => {} }];
    const label = d.indexNumber ?? displayName(d.name);
    const release = (quiet: boolean) => { setError(null); void releaser.release(t, label, no, quiet); };
    const out: MenuItem[] = [{ label: releaseLabel(t, no), hint: releaseHint(rules, t), onSelect: () => release(false) }];
    if (canReleaseQuietly(rules, t)) out.push({ label: QUIET_LABEL, hint: QUIET_HINT, onSelect: () => release(true) });
    return out;
  }
  function docMenu(d: Item): MenuItem[] {
    const out: MenuItem[] = [...releaseItems(d)];
    if (seller) out.push({ label: 'Versions and details', hint: 'Who uploaded it, processing, who can see it', onSelect: () => router.push(detailsHref(ws, d.id)) });
    if (seller && d.allowed.includes('upload')) out.push({ label: 'Upload a new version', onSelect: () => { versionFor.current = d; versionInput.current?.click(); } });
    if (admin && data.groups) out.push({ label: 'Set access for this file', hint: ownText(d) ?? `Follows ${folderLabel}`, onSelect: () => setDialog({ kind: 'access', doc: d }) });
    if (admin && d.state !== 'draft') out.push({ label: 'See who opened it in Activity', separated: true, onSelect: () => router.push(roomHref(ws, 'activity')) });
    const del = deletable(d);
    if (del) out.push({ label: del.label, hint: del.hint, separated: true, onSelect: () => setDialog({ kind: 'delete', doc: d }) });
    return out;
  }
  function deletable(d: Item) {
    const del = deleteTarget(d);
    if (!del || readOnly || releaser.released.has(d.id)) return null;
    const mine = d.uploadedBy?.personId === me.personId && d.allowed.includes('upload');
    return admin || d.allowed.includes('publish') || mine ? del : null;
  }
  const folderMenu: MenuItem[] = [
    { label: 'Bulk import', hint: 'A whole folder structure, numbered from a spreadsheet or the folder names', onSelect: () => router.push(`${roomHref(ws, 'import')}${folder ? `?into=${folder.id}` : ''}`) },
    { label: 'Change access in Permissions', hint: `Who sees ${folderLabel}`, onSelect: () => router.push(roomHref(ws, 'permissions')) },
  ];
  const openMenu = (key: string) => (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const anchor = e.currentTarget;
    setMenu((m) => (m?.key === key ? null : { key, anchor }));
  };
  let menuItems: MenuItem[] = [];
  if (menu?.key === 'folder') {
    menuItems = folderMenu;
  } else if (menu) {
    const d = docs.find((x) => x.id === menu.key);
    if (d) menuItems = docMenu(d);
  }

  let uploadRoot: IndexEntry | undefined;
  for (let at = entry; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
    if (at.canUpload) uploadRoot = at;
  }
  let sub: string | null = null;
  if (!admin && seller && mayUpload && uploadRoot) {
    const where = labelOf(uploadRoot);
    sub = role === 'publisher'
      ? `You can add and publish files in ${where}. Who sees ${where} is set by the room admins.`
      : `You can add files to ${where}. ${publishersLine(data.publishers)} what you add.`;
  }

  const acts = admin ? (
    <div className="acts">
      <button type="button" className={`btn ${editing ? 'on' : 'secondary'} sm`} onClick={() => (editing ? leaveEdit() : setEditing(true))} aria-pressed={editing}>
        <Pen />{editing ? 'Leave edit mode' : 'Edit index'}
      </button>
      <Link className="btn primary sm" href={roomHref(ws, 'release')}>Release review · {(data.releaseCount ?? 0).toLocaleString('en-GB')}</Link>
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={menu?.key === 'folder'} aria-label="More actions for this folder" title="Bulk import, change access" onClick={openMenu('folder')}><More /></button>
    </div>
  ) : data.releaseCount !== null && !readOnly ? (
    <div className="acts"><Link className="btn primary sm" href={roomHref(ws, 'release')}>Release review · {data.releaseCount.toLocaleString('en-GB')}</Link></div>
  ) : <div className="acts" />;  // header gap on phones

  const over = parent ? labelOf(parent) : 'Documents';
  const folderHead = folder ? (
    <div className="head">
      <div>
        <p className="over">{over}</p>
        <h1>{folder.indexNumber ? <span className="ix">{folder.indexNumber}</span> : null}{folder.name}{entry?.renumberedFrom ? <> <Renumbered from={entry.renumberedFrom} /></> : null}</h1>
        {data.groups ? <VisibilityLine groups={data.groups} /> : null}
        {sub ? <p className="sub" style={{ marginTop: 4 }}>{sub}</p> : null}
      </div>
      {acts}
    </div>
  ) : null;

  const editBar = editing ? (
    <div className="editbar" role="status">
      <div>
        <b>Edit mode</b>
        <span className="cap">Move folders in the index on the left by dragging their handle. Move documents in the list below the same way, or type a new number. Drafts change at once. Changing a published number asks you first.</span>
      </div>
      <div className="btns">
        <button type="button" className="btn ghost sm" onClick={undoLast} disabled={!undo.length || busy}>Undo</button>
        <button type="button" className="btn primary sm" onClick={leaveEdit}>Done</button>
      </div>
    </div>
  ) : null;

  const errorBox = error ? (
    <div className="ask" role="alert"><p>{error}</p><div><button type="button" className="btn ghost sm" onClick={() => setError(null)}>Dismiss this message</button></div></div>
  ) : null;

  const confirm = pending ? (() => {
    // skip items carried inside a moved folder
    const under = (a: string | null, b: string | null) => !!a && !!b && a.startsWith(`${b}.`);
    const direct = pending.items.filter((c) => !pending.items.some((o) => o !== c && under(c.from, o.from)));
    const known = direct.filter((c) => nameOf(c.id));
    const folderItems = pending.items.filter((c) => byId.has(c.id));
    const nDocs = pending.items.length - folderItems.length;
    let lead = 'They are';
    if (direct.length === 1) lead = byId.has(direct[0]!.id) ? 'The folder is' : 'It is';
    else if (direct.every((c) => byId.has(c.id))) lead = direct.length === 2 ? 'Both folders are' : 'The folders are';
    return (
      <div className="confirm" role="alertdialog" aria-labelledby="cf-h">
        <h3 id="cf-h">{pending.title}</h3>
        <div className="swap">
          {known.slice(0, 8).map((c) => (
            <span key={c.id} style={{ display: 'contents' }}>
              <span className="sw-n">{c.from}</span><s>becomes</s><span><b>{c.to}</b> {nameOf(c.id)}</span>
            </span>
          ))}
        </div>
        <p>
          {lead} published, so {nDocs ? plural(nDocs, 'document gets', 'documents get') : plural(folderItems.length, 'folder gets', 'folders get')} a new number{known.length > 8 ? `, ${known.length - 8} more than listed here` : ''}. Bidders see &ldquo;Renumbered&rdquo; beside them for {plural(pending.tagDays, 'day', 'days')}, and the old numbers stay in the activity log. Questions that quote an old number still link to the right document.
        </p>
        <div className="btns">
          <button type="button" className="btn primary sm" disabled={busy} onClick={() => void patch(pending.id, pending.body, pending.title, pending.undo, true)}>
            Renumber {nDocs ? plural(nDocs, 'document', 'documents') : plural(folderItems.length, 'folder', 'folders')}
          </button>
          <button type="button" className="btn secondary sm" disabled={busy} onClick={() => setPending(null)}>Keep the current numbers</button>
        </div>
      </div>
    );
  })() : renumbered && editing ? (
    <div className="pfoot" style={{ borderTop: 0 }}><span className="badge b-info">Renumbered</span><span className="cap">{renumbered} Undo is available until you leave edit mode.</span></div>
  ) : null;

  function status(d: Item) {
    const out = [];
    const by = d.uploadedBy ? <small key="u">Uploaded by {d.uploadedBy.personId === me.personId ? 'you' : d.uploadedBy.name}</small> : null;
    if (releaser.busy === d.id) out.push(<span key="b" className="badge b-info">Releasing…</span>);
    else if (releaser.released.has(d.id)) out.push(<span key="ok" className="badge b-ok">Released</span>);
    else if (previewOf(d) === 'processing') out.push(<span key="p" className="badge b-info">Processing</span>, by);
    else if (previewOf(d) === 'failed' && d.state === 'draft') out.push(<span key="f" className="badge b-danger">Could not be prepared</span>, by);
    else if (d.state === 'draft') out.push(<span key="d" className="badge b-warn">Draft</span>, by);
    else if (data.pending[d.id]) out.push(<span key="r" className="badge b-info">Replacement in draft</span>);
    const own = admin ? ownText(d) : null;
    if (own) out.push(<span key="o" className="badge b-own" title={own}>Custom access</span>);
    if (d.renumberedFrom) out.push(<Renumbered key="rn" from={d.renumberedFrom} />);
    if (previewOf(d) === 'none' || (previewOf(d) === 'failed' && d.state !== 'draft')) {
      out.push(<span key="np" className="badge b-np" title="This file cannot be shown in the browser. It is downloaded as the original.">No preview</span>);
    }
    return out;
  }

  // released version decides while a replacement waits
  function previewOf(d: Item): 'processing' | 'failed' | 'none' | null {
    if (d.releasedVersion) return d.releasedVersion.noPreview ? 'none' : null;
    const v = d.version;
    if (!v) return null;
    if (v.status === 'pending' || v.status === 'processing') return 'processing';
    if (v.status === 'failed') return 'failed';
    return v.noPreview ? 'none' : null;
  }

  function pagesOf(d: Item): number | null {
    return d.releasedVersion ? d.releasedVersion.pageCount : d.version?.pageCount ?? null;
  }

  function ixCell(d: Item) {
    if (!editing) return <span className="ix">{d.indexNumber}</span>;
    if (d.state === 'draft' || ixEdit === d.id) {
      return (
        <input
          // uncontrolled: key on number
          key={`${d.id}:${d.indexNumber ?? ''}`}
          className="ixe"
          defaultValue={d.indexNumber ?? ''}
          autoFocus={ixEdit === d.id}
          aria-label={`Index number for ${displayName(d.name)}`}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = d.indexNumber ?? ''; e.currentTarget.blur(); } }}
          onBlur={(e) => typedNumber(d, e.currentTarget.value)}
        />
      );
    }
    return (
      <button type="button" className="ixl" title="Published. Changing this number asks for confirmation." onClick={() => setIxEdit(d.id)} aria-label={`Change the number of ${docLabel(d)}, published`}>
        <Lock />{d.indexNumber}
      </button>
    );
  }

  function rowDrag(d: Item) {
    if (!editing) return {};
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => { setDragDoc(d.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-vdrkit-doc', d.id); },
      onDragEnd: () => { setDragDoc(null); setDropAbove(null); },
      onDragOver: (e: DragEvent) => { if (dragDoc && dragDoc !== d.id) { e.preventDefault(); setDropAbove(d.id); } },
      onDrop: (e: DragEvent) => {
        if (!dragDoc || dragDoc === d.id) return;
        e.preventDefault();
        const src = docs.find((x) => x.id === dragDoc);
        setDragDoc(null);
        setDropAbove(null);
        if (!src) return;
        moveItem(src.id, src, { parentId: src.parentId, beforeId: d.id }, `Move ${docLabel(src)} above ${docLabel(d)}?`);
      },
    };
  }

  const rowClick = (d: Item) => (e: MouseEvent<HTMLDivElement>) => {
    if (editing || (e.target as HTMLElement).closest('button, a, input, select')) return;
    router.push(viewHref(ws, d.id));
  };

  const table = (
    <div style={{ overflowX: 'auto' }}>
      <div role="table" aria-label={`Documents in ${folder?.name ?? data.roomName}`}>
        <div className="dh" role="row" style={{ borderTop: 0 }}>
          <span aria-hidden="true" /><span role="columnheader">Index</span><span role="columnheader">Name</span><span role="columnheader"><span className="sr-only">Status</span></span><span className="r" role="columnheader">Pages</span><span className="r" role="columnheader">Updated</span><span role="columnheader"><span className="sr-only">Actions</span></span>
        </div>
        {docs.map((d) => {
          const tag = typeTag(d.name);
          const mi = seller && !readOnly ? docMenu(d) : [];
          const up = seller && !readOnly && d.allowed.includes('upload');
          return (
            <div
              key={d.id}
              className={['dr', hotRow === d.id || (dialog?.kind === 'version' && dialog.doc.id === d.id) ? 'target' : '', dropAbove === d.id ? 'drop-above' : '', editing ? '' : 'go'].filter(Boolean).join(' ')}
              role="row"
              data-doc={d.id}
              data-upload={up ? '1' : undefined}
              onClick={rowClick(d)}
              {...rowDrag(d)}
            >
              <span className="h" aria-hidden="true"><Grip /></span>
              <span role="cell">{ixCell(d)}</span>
              <span role="cell" className="nmc">
                <Link className="nm" href={viewHref(ws, d.id)} onClick={(e) => { if (editing) e.preventDefault(); }}>
                  <span className={`ty ${tag.cls}`}>{tag.label}</span><b>{displayName(d.name)}</b>
                </Link>
              </span>
              <span className="st" role="cell">{status(d)}</span>
              <span className="r" role="cell">{pagesOf(d) ?? '–'}</span>
              <span className="r" role="cell">{d.version ? formatDay(d.version.uploadedAt, tz) : '–'}</span>
              <span role="cell">{mi.length ? (
                <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={menu?.key === d.id} aria-label={`Actions for ${docLabel(d)}`}
                  title={`${releaseItems(d).length ? 'Release, new' : 'New'} version${admin ? ', access for this file' : ''}${deletable(d) ? ', delete' : ''}`} onClick={openMenu(d.id)}><More /></button>
              ) : null}</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const dropzone = canUpload && folder ? (
    <div className={`dropzone top${fileOver && !hotRow ? ' hot' : ''}`} data-testid="dropzone">
      <Up />
      <span>Drop files here to add them to {folderLabel}, or onto a document to upload a new version.{admin ? ' For a whole folder structure, use Bulk import in the ⋯ menu above.' : ''}</span>
      <button type="button" className="btn secondary sm" onClick={() => setDialog({ kind: 'add', initial: null })}>Choose files</button>
    </div>
  ) : null;

  const overviewList = (list: IndexEntry[]) => (
    <section className="panel" aria-label="Folders">
      {list.map((f) => (
        <Link key={f.id} className="fo" href={roomHref(ws, 'documents', f.id)}>
          <span className="ix">{f.indexNumber}</span><b>{f.name}</b>
          <span className="r">
            {f.drafts && admin ? <span className="badge b-warn">{plural(f.drafts, 'draft', 'drafts')}</span> : null}
            {f.noBidderAccess && admin ? <span className="badge b-danger">No bidder access</span> : null}
            {f.renumberedFrom ? <Renumbered from={f.renumberedFrom} /> : null}
            {plural(f.documents, 'document', 'documents')}
          </span>
          <ChevR />
        </Link>
      ))}
    </section>
  );
  const childFolders = index.filter((f) => (f.parentId ?? null) === (folder?.id ?? null));

  let body;
  if (mode === 'overview') {
    const n = childFolders.reduce((a, f) => a + f.documents, 0);
    body = (
      <>
        <div className="head">
          <div>
            <p className="over">{folder ? over : data.roomName}</p>
            <h1>{folder?.indexNumber ? <span className="ix">{folder.indexNumber}</span> : null}{folder ? folder.name : 'Documents'}</h1>
            <p className="sub" style={{ marginTop: 4 }}>{plural(n, 'document', 'documents')}{childFolders.length ? ` in ${plural(childFolders.length, 'folder', 'folders')}` : ''}.</p>
          </div>
        </div>
        {overviewList(childFolders)}
      </>
    );
  } else if (mode === 'empty-room') {
    body = admin ? (
      <>
        <div className="head"><div><h1>Documents</h1><p className="sub">No documents yet. The room was created without a folder structure.</p></div></div>
        <section className="panel drop">
          <div className="empty">
            <div className="ei"><FolderPlus /></div>
            <h2>Drop a folder here to start</h2>
            <p>VDRkit keeps your folder structure and numbers the folders and files. Everything arrives as a draft, so bidders see nothing until you publish it.</p>
            <div className="row">
              <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'add', initial: null, root: true })}><Up />Choose a folder</button>
              <button type="button" className="btn secondary" onClick={() => setDialog({ kind: 'newfolder', topOnly: true })}>New folder</button>
            </div>
          </div>
        </section>
        {errorBox}
        {readOnly ? null : (
          <p className="sub">Prefer a ready-made structure? Create the folders from the standard M&amp;A index (11 folders, 40 subfolders) in one click.{' '}
            <button type="button" className="btn ghost sm" disabled={busyIndex} onClick={() => void applyStandardIndex()}>{busyIndex ? 'Creating the folders…' : 'Use the standard index'}</button></p>
        )}
      </>
    ) : (
      <>
        <div className="head"><div><h1>Documents</h1></div></div>
        <section className="panel">
          <div className="empty">
            <div className="ei"><Mail /></div>
            {seller ? (
              <>
                <h2>No documents in this room yet</h2>
                <p>The room admins have not added any documents yet. {noticeText(data.notice)}</p>
              </>
            ) : (
              <>
                <h2>No documents shared with {me.group ?? 'you'} yet</h2>
                <p>The seller is still preparing the documents. {noticeText(data.notice)}</p>
              </>
            )}
            {readOnly ? null : <div className="row"><Link className="btn secondary" href={roomHref(ws, 'profile')}>Change how you are told</Link></div>}
          </div>
        </section>
      </>
    );
  } else if (mode === 'empty-folder') {
    const named = data.groups ? visibleGroups(data.groups).map((g) => g.name) : [];
    const emptyHead = admin && folder && named.length ? (
      <div className="head">
        <div>
          <p className="over"><span className="crumb2">{parent ? <>{labelOf(parent)} › </> : null}<b>{folderLabel}</b></span></p>
          <h1>{folder.indexNumber ? <span className="ix">{folder.indexNumber}</span> : null}{folder.name}</h1>
          <p className="sub">Visible to {named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : named[0]} once documents are published.</p>
        </div>
        <div className="acts">
          <button type="button" className="btn secondary sm" onClick={() => setDialog({ kind: 'newfolder', topOnly: false })}>New subfolder</button>
          <button type="button" className="btn primary sm" onClick={() => setDialog({ kind: 'add', initial: null })}><Up />Upload files</button>
        </div>
      </div>
    ) : folderHead;
    body = (
      <>
        {emptyHead}
        {editBar}
        {errorBox}
        <section className={`panel${canUpload ? ' drop' : ''}${fileOver ? ' hot' : ''}`}>
          {confirm}
          <div className="empty">
            <div className="ei"><Up /></div>
            <h2>This folder is empty</h2>
            {canUpload ? (
              <>
                <p>Drop files here. They are numbered {join(folder!.indexNumber, 1)}, {join(folder!.indexNumber, 2)} and so on, and arrive as drafts for Release review.</p>
                <div className="row"><button type="button" className="btn primary" onClick={() => setDialog({ kind: 'add', initial: null })}><Up />Upload files</button></div>
              </>
            ) : <p>Nothing in this folder has been shared with you yet.</p>}
          </div>
        </section>
      </>
    );
  } else {
    body = (
      <>
        {folderHead}
        {editBar}
        {errorBox}
        {subfolders.length ? overviewList(childFolders) : null}
        <section className="panel" aria-label="Folder contents">
          {dropzone}
          {confirm ? <div style={{ paddingTop: 14 }}>{confirm}</div> : null}
          {table}
        </section>
      </>
    );
  }

  const tops = index.filter((f) => !f.parentId);
  const topNote = tops.length
    ? `Next to ${labelOf(tops[0]!)} to ${labelOf(tops[tops.length - 1]!)}. Bidders get no access until you set it in Permissions, and it is labelled No bidder access until then.`
    : 'Bidders get no access until you set it in Permissions, and it is labelled No bidder access until then.';
  const places: Place[] = [{ key: 'top', parentId: null, title: 'Top level', becomes: join(null, nextFolderNumber(tops)), note: topNote }];
  if (dialog?.kind === 'newfolder' && !dialog.topOnly && folder) {
    if (parent && data.nextInParent) {
      places.push({ key: 'parent', parentId: parent.id, title: `Inside ${labelOf(parent)}`, becomes: data.nextInParent, note: `Next to ${folderLabel}. It starts with the same access as ${labelOf(parent)}.` });
    }
    places.push({
      key: 'sel', parentId: folder.id, title: `Inside ${folderLabel}`, becomes: join(folder.indexNumber, nextFolderNumber(items)),
      note: `${docs.length ? `After the ${plural(docs.length, 'document', 'documents')} in this folder. ` : ''}It starts with the same access as ${folderLabel}.`,
    });
  }
  let ownTop = entry;
  while (ownTop?.parentId) ownTop = byId.get(ownTop.parentId);
  const others = tops.filter((t) => t.id !== ownTop?.id);
  const exampleFolder = others.find((t) => t.noBidderAccess) ?? others[others.length - 1];
  const example = exampleFolder ? labelOf(exampleFolder) : null;

  return (
    <div className={editing ? 'edit' : undefined} style={{ display: 'contents' }}>
      {body}
      <input
        ref={versionInput}
        type="file"
        hidden
        data-testid="version-input"
        onChange={(e) => {
          const p = pickedFromInput(e.target.files)[0];
          const d = versionFor.current;
          e.target.value = '';
          if (p && d) setDialog({ kind: 'version', doc: d, picked: p });
        }}
      />
      {toast.node}
      {menu && menuItems.length ? <FloatMenu anchor={menu.anchor} items={menuItems} onClose={() => setMenu(null)} label={menu.key === 'folder' ? 'Folder actions' : 'Document actions'} /> : null}
      {dialog?.kind === 'add' ? (
        <AddFilesDialog
          ws={ws}
          target={dialog.root || !folder ? { id: null, ix: null, name: data.roomName } : { id: folder.id, ix: folder.indexNumber, name: folder.name }}
          items={dialog.root || !folder ? [] : items}
          initial={dialog.initial}
          role={role}
          groups={dialog.root ? null : data.groups}
          publishers={data.publishers}
          fourEyes={!!data.release?.rules.fourEyes}
          canPublishNow={canPublishNow && !dialog.root}
          chooseFolder={dialog.root}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === 'version' ? (
        <NewVersionDialog ws={ws} doc={dialog.doc} picked={dialog.picked} timeZone={tz} me={me.personId} isAdmin={admin} canPublish={admin || dialog.doc.allowed.includes('publish')} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteDraftDialog ws={ws} doc={dialog.doc}
          onClose={(notice) => { closeDialog(!!notice, notice ?? undefined); }} />
      ) : null}
      {dialog?.kind === 'access' && data.groups ? (
        <FileAccessDialog ws={ws} doc={dialog.doc} folderLabel={folderLabel} groups={data.groups} own={data.ownAccess[dialog.doc.id] ?? {}} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === 'newfolder' ? (
        <NewFolderDialog
          ws={ws}
          places={places}
          openLabel={dialog.topOnly ? null : folder ? folderLabel : null}
          example={example}
          onClose={(created) => { setDialog(null); if (created) router.refresh(); }}
        />
      ) : null}
    </div>
  );
}
