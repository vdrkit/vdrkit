// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRef } from 'react';

// A ref, not state: two clicks in the same tick would both see false.
// One hook guards all the handlers it wraps.
export function useSendOnce() {
  const running = useRef(false);
  return <A extends unknown[]>(send: (...args: A) => Promise<unknown> | unknown) => async (...args: A): Promise<void> => {
    if (running.current) return;
    running.current = true;
    try {
      await send(...args);
    } finally {
      running.current = false;
    }
  };
}
