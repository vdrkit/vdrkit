// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from 'next/navigation';
import { must, serverApi } from '@/api/server';
import { AccessEnded } from '@/components/errors/pages';
import { OutsidePage } from '@/components/outside/OutsidePage';
import { MY_ROOMS_HREF } from '@/components/rooms/routes';

export default async function Home() {
  const api = await serverApi();
  if ((await api.GET('/v1/setup')).data?.open) redirect('/setup');
  const rooms = await must(await api.GET('/v1/me/workspaces'));
  const home = rooms.items.find((r) => r.id === rooms.openAtSignInWorkspaceId);
  if (home) redirect(`/rooms/${home.id}/dashboard`);
  const current = rooms.items.filter((r) => r.state !== 'closed' && r.state !== 'archived');
  if (current.length === 1) redirect(`/rooms/${current[0]!.id}/dashboard`);
  if (rooms.items.length > 0) redirect(MY_ROOMS_HREF);
  const me = await must(await api.GET('/v1/me'));
  if (me.canCreateRooms || me.isSiteAdmin) redirect(MY_ROOMS_HREF);
  return <OutsidePage><AccessEnded /></OutsidePage>;
}
