// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { ActivityBody } from '@/components/activity/ActivityBody';
import { filtersFrom, logQuery } from '@/components/activity/model';
import { RoomPage } from '@/components/room/RoomPage';
import '@/styles/activity.css';

export const metadata: Metadata = { title: 'Activity' };

export default async function Activity({ params, searchParams }: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ws } = await params;
  const shell = await getRoomShell(ws);
  if (!shell.me.canReadActivity) notFound();
  const filters = filtersFrom(await searchParams);
  const timeZone = shell.me.timeZone;
  const api = await serverApi();
  const [summary, log, chain] = await Promise.all([
    api.GET('/v1/workspaces/{ws}/activity/summary', { params: { path: { ws } } }).then((r) => must(r, ws)),
    api.GET('/v1/workspaces/{ws}/events', { params: { path: { ws }, query: { ...logQuery(filters, timeZone), limit: 100 } } }).then((r) => must(r, ws)),
    api.GET('/v1/workspaces/{ws}/events/verify', { params: { path: { ws } } }).then((r) => must(r, ws)),
  ]);
  if (filters.group && !summary.groups.some((g) => g.id === filters.group)) { filters.group = ''; filters.person = ''; }
  const people = filters.group && shell.me.isAdmin
    ? (await api.GET('/v1/workspaces/{ws}/activity/groups/{group}/people', { params: { path: { ws, group: filters.group } } })).data ?? null
    : null;

  return (
    <RoomPage ws={ws} section="activity">
      <ActivityBody ws={ws} roomName={shell.room.name} timeZone={timeZone} isAdmin={shell.me.isAdmin}
        summary={summary} initialLog={log} initialPeople={people} chain={chain} initialFilters={filters} />
    </RoomPage>
  );
}
