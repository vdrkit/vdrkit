// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { DocumentsScreen } from '@/components/documents/DocumentsScreen';
import { loadDocuments } from '@/components/documents/load';
import { RoomPage } from '@/components/room/RoomPage';

export const metadata: Metadata = { title: 'Documents' };

export default async function Documents({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const data = await loadDocuments(ws, null);
  return (
    <RoomPage ws={ws} section="documents">
      <DocumentsScreen data={data} />
    </RoomPage>
  );
}
