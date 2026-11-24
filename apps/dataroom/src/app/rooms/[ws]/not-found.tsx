// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { NotAvailable } from '@/components/errors/pages';
import { NO_BRANDING, OutsideFrame } from '@/components/outside/OutsideFrame';
import { SeeAsBar } from '@/components/room/SeeAs';
import { useRoom } from './RoomContext';

export default function RoomNotFound() {
  const ctx = useRoom();
  return (
    <>
      {/* Client components can't export metadata. */}
      <title>VDRkit Page not available</title>
      {ctx?.seeAs ? <SeeAsBar ws={ctx.room.id} team={ctx.seeAs} /> : null}
      <OutsideFrame branding={ctx?.branding ?? NO_BRANDING}>
        <NotAvailable room={ctx?.room} seeAs={!!ctx?.seeAs} />
      </OutsideFrame>
    </>
  );
}
