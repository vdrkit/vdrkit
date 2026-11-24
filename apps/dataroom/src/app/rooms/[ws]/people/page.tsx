// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { PeopleScreen } from '@/components/people/PeopleScreen';
import { RoomPage } from '@/components/room/RoomPage';
import '@/styles/people.css';

export const metadata: Metadata = { title: 'People' };

export default async function PeoplePage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const shell = await getRoomShell(ws);
  if (!shell.me.isAdmin) notFound();
  const api = await serverApi();
  const path = { params: { path: { ws } } };
  const [people, requests, removals, settings] = await Promise.all([
    api.GET('/v1/workspaces/{ws}/people', path),
    api.GET('/v1/workspaces/{ws}/team-requests', { params: { path: { ws }, query: { status: 'pending' } } }),
    api.GET('/v1/workspaces/{ws}/removal-requests', { params: { path: { ws }, query: { status: 'pending' } } }),
    api.GET('/v1/workspaces/{ws}/settings', path),
  ]);
  const p = await must(people, ws);
  const rq = await must(requests, ws);
  const rm = await must(removals, ws);
  const st = await must(settings, ws);
  const signed = st.invitation.message.split('{signature}').join(`${shell.me.name}\n${shell.room.runBy}`);
  const folders = shell.index.filter((f) => !f.parentId).map((f) => ({ id: f.id, ix: f.indexNumber ?? '', name: f.name }));
  return (
    <RoomPage ws={ws} section="people">
      <PeopleScreen ws={ws} people={p} requests={rq.items} removals={rm.items}
        invitation={{ message: signed, leadParagraph: st.invitation.leadParagraph }}
        folders={folders} myPersonId={shell.me.personId} timeZone={shell.me.timeZone} roomTz={shell.room.timeZone} now={new Date().toISOString()}
        roomHolds={shell.room.state === 'preparing' || shell.room.state === 'closed'} />
    </RoomPage>
  );
}
