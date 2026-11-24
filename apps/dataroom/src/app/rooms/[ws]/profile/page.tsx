// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { devIdentityHeaders, realSignIn } from '@dev-tools';
import { redirect } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { RoomPage } from '@/components/room/RoomPage';
import { parseRoomPart } from '@/components/room/see-as';
import { ProfileScreen, type ProfileTab, type RoomNotifications } from '@/components/profile/ProfileScreen';
import '@/styles/profile.css';

export const metadata: Metadata = { title: 'Profile and notifications' };

const TABS: Record<string, ProfileTab> = { details: 'profile', notifications: 'notif', 'sign-in': 'signin' };

export default async function Profile({ params, searchParams }: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { ws } = await params;
  const { tab } = await searchParams;
  // never in see-as mode
  const { room, team } = parseRoomPart(ws);
  if (team !== null) redirect(`/rooms/${room}/profile${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`);
  const shell = await getRoomShell(ws);
  const api = await serverApi();

  const [me, rooms, here, policy, browsers] = await Promise.all([
    api.GET('/v1/me'),
    api.GET('/v1/me/workspaces'),
    api.GET('/v1/workspaces/{ws}/me/notifications', { params: { path: { ws } } }),
    api.GET('/v1/me/sign-in-policy'),
    api.GET('/v1/me/trusted-browsers'),
  ]);
  const profile = await must(me, ws);
  const roomList = await must(rooms, ws);
  const current = await must(here, ws);
  const signIn = await must(policy, ws);

  const others = await Promise.all(roomList.items.filter((r) => r.id !== ws).map(async (r) => {
    const n = await api.GET('/v1/workspaces/{ws}/me/notifications', { params: { path: { ws: r.id } } });
    return n.data ? { id: r.id, name: r.name, settings: n.data } : null;
  }));
  const notifications: RoomNotifications[] = [
    { id: ws, name: shell.room.name, settings: current },
    ...others.filter((x): x is RoomNotifications => x !== null),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <RoomPage ws={ws} section="profile" crumbs={[{ label: 'Your account' }, { label: 'Profile and notifications' }]}>
      <ProfileScreen
        ws={ws}
        initialTab={TABS[tab ?? ''] ?? 'profile'}
        profile={profile}
        rooms={notifications}
        loggedIn={roomList.items.map((r) => r.name)}
        signIn={signIn}
        browsers={browsers.data?.items ?? null}
        viewAs={Object.keys(devIdentityHeaders(await cookies())).length > 0 && !(await realSignIn())}
      />
    </RoomPage>
  );
}
