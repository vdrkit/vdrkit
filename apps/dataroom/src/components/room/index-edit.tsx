// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { createContext, useContext, useEffect } from 'react';
import type { IndexEdit } from '@/components/shell/DocumentIndex';

// lets the Documents screen drive edit mode in the frame's index
export const IndexEditContext = createContext<(edit: IndexEdit | null) => void>(() => {});

export function useIndexEdit(edit: IndexEdit | null) {
  const set = useContext(IndexEditContext);
  useEffect(() => {
    set(edit);
    return () => set(null);
  }, [set, edit]);
}
