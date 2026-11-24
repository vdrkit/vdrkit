// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import type { RoomShellData } from '@/api/server';
import type { QuickSearchItem } from '@/components/shell';
import { byIndex, displayName } from '@/lib/search';

// ?q= kept in step for reload and Back
interface SearchQuery {
  q: string;
  setQ: (q: string) => void;
}

const Ctx = createContext<SearchQuery | null>(null);

export function replaceParam(name: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function SearchQueryProvider({ initial, children }: { initial: string; children: ReactNode }) {
  const [q, set] = useState(initial);
  const setQ = useCallback((v: string) => {
    set(v);
    replaceParam('q', v.trim() ? v : null);
  }, []);
  return <Ctx.Provider value={{ q, setQ }}>{children}</Ctx.Provider>;
}

export function useSearchQuery(): SearchQuery {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSearchQuery() is only available on the Search page');
  return v;
}

type Flat = RoomShellData['index'][number];

const INDEX_NUMBER = /^\d+(?:\.\d+)*\.?$/;

export function useQuickSearchItems(shell: RoomShellData) {
  const ws = shell.room.id;
  const label = (f: { indexNumber: string | null; name: string }) => (f.indexNumber ? `${f.indexNumber} ${f.name}` : f.name);
  const pathOf = (f: Flat): string => {
    const out: string[] = [];
    let p = shell.index.find((x) => x.id === f.parentId);
    while (p) {
      out.unshift(label(p));
      const parentId = p.parentId;
      p = shell.index.find((x) => x.id === parentId);
    }
    return out.join(' › ');
  };
  const folders: QuickSearchItem[] = shell.index.map((f) => ({ id: f.id, ix: f.indexNumber ?? '', name: f.name, where: pathOf(f), folder: true }));

  const [found, setFound] = useState<QuickSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const listings = useRef(new Map<string, Promise<QuickSearchItem[]>>());

  useEffect(() => () => { window.clearTimeout(timer.current); abort.current?.abort(); }, []);

  function childrenOf(folder: Flat): Promise<QuickSearchItem[]> {
    let p = listings.current.get(folder.id);
    if (!p) {
      const where = [pathOf(folder), label(folder)].filter(Boolean).join(' › ');
      p = browserApi().GET('/v1/workspaces/{ws}/nodes', { params: { path: { ws }, query: { parent: folder.id } } })
        .then(({ data }) => (data?.items ?? []).filter((n) => n.kind === 'document')
          .map((n) => ({ id: n.id, ix: n.indexNumber ?? '', name: displayName(n.name), where })))
        .catch(() => []);
      listings.current.set(folder.id, p);
    }
    return p;
  }

  function onQueryChange(raw: string) {
    window.clearTimeout(timer.current);
    abort.current?.abort();
    const q = raw.trim();
    if (!q) { setFound([]); setLoading(false); return; }
    const ctl = new AbortController();
    abort.current = ctl;
    setLoading(true);
    let names: QuickSearchItem[] | null = null;
    let numbers: QuickSearchItem[] | null = null;
    const show = () => {
      if (ctl.signal.aborted) return;
      setFound([...(names ?? []), ...(numbers ?? [])]);
      if (names && numbers) setLoading(false);
    };
    if (INDEX_NUMBER.test(q)) {
      const ix = q.replace(/\.$/, '');
      const parentIx = ix.includes('.') ? ix.slice(0, ix.lastIndexOf('.')) : null;
      const holders = shell.index.filter((f) => f.indexNumber === ix || (parentIx !== null && f.indexNumber === parentIx));
      void Promise.all(holders.map(childrenOf)).then((lists) => { numbers = lists.flat(); show(); });
    } else numbers = [];
    timer.current = window.setTimeout(() => {
      void browserApi().GET('/v1/workspaces/{ws}/search', { params: { path: { ws }, query: { q, limit: 25, match: 'names' } }, signal: ctl.signal })
        .then(({ data }) => (data?.items ?? []).map((r) => {
          const item: QuickSearchItem = {
            id: r.nodeId, ix: r.indexNumber ?? '', name: displayName(r.name, r.kind), folder: r.kind === 'folder',
            where: r.path.map(label).join(' › '),
          };
          if (r.wasNumber) item.was = r.wasNumber;
          return item;
        }))
        .catch((): QuickSearchItem[] => [])
        .then((items) => { names = items; show(); });
    }, 150);
  }

  const seen = new Set<string>();
  const items: QuickSearchItem[] = [];
  // found first, so an old-number hit keeps its "was"
  for (const i of [...found, ...folders]) {
    if (i.id && seen.has(i.id)) continue;
    if (i.id) seen.add(i.id);
    items.push(i);
  }
  items.sort((a, b) => byIndex(a.ix, b.ix));
  return { items, onQueryChange, loading };
}
