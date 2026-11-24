// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import type { IndexViewer } from '@/components/shell/DocumentIndex';
import { roomHref, viewHref } from '@/components/room/routes';
import { replaceParam, useSearchQuery } from '@/components/room/search-state';
import { byIndex, displayName } from '@/lib/search';
import { useSendOnce } from '@/lib/send-once';
import '@/styles/search.css';

// `documents` includes drafts the viewer can see
export interface SearchFolder { id: string; ix: string; name: string; documents: number; published: number }

type Hit = {
  nodeId: string; indexNumber: string | null; name: string; kind: 'folder' | 'document';
  path: { nodeId: string; indexNumber: string | null; name: string }[];
  snippet: string | null; highlights: [number, number][]; page: number | null; matchedIn: 'name' | 'content';
  pages: { page: number; snippet: string; highlights: [number, number][] }[];
  pagesMatched: number;
  state: 'draft' | 'published' | 'withdrawn';
  isNew: boolean;
  wasNumber: string | null;
};

interface Results { key: string; folder: string; query: string; items: Hit[]; total: number }

const PAGE = 50;
const n = (x: number) => x.toLocaleString('en-GB');
const EXAMPLES = ['change of control', '"supply agreement"', 'lease -Germiston', 'Ombeli'];

function searchQuery(q: string, limit: number, folder: string, offset?: number) {
  const query: { q: string; limit: number; offset?: number; folder?: string } = { q, limit };
  if (offset !== undefined) query.offset = offset;
  if (folder) query.folder = folder;
  return query;
}

export function parseQuery(q: string): { terms: string[]; not: string[]; tokens: { text: string; neg: boolean }[] } {
  const terms: string[] = [];
  const not: string[] = [];
  const tokens: { text: string; neg: boolean }[] = [];
  q.replace(/(-?)"([^"]+)"|(-?)(\S+)/g, (m, n1: string, ph: string, n2: string, w: string) => {
    const t = (ph || w || '').replace(/"/g, '').toLowerCase();
    if (!t || t === 'or') return m;
    const neg = !!(n1 || n2);
    (neg ? not : terms).push(t);
    tokens.push({ text: m, neg });
    return m;
  });
  return { terms, not, tokens };
}

function markName(text: string, terms: string[]): ReactNode {
  const whole = terms.join(' ');
  const marks = terms.length > 1 && text.toLowerCase().includes(whole) ? [whole] : terms.filter((t) => t.length > 2);
  if (!marks.length) return text;
  marks.sort((a, b) => b.length - a.length);
  const alternatives = marks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(${alternatives})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

export function snippetParts(snippet: string, highlights: [number, number][]): { text: string; marks: [number, number][] } {
  let text = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < snippet.length; i++) {
    at[i] = text.length;
    const ch = snippet[i]!;
    if (/\s/.test(ch)) { if (!space && text.length) text += ' '; space = true; }
    else { text += ch; space = false; }
  }
  at[snippet.length] = text.length;
  const ranges: [number, number][] = [];
  for (const [a, b] of highlights) {
    const start = at[a] ?? text.length;
    const end = at[b] ?? text.length;
    if (end > start) ranges.push([start, end]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && /^\s*$/.test(text.slice(last[1], r[0]))) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return { text: text.trimEnd(), marks: merged.filter(([a, b]) => b - a > 2) };
}

function Snippet({ snippet, highlights }: { snippet: string; highlights: [number, number][] }) {
  const { text, marks } = snippetParts(snippet, highlights);
  const out: ReactNode[] = [];
  let pos = 0;
  marks.forEach(([a, b], i) => {
    if (a > pos) out.push(<Fragment key={`t${i}`}>{text.slice(pos, a)}</Fragment>);
    out.push(<mark key={`m${i}`}>{text.slice(a, b)}</mark>);
    pos = b;
  });
  if (pos < text.length) out.push(<Fragment key="end">{text.slice(pos)}</Fragment>);
  return <>{out}</>;
}

function fileType(name: string): { cls: string; label: string } {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'pdf') return { cls: 'pdf', label: 'PDF' };
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return { cls: 'doc', label: 'DOC' };
  if (['xls', 'xlsx', 'xlsm', 'csv', 'ods'].includes(ext)) return { cls: 'xls', label: 'XLS' };
  if (['ppt', 'pptx', 'odp'].includes(ext)) return { cls: 'ppt', label: 'PPT' };
  return { cls: 'file', label: ext ? ext.toUpperCase().slice(0, 4) : 'FILE' };
}

const DirIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
);

// middle terms first, then the last, then the first
export function shorterSearches(tokens: { text: string; neg: boolean }[]): string[] {
  const pos = tokens.map((t, i) => (t.neg ? -1 : i)).filter((i) => i >= 0);
  if (pos.length < 2) return [];
  const order = [...pos.slice(1, -1), pos[pos.length - 1]!, pos[0]!];
  return order.map((drop) => tokens.filter((_, i) => i !== drop).map((t) => t.text).join(' '));
}

export function browseFolder(folders: SearchFolder[], terms: string[]): SearchFolder | undefined {
  const words = terms.flatMap((t) => t.split(' ')).filter((w) => w.length > 2);
  if (!words.length) return undefined;
  const hits = folders.filter((f) => {
    const nameWords = f.name.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    return nameWords.some((w) => words.some((t) => w.startsWith(t)));
  });
  return hits.sort((a, b) => b.ix.split('.').length - a.ix.split('.').length || byIndex(a.ix, b.ix))[0];
}

export function SearchBody({ ws, roomName, viewer, isAdmin, total, folders, allFolders, ownGroup, initialFolder }: {
  ws: string;
  roomName: string;
  viewer: IndexViewer;
  isAdmin: boolean;
  total: number;
  folders: SearchFolder[];
  allFolders: SearchFolder[];
  /** bidders only; never another group's name */
  ownGroup: string | null;
  initialFolder: string;
}) {
  const { q, setQ } = useSearchQuery();
  const [folder, setFolder] = useState(initialFolder);
  const [sort, setSort] = useState<'best' | 'ix'>('best');
  const [res, setRes] = useState<Results | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [retry, setRetry] = useState(0);
  const [shorter, setShorter] = useState<{ key: string; q: string } | null>(null);

  const query = q.trim();
  const { terms, tokens } = useMemo(() => parseQuery(query), [query]);
  const runnable = terms.length > 0;
  const key = `${folder}\u0000${query}`;
  const folderOf = (id: string) => allFolders.find((x) => x.id === id);
  const scopeOf = (id: string) => {
    const f = folderOf(id);
    return f ? `in ${f.ix} ${f.name}` : 'in all folders';
  };
  const seller = viewer !== 'buyer';

  useEffect(() => {
    if (!query) document.querySelector<HTMLInputElement>('.top .qs-in')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once, on arrival
  }, []);

  useEffect(() => {
    if (!runnable) { setBusy(false); setFailed(null); return; }
    const ctl = new AbortController();
    setBusy(true);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the body catches everything
    const t = window.setTimeout(async () => {
      try {
        const { data, error } = await browserApi().GET('/v1/workspaces/{ws}/search', {
          params: { path: { ws }, query: searchQuery(query, PAGE, folder) }, signal: ctl.signal,
        });
        if (ctl.signal.aborted) return;
        if (!data) {
          setFailed((error as { detail?: string } | undefined)?.detail ?? 'Search did not answer.');
          setBusy(false);
          return;
        }
        setRes({ key, folder, query, items: data.items as Hit[], total: data.total });
        setFailed(null);
        setBusy(false);
      } catch {
        if (!ctl.signal.aborted) { setFailed('Search did not answer.'); setBusy(false); }
      }
    }, 180);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [ws, key, query, folder, runnable, retry]);

  const more = once(async () => {
    if (!res) return;
    setBusy(true);
    const { data } = await browserApi().GET('/v1/workspaces/{ws}/search', {
      params: { path: { ws }, query: searchQuery(query, PAGE, folder, res.items.length) },
    });
    setBusy(false);
    if (!data) return;
    setRes((r) => {
      if (!r || r.key !== key) return r;
      return { ...r, items: [...r.items, ...(data.items as Hit[])], total: data.total };
    });
  });

  const noneKey = res && res.key === key && !busy && res.items.length === 0 ? key : null;
  useEffect(() => {
    if (!noneKey) return;
    const options = shorterSearches(tokens);
    if (!options.length) return;
    const ctl = new AbortController();
    const countFor = async (o: string) => {
      try {
        const { data } = await browserApi().GET('/v1/workspaces/{ws}/search', {
          params: { path: { ws }, query: searchQuery(o, 1, folder) }, signal: ctl.signal,
        });
        return data?.total ?? 0;
      } catch {
        return 0;
      }
    };
    void Promise.all(options.map(countFor))
      .then((totals) => {
        if (ctl.signal.aborted) return;
        const i = totals.findIndex((t) => t > 0);
        if (i >= 0) setShorter({ key: noneKey, q: options[i]! });
      });
    return () => ctl.abort();
    // tokens and folder are in noneKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noneKey, ws]);

  function chooseFolder(id: string) {
    setFolder(id);
    replaceParam('folder', id || null);
  }

  // keep old results up while loading
  const current = res && (res.key === key || busy) ? res : null;
  const scope = scopeOf(current ? current.folder : folder);
  const shownQuery = current ? current.query : query;
  const shown = useMemo(() => {
    if (!current) return [];
    if (sort !== 'ix') return current.items;
    return [...current.items].sort((a, b) => byIndex(a.indexNumber ?? '￿', b.indexNumber ?? '￿'));
  }, [current, sort]);
  const docCount = new Map(allFolders.map((f) => [f.id, f.documents]));

  let body: ReactNode;
  let head: ReactNode = null;
  // only admins may learn the room itself is empty
  const nothing = total === 0 && allFolders.every((f) => f.documents === 0);
  if (nothing) {
    let title = 'No documents shared with you yet';
    if (ownGroup) title = `No documents shared with ${ownGroup} yet`;
    else if (isAdmin) title = 'No documents in this room yet';
    body = (
      <div className="empty none">
        <div className="ei"><SearchIcon /></div>
        <h2>{title}</h2>
        <p>There is nothing to search yet. Search covers the names and text of documents once {isAdmin && !ownGroup ? 'they are added' : 'they are shared with you'}.</p>
        {isAdmin ? <div className="row"><Link className="btn secondary" href={roomHref(ws, 'documents')}>Go to Documents</Link></div> : null}
      </div>
    );
  } else if (!runnable) {
    body = (
      <div className="empty">
        <b>Type what you are looking for in the search bar at the top</b>
        <span className="cap">Search covers the names and the text of the {n(total)} documents you can open. Try one of these:</span>
        <div className="chipsx">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="chipq" onClick={() => setQ(x)}>{x}</button>
          ))}
        </div>
      </div>
    );
  } else if (failed && !current) {
    body = (
      <div className="empty" role="alert">
        <b>Search did not answer</b>
        <span className="cap">{failed} Your words are kept, so you can try again.</span>
        <button type="button" className="btn secondary sm" onClick={() => setRetry((r) => r + 1)}>Search again</button>
      </div>
    );
  } else if (!current) {
    body = <div className="empty"><span className="cap">Searching…</span></div>;
  } else if (!current.items.length) {
    const inFolder = current.folder ? folderOf(current.folder) : undefined;
    const browse = inFolder ?? browseFolder(allFolders, terms);
    let example: string | undefined;
    if (inFolder) example = allFolders.find((f) => f.ix.startsWith(`${inFolder.ix}.`))?.ix ?? (inFolder.ix || undefined);
    else if (browse && browse.ix.includes('.')) example = browse.ix;
    else example = allFolders.find((f) => f.ix.includes('.'))?.ix;
    const count = inFolder ? inFolder.published : total;
    const suggestion = shorter && shorter.key === current.key ? shorter.q : '';
    body = (
      <div className="empty none">
        <div className="ei"><SearchIcon /></div>
        <h2>No documents match “{shownQuery}”{current.folder ? ` ${scope}` : ''}</h2>
        <p>Search looks inside the text of the {n(count)} {count === 1 ? 'document' : 'documents'}{inFolder ? ` ${scope}` : ''} {ownGroup ? `shared with ${ownGroup}` : 'you can open'}.</p>
        <ul className="tips">
          <li>Use fewer words. Every word must appear in the document.</li>
          {example ? <li>Search for an index number, such as {example}.</li> : null}
          {current.folder ? <li><button type="button" className="linkbtn" onClick={() => chooseFolder('')}>Search all folders</button> instead.</li> : null}
          {browse
            ? <li>Browse <Link className="linkbtn" href={roomHref(ws, 'documents', browse.id)}>{browse.ix} {browse.name}</Link> in Documents.</li>
            : <li>Browse the folders in <Link className="linkbtn" href={roomHref(ws, 'documents')}>Documents</Link>.</li>}
        </ul>
        {suggestion ? <div className="row"><button type="button" className="btn secondary" onClick={() => setQ(suggestion)}>Search for “{suggestion}”</button></div> : null}
      </div>
    );
  } else {
    head = (
      <div className="rhead">
        <h2>{n(current.total)} {current.total === 1 ? 'result' : 'results'} {scope}</h2>
        <div className="sortby" role="group" aria-label="Sort results">
          <button type="button" aria-pressed={sort === 'best'} onClick={() => setSort('best')}>Best match</button>
          <button type="button" aria-pressed={sort === 'ix'} onClick={() => setSort('ix')}>Index order</button>
        </div>
      </div>
    );
    body = (
      <>
        {shown.map((h) => {
          const isFolder = h.kind === 'folder';
          const name = displayName(h.name, h.kind);
          const ft = fileType(h.name);
          const where = h.path.map((p) => (p.indexNumber ? `${p.indexNumber} ${p.name}` : p.name)).join(' › ');
          const pages = h.pages.slice(0, 2);
          const page = pages[0]?.page ?? null;
          const morePages = h.pagesMatched - pages.length;
          const href = isFolder ? roomHref(ws, 'documents', h.nodeId) : viewHref(ws, h.nodeId, page ?? undefined);
          const label = `Open ${h.indexNumber ? `${h.indexNumber} ` : ''}${name}${page ? ` at page ${page}` : ''}`;
          const nameOnly = h.matchedIn === 'name' && !page && !isFolder && !h.wasNumber;
          return (
            <Link key={h.nodeId} className="hit" href={href} prefetch={false} aria-label={label} data-node={h.nodeId}>
              {isFolder ? <span className="ftype dir"><DirIcon /></span> : <span className={`ftype ${ft.cls}`}>{ft.label}</span>}
              <span className="t">
                {h.indexNumber ? <span className="n">{h.indexNumber}</span> : null}
                <b>{markName(name, terms)}</b>
                {h.wasNumber ? <span className="cap" data-was>was {h.wasNumber}</span> : null}
                {isFolder && docCount.has(h.nodeId) ? <span className="cap">Folder · {n(docCount.get(h.nodeId)!)} documents</span> : null}
              </span>
              <div className="badges">
                {seller && h.state === 'draft' ? <span className="badge b-draft">Draft, bidders cannot see it</span> : null}
                {viewer === 'buyer' && h.isNew ? <span className="badge b-new">New</span> : null}
              </div>
              {where || nameOnly ? (
                <span className="path">{where}{nameOnly ? `${where ? ' · ' : ''}name matches` : ''}</span>
              ) : null}
              {pages.map((p) => (
                <div key={p.page} className="snip"><span className="pg">Page {p.page}</span><Snippet snippet={p.snippet} highlights={p.highlights} /></div>
              ))}
              {pages.length && morePages > 0 ? (
                <div className="more">{n(morePages)} more {morePages === 1 ? 'page matches' : 'pages match'}</div>
              ) : null}
            </Link>
          );
        })}
        {current.total > current.items.length ? (
          <div className="pfoot">
            <span className="cap">Showing {n(current.items.length)} of {n(current.total)}{sort === 'ix' ? ', in index order among those shown' : ''}</span>
            <button type="button" className="btn secondary sm" onClick={more} disabled={busy}>Show {n(Math.min(PAGE, current.total - current.items.length))} more results</button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="c4">
      <div className="head">
        <div>
          <p className="over">{roomName}</p>
          <h1>Search</h1>
          <p className="sub">
            Results for what you type in the search bar at the top. It finds words in document names and in the text inside them, and you only see documents you can open{isAdmin ? ', drafts included' : ''}.
          </p>
        </div>
      </div>
      <div className="qbar">
        <label className="fl" htmlFor="c4-folder">Search in</label>
        <select className="sel" id="c4-folder" value={folder} onChange={(e) => chooseFolder(e.target.value)}>
          <option value="">All folders</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.ix ? `${f.ix} ${f.name}` : f.name}</option>)}
        </select>
        <p className="tips">Every word must match. <code>&quot;exact phrase&quot;</code> keeps words together, <code>-word</code> leaves a word out.</p>
      </div>
      <div className="grid">
        <div className="col">
          <section className="panel" aria-label="Search results" aria-busy={busy}>
            {head}
            {body}
          </section>
        </div>
        <div className="col">
          <section className="panel">
            <div className="ph"><h2>What search covers</h2></div>
            <div className="side-note">
              <span><b>Names and text.</b> Every page of PDFs, Word, Excel and PowerPoint files, once they are processed. A match opens the document at that page.</span>
              <span><b>Only what you can open.</b> {isAdmin ? 'As room admin you also find drafts. Bidders never see them in their results.' : 'Folders and documents outside your access never appear, not even as a count.'}</span>
              <span><b>Scanned pages</b> without a text layer are found by their document name only.</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
