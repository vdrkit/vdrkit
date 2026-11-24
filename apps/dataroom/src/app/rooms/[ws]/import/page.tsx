// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { BulkImport, type ImportTarget } from '@/components/import/BulkImport';
import { RoomPage } from '@/components/room/RoomPage';
import '@/styles/import.css';

export const metadata: Metadata = { title: 'Bulk import' };

export default async function Import({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ into?: string }> }) {
  const { ws } = await params;
  const { into } = await searchParams;
  const shell = await getRoomShell(ws);
  const isAdmin = shell.me.isAdmin;
  const upload = shell.index.filter((f) => f.canUpload);
  if (!isAdmin && !upload.length) notFound();

  const api = await serverApi();
  const tops = isAdmin ? [] : (await must(await api.GET('/v1/workspaces/{ws}/nodes', { params: { path: { ws }, query: {} } }), ws)).items;
  const publishTops = new Set(tops.filter((t) => t.kind === 'folder' && t.access.allowed.includes('publish')).map((t) => t.id));
  const byId = new Map(shell.index.map((f) => [f.id, f]));
  const topOf = (id: string) => {
    let f = byId.get(id);
    while (f?.parentId) f = byId.get(f.parentId);
    return f?.id;
  };

  const targets: ImportTarget[] = [];
  if (isAdmin) targets.push({ id: null, label: 'Top level of the index', ix: null, canPublish: true });
  for (const f of isAdmin ? shell.index : upload) {
    targets.push({
      id: f.id,
      label: f.indexNumber ? `${f.indexNumber} ${f.name}` : f.name,
      ix: f.indexNumber,
      canPublish: isAdmin || publishTops.has(topOf(f.id) ?? ''),
    });
  }
  const initialTarget = into && targets.some((t) => t.id === into) ? into : targets[0]!.id;
  const recent = await must(await api.GET('/v1/workspaces/{ws}/uploads/recent', { params: { path: { ws }, query: { limit: 3 } } }), ws);

  return (
    <RoomPage ws={ws} section="documents" tail={[{ label: 'Bulk import' }]}>
      <BulkImport data={{
        ws, roomName: shell.room.name, timeZone: shell.me.timeZone, isAdmin, targets, initialTarget,
        draftsBefore: isAdmin ? shell.index.filter((f) => !f.parentId).reduce((a, f) => a + f.drafts, 0) : 0,
        recent: recent.items.map((r) => ({ at: r.at, person: r.person?.name ?? null, files: r.files, drafts: r.drafts, folders: r.folders, first: r.first })),
      }} />
    </RoomPage>
  );
}
