// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { RoomPage } from '@/components/room/RoomPage';
import { TeamScreen } from '@/components/team/TeamScreen';
import '@/styles/team.css';

export const metadata: Metadata = { title: 'My team' };

export default async function MyTeam({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const shell = await getRoomShell(ws);
  const buyer = !shell.me.isAdmin && shell.me.groups.some((g) => g.partyKind === 'bidder' || g.partyKind === 'financier');
  if (!buyer) notFound();

  const api = await serverApi();
  const team = await must(await api.GET('/v1/workspaces/{ws}/my-team', { params: { path: { ws } } }), ws);
  const own = shell.me.groups.filter((g) => g.partyKind === 'bidder' || g.partyKind === 'financier')
    .sort((a, b) => Number(!!a.parentGroupId) - Number(!!b.parentGroupId))[0]!;
  const group = team.groups.find((g) => g.id === own.id);
  if (!group) notFound();
  // subgroup leads don't count
  const requests = group.isLead && !own.parentGroupId
    ? (await must(await api.GET('/v1/workspaces/{ws}/team-requests', { params: { path: { ws } } }), ws)).items.filter((r) => r.groupId === group.id)
    : null;
  const tops = shell.index.filter((f) => !f.parentId).length;

  return (
    <RoomPage ws={ws} section="team">
      <TeamScreen ws={ws} me={{ personId: shell.me.personId, name: shell.me.name, timeZone: shell.me.timeZone }}
        group={group} subgroup={!!own.parentGroupId} requests={requests} roomAdmins={team.roomAdmins}
        sees={{ folders: tops, documents: shell.documents.published }} now={new Date().toISOString()} />
    </RoomPage>
  );
}
