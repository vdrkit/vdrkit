// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { QuickSearchItem } from './types';

export function QuickSearch({
  placeholder,
  items,
  onOpen,
  onSearchAll,
  onQueryChange,
  loading,
  live,
}: {
  placeholder: string;
  items: QuickSearchItem[];
  onOpen?: (item: QuickSearchItem) => void;
  onSearchAll?: (query: string) => void;
  onQueryChange?: (query: string) => void;
  loading?: boolean;
  live?: { value: string; onChange: (query: string) => void };
}) {
  const [own, setOwn] = useState('');
  const q = live ? live.value : own;
  const setQ = (v: string) => {
    if (live) live.onChange(v);
    else { setOwn(v); onQueryChange?.(v); }
  };
  const [open, setOpen] = useState(false);
  // tests wait on this
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const query = q.trim();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let hits: QuickSearchItem[] = [];
  if (query) {
    // old numbers match too
    const matching = items.filter((d) => {
      const text = `${d.ix} ${d.name} ${d.was ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    hits = matching.slice(0, 5);
  }
  const showing = !live && open && query.length > 0;
  const optionCount = hits.length + 1;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function close() {
    setOpen(false);
    input.current?.blur();
  }
  function pick(i: number) {
    const hit = hits[i];
    if (hit) onOpen?.(hit);
    else onSearchAll?.(query);
    close();
  }

  return (
    <div className="search qs" role="search" onClick={() => input.current?.focus()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
      <input
        ref={input}
        className="qs-in"
        data-ready={ready ? '' : undefined}
        type="search"
        placeholder={placeholder}
        aria-label="Search documents"
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={listId}
        aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
        value={q}
        onChange={(e) => { setQ(e.target.value); setActive(-1); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(ev) => {
          if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive((a) => (a + 1 + optionCount) % optionCount); }
          else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive((a) => (a - 1 + optionCount) % optionCount); }
          else if (ev.key === 'Enter') { ev.preventDefault(); if (query && !live) pick(active >= 0 ? active : hits.length); }
          else if (ev.key === 'Escape') close();
        }}
      />
      <kbd>Ctrl K</kbd>
      <div className="qs-pop" id={listId} role="listbox" aria-label="Matching documents" hidden={!showing} onMouseDown={(e) => e.preventDefault()}>
        {showing && (
          <>
            {hits.length ? (
              <>
                <div className="qs-sec" aria-hidden="true">Documents and folders by name</div>
                {hits.map((d, i) => (
                  <button key={d.id ?? d.ix} id={`${listId}-${i}`} tabIndex={-1} type="button" className="qs-opt" role="option" aria-selected={active === i} onClick={() => pick(i)}>
                    <span className="qs-n">{d.ix}</span>
                    <span>{highlight(d.name, words)}</span>
                    <small>{d.was ? `was ${d.was}${d.where ? ' · ' : ''}` : ''}{d.folder ? `Folder in ${d.where}` : d.where}</small>
                  </button>
                ))}
              </>
            ) : null}
            {!hits.length && !loading ? (
              <div className="qs-none" role="option" aria-selected={false} aria-disabled="true">No document or folder names match.</div>
            ) : null}
            <button type="button" id={`${listId}-${hits.length}`} tabIndex={-1} className="qs-opt qs-all" role="option" aria-selected={active === hits.length} onClick={() => pick(hits.length)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              <span>Search inside all documents for “{query}”</span>
              <kbd>Enter</kbd>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function highlight(text: string, words: string[]): ReactNode {
  const marks = words.filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!marks.length) return text;
  const re = new RegExp(`(${marks.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}
