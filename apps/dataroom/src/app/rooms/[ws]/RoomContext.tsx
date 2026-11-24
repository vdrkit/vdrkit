// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Branding } from '@/components/outside/OutsideFrame';
import type { SeeAsTeam } from '@/components/room/SeeAs';
import type { SiteNoticeData } from '@/components/site/SiteNotice';

export interface RoomContextValue {
  room: { id: string; name: string };
  branding: Branding;
  seeAs?: SeeAsTeam | null;
  notice?: SiteNoticeData | null;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function RoomProvider({ value, children }: { value: RoomContextValue; children: ReactNode }) {
  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export const useRoom = () => useContext(RoomContext);
