// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { onMenuKeys } from '@/lib/a11y';

export interface MenuItem {
  label: string;
  hint?: string;
  onSelect: () => void;
  separated?: boolean;
  heading?: string;
  disabled?: boolean;
}

export function FloatMenu({ anchor, items, onClose, label }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const r = anchor.getBoundingClientRect();
    const h = m.offsetHeight;
    m.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    const below = r.bottom + 4 + h <= window.innerHeight - 8;
    const above = r.top - 4 - h >= 8;
    m.style.top = `${below || !above ? r.bottom + 4 : r.top - 4 - h}px`;
    m.querySelector<HTMLElement>('button')?.focus();
  }, [anchor]);

  // items may arrive late; menu holds focus meanwhile
  const firstEnabled = items.findIndex((it) => !it.disabled);
  useEffect(() => {
    const m = ref.current;
    if (!m || m.contains(document.activeElement) && document.activeElement !== m) return;
    (m.querySelector<HTMLElement>('button:not(:disabled)') ?? m).focus();
  }, [firstEnabled]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) close.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close.current(); anchor.focus(); } };
    // scroll-into-view of the button fires after open; only close if it moved
    const at = anchor.getBoundingClientRect();
    const gone = () => {
      const now = anchor.getBoundingClientRect();
      if (Math.abs(now.top - at.top) > 1 || Math.abs(now.left - at.left) > 1) close.current();
    };
    const resized = () => close.current();
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', gone, true);
    window.addEventListener('resize', resized);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', gone, true);
      window.removeEventListener('resize', resized);
    };
  }, [anchor]);

  const out: ReactNode[] = [];
  items.forEach((it, i) => {
    if (it.separated) out.push(<hr key={`hr${i}`} />);
    if (it.heading) out.push(<p key={`h${i}`} className="fmenu-h" role="presentation">{it.heading}</p>);
    out.push(
      <button key={i} type="button" role="menuitem" disabled={it.disabled} onClick={() => { if (it.disabled) return; close.current(); it.onSelect(); }}>
        {it.label}{it.hint ? <small>{it.hint}</small> : null}
      </button>,
    );
  });
  return (
    <div ref={ref} className="fmenu" role="menu" aria-label={label} tabIndex={-1} onKeyDown={onMenuKeys}
      onBlur={(e) => { if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node) && e.relatedTarget !== anchor) close.current(); }}>
      {out}
    </div>
  );
}
