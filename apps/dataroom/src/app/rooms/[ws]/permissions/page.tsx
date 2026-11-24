// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { PermissionsScreen } from '@/components/permissions/PermissionsScreen';
import { RoomPage } from '@/components/room/RoomPage';

export const metadata: Metadata = { title: 'Permissions' };

export default async function Permissions({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const shell = await getRoomShell(ws);
  if (!shell.me.isAdmin) notFound();
  const api = await serverApi();
  const data = await must(await api.GET('/v1/workspaces/{ws}/permissions', { params: { path: { ws } } }), ws);
  return (
    <RoomPage ws={ws} section="permissions">
      <PermissionsScreen ws={ws} initial={data} timeZone={shell.me.timeZone} runBy={shell.room.runBy} />
    </RoomPage>
  );
}
