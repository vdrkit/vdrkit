// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import type { paths, Problem } from '@/api/client';
import { displayName, levelLabel, typeTag } from '@/components/documents/format';
import { roomHref, viewHref } from '@/components/room/routes';
import { formatDay } from '@/lib/time';
import { useModal } from '@/lib/a11y';
import { useSendOnce } from '@/lib/send-once';

export type ReleaseData = paths['/v1/workspaces/{ws}/release-review']['get']['responses'][200]['content']['application/json'];
type Item = ReleaseData['items'][number];
type Folder = ReleaseData['folders'][number];
type Kind = 'all' | 'new' | 'ver' | 'mine';

const PARTY_COLOURS = ['var(--g-a)', 'var(--g-b)', 'var(--g-c)', 'var(--g-s)'];
const fmt = (n: number) => n.toLocaleString('en-GB');
const drafts = (n: number) => `${fmt(n)} ${n === 1 ? 'draft' : 'drafts'}`;
const keyOf = (i: Item) => i.versionId ?? i.id;
const folderLabel = (f: { indexNumber: string | null; name: string }) => (f.indexNumber ? `${f.indexNumber} ${f.name}` : f.name);

const svg = (body: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{body}</svg>;
const ChevR = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5L7.5 6L4 9.5" /></svg>;
const ChevD = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4L6 7.5L9.5 4" /></svg>;
const Eye = () => svg(<><path d="M2.5 12S6 5.5 12 5.5S21.5 12 21.5 12S18 18.5 12 18.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></>);
const Warn = () => svg(<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>);
const Info = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
const Close = () => svg(<path d="M6 6l12 12M18 6L6 18" />);
const Check = () => svg(<path d="M5 12l4 4L19 6" />);

function whyBlocked(i: Item): string {
  if (i.blocked === 'processing') return 'Still being prepared for viewing. Ready in about a minute.';
  if (i.blocked === 'failed' && i.downloadOnly) return 'This file could not be prepared for viewing. You can still publish the original file, for download only.';
  if (i.blocked === 'failed') return 'This file could not be prepared for viewing. Upload a new copy in Documents.';
  if (i.blocked === 'four_eyes') return 'You uploaded this. Under the four-eyes rule someone else publishes it.';
  return '';
}

export function ReleaseReview({ ws, data, timeZone }: { ws: string; data: ReleaseData; timeZone: string }) {
  const router = useRouter();
  const admin = data.me.isAdmin;
  const frozen = data.room.state === 'frozen';
  const closed = data.room.state === 'closed' || data.room.state === 'archived';
  const locked = frozen || closed;

  const colour = useMemo(() => new Map(data.parties.map((p, i) => [p.id, PARTY_COLOURS[i % PARTY_COLOURS.length]!])), [data.parties]);
  const groupById = useMemo(() => new Map(data.groups.map((g) => [g.id, g])), [data.groups]);
  const folderById = useMemo(() => new Map(data.folders.map((f) => [f.id, f])), [data.folders]);
  const rowsOf = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of data.items) {
      const list = m.get(i.folderId);
      if (list) list.push(i);
      else m.set(i.folderId, [i]);
    }
    return m;
  }, [data.items]);
  const groupsOf = (i: Item) => i.groups ?? folderById.get(i.folderId)?.groups ?? [];

  const [kind, setKind] = useState<Kind>('all');
  const [open, setOpen] = useState<Record<string, boolean>>(() => initialOpen(data.folders, rowsOf));
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState(false);
  const [toast, setToast] = useState<{ title: string; line: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    setSel((s) => {
      const ok = new Set(data.items.filter((i) => !i.blocked || i.downloadOnly).map(keyOf));
      const next = new Set([...s].filter((k) => ok.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [data.items]);

  const kindOk = (i: Item) => {
    if (kind === 'ver') return !!i.versionId;
    if (kind === 'new') return !i.versionId;
    if (kind === 'mine') return i.uploadedByMe;
    return true;
  };
  // failed files: one by one only, never via Select all
  const canPick = (i: Item) => !locked && (!i.blocked || i.downloadOnly);
  const inBulk = (i: Item) => !locked && !i.blocked;
  const selectable = data.items.filter((i) => kindOk(i) && inBulk(i)).map(keyOf);
  const allOn = selectable.length > 0 && selectable.every((k) => sel.has(k));

  const vers = data.items.filter((i) => i.versionId).length;
  const docs = data.items.length - vers;
  const firsts = `${fmt(docs)} first ${docs === 1 ? 'release' : 'releases'}`;
  const reps = `${fmt(vers)} ${vers === 1 ? 'replacement' : 'replacements'}`;
  let what = firsts;
  if (docs && vers) what = `${firsts} and ${reps}`;
  else if (vers) what = reps;
  const scope = (data.me.scope ?? []).map(folderLabel);
  const scopeText = scope.length <= 1 ? scope[0] ?? 'your folders' : `${scope.slice(0, -1).join(', ')} and ${scope[scope.length - 1]}`;
  const sub = admin
    ? `${what} waiting in ${fmt(data.folders.length)} ${data.folders.length === 1 ? 'folder' : 'folders'}. Bidders see nothing until you publish.`
    : `${what} waiting in ${scopeText}, where you may publish. Who sees ${scope.length === 1 ? scopeText : 'these folders'} is set by the room admins.`;

  const toggle = (keys: string[], on: boolean) => setSel((s) => {
    const next = new Set(s);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    return next;
  });

  const showToast = (title: string, line: string) => {
    setToast({ title, line });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  const toastBox = <div role="status">{toast ? <div className="toast"><i aria-hidden="true">✓</i><div><b>{toast.title}</b><span>{toast.line}</span></div></div> : null}</div>;

  if (data.items.length === 0) {
    return (
      <div className="d3">
        <div className="head"><div><p className="over">Documents</p><h1>Release review</h1><p className="sub">Drafts waiting to be published to bidders.</p></div></div>
        <section className="panel">
          <div className="empty">
            <div className="ei"><Check /></div>
            <h2>Nothing waiting for release</h2>
            <p>Every uploaded document has been published or withdrawn. New uploads and new versions arrive here as drafts.</p>
            <div className="row"><Link className="btn secondary" href={roomHref(ws, 'documents')}>Go to Documents</Link></div>
          </div>
        </section>
        {toastBox}
      </div>
    );
  }

  const chips: [Kind, string][] = [['all', 'All'], ['new', 'First releases'], ['ver', 'Replacements'], ['mine', 'Uploaded by me']];

  return (
    <div className="d3">
      <div className="head"><div><p className="over">Documents</p><h1>Release review</h1><p className="sub">{sub}</p></div></div>
      {data.room.fourEyes || locked ? (
        <div className="notes">
          {frozen ? (
            <div className="note warn"><Warn /><span>The room is frozen. Nobody can publish until {admin ? 'you open' : 'a room admin opens'} it again in Room settings.</span>
              {admin ? <Link className="linkbtn" href={roomHref(ws, 'settings')}>Room settings</Link> : null}</div>
          ) : null}
          {closed ? <div className="note warn"><Warn /><span>The room is closed. Nothing more can be published.</span></div> : null}
          {data.room.fourEyes ? (
            <div className="note info"><Info /><span>The four-eyes rule is on. Publishers cannot publish documents they uploaded themselves. Room admins may.</span></div>
          ) : null}
        </div>
      ) : null}

      <div className="tools">
        <div className="selall">
          {locked ? null : (
            <label className="sa">
              <input type="checkbox" className="cb" checked={allOn} disabled={!selectable.length}
                onChange={(e) => toggle(selectable, e.target.checked)} />
              <span>{allOn ? `All ${fmt(selectable.length)} selected` : `Select all ${fmt(selectable.length)}`}</span>
            </label>
          )}
          <div className="chips" role="group" aria-label="Show">
            {chips.map(([k, label]) => (
              <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {label}{k === 'ver' && vers ? ` · ${fmt(vers)}` : ''}
              </button>
            ))}
          </div>
        </div>
        <span className="cap">Numbers can still be changed in Documents until a draft is published.</span>
      </div>

      <div>
        {data.folders.map((f) => {
          const rows = (rowsOf.get(f.id) ?? []).filter(kindOk);
          if (!rows.length) return null;
          const ok = rows.filter(inBulk).map(keyOf);
          const nsel = ok.filter((k) => sel.has(k)).length;
          const isOpen = !!open[f.id];
          const none = f.groups.length === 0;
          const limit = showAll[f.id] ? rows.length : 5;
          const label = f.indexNumber ?? f.name;
          return (
            <section key={f.id} className={`fgrp${none ? ' warn' : ''}`} aria-label={folderLabel(f)}>
              <div className="fh2">
                <span><input type="checkbox" className="cb" aria-label={`Select all ${fmt(ok.length)} drafts that can be published in ${label}`}
                  checked={ok.length > 0 && nsel === ok.length} disabled={!ok.length} onChange={(e) => toggle(ok, e.target.checked)} /></span>
                <button type="button" className="tg" aria-expanded={isOpen} aria-label={`${isOpen ? 'Close' : 'Open'} ${f.name}`}
                  onClick={() => setOpen((o) => ({ ...o, [f.id]: !o[f.id] }))}>{isOpen ? <ChevD /> : <ChevR />}</button>
                <div className="ft2">
                  <b>{f.indexNumber ? <span className="n">{f.indexNumber}</span> : null}{f.name}<span className="cnt">{fmt(rows.length)}</span></b>
                  <Audience folder={f} groupById={groupById} colour={colour} />
                </div>
                {nsel ? <span className="cap">{fmt(nsel)} selected</span> : <span />}
              </div>
              {isOpen ? (
                <>
                  {none ? (
                    <div className="fwarn"><Warn /><span>{folderLabel(f)} has no bidder access yet. Publishing makes these documents final for the seller team,
                      and bidders see them only after {admin ? <>you give access in <Link className="linkbtn" href={roomHref(ws, 'permissions')}>Permissions</Link></> : 'a room admin gives access in Permissions'}.</span></div>
                  ) : null}
                  {rows.slice(0, limit).map((i) => (
                    <Row key={keyOf(i)} ws={ws} item={i} timeZone={timeZone} selected={sel.has(keyOf(i))} pickable={canPick(i)}
                      onPick={(on) => toggle([keyOf(i)], on)} />
                  ))}
                  {rows.length > limit ? (
                    <div className="more-row"><span>{fmt(rows.length - limit)} more drafts in {label}</span>
                      <button type="button" className="linkbtn" onClick={() => setShowAll((s) => ({ ...s, [f.id]: true }))}>Show all {fmt(rows.length)}</button></div>
                  ) : null}
                </>
              ) : null}
            </section>
          );
        })}
      </div>

      {sel.size && !locked ? (
        <div className="sbar" role="region" aria-label="Selection">
          <div className="grow"><b>{fmt(sel.size)} selected</b><span>Check who will see them before they go live.</span></div>
          <button type="button" className="btn quiet" onClick={() => setSel(new Set())}>Clear</button>
          <button type="button" className="btn primary" onClick={() => setDialog(true)}>Publish {drafts(sel.size)}</button>
        </div>
      ) : null}

      {dialog ? (
        <PublishDialog
          ws={ws} data={data} picked={data.items.filter((i) => sel.has(keyOf(i)))} groupsOf={groupsOf} colour={colour}
          onClose={() => setDialog(false)}
          onDone={(n, quiet, anyBidder) => {
            setDialog(false);
            setSel(new Set());
            let line = 'Bidders hear about them as each chose in their notification settings. Logged in Activity.';
            if (!anyBidder) line = 'Published for the seller team only. Logged in Activity.';
            else if (data.room.noticeMandatory) line = 'Bidders are emailed, because the room admins made this email mandatory. Logged in Activity.';
            else if (quiet) line = 'Nobody is emailed. They show as new in the room. Logged in Activity.';
            showToast(`${drafts(n)} published`, line);
            router.refresh();
          }}
          onRefused={() => router.refresh()}
        />
      ) : null}
      {toastBox}
    </div>
  );
}

function initialOpen(folders: Folder[], rowsOf: Map<string, Item[]>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of folders) if ((rowsOf.get(f.id)?.length ?? 0) <= 5) out[f.id] = true;
  const firstNone = folders.find((f) => f.groups.length === 0);
  if (firstNone) out[firstNone.id] = true;
  return out;
}

function Audience({ folder, groupById, colour }: {
  folder: Folder; groupById: Map<string, ReleaseData['groups'][number]>; colour: Map<string, string>;
}) {
  if (!folder.groups.length) return <span className="aud none">No bidder access yet. Published documents here stay with the seller team.</span>;
  return (
    <span className="aud">Once published:{' '}
      {folder.groups.map((x) => {
        const g = groupById.get(x.id);
        if (!g) return null;
        return <span key={x.id} className="g"><i style={{ background: colour.get(g.partyId) ?? PARTY_COLOURS[0] }} />{g.name}: <em>{levelLabel(x.level)}</em></span>;
      })}
    </span>
  );
}

function Row({ ws, item: i, timeZone, selected, pickable, onPick }: {
  ws: string; item: Item; timeZone: string; selected: boolean; pickable: boolean; onPick: (on: boolean) => void;
}) {
  const why = whyBlocked(i);
  const off = !!why && !(i.blocked === 'failed' && i.downloadOnly);
  const name = displayName(i.name);
  const tag = typeTag(i.name);
  let kindTag = <span className="k k-new">First release</span>;
  if (i.blocked === 'processing') kindTag = <span className="k k-proc">Being prepared</span>;
  else if (i.blocked === 'failed') kindTag = <span className="k k-proc">Could not be prepared</span>;
  else if (i.versionId) kindTag = <span className="k k-ver">Replaces version {i.replacesVersionNo ?? 1}</span>;
  const by = i.uploadedByMe ? 'you' : i.uploadedBy ?? 'someone no longer in the room';
  return (
    <div className={`rr${selected ? ' sel' : ''}${off ? ' off' : ''}`}>
      <span><input type="checkbox" className="cb" aria-label={i.indexNumber ? `Select ${i.indexNumber} ${name}` : `Select ${name}`}
        checked={selected} disabled={!pickable} onChange={(e) => onPick(e.target.checked)} /></span>
      <span className="ix">{i.indexNumber}</span>
      <span className="nm"><span className={`ty ${tag.cls}`}>{tag.label}</span><div>
        <b><Link className="nm-link" href={viewHref(ws, i.id)} title="Preview in the viewer">{name}</Link></b>{i.noPreview ? <> <span className="badge b-np" title="This file cannot be shown in the browser. It is published and downloaded as the original.">No preview</span></> : null}
        {why ? <small className="why">{why}</small>
          : <small>Uploaded by {by} · {formatDay(i.uploadedAt, timeZone)}{i.versionId ? ` · bidders see version ${i.replacesVersionNo ?? 1} until you publish` : ''}</small>}
      </div></span>
      {kindTag}
      <span className="r">{i.pageCount ? `${fmt(i.pageCount)} p` : '–'}</span>
      <Link className="icon-btn" href={viewHref(ws, i.id)} aria-label={`Preview ${i.indexNumber ?? name} in the viewer`} title="Preview"><Eye /></Link>
    </div>
  );
}

function PublishDialog({ ws, data, picked, groupsOf, colour, onClose, onDone, onRefused }: {
  ws: string; data: ReleaseData; picked: Item[]; groupsOf: (i: Item) => { id: string; level: number }[]; colour: Map<string, string>;
  onClose: () => void; onDone: (n: number, quiet: boolean, anyBidder: boolean) => void; onRefused: () => void;
}) {
  const [quiet, setQuiet] = useState(false);
  const [asOriginal, setAsOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useModal(box, { focusFirst: false });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input[name="as-original"], .dlg-f .btn.primary')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busyRef.current) { e.preventDefault(); closeRef.current(); } };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); before?.focus?.(); };
  }, []);

  const n = picked.length;
  const failed = picked.filter((i) => i.blocked === 'failed');
  const confirmOk = failed.length === 0 || asOriginal;
  const per = new Map<string, { n: number; lv: Map<number, number> }>();
  const people = new Map<string, { name: string; n: number; lv: Map<number, number> }>();
  let toNobody = 0;
  let versions = 0;
  const count = (p: { n: number; lv: Map<number, number> }, level: number) => {
    p.n++;
    p.lv.set(level, (p.lv.get(level) ?? 0) + 1);
  };
  for (const i of picked) {
    if (i.versionId) versions++;
    const gs = groupsOf(i);
    if (!gs.length && !i.people.length) toNobody++;
    for (const g of gs) {
      const p = per.get(g.id) ?? { n: 0, lv: new Map() };
      count(p, g.level);
      per.set(g.id, p);
    }
    for (const x of i.people) {
      const p = people.get(x.id) ?? { name: x.name, n: 0, lv: new Map() };
      count(p, x.level);
      people.set(x.id, p);
    }
  }
  const lvText = (lv: Map<number, number>) => [...lv.entries()].sort((a, b) => a[0] - b[0]).map(([l, c]) => `${fmt(c)} at ${levelLabel(l)}`).join(', ');
  const anyBidder = per.size > 0 || people.size > 0;
  // mandatory email goes out anyway
  const quietOk = anyBidder && !data.room.noticeMandatory;

  const publish = once(async () => {
    setBusy(true);
    setError(null);
    const body: { nodeIds: string[]; versionIds: string[]; quiet: boolean; downloadOnly?: boolean } = {
      nodeIds: picked.filter((i) => !i.versionId).map((i) => i.id),
      versionIds: picked.filter((i) => i.versionId).map((i) => i.versionId!),
      quiet: quiet && quietOk,
    };
    if (failed.length) body.downloadOnly = asOriginal;
    const r = await browserApi().POST('/v1/workspaces/{ws}/publish', { params: { path: { ws } }, body });
    setBusy(false);
    if (r.data) { onDone(n, r.data.quiet, anyBidder); return; }
    const p = r.error as Problem | undefined;
    setError(p?.detail ?? p?.title ?? 'Publishing did not work. Nothing was published. Try again.');
    if (p?.reason === 'room_frozen' || r.response.status === 404) onRefused();
  });

  return (
    <>
      <div className="scrim" onClick={() => { if (!busy) onClose(); }} />
      <div ref={box} className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-h">
        <div className="dlg-h">
          <div><p className="over">Release review</p><h2 id="dlg-h">Publish {drafts(n)}?</h2></div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}><Close /></button>
        </div>
        <div className="dlg-b">
          <div className="sec"><h3>Who will see them</h3>
            <div className="wl">
              {data.groups.map((g) => {
                const p = per.get(g.id);
                const c = colour.get(g.partyId) ?? PARTY_COLOURS[0];
                if (!p) return <div key={g.id}><span className="g"><i style={{ background: c }} />{g.name}<small className="none">Gets none of these</small></span><span className="n none">0</span></div>;
                return <div key={g.id}><span className="g"><i style={{ background: c }} /><span>{g.name}<small>{lvText(p.lv)}</small></span></span><span className="n">{fmt(p.n)}</span></div>;
              })}
              {[...people.entries()].map(([id, p]) => (
                <div key={id}><span className="g"><i className="p" /><span>{p.name}<small>Given access by name · {lvText(p.lv)}</small></span></span><span className="n">{fmt(p.n)}</span></div>
              ))}
            </div>
          </div>
          {toNobody ? (
            <div className="wbox">{toNobody === 1
              ? '1 of these is in a folder without bidder access. It is published for the seller team only, and no bidder sees it'
              : `${fmt(toNobody)} of these are in folders without bidder access. They are published for the seller team only, and no bidder sees them`} until access is given in Permissions.</div>
          ) : null}
          {anyBidder ? (
            <div className="sec"><h3>How bidders hear about it</h3>
              {data.room.noticeMandatory ? (
                <p className="cap">Everyone with access is emailed, because the room admins made this email mandatory.</p>
              ) : (
                <>
                  <p className="cap">Each person hears about new documents as they chose in their notification settings.</p>
                  <label className="opt"><input type="checkbox" name="quiet" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
                    <div><b>Release quietly, no email</b><span>For a small fix. Nobody is emailed. The documents still show as new in the room, and the release is logged.</span></div></label>
                </>
              )}
            </div>
          ) : null}
          <ul className="facts">
            {versions ? <li>{versions === 1 ? `1 replacement takes the place of version ${picked.find((i) => i.versionId)?.replacesVersionNo ?? 1}` : `${fmt(versions)} replacements take the place of the earlier versions`} for bidders, under the same number. The earlier version stays in the history.</li> : null}
            <li>You can withdraw a published document later. Bidders lose it at once, and the activity log keeps who saw it.</li>
          </ul>
          {failed.length ? (
            <div className="sec"><h3>{failed.length === 1 ? '1 file could not be prepared for viewing' : `${fmt(failed.length)} files could not be prepared for viewing`}</h3>
              <label className="opt"><input type="checkbox" name="as-original" checked={asOriginal} onChange={(e) => setAsOriginal(e.target.checked)} />
                <div><b>{failed.length === 1 ? 'Publish it as the original file only' : 'Publish them as the original files only'}</b>
                  <span>{failed.length === 1 ? 'It has no preview and no watermark. Only people allowed to download original files can open it.'
                    : 'They have no preview and no watermark. Only people allowed to download original files can open them.'}</span></div></label>
              {!asOriginal ? <p className="cap">Tick the box to publish, or cancel and leave {failed.length === 1 ? 'it' : 'them'} out.</p> : null}
            </div>
          ) : null}
          {error ? <div className="err" role="alert">{error}</div> : null}
        </div>
        <div className="dlg-f">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => { void publish(); }} disabled={busy || !confirmOk}>{busy ? 'Publishing…' : `Publish ${drafts(n)}`}</button>
        </div>
      </div>
    </>
  );
}
