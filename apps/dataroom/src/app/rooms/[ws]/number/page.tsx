// SPDX-License-Identifier: AGPL-3.0-only
import { notFound, redirect } from 'next/navigation';
import { must, serverApi } from '@/api/server';
import { roomHref, viewHref } from '@/components/room/routes';

// ?at = when the number was quoted (ISO)
export default async function NumberLink({ params, searchParams }: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ n?: string | string[]; at?: string | string[] }>;
}) {
  const { ws } = await params;
  const { n, at } = await searchParams;
  if (typeof n !== 'string' || !/^\d+(\.\d+)*$/.test(n)) notFound();
  const quoted = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : undefined;
  const api = await serverApi();
  const hit = await must(await api.GET('/v1/workspaces/{ws}/numbers/{number}', { params: { path: { ws, number: n }, query: quoted ? { at: quoted } : {} } }), ws);
  redirect(hit.kind === 'folder' ? roomHref(ws, 'documents', hit.nodeId) : viewHref(ws, hit.nodeId));
}
