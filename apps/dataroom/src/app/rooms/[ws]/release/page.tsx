// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { getRoomShell, must, serverApi } from '@/api/server';
import { ReleaseReview } from '@/components/release/ReleaseReview';
import { RoomPage } from '@/components/room/RoomPage';
import '@/styles/release.css';

export const metadata: Metadata = { title: 'Release review' };

export default async function Release({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const api = await serverApi();
  const data = await must(await api.GET('/v1/workspaces/{ws}/release-review', { params: { path: { ws } } }), ws);
  const shell = await getRoomShell(ws);
  return (
    <RoomPage ws={ws} section="documents" tail={[{ label: 'Release review' }]}>
      <ReleaseReview ws={ws} data={data} timeZone={shell.me.timeZone} />
    </RoomPage>
  );
}
