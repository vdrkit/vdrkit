// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState } from 'react';
import { NO_BRANDING, privacyLinkOf, type Branding } from './OutsideFrame';

// error boundaries can't fetch on the server
export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(NO_BRANDING);
  useEffect(() => {
    void fetch('/v1/branding', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { organisationName?: string | null; logos?: { light?: { url: string } | null; dark?: { url: string } | null };
        privacyNotice?: { kind: 'url'; url: string } | { kind: 'page' } | null; sourceCode?: { url: string } } | null) => {
        if (!b) return;
        const next: Branding = {
          name: b.organisationName ?? null,
          logos: { light: b.logos?.light?.url ?? null, dark: b.logos?.dark?.url ?? null },
          privacy: privacyLinkOf(b.privacyNotice),
        };
        if (b.sourceCode?.url) next.source = b.sourceCode.url;
        setBranding(next);
      })
      .catch(() => {});
  }, []);
  return branding;
}
