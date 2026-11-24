// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])', 'summary',
].join(', ');

export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.closest('[inert], [hidden]')) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  });
}

const isNamedRadio = (el: HTMLElement): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio' && !!el.name;

function tabStops(list: HTMLElement[], at: HTMLElement | null): HTMLElement[] {
  const groups = new Map<string, HTMLInputElement[]>();
  for (const el of list) {
    if (isNamedRadio(el)) groups.set(el.name, [...(groups.get(el.name) ?? []), el]);
  }
  return list.filter((el) => {
    if (!isNamedRadio(el)) return true;
    const g = groups.get(el.name)!;
    const stop = g.find((x) => x === at) ?? g.find((x) => x.checked) ?? g[0];
    return el === stop;
  });
}

// Focus trap. Use `active` when the parent shows and hides the dialog instead of unmounting it.
export function useModal(box: RefObject<HTMLElement | null>, opts: { onClose?: () => void; busy?: boolean; focusFirst?: boolean; active?: boolean } = {}) {
  const close = useRef(opts.onClose);
  close.current = opts.onClose;
  const busy = useRef(opts.busy);
  busy.current = opts.busy;
  const focusFirst = opts.focusFirst ?? true;
  const active = opts.active ?? true;

  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const el = box.current;
    if (el && focusFirst && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>('[data-autofocus]')
        ?? tabbables(el).find((x) => x.matches('input, select, textarea'))
        ?? tabbables(el)[0];
      (first ?? el).focus();
    }
    const key = (e: globalThis.KeyboardEvent) => {
      const root = box.current;
      if (!root) return;
      if (e.key === 'Escape' && close.current && !busy.current) {
        if (e.defaultPrevented) return;
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // every Tab, not just at the ends: Safari skips links and would escape the dialog
      e.preventDefault();
      const at = document.activeElement as HTMLElement | null;
      const list = tabStops(tabbables(root), at);
      if (!list.length) return;
      if (!at || !root.contains(at)) { (e.shiftKey ? list[list.length - 1]! : list[0]!).focus(); return; }
      const i = list.indexOf(at);
      let next: number;
      if (i >= 0) {
        next = e.shiftKey ? i - 1 : i + 1;
      } else {
        const after = list.findIndex((x) => at.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
        const from = after < 0 ? list.length : after;
        next = e.shiftKey ? from - 1 : from;
      }
      list[(next + list.length) % list.length]!.focus();
    };
    // window, not document: menus inside get Escape first
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (before && before.isConnected && before !== document.body) before.focus({ preventScroll: true });
    };
  }, [active]);
}

export function onMenuKeys(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  let to: number;
  switch (e.key) {
    case 'ArrowDown': to = i + 1; break;
    case 'ArrowUp': to = i < 0 ? last : i - 1; break;
    case 'Home': to = 0; break;
    case 'End': to = last; break;
    default: return;
  }
  e.preventDefault();
  items[(to + items.length) % items.length]!.focus();
}

export function onTabListKeys(e: KeyboardEvent<HTMLElement>) {
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not(:disabled)')];
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  let to: number;
  switch (e.key) {
    case 'ArrowRight': to = i + 1; break;
    case 'ArrowLeft': to = i - 1; break;
    case 'Home': to = 0; break;
    case 'End': to = tabs.length - 1; break;
    default: return;
  }
  e.preventDefault();
  const t = tabs[(to + tabs.length) % tabs.length]!;
  t.focus();
  t.click();
}
