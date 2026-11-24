// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { getRoomShell } from '@/api/server';
import { RoomPage } from '@/components/room/RoomPage';
import { byIndex } from '@/lib/search';
import { SearchBody, type SearchFolder } from './SearchBody';

export const metadata: Metadata = { title: 'Search' };

export default async function Search({ params, searchParams }: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ q?: string | string[]; folder?: string | string[] }>;
}) {
  const { ws } = await params;
  const sp = await searchParams;
  const shell = await getRoomShell(ws);
  const allFolders: SearchFolder[] = shell.index
    .map((f) => ({ id: f.id, ix: f.indexNumber ?? '', name: f.name, documents: f.documents, published: f.documents - f.drafts }))
    .sort((a, b) => byIndex(a.ix, b.ix));
  const asked = typeof sp.folder === 'string' ? sp.folder : '';
  const tops = new Set(shell.index.filter((f) => !f.parentId).map((f) => f.id));
  const folders = [...allFolders.filter((f) => tops.has(f.id)), ...allFolders.filter((f) => f.id === asked && !tops.has(f.id))];
  const total = shell.documents.published;
  // mirrors viewerOf(), which is client-only
  let viewer: 'admin' | 'seller' | 'buyer' = 'buyer';
  if (shell.me.isAdmin) viewer = 'admin';
  else if (shell.me.groups.some((g) => g.partyKind === 'seller')) viewer = 'seller';
  let own: string | null = null;
  if (viewer === 'buyer') {
    const group = shell.me.groups.find((g) => !g.parentGroupId) ?? shell.me.groups[0];
    own = group?.name ?? null;
  }
  return (
    <RoomPage ws={ws} section="search">
      <SearchBody
        ws={ws}
        roomName={shell.room.name}
        viewer={viewer}
        isAdmin={shell.me.isAdmin}
        total={total}
        folders={folders}
        allFolders={allFolders}
        ownGroup={own}
        initialFolder={allFolders.some((f) => f.id === asked) ? asked : ''}
      />
    </RoomPage>
  );
}
