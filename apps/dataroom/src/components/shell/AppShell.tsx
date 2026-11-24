// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useModal } from '@/lib/a11y';
import { MenuIcon } from './icons';

export function AppShell({
  sidebar,
  topBar,
  children,
  hasIndex = false,
  notice,
}: {
  sidebar: ReactNode;
  topBar: (menuButton: ReactNode) => ReactNode;
  children: ReactNode;
  hasIndex?: boolean;
  notice?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const app = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement | null>(null);
  useEffect(() => { side.current = app.current?.querySelector<HTMLElement>('.side') ?? null; });
  useModal(side, { active: open, focusFirst: false });

  // hidden while closed, so it can't take focus until drawn open
  useEffect(() => {
    if (open) app.current?.querySelector<HTMLElement>('.side .nav a')?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && app.current?.classList.contains('mm-open')) { setOpen(false); btn.current?.focus(); }
    };
    const mq = window.matchMedia('(min-width: 901px)');
    const wide = (m: MediaQueryListEvent) => { if (m.matches) setOpen(false); };
    document.addEventListener('keydown', key);
    mq.addEventListener('change', wide);
    return () => { document.removeEventListener('keydown', key); mq.removeEventListener('change', wide); };
  }, []);

  const menuButton = (
    <button
      ref={btn}
      type="button"
      className="mm-btn"
      aria-label={open ? 'Close the room menu' : 'Open the room menu'}
      aria-expanded={open}
      aria-controls="room-menu"
      onClick={() => setOpen(!open)}
    >
      <MenuIcon />
    </button>
  );

  return (
    <div
      ref={app}
      className={`app${hasIndex ? ' has-index' : ''}${open ? ' mm-open' : ''}`}
      onClick={(e) => { if (open && (e.target as HTMLElement).closest('.side .nav a, .side [data-close-drawer]')) setOpen(false); }}
    >
      {/* WCAG 2.4.1 */}
      <a className="skip" href="#content">Skip to the page</a>
      {sidebar}
      <div className="main">
        {topBar(menuButton)}
        <main className="content" id="content">{notice}{children}</main>
      </div>
      <div className="mm-scrim" onClick={() => setOpen(false)} />
    </div>
  );
}
