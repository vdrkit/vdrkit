// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { RoomPage } from '@/components/room/RoomPage';
import { TimelineScreen } from '@/components/timeline/TimelineScreen';
import { TimelineView } from '@/components/timeline/TimelineView';
import '@/styles/dashboard.css';
import '@/styles/timeline.css';

export const metadata: Metadata = { title: 'Timeline' };

export default async function Timeline({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const shell = await getRoomShell(ws);
  const api = await serverApi();
  if (!shell.me.isAdmin) {
    const observer = shell.me.canReadActivity;
    // buyer = no seller-side group
    const buyer = !shell.me.groups.some((g) => g.partyKind === 'seller');
    if (!buyer && !observer) notFound();
    const milestones = await must(await api.GET('/v1/workspaces/{ws}/milestones', { params: { path: { ws } } }), ws);
    return (
      <RoomPage ws={ws} section="timeline">
        <TimelineView roomName={shell.room.name} timeZone={shell.me.timeZone} now={new Date().toISOString()} milestones={milestones.items} />
      </RoomPage>
    );
  }
  const [milestones, groups] = await Promise.all([
    api.GET('/v1/workspaces/{ws}/milestones', { params: { path: { ws } } }).then((r) => must(r, ws)),
    api.GET('/v1/workspaces/{ws}/timeline/groups', { params: { path: { ws } } }).then((r) => must(r, ws)),
  ]);
  return (
    <RoomPage ws={ws} section="timeline">
      <TimelineScreen ws={ws} roomName={shell.room.name} roomTimeZone={groups.roomTimeZone} now={new Date().toISOString()}
        milestones={milestones.items} groups={groups.items} />
    </RoomPage>
  );
}
