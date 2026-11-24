// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { must, serverApi } from '@/api/server';
import { getBranding } from '@/components/outside/OutsidePage';
import { roomHref } from '@/components/room/routes';
import { MyRooms } from '@/components/rooms/MyRooms';
import { OutsideRoomFrame } from '@/components/rooms/OutsideRoomFrame';
import type { MyRoomsResponse } from '@/components/rooms/model';
import { devAuthOn } from '@/lib/dev-auth';
import '@/styles/rooms.css';

export const metadata: Metadata = { title: 'My rooms' };

export default async function MyRoomsPage() {
  const api = await serverApi();
  const [rooms, me, branding] = await Promise.all([api.GET('/v1/me/rooms').then(must), api.GET('/v1/me').then(must), getBranding()]);
  const data: MyRoomsResponse = rooms;
  const profileRoom = data.rooms.find((r) => r.canEnter) ?? null;
  return (
    <OutsideRoomFrame
      runBy={data.runBy}
      person={{ personId: me.personId, name: me.name, role: personLine(data, me) }}
      current="rooms"
      roomCount={data.rooms.length}
      canCreateRooms={data.canCreateRooms}
      isSiteAdmin={data.isSiteAdmin}
      profileHref={profileRoom ? roomHref(profileRoom.id, 'profile') : null}
      crumb="My rooms"
      privacy={branding.privacy ?? null}
      idle={!devAuthOn()}
    >
      <MyRooms data={data} timeZone={me.timeZone} now={new Date().toISOString()} />
    </OutsideRoomFrame>
  );
}

function personLine(d: MyRoomsResponse, me: { company: string | null; jobTitle: string | null; email: string }): string {
  const admin = d.rooms.some((r) => r.isAdmin) || d.past.some((r) => r.isAdmin);
  let what = me.jobTitle;
  if (d.isSiteAdmin) what = admin ? 'Room and site admin' : 'Site admin';
  else if (admin) what = 'Room admin';
  const where = me.company ?? (admin || d.isSiteAdmin ? d.runBy : null);
  return [what, where].filter(Boolean).join(' · ') || me.email;
}
