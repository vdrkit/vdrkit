// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { DocumentsScreen } from '@/components/documents/DocumentsScreen';
import { loadDocuments } from '@/components/documents/load';
import { RoomPage } from '@/components/room/RoomPage';

export const metadata: Metadata = { title: 'Documents' };

export default async function Folder({ params }: { params: Promise<{ ws: string; folder: string }> }) {
  const { ws, folder } = await params;
  const data = await loadDocuments(ws, folder);
  return (
    <RoomPage ws={ws} section="documents" folderId={folder}>
      <DocumentsScreen key={folder} data={data} />
    </RoomPage>
  );
}
