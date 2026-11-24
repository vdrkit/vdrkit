// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useModal } from '@/lib/a11y';

export function SiteDialog({ title, children, foot, onClose, busy }: {
  title: string;
  children: ReactNode;
  foot: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useModal(box, { focusFirst: false });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('textarea, input, .df .btn.primary');
    first?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busyRef.current) { e.preventDefault(); closeRef.current(); } };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); before?.focus?.(); };
  }, []);

  return (
    <div className="g2-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={box} className="g2-dlg" role="dialog" aria-modal="true" aria-labelledby="g2-dlg-t">
        <div className="dh"><h2 id="g2-dlg-t">{title}</h2></div>
        <div className="db">{children}</div>
        <div className="df">{foot}</div>
      </div>
    </div>
  );
}
