// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { onMenuKeys } from '@/lib/a11y';
import { THEME_CHOICES, THEME_KEY, themeChoiceLabel, type ThemeChoice } from '@/lib/theme';
import { MoonIcon, SunIcon, SystemIcon } from './icons';

function readChoice(): ThemeChoice {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

/** system: drop both the stored value and the attribute */
function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage blocked; lasts for this page
  }
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

const ICONS: Record<ThemeChoice, () => JSX.Element> = { light: SunIcon, dark: MoonIcon, system: SystemIcon };

const CheckIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;

// All three icons render and CSS picks by data-theme, so it's right before hydration
export function ThemeButton() {
  const [choice, setChoice] = useState<ThemeChoice | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => { setChoice(readChoice()); }, []);

  useEffect(() => {
    if (!pos) return;
    (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('button'))?.focus();
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setPos(null);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [pos]);

  function toggle() {
    if (pos) { setPos(null); return; }
    setChoice(readChoice());
    const r = btn.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }

  function close() {
    setPos(null);
    btn.current?.focus();
  }

  function choose(c: ThemeChoice) {
    apply(c);
    setChoice(c);
    close();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      // or Esc would close the viewer too
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') { setPos(null); return; }
    onMenuKeys(e);
  }

  const label = choice ? `Theme: ${themeChoiceLabel(choice)}` : 'Theme';

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="icon-btn theme-btn"
        id="theme-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        data-choice={choice ?? undefined}
        onClick={toggle}
      >
        <span className="ti ti-sun"><SunIcon /></span>
        <span className="ti ti-moon"><MoonIcon /></span>
        <span className="ti ti-sys"><SystemIcon /></span>
      </button>
      {pos && (
        <div ref={menu} className="fmenu theme-menu" role="menu" aria-label="Theme" style={{ top: pos.top, right: pos.right, zIndex: 95 }}
          onKeyDown={onKeyDown}
          onBlur={(e) => { if (e.relatedTarget && !menu.current?.contains(e.relatedTarget as Node) && e.relatedTarget !== btn.current) setPos(null); }}>
          {THEME_CHOICES.map((c) => {
            const Ico = ICONS[c.value];
            const on = c.value === choice;
            return (
              <button key={c.value} type="button" role="menuitemradio" aria-checked={on} data-theme-choice={c.value}
                tabIndex={on ? 0 : -1} onClick={() => choose(c.value)}>
                <span className="tm-ico"><Ico /></span>
                <span className="tm-label">{c.label}</span>
                <span className="tm-check">{on ? <CheckIcon /> : null}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
