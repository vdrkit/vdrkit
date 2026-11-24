// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect } from 'react';

// e2e waits for data-hydrated. WebKit dev bundles hydrate slowly, and React drops text Playwright typed too early.
export function HydrationMark() {
  useEffect(() => {
    document.documentElement.setAttribute('data-hydrated', '');
  }, []);
  return null;
}
