// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { getRoomShell, must, serverApi } from '@/api/server';
import { DocumentDetails } from '@/components/details/DocumentDetails';
import { loadReleaseInfo } from '@/components/documents/release-one';
import { RoomPage } from '@/components/room/RoomPage';
import '@/styles/details.css';

export const metadata: Metadata = { title: 'Versions and details' };

export default async function Details({ params }: { params: Promise<{ ws: string; node: string }> }) {
  const { ws, node: id } = await params;
  const api = await serverApi();
  const details = await must(await api.GET('/v1/workspaces/{ws}/nodes/{id}/details', { params: { path: { ws, id } } }), ws);
  const shell = await getRoomShell(ws);
  const folder = details.document.path.at(-1);
  const waits = details.versions.some((v) => v.status === 'draft' || v.status === 'waiting');
  const release = details.me.canPublish && waits && folder ? await loadReleaseInfo(api, ws, folder.id) : null;
  const name = details.document.name.replace(/\.[a-z0-9]{1,6}$/i, '');
  return (
    <RoomPage ws={ws} section="documents" tail={[{ label: details.document.indexNumber ? `${details.document.indexNumber} ${name}` : name }]}>
      <DocumentDetails key={id} ws={ws} details={details} timeZone={shell.me.timeZone} me={shell.me.personId} release={release} />
    </RoomPage>
  );
}
