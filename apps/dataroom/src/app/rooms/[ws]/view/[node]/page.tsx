// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { IdleGuard } from '@/components/room/IdleGuard';
import { Viewer, type ViewerProps } from '@/components/viewer/Viewer';
import { DEFAULT_WATERMARK, openedBySummary, readableSiblings, type Sibling } from '@/components/viewer/model';
import '@/components/viewer/viewer.css';
import { devAuthOn } from '@/lib/dev-auth';

export const metadata: Metadata = { title: 'Document viewer' };

export default async function View({ params }: { params: Promise<{ ws: string; node: string }> }) {
  const { ws, node: id } = await params;
  const api = await serverApi();
  const node = await must(await api.GET('/v1/workspaces/{ws}/nodes/{id}', { params: { path: { ws, id } } }), ws);
  if (node.kind !== 'document') notFound();
  const shell = await getRoomShell(ws);

  const query = node.parentId ? { parent: node.parentId } : {};
  const listing = await must(await api.GET('/v1/workspaces/{ws}/nodes', { params: { path: { ws }, query } }));
  const siblings = readableSiblings(listing.items, node.id).map((x) => {
    const s: Sibling = { id: x.id, indexNumber: x.indexNumber, name: x.name };
    if (x.state !== 'published') s.state = x.state;
    if (!shell.me.isAdmin && !shell.seeAs && x.id !== node.id && x.read === false) s.unread = true;
    return s;
  });
  const parent = shell.index.find((f) => f.id === node.parentId);
  let folder: ViewerProps['folder'] = { id: null, label: 'Documents' };
  if (parent) folder = { id: parent.id, label: parent.indexNumber ? `${parent.indexNumber} ${parent.name}` : parent.name };

  const version = node.version;
  const doc: ViewerProps['doc'] = {
    id: node.id,
    name: node.name,
    indexNumber: node.indexNumber,
    level: node.access.level,
    versionNumber: version?.number ?? null,
    versionCount: version?.count ?? null,
    pageCount: version?.pageCount ?? null,
    sizeBytes: version?.sizeBytes ?? null,
    pdfBytes: version?.pdfBytes ?? null,
    publishedAt: node.publishedAt ?? null,
    uploadedBy: version?.uploadedBy ?? null,
    watermark: node.watermark ?? DEFAULT_WATERMARK,
    noPreview: version?.noPreview ?? null,
  };
  if (version?.status === 'failed') doc.noPreview = 'failed';

  let openedBy: string | null = null;
  if (shell.me.isAdmin) {
    const [cov, people] = await Promise.all([
      api.GET('/v1/workspaces/{ws}/nodes/{id}/coverage', { params: { path: { ws, id } } }),
      api.GET('/v1/workspaces/{ws}/people', { params: { path: { ws } } }),
    ]);
    if (cov.data && people.data) openedBy = openedBySummary(cov.data, people.data);
  }

  return (
    <>
      <Viewer
        key={node.id}
        shell={shell}
        doc={doc}
        folder={folder}
        siblings={siblings}
        openedBy={openedBy}
      />
      {devAuthOn() ? null : <IdleGuard roomName={shell.room.name} />}
    </>
  );
}
