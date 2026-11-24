// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState } from 'react';
import { clockTime, sameClock, utcOffsetLabel, zoneAbbreviation } from '@/lib/clock';

export function RoomClock({ roomTimeZone, ownTimeZone }: { roomTimeZone: string; ownTimeZone?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  const [own, setOwn] = useState<string | undefined>(ownTimeZone);

  useEffect(() => {
    if (!ownTimeZone) setOwn(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, [ownTimeZone]);

  // keep the space so the top bar doesn't jump
  if (!now) {
    return <div className="clock" aria-hidden="true"><div className="room-t"><small>Room time</small><b>&nbsp;</b></div></div>;
  }

  const zone = zoneAbbreviation(roomTimeZone, now);
  const offset = utcOffsetLabel(roomTimeZone, now);
  const same = !own || sameClock(roomTimeZone, own, now);

  if (same) {
    return (
      <div className="clock" title={`The room's time zone is ${zone} (${offset}), which is also yours.`}>
        <div className="room-t"><small>Room time</small><b>{clockTime(roomTimeZone, now)}</b></div>
      </div>
    );
  }
  return (
    <div className="clock" title={`Deadlines in this room are set in the room's time zone, ${zone} (${offset}).`}>
      <div className="room-t"><small>Room</small><b>{clockTime(roomTimeZone, now)}</b></div>
      <div><small>You</small><b>{clockTime(own!, now)}</b></div>
    </div>
  );
}
