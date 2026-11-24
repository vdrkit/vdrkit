// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';

// one-time-code autofill can drop several digits into any box
export function CodeBoxes({ onChange, onEnter, bad, reset = 0, autoFocus = true, label = 'Six-digit code', errorId }: {
  onChange: (v: string) => void; onEnter?: () => void; bad?: boolean; reset?: number; autoFocus?: boolean; label?: string;
  errorId?: string;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);

  useEffect(() => {
    setDigits(['', '', '', '', '', '']);
    onChange('');
    if (autoFocus) boxes.current[0]?.focus({ preventScroll: true });
    // onChange is a new function every render; only `reset` clears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset, autoFocus]);

  function update(next: string[]) {
    setDigits(next);
    onChange(next.join(''));
  }

  function fill(i: number, text: string) {
    const t = text.replace(/\D/g, '').slice(0, 6 - i);
    const next = digits.map((x, k) => (k >= i && k < i + t.length ? t[k - i]! : x));
    update(next);
    boxes.current[Math.min(i + t.length, 5)]?.focus();
  }

  return (
    <div className={`code${bad ? ' bad' : ''}`} role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { boxes.current[i] = el; }}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={`${label}, digit ${i + 1} of 6`}
          aria-invalid={bad || undefined}
          aria-describedby={errorId}
          data-d={i + 1}
          value={d}
          onChange={(e) => {
            const all = e.target.value.replace(/\D/g, '');
            if (all.length > 2 || (all.length === 2 && !d)) { fill(i, all); return; }
            const v = all.replace(d, '').slice(-1) || all.slice(-1);
            update(digits.map((x, k) => (k === i ? v : x)));
            if (v) boxes.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !d && i > 0) boxes.current[i - 1]?.focus();
            if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); }
          }}
          onPaste={(e) => {
            const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
            if (!t) return;
            e.preventDefault();
            if (t.length === 6) { update(t.split('')); boxes.current[5]?.focus(); } else fill(i, t);
          }}
        />
      ))}
    </div>
  );
}
