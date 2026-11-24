// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useLayoutEffect } from 'react';
import { THEME_BOOT_SCRIPT, THEME_KEY } from '@/lib/theme';

// Runs before first paint. text/plain on the client because React warns about scripts it creates.
// React drops data-theme when it rebuilds <html>; the effect puts it back.
export function ThemeBoot() {
  useLayoutEffect(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      const root = document.documentElement;
      if ((t === 'light' || t === 'dark') && root.getAttribute('data-theme') !== t) root.setAttribute('data-theme', t);
    } catch {
      // storage may be blocked; system setting then
    }
  }, []);
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
    />
  );
}
