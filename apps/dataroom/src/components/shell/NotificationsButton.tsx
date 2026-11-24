// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { BellIcon } from './icons';

// off until there's an in-app feed; the panel would only ever say "You are up to date"
export const SHOW_BELL = false;

export function NotificationsButton({ unread, settingsHref }: { unread: number; settingsHref?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); bell.current?.focus(); } };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <div ref={wrap} className="notif-wrap">
      <button ref={bell} type="button" className="icon-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications, none unread'}
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        <BellIcon />
        {unread > 0 && <s></s>}
      </button>
      {open ? (
        <div className="pop notif-pop" id={id} role="dialog" aria-label="Notifications">
          <div className="ph">
            <h2>Notifications</h2>
            {settingsHref ? <Link className="btn ghost sm" href={settingsHref} title="Opens your notification settings" onClick={() => setOpen(false)}>Settings</Link> : null}
          </div>
          <div className="empty">
            <div className="ei"><BellIcon /></div>
            <h2>You are up to date</h2>
            <p>New documents, deadlines and changes to your access appear here.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
