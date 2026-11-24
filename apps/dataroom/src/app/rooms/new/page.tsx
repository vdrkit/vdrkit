// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { must, serverApi } from '@/api/server';
import { getBranding } from '@/components/outside/OutsidePage';
import { CreateRoomScreen } from '@/components/create-room/CreateRoomScreen';
import '@/styles/create.css';

export const metadata: Metadata = { title: 'Create a room' };

export default async function CreateRoomPage() {
  const api = await serverApi();
  const me = await must(await api.GET('/v1/me'));
  if (!me.canCreateRooms) notFound();
  const [rooms, template, branding] = await Promise.all([
    api.GET('/v1/me/workspaces').then(must),
    api.GET('/v1/room-templates/standard').then(must),
    getBranding(),
  ]);
  return (
    <CreateRoomScreen
      me={{ personId: me.personId, name: me.name, email: me.email, timeZone: me.timeZone, organisation: me.organisation, isSiteAdmin: me.isSiteAdmin }}
      rooms={rooms.items.map((r) => ({ id: r.id, name: r.name, isAdmin: r.isAdmin, state: r.state }))}
      template={template}
      branding={branding}
    />
  );
}
