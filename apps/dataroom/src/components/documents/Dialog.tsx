// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useModal } from '@/lib/a11y';

const CloseIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;

export function Dialog({ over, title, narrow, onClose, busy, foot, children, label }: {
  over: string;
  title: string;
  narrow?: boolean;
  onClose: () => void;
  busy?: boolean;
  foot: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  const box = useRef<HTMLElement>(null);
  useModal(box, { onClose, busy, focusFirst: false });

  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('.dw-b input, .dw-b select, .dw-f .btn.primary, .dw-f .btn');
    first?.focus();
  }, []);

  return (
    <>
      <div className="scrim" onClick={() => { if (!busy) onClose(); }} />
      <aside ref={box} className={`drawer${narrow ? ' nf' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dw-t" aria-label={label}>
        <div className="dw-h">
          <div><p className="over">{over}</p><h2 id="dw-t">{title}</h2></div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}><CloseIcon /></button>
        </div>
        <div className="dw-b">{children}</div>
        <div className="dw-f">{foot}</div>
      </aside>
    </>
  );
}
