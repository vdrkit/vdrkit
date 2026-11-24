// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { browserApi } from '@/api/browser';
import { useSendOnce } from '@/lib/send-once';
import { releasedToast, type ReleaseInfo, type ReleaseTarget } from './release-one';

export function useReleaseOne(ws: string, info: ReleaseInfo | null, show: (title: string, line: string) => void, onError: (message: string) => void) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const once = useSendOnce();
  const [released, setReleased] = useState<Set<string>>(() => new Set());
  useEffect(() => { setReleased(new Set()); }, [info]);

  const release = once(async (t: ReleaseTarget, label: string, versionNo: number | null, quiet: boolean = false) => {
    if (!info || busy) return;
    setBusy(t.id);
    const r = await browserApi().POST('/v1/workspaces/{ws}/publish', {
      params: { path: { ws } },
      body: t.versionId ? { versionIds: [t.versionId], quiet } : { nodeIds: [t.id], quiet },
    });
    setBusy(null);
    if (r.data) {
      setReleased((s) => new Set(s).add(t.id));
      // includes draft folders above
      const along = t.versionId ? 0 : Math.max(0, r.data.published - 1);
      const msg = releasedToast(info.rules, t, label, versionNo, along, r.data.quiet);
      show(msg.title, msg.line);
      router.refresh();
      return;
    }
    const p = r.error as { detail?: string; title?: string } | undefined;
    onError(p?.detail ?? p?.title ?? 'Releasing did not work. Nothing was published. Try again.');
    router.refresh();
  });

  return { busy, released, release };
}
