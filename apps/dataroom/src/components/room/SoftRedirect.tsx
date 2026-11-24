// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect } from 'react';

// redirect() or a router push during a client navigation into a room with a pending NDA leaves an empty page:
// the router reuses the layout's answer, which has no page in it.
export function SoftRedirect({ href }: { href: string }) {
  useEffect(() => { window.location.replace(href); }, [href]);
  return null;
}
