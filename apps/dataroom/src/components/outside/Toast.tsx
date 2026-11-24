// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useToast() {
  const [t, setT] = useState<{ title: string; line: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((title: string, line: string) => {
    setT({ title, line });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setT(null), 3500);
  }, []);
  const node = (
    <div aria-live="polite">
      {t ? <div className="toast"><i>✓</i><div><b>{t.title}</b><span>{t.line}</span></div></div> : null}
    </div>
  );
  return { show, node };
}
