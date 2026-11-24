// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useModal } from '@/lib/a11y';

export const I = {
  chevR: <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5L7.5 6L4 9.5" /></svg>,
  chevD: <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4L6 7.5L9.5 4" /></svg>,
  plus: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  mail: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5L12 13l8.5-6.5" /></svg>,
  more: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18.5" cy="12" r="1" /></svg>,
  perm: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10c-4-1.7-7-5.5-7-10V6z" /></svg>,
  act: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7l4 14l3-7h4" /></svg>,
  close: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  bid: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.8a3.5 3.5 0 0 1 0 6.4M21 20c0-2.6-1.6-4.8-4-5.6" /></svg>,
  sell: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V8l8-4l8 4v12M9 20v-6h6v6M4 20h16" /></svg>,
};

export function Dlg({ over, title, onClose, busy, foot, children, focus }: {
  over: string; title: string; onClose: () => void; busy?: boolean; foot: ReactNode; children: ReactNode;
  focus?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useModal(box, { onClose, busy, focusFirst: false });
  useEffect(() => {
    const f = (focus ? box.current?.querySelector<HTMLElement>(focus) : null)
      ?? box.current?.querySelector<HTMLElement>('.dlg-b input:not([type=radio]):not([type=checkbox]), .dlg-b select, .dlg-b textarea')
      ?? box.current?.querySelector<HTMLElement>('.dlg-f .btn.primary');
    f?.focus();
  }, []);
  return (
    <>
      <div className="scrim" onClick={() => { if (!busy) onClose(); }} />
      <div ref={box} className="dlg" role="dialog" aria-modal="true" aria-labelledby="dl-h">
        <div className="dlg-h">
          <div><p className="over">{over}</p><h2 id="dl-h">{title}</h2></div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>{I.close}</button>
        </div>
        <div className="dlg-b">{children}</div>
        <div className="dlg-f">{foot}</div>
      </div>
    </>
  );
}

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; separated?: boolean }

export function Menu({ anchor, items, onClose }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const r = anchor.getBoundingClientRect();
    const h = m.offsetHeight;
    m.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    m.style.left = 'auto';
    const below = r.bottom + 4 + h <= window.innerHeight - 8;
    const above = r.top - 4 - h >= 8;
    m.style.top = `${below || !above ? r.bottom + 4 : r.top - 4 - h}px`;
    m.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, [anchor]);
  useEffect(() => {
    const away = (e: MouseEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !anchor.contains(t)) close.current(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close.current(); anchor.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      e.preventDefault();
    };
    // ignore the scroll that brings the button into view on open
    const opened = Date.now();
    const gone = () => { if (Date.now() - opened > 250) close.current(); };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', gone, true);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', gone, true);
      window.removeEventListener('resize', gone);
    };
  }, [anchor]);
  return (
    <div ref={ref} className="menu" role="menu" aria-label={anchor.getAttribute('aria-label') ?? undefined}
      onBlur={(e) => { if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node) && e.relatedTarget !== anchor) close.current(); }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {it.separated ? <hr /> : null}
          <button type="button" role="menuitem" className={it.danger ? 'danger' : undefined} onClick={() => { close.current(); it.onSelect(); }}>{it.label}</button>
        </span>
      ))}
    </div>
  );
}

export function Toast({ toast }: { toast: { title: string; text: string; key: number; error?: boolean } | null }) {
  return (
    <div aria-live="polite">
      {toast ? <div className={toast.error ? 'toast err' : 'toast'} key={toast.key} role={toast.error ? 'alert' : undefined}>
        <i aria-hidden="true">{toast.error ? '!' : '✓'}</i><div><b>{toast.title}</b><span>{toast.text}</span></div></div> : null}
    </div>
  );
}

export function ErrorLine({ text }: { text: string | null }) {
  return text ? <p className="hint" role="alert" style={{ color: 'var(--danger)' }}>{text}</p> : null;
}
