// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { currentPath, getRoomShellAnswer, must, serverApi, type RoomShellData } from '@/api/server';
import type { Problem } from '@/api/client';
import { RoomClosed, RoomNotOpen, type RoomFacts } from '@/components/errors/pages';
import { getBranding } from '@/components/outside/OutsidePage';
import { OutsideFrame } from '@/components/outside/OutsideFrame';
import { SoftRedirect } from '@/components/room/SoftRedirect';
import { getSiteNotice } from '@/components/site/notice';
import { RoomProvider } from './RoomContext';

export default async function RoomLayout({ children, params }: { children: ReactNode; params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const answer = await getRoomShellAnswer(ws);
  const reason = (answer.error as Problem | undefined)?.reason;
  if (answer.response.status === 403 && (reason === 'room_preparing' || reason === 'room_closed')) {
    return <RoomStatePage ws={ws} closed={reason === 'room_closed'} />;
  }
  const shell: RoomShellData = await must(answer, ws);
  const [branding, notice] = await Promise.all([getBranding(), getSiteNotice()]);

  const path = await currentPath();
  if (!path.startsWith(`/rooms/${ws}/nda`)) {
    const api = await serverApi();
    const nda = await api.GET('/v1/workspaces/{ws}/nda', { params: { path: { ws } } });
    if (nda.data?.mustAccept) {
      // not redirect(): thrown from a layout it loops on client-side navigation
      return <SoftRedirect href={`/rooms/${ws}/nda?next=${encodeURIComponent(path)}`} />;
    }
  }

  return <RoomProvider value={{ room: { id: ws, name: shell.room.name }, branding, seeAs: shell.seeAs ?? null, notice }}>{children}</RoomProvider>;
}

async function RoomStatePage({ ws, closed }: { ws: string; closed: boolean }) {
  const api = await serverApi();
  const [rooms, me, branding] = await Promise.all([api.GET('/v1/me/workspaces'), api.GET('/v1/me'), getBranding()]);
  const r = rooms.data?.items.find((x) => x.id === ws);
  const room: RoomFacts = {
    name: r?.name ?? 'This room', runBy: branding.name, onBehalfOf: r?.onBehalfOf ?? null,
    contactName: r?.contactName ?? null, stateSince: r?.stateSince ?? null,
  };
  return (
    <OutsideFrame branding={branding}>
      {closed ? <RoomClosed room={room} timeZone={me.data?.timeZone ?? 'UTC'} /> : <RoomNotOpen room={room} />}
    </OutsideFrame>
  );
}
