// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { onMenuKeys } from '@/lib/a11y';
import { AboutDialog } from './AboutDialog';
import { MoreIcon } from './icons';

export interface AccountMenuItem {
  label: string;
  hint?: string;
  onSelect?: () => void;
  href?: string;
  external?: boolean;
  about?: true;
}

export function aboutMenuItem(): AccountMenuItem {
  return { label: 'About and source code', hint: 'Shows the version and where to get the source code', about: true };
}

export function privacyMenuItem(privacy: { href: string; external: boolean } | null | undefined): AccountMenuItem[] {
  if (!privacy) return [];
  return [{ label: 'Privacy notice', hint: privacy.external ? 'Opens the site’s privacy notice in a new tab' : 'Opens the site’s privacy notice',
    href: privacy.href, external: privacy.external }];
}

export function AccountMenu({ items }: { items: AccountMenuItem[] }) {
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const [about, setAbout] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    menu.current?.querySelector('button')?.focus();
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setPos(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setPos(null); btn.current?.focus(); }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [pos]);

  function toggle() {
    if (pos) { setPos(null); return; }
    const r = btn.current!.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 248)), bottom: window.innerHeight - r.top + 6 });
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="icon-btn"
        aria-label="Account menu: profile, notification settings, about, sign out"
        aria-haspopup="menu"
        aria-expanded={!!pos}
        onClick={toggle}
      >
        <MoreIcon />
      </button>
      {pos && (
        <div ref={menu} className="fmenu" role="menu" aria-label="Account" style={{ left: pos.left, bottom: pos.bottom, zIndex: 90 }} onKeyDown={onMenuKeys}
          onBlur={(e) => { if (e.relatedTarget && !menu.current?.contains(e.relatedTarget as Node) && e.relatedTarget !== btn.current) setPos(null); }}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" {...(it.about ? { 'data-close-drawer': '' } : {})} onClick={() => {
              setPos(null);
              if (it.about) setAbout(true);
              it.onSelect?.();
              if (it.href && it.external) window.open(it.href, '_blank', 'noopener,noreferrer');
              else if (it.href) window.location.assign(it.href);
            }}>
              {it.label}
              {it.hint && <small>{it.hint}</small>}
            </button>
          ))}
        </div>
      )}
      {/* portal: the phone drawer is transformed and would drag a fixed dialog along */}
      {about && createPortal(<AboutDialog onClose={() => { setAbout(false); btn.current?.focus(); }} />, document.body)}
    </>
  );
}
