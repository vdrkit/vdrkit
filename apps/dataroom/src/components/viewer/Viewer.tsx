// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { apiUrl, browserApi, followSignOut } from '@/api/browser';
import type { RoomShellData } from '@/api/server';
import { navFor, roleLabel } from '@/components/room/RoomFrame';
import { roomHref, viewHref } from '@/components/room/routes';
import { SeeAsBar } from '@/components/room/SeeAs';
import { parseRoomPart } from '@/components/room/see-as';
import { Avatar } from '@/components/shell';
import { Icon } from '@/components/shell/icons';
import { ThemeButton } from '@/components/shell/ThemeButton';
import { formatDay } from '@/lib/time';
import { retrying, Transient, transientStatus } from '@/lib/retry';
import { useModal } from '@/lib/a11y';
import { useSendOnce } from '@/lib/send-once';
import { placeBeforeViewer } from '@/lib/last-place';
import { RoomLogo } from '@/components/rooms/RoomLogo';
import {
  canDownloadOriginal, canDownloadPdf, clampPage, displayName, docLabel, fileType, formatSize, levelClass, levelLabel, neighbours,
  nearWindow, noPreviewText, pagesLabel, rightsSentence, startPage, watermarkOn, watermarkSentence, zoomBy, type NoPreview, type Sibling,
  type WatermarkNote,
} from './model';

export interface ViewerProps {
  shell: RoomShellData;
  doc: {
    id: string; name: string; indexNumber: string | null; level: number; versionNumber: number | null; versionCount: number | null;
    pageCount: number | null; sizeBytes: number | null; pdfBytes: number | null; publishedAt: string | null;
    uploadedBy: string | null;
    watermark: WatermarkNote;
    noPreview: NoPreview | null;
  };
  folder: { id: string | null; label: string };
  siblings: Sibling[];
  openedBy: string | null;
}

interface Session { id: string; pageCount: number; expiresAt: string; gen: number }
type OpenState =
  | { status: 'opening' }
  | { status: 'open'; session: Session }
  | { status: 'error'; title: string; detail: string; retry: boolean; notReady?: true }
  | { status: 'none'; why: NoPreview };

type PageResult = { url: string } | { failed: true };

const PAGE_W = 760;
// always print the year
const YEAR_ALWAYS = new Date(0);

export function Viewer({ shell, doc, folder, siblings, openedBy }: ViewerProps) {
  const router = useRouter();
  const ws = shell.room.id;
  const isAdmin = shell.me.isAdmin;
  const ix = doc.indexNumber ?? '';
  const title = displayName(doc.name);
  const type = fileType(doc.name);
  const { prev, next } = neighbours(siblings, doc.id);
  const folderHref = folder.id ? roomHref(ws, 'documents', folder.id) : roomHref(ws, 'documents');

  const [open, setOpen] = useState<OpenState>(doc.noPreview ? { status: 'none', why: doc.noPreview } : { status: 'opening' });
  const [ended, setEnded] = useState(false);
  // ref: several 410s arrive together
  const endedNow = useRef(false);
  const [page, setPage] = useState(1);
  const [pageField, setPageField] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [info, setInfo] = useState<boolean | null>(null);
  const [menu, setMenu] = useState(false);
  const [dl, setDl] = useState(false);
  const [dlKind, setDlKind] = useState<'pdf' | 'original'>('pdf');
  const [dlBusy, setDlBusy] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ t: string; s: string } | null>(null);
  // gate page loads until placed, or skipped pages count as read
  const [placed, setPlaced] = useState(-1);

  const canvas = useRef<HTMLElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const startAt = useRef<number | null>(null);
  const keptPage = useRef(1);
  const urls = useRef<string[]>([]);
  const gen = useRef(0);
  const alive = useRef(false);
  const started = useRef(false);
  const opening = useSendOnce();
  const downloading = useSendOnce();

  const session = open.status === 'open' ? open.session : null;
  // failed open (409 too): no count, no download
  const notReady = open.status === 'error' && open.notReady === true;
  const noPreview = open.status === 'none' ? open.why : null;
  let knownCount: number | null = null;
  if (open.status !== 'error' && !noPreview) knownCount = session?.pageCount ?? doc.pageCount ?? null;
  const pageCount = knownCount ?? 1;
  const pageList = knownCount === null ? [] : Array.from({ length: Math.max(knownCount, 1) }, (_, i) => i + 1);

  const revokeAll = () => {
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current = [];
  };

  const openSession = useCallback(async () => {
    const g = ++gen.current;
    setOpen({ status: 'opening' });
    const gone = () => g !== gen.current || !alive.current;
    // a failed open rolls back; a retry double-logs only if the response was lost
    type Answer = Awaited<ReturnType<ReturnType<typeof browserApi>['POST']>>;
    let r: Answer | null;
    try {
      r = await retrying(async () => {
        let res: Answer;
        try {
          res = await browserApi().POST('/v1/workspaces/{ws}/nodes/{id}/open', { params: { path: { ws, id: doc.id } } });
        } catch {
          throw new Transient('no answer');
        }
        if (!res.data && transientStatus(res.response.status)) throw Object.assign(new Transient('server'), { res });
        return res;
      }, { retries: 2, cancelled: gone, online: () => true });
    } catch (e) {
      r = (e as { res?: Answer }).res ?? null;
    }
    if (gone()) return;
    if (!r) {
      setOpen({ status: 'error', title: 'This document could not be opened', detail: 'The server could not be reached. Check your connection and try again.', retry: true });
      return;
    }
    if (r.data) {
      revokeAll();
      endedNow.current = false;
      setEnded(false);
      setOpen({ status: 'open', session: { id: r.data.sessionId, pageCount: r.data.pageCount, expiresAt: r.data.expiresAt, gen: g } });
      return;
    }
    const problem = r.error as { detail?: string; reason?: string; noPreview?: NoPreview } | undefined;
    const status = r.response.status;
    if (status === 409 && problem?.reason === 'no_preview') setOpen({ status: 'none', why: problem.noPreview ?? 'file_type' });
    else if (status === 409) setOpen({ status: 'error', title: 'This document is still being prepared', detail: 'Its pages appear here once they are ready. Try again in a minute.', retry: true, notReady: true });
    else if (status === 403) setOpen({ status: 'error', title: 'You cannot open this document', detail: problem?.detail ?? 'Your access does not include opening it.', retry: false });
    else if (status === 404) setOpen({ status: 'error', title: 'This document is not available', detail: 'It may have been withdrawn, or your access has changed.', retry: false });
    else setOpen({ status: 'error', title: 'This document could not be opened', detail: problem?.detail ?? 'Something went wrong on the server.', retry: true });
  }, [ws, doc.id]);
  // each open is logged: a second click must not open twice
  const reopen = opening(openSession);

  // strict mode: one document.opened per mount
  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      startAt.current = startPage(window.location.search, window.location.hash);
      setInfo(window.innerWidth > 900);
      if (!doc.noPreview) void openSession();
    }
    return () => { alive.current = false; };
  }, [openSession, doc.noPreview]);
  useEffect(() => () => { if (!alive.current) revokeAll(); }, []);

  useEffect(() => {
    if (!session) return;
    const ms = Date.parse(session.expiresAt) - Date.now();
    const t = window.setTimeout(() => endSession(), Math.max(0, Math.min(ms, 2_147_000_000)));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per session
  }, [session]);

  function endSession() {
    // later 410s would record page 1
    if (endedNow.current) return;
    endedNow.current = true;
    keptPage.current = currentPage();
    setEnded(true);
    setDl(false);
    // images are gone, nothing to scroll to
    revokeAll();
    // not smooth: may still run on reopen
    if (canvas.current) canvas.current.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }

  useEffect(() => {
    if (!session) return;
    const target = startAt.current ?? keptPage.current;
    startAt.current = null;
    const n = clampPage(target, session.pageCount);
    requestAnimationFrame(() => { goPage(n); setPlaced(session.gen); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- place the pages once per session
  }, [session]);

  useEffect(() => {
    const strip = document.getElementById('strip');
    const th = strip?.querySelector<HTMLElement>('.th.on');
    if (!strip || !th) return;
    const top = th.offsetTop - strip.offsetTop;
    if (top < strip.scrollTop || top + th.offsetHeight > strip.scrollTop + strip.clientHeight) strip.scrollTop = top - 12;
  }, [page]);

  const pageEl = (n: number) => canvas.current?.querySelector<HTMLElement>(`#p${n}`) ?? null;

  function goPage(n: number) {
    const el = pageEl(clampPage(n, pageCount));
    // instant, or passed pages count as read
    if (el && canvas.current) canvas.current.scrollTo({ top: el.offsetTop - 24, behavior: 'instant' as ScrollBehavior });
    setPage(clampPage(n, pageCount));
  }

  function currentPage(): number {
    const c = canvas.current;
    if (!c) return page;
    const line = c.scrollTop + c.clientHeight / 3;
    let cur = 1;
    c.querySelectorAll<HTMLElement>('.page').forEach((el, i) => { if (el.offsetTop <= line) cur = i + 1; });
    return cur;
  }

  // full pages record coverage
  const loadPage = useCallback(async (n: number, size: 'full' | 'thumb', s: Session): Promise<PageResult | null> => {
    let blob: Blob;
    const src = apiUrl(`/v1/workspaces/${ws}/nodes/${doc.id}/pages/${n}?session=${s.id}${size === 'thumb' ? '&size=thumb' : ''}`);
    try {
      const res = await fetch(src, { credentials: 'include', cache: 'no-store' });
      if (s.gen !== gen.current) return null;
      if (res.status === 410) { endSession(); return null; }
      if (await followSignOut(src, res)) return null;
      if (!res.ok) return { failed: true };
      blob = await res.blob();
    } catch {
      // offline or cut off: same retry as an HTTP failure
      return s.gen === gen.current ? { failed: true } : null;
    }
    // ended or left while the image arrived: no URL that nothing would release
    if (s.gen !== gen.current || endedNow.current || !alive.current) return null;
    const url = URL.createObjectURL(blob);
    urls.current.push(url);
    return { url };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- uses the canvas ref
  }, [ws, doc.id]);

  const goDoc = useCallback((d: Sibling | null) => { if (d) router.push(viewHref(ws, d.id)); }, [router, ws]);

  useEffect(() => {
    const at = document.activeElement;
    if (!at || at === document.body) canvas.current?.focus({ preventScroll: true });
  }, [doc.id]);

  const menuBox = useRef<HTMLElement>(null);
  useModal(menuBox, { active: menu });

  const closeViewer = useCallback(() => {
    const back = placeBeforeViewer();
    if (back?.oneStepBack && window.history.length > 1) router.back();
    else router.push(back?.url ?? folderHref);
  }, [router, folderHref]);

  // J/K only inside the viewer body
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        if (menu) {
          setMenu(false);
          menuBtn.current?.focus();
        } else if (dl) {
          setDl(false);
          document.getElementById('dl-btn')?.focus();
        } else if (info && overlayInfo()) closeInfo();
        else if (t.id === 'pg' && pageField !== null) setPageField(null);
        else if (!document.querySelector('[role="menu"], [aria-modal="true"]')) { e.preventDefault(); closeViewer(); }
        return;
      }
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (t !== document.body && !t.closest('.vbody')) return;
      if (menu) return;
      if (e.key === 'j' || e.key === 'J') goDoc(next);
      else if (e.key === 'k' || e.key === 'K') goDoc(prev);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [menu, dl, info, next, prev, goDoc, closeViewer, pageField]);

  useEffect(() => {
    if (!dl) return;
    const click = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.dlwrap')) setDl(false); };
    document.addEventListener('click', click);
    return () => document.removeEventListener('click', click);
  }, [dl]);

  useEffect(() => {
    if (!menu) return;
    document.querySelector<HTMLElement>('.vroot .mpanel .nav a.on')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(t);
  }, [toast]);

  function closeMenu() { setMenu(false); menuBtn.current?.focus(); }
  const overlayInfo = () => window.matchMedia('(max-width: 900px)').matches;
  function closeInfo() { setInfo(false); document.getElementById('info-btn')?.focus(); }
  // modal below 900px
  const [infoOverlay, setInfoOverlay] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const set = () => setInfoOverlay(mq.matches);
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  }, []);
  const infoBox = useRef<HTMLElement>(null);
  useModal(infoBox, { active: info === true && infoOverlay });

  function changeZoom(dir: 1 | -1) {
    const p = currentPage();
    setZoom((z) => zoomBy(z, dir));
    requestAnimationFrame(() => requestAnimationFrame(() => goPage(p)));
  }

  function commitPageField() {
    if (pageField === null) return;
    const n = Number(pageField);
    setPageField(null);
    if (Number.isFinite(n) && n >= 1) goPage(n);
  }

  const download = downloading(async (kind: 'pdf' | 'original' = dlKind) => {
    setDlBusy(true);
    setDlError(null);
    const format = kind === 'original' && canDownloadOriginal(doc.level) ? 'original' : 'pdf';
    try {
      const src = apiUrl(`/v1/workspaces/${ws}/nodes/${doc.id}/download?format=${format}`);
      const res = await fetch(src, { credentials: 'include', cache: 'no-store' });
      if (await followSignOut(src, res)) return;
      if (!res.ok) {
        const p = (await res.json().catch(() => null)) as { detail?: string } | null;
        setDlError(p?.detail ?? 'The download did not start. Try again.');
        return;
      }
      const name = fileNameOf(res.headers.get('content-disposition')) ?? (format === 'pdf' ? `${title}.pdf` : doc.name);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDl(false);
      if (format === 'original') {
        setToast({ t: 'Original file downloaded', s: 'Recorded in the activity log.' });
      } else {
        const mark = watermarkOn(doc.watermark) ? `${watermarkSentence(doc.watermark, 'you')} ` : '';
        setToast({ t: 'PDF downloaded', s: `${mark}Recorded in the activity log.` });
      }
    } catch {
      setDlError('The download did not start. Try again.');
    } finally {
      setDlBusy(false);
    }
  });

  const infoOn = info === true;
  const versionText = `Version ${doc.versionNumber ?? 1}${doc.versionCount ? ` of ${doc.versionCount}` : ''}`;
  const marked = watermarkOn(doc.watermark);
  const nav = navFor(shell, 'documents');
  const menuLabel = `Room menu: ${nav.flatMap((e) => ('section' in e ? [] : [e.label])).join(', ')}`;
  const near = nearWindow(siblings, doc.id);
  const roomSubtitle = isAdmin && shell.room.bidderGroups !== null
    ? `${shell.room.bidderGroups.toLocaleString('en-GB')} bidder ${shell.room.bidderGroups === 1 ? 'group' : 'groups'}` : `Run by ${shell.room.runBy}`;
  const roomInitials = shell.room.name.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('').slice(0, 2);

  let pagesTag = '';
  if (knownCount !== null) pagesTag = `${pagesLabel(knownCount)} · `;
  else if (noPreview) pagesTag = 'No preview · ';
  else if (notReady) pagesTag = 'Pages not ready yet · ';
  let bodyClass = 'vbody';
  if (info === null) bodyClass += ' info-auto';
  else if (!info) bodyClass += ' no-info';

  // an ended session keeps no page images, so its places are new elements
  const pageKey = (n: number) => `${ended ? 'ended' : session?.gen ?? 0}-${n}`;

  const onScroll = () => {
    if (ended) return;
    const p = currentPage();
    if (p !== page) setPage(p);
  };

  return (
    <div className="vroot" style={{ '--pw': `${Math.round(PAGE_W * zoom / 100)}px` } as CSSProperties}>
      {shell.seeAs ? <SeeAsBar ws={ws} team={shell.seeAs} /> : null}
      <div className="viewer">
        <header className="vbar">
          <button ref={menuBtn} type="button" className="icon-btn" id="menu-btn" aria-label={menuLabel} title="Room menu" aria-expanded={menu} onClick={() => setMenu(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <Link className="back" href={folderHref} title="Back to the folder, with the room menu">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7l7 7" /></svg><span className="t">{folder.label}</span>
          </Link>
          <span className="vsep" />
          <div className="doct">
            {ix && <span className="ix">{ix}</span>}
            <h1 title={title}>{title}</h1>
            <span className="vtag" id="vtag">
              {isAdmin && doc.versionNumber ? `${versionText} · ` : ''}{pagesTag}{type}
            </span>
          </div>
          <div className="pager" hidden={knownCount === null}>
            Page <input id="pg" inputMode="numeric" aria-label="Page number" value={pageField ?? String(page)}
              onChange={(e) => setPageField(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitPageField}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitPageField(); } }} /> of <b>{pageCount}</b>
          </div>
          <div className="zoom" role="group" aria-label="Zoom">
            <button type="button" aria-label="Zoom out" onClick={() => changeZoom(-1)}>−</button>
            <span id="zv" aria-live="polite">{zoom}%</span>
            <button type="button" aria-label="Zoom in" onClick={() => changeZoom(1)}>+</button>
          </div>
          <div className="vacts">
            <div className="docnav">
              <button type="button" data-doc="-1" aria-keyshortcuts="K" disabled={!prev} title={prev ? docLabel(prev) : 'This is the first document in the folder'} onClick={() => goDoc(prev)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7l7 7" /></svg><span className="t">Previous</span><kbd>K</kbd>
              </button>
              <button type="button" data-doc="1" aria-keyshortcuts="J" disabled={!next} title={next ? docLabel(next) : 'This is the last document in the folder'} onClick={() => goDoc(next)}>
                <span className="t">Next</span><kbd>J</kbd><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7l-7 7" /></svg>
              </button>
            </div>
            {canDownloadPdf(doc.level) && knownCount !== null && !shell.seeAs && (
              <span className="dlwrap" id="dlwrap">
                <button type="button" className="btn secondary sm" id="dl-btn" aria-expanded={dl} onClick={() => { setDl(!dl); setDlError(null); }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" /></svg>Download
                </button>
                {dl && (
                  <div className="dl" role="dialog" aria-label="Download">
                    <b>Download {ix || title}</b>
                    <label className="opt">
                      <input type="radio" name="dlk" value="pdf" checked={dlKind === 'pdf'} onChange={() => setDlKind('pdf')} />
                      <span>{marked ? 'PDF with watermark' : 'PDF'}<small>{watermarkSentence(doc.watermark, 'values')}{doc.pdfBytes ? ` ${formatSize(doc.pdfBytes)}.` : ''}</small></span>
                    </label>
                    {canDownloadOriginal(doc.level) && (
                      <label className="opt">
                        <input type="radio" name="dlk" value="original" checked={dlKind === 'original'} onChange={() => setDlKind('original')} />
                        <span>Original file<small>The file as uploaded, without a watermark.{doc.sizeBytes ? ` ${formatSize(doc.sizeBytes)}.` : ''}</small></span>
                      </label>
                    )}
                    <span className="cap">Downloads are recorded in the activity log.</span>
                    {dlError && <span className="cap err" role="alert">{dlError}</span>}
                    <div className="row">
                      <button type="button" className="btn ghost sm" id="dl-cancel" onClick={() => setDl(false)}>Cancel</button>
                      <button type="button" className="btn primary sm" id="dl-go" disabled={dlBusy} onClick={() => void download()}>Download</button>
                    </div>
                  </div>
                )}
              </span>
            )}
            <button type="button" className={`btn secondary sm${infoOn ? ' on' : ''}`} id="info-btn" aria-pressed={info === null ? undefined : info}
              title="Show or hide the details panel on the right" onClick={() => setInfo(!(info ?? window.innerWidth > 900))}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M14.5 4.5v15" /></svg>Details
            </button>
            <ThemeButton />
          </div>
        </header>

        <div className={bodyClass} id="vbody">
          <nav className="strip" id="strip" aria-label="Pages">
            {pageList.map((n) => (
              <Thumb key={pageKey(n)} n={n} on={n === page} session={ended ? null : session} load={loadPage} onGo={() => goPage(n)} />
            ))}
          </nav>
          <main className="canvas" id="canvas" tabIndex={0} aria-label={`${title}, pages`} ref={canvas} onScroll={onScroll}>
            {ended && (
              <div className="ended" role="alertdialog" aria-labelledby="end-h">
                <div className="box">
                  <h2 id="end-h">This viewing session has ended</h2>
                  <p>Viewing sessions end 8 hours after a document is opened, so a screen left open does not keep showing pages. Your place is kept at page {keptPage.current}.</p>
                  <div><button type="button" className="btn primary" onClick={() => void reopen()}>Open the document again</button></div>
                </div>
              </div>
            )}
            {open.status === 'error' && (
              <div className="ended" role="alert" aria-labelledby="err-h">
                <div className="box">
                  <h2 id="err-h">{open.title}</h2>
                  <p>{open.detail}</p>
                  <div>
                    {open.retry
                      ? <button type="button" className="btn primary" onClick={() => void reopen()}>Try opening it again</button>
                      : <Link className="btn primary" href={folderHref}>Back to {folder.label}</Link>}
                  </div>
                </div>
              </div>
            )}
            {noPreview && <NoPreviewPanel why={noPreview} fileName={doc.name} sizeBytes={doc.sizeBytes} level={doc.level} seeAs={!!shell.seeAs}
              busy={dlBusy} error={dlError} onDownload={() => void download('original')} />}
            <div className="pages" id="pages">
              {pageList.map((n) => (
                <PageView key={pageKey(n)} n={n} total={pageCount} session={ended || placed !== session?.gen ? null : session} load={loadPage} canvas={canvas} />
              ))}
            </div>
            {session && (
              <div id="next-slot">
                {next ? (
                  <div className="nextdoc">
                    <div><span>End of {ix || title} · next in {folder.label}</span><b>{docLabel(next)}</b></div>
                    <button type="button" className="btn primary sm" onClick={() => goDoc(next)}>Open next document</button>
                  </div>
                ) : (
                  <div className="nextdoc">
                    <div><span>End of {ix || title}</span><b>Last document in {folder.label}</b></div>
                    <Link className="btn primary sm" href={folderHref}>Back to the folder</Link>
                  </div>
                )}
              </div>
            )}
          </main>
          {infoOn && <div className="iscrim" onClick={closeInfo} />}
          <aside ref={infoBox} className="info" id="info" aria-label="Document details" role={info === true && infoOverlay ? 'dialog' : undefined}
            aria-modal={info === true && infoOverlay ? true : undefined}>
            <section>
              <div className="ihead">
                <h2>Document</h2>
                <button type="button" className="icon-btn iclose" aria-label="Close the details panel" title="Close the details panel" onClick={closeInfo}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <dl className="kv">
                {ix && (<><dt>Index</dt><dd className="mono">{ix}</dd></>)}
                <dt>Folder</dt><dd>{folder.label}</dd>
                {(knownCount !== null || notReady || noPreview) && (<><dt>Pages</dt><dd>{noPreview ? 'No preview' : knownCount ?? 'Not ready yet'}</dd></>)}
                <dt>File</dt><dd>{type}{doc.sizeBytes ? ` · ${formatSize(doc.sizeBytes)}` : ''}</dd>
                {doc.publishedAt && (<><dt>Published</dt><dd>{formatDay(doc.publishedAt, shell.me.timeZone, YEAR_ALWAYS)}</dd></>)}
                <dt>Watermarked</dt><dd>{marked && !noPreview ? 'Yes' : 'No'}</dd>
                {isAdmin && doc.uploadedBy && (<><dt>Uploaded by</dt><dd>{doc.uploadedBy}</dd></>)}
                {isAdmin && doc.versionNumber && (<><dt>Version</dt><dd>{versionText.replace(/^Version /, '')}</dd></>)}
              </dl>
            </section>
            <section>
              <h2>What you can do</h2>
              <div className="right">
                <span className={`lvl ${levelClass(isAdmin ? 60 : doc.level)}`}>{levelLabel(isAdmin ? 60 : doc.level)}</span>
                <span>{rightsSentence(doc.level, isAdmin, doc.watermark)}</span>
              </div>
            </section>
            {siblings.length > 0 && (
              <section>
                <h2>Other documents in {folder.label}</h2>
                <div className="near">
                  {near.map((d) => (
                    <Link key={d.id} href={viewHref(ws, d.id)} className={d.id === doc.id ? 'on' : undefined} aria-current={d.id === doc.id ? 'page' : undefined}>
                      <span className="ix">{d.indexNumber ?? ''}</span><span className="nm">{displayName(d.name)}</span>
                      {d.state ? <span className="st">{d.state === 'draft' ? 'Draft' : 'Withdrawn'}</span>
                        : d.unread && !isAdmin ? <span className="new">Unread</span> : <span />}
                    </Link>
                  ))}
                </div>
              </section>
            )}
            {isAdmin && (
              <section>
                <h2>Activity</h2>
                <div className="adm">
                  <span>{openedBy ?? 'Who opened it could not be loaded.'}</span>
                  <Link href={roomHref(ws, 'activity')}>See who opened it in Activity</Link>
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>

      {menu && (
        <>
          <div className="mscrim" onClick={closeMenu} />
          <aside ref={menuBox} className="mpanel" role="dialog" aria-modal="true" aria-label="Room menu">
            <div className="mh">
              <div className="room"><RoomLogo roomId={shell.room.id} initials={roomInitials} logos={shell.room.logos} className="room-logo" /><div><b>{shell.room.name}</b><span>{roomSubtitle}</span></div></div>
              <button type="button" className="icon-btn" aria-label="Close the room menu" onClick={closeMenu}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <nav className="nav" aria-label="Room sections">
              {nav.map((e) => ('section' in e
                ? <div key={`sec-${e.section}`} className="sec">{e.section}</div>
                : <Link key={e.key} href={e.href} className={e.current ? 'on' : undefined} onClick={() => setMenu(false)}><Icon name={e.icon} />{e.label}</Link>))}
            </nav>
            <div className="user">
              <Link className="me" href={roomHref(parseRoomPart(ws).room, 'profile')} title="Opens your profile and email settings" onClick={() => setMenu(false)}>
                <Avatar name={shell.me.name} colourKey={shell.seeAs?.groupId ?? shell.me.personId} />
                <span className="who"><b>{shell.me.name}</b><span>{roleLabel(shell)}</span></span>
              </Link>
            </div>
          </aside>
        </>
      )}
      <div aria-live="polite">
        {toast && <div className="toast"><i>✓</i><div><b>{toast.t}</b><span>{toast.s}</span></div></div>}
      </div>
    </div>
  );
}

// no PDF exists; originals can't be watermarked
function NoPreviewPanel({ why, fileName, sizeBytes, level, seeAs, busy, error, onDownload }: {
  why: NoPreview; fileName: string; sizeBytes: number | null; level: number; seeAs: boolean; busy: boolean; error: string | null; onDownload: () => void;
}) {
  const can = canDownloadOriginal(level);
  const t = noPreviewText(why, fileName, can);
  const ext = fileType(fileName);
  return (
    <section className="nopv" aria-labelledby="np-h" data-why={why}>
      <div className="box">
        <span className="ficon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" /></svg><b>{ext === 'File' ? '' : ext.slice(0, 4)}</b></span>
        <h2 id="np-h">{t.title}</h2>
        <p>{t.reason} {t.next}</p>
        {can ? (
          <div className="act">
            <button type="button" className="btn primary" id="np-dl" disabled={busy || seeAs} onClick={onDownload}
              title={seeAs ? 'Nothing is downloaded while you see the room as a team.' : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" /></svg>{busy ? 'Downloading…' : 'Download the original file'}
            </button>
            <span className="cap">{ext === 'File' ? 'The file' : `${ext} file`} as uploaded, without a watermark{sizeBytes ? `, ${formatSize(sizeBytes)}` : ''}. Downloads are recorded in the activity log.</span>
            {error && <span className="cap err" role="alert">{error}</span>}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function fileNameOf(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch (err) {
      if (!(err instanceof URIError)) throw err;
    }
  }
  return /filename="([^"]+)"/i.exec(cd)?.[1] ?? null;
}

type Loader = (n: number, size: 'full' | 'thumb', s: Session) => Promise<PageResult | null>;
const THUMB_RETRIES = 3;

function useSeen(el: RefObject<HTMLElement | null>, root: () => Element | null, active: boolean, cb: () => void, margin = '0px') {
  useEffect(() => {
    const node = el.current;
    if (!node || !active) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting)) return;
      io.disconnect();
      cb();
    }, { root: root(), rootMargin: margin });
    io.observe(node);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- observe again only when it becomes active
  }, [active]);
}

// fetch only once visible: every full fetch counts as read
function PageView({ n, total, session, load, canvas }: { n: number; total: number; session: Session | null; load: Loader; canvas: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLElement>(null);
  const [img, setImg] = useState<PageResult | null>(null);
  const [ratio, setRatio] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const heightBefore = useRef(0);
  // manual scroll anchoring: Safari has none
  useLayoutEffect(() => {
    const el = ref.current;
    const c = canvas.current;
    if (!ratio || !el || !c) return;
    const delta = el.offsetHeight - heightBefore.current;
    if (delta && el.offsetTop < c.scrollTop) c.scrollTo({ top: c.scrollTop + delta, behavior: 'instant' as ScrollBehavior });
  }, [ratio, canvas]);
  const fetchIt = () => {
    if (!session) return;
    void load(n, 'full', session).then((r) => { if (r) setImg(r); });
  };
  // ignore the sliver above the start page
  useSeen(ref, () => canvas.current, !!session && !img, fetchIt, '-40px 0px -40px 0px');
  useEffect(() => { if (attempt > 0) fetchIt(); }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps -- click only
  return (
    <section className="page" id={`p${n}`} ref={ref} aria-label={`Page ${n} of ${total}`} style={ratio ? ({ '--ar': ratio } as CSSProperties) : undefined}>
      {img && 'url' in img && (
        <img src={img.url} alt={`Page ${n} of ${total}`} draggable={false}
          onLoad={(e) => {
            const i = e.currentTarget;
            if (!i.naturalWidth) return;
            heightBefore.current = ref.current?.offsetHeight ?? 0;
            setRatio(`${i.naturalWidth} / ${i.naturalHeight}`);
          }} />
      )}
      {img && 'failed' in img && (
        <div className="pfail"><span>Page {n} could not be shown.</span>
          <button type="button" className="btn secondary sm" onClick={() => { setImg(null); setAttempt((a) => a + 1); }}>Load page {n} again</button></div>
      )}
    </section>
  );
}

function Thumb({ n, on, session, load, onGo }: { n: number; on: boolean; session: Session | null; load: Loader; onGo: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [img, setImg] = useState<string | null>(null);
  const shown = useRef(true);
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);
  useSeen(ref, () => ref.current?.parentElement ?? null, !!session && !img, () => {
    if (!session) return;
    // thumbnails: a few tries, then just the page number
    void retrying(async () => {
      const r = await load(n, 'thumb', session);
      if (r && 'failed' in r) throw new Transient();
      return r;
    }, { retries: THUMB_RETRIES, cancelled: () => !shown.current }).then((r) => { if (r && 'url' in r) setImg(r.url); }, () => undefined);
  });
  return (
    <button ref={ref} type="button" className={`th${on ? ' on' : ''}`} aria-label={`Go to page ${n}`} aria-current={on ? 'page' : undefined} onClick={onGo}>
      <i className={img ? 'has' : undefined}>{img && <img src={img} alt="" draggable={false} />}</i>{n}
    </button>
  );
}
