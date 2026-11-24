// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { notePlace } from '@/lib/last-place';

function Track() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => { notePlace(`${pathname}${search ? `?${search}` : ''}`); }, [pathname, search]);
  return null;
}

export function PlaceTracker() {
  return <Suspense fallback={null}><Track /></Suspense>;
}
