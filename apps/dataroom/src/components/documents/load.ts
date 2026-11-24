// SPDX-License-Identifier: AGPL-3.0-only
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { documentsNotice } from '@/lib/notice';
import { join, nextFolderNumber } from './format';
import { loadReleaseInfo, type ReleaseInfo } from './release-one';
import type { DocumentsData, GroupAccess, Item } from './types';

const PARTY_COLOURS = ['var(--g-a)', 'var(--g-b)', 'var(--g-c)', 'var(--g-s)'];
const partyColour = (i: number) => PARTY_COLOURS[i % PARTY_COLOURS.length]!;

export function nextNumber(prefix: string | null, siblings: { indexNumber: string | null }[]): string {
  return join(prefix, nextFolderNumber(siblings));
}

export async function loadDocuments(ws: string, folderId: string | null): Promise<DocumentsData> {
  const api = await serverApi();
  const shell = await getRoomShell(ws);
  const isAdmin = shell.me.isAdmin;
  const isSeller = shell.me.groups.some((g) => g.partyKind === 'seller');

  const folder = folderId ? (await must(await api.GET('/v1/workspaces/{ws}/nodes/{id}', { params: { path: { ws, id: folderId } } }))) : null;
  if (folder && folder.kind !== 'folder') notFound();
  const list = (await must(await api.GET('/v1/workspaces/{ws}/nodes', { params: { path: { ws }, query: folderId ? { parent: folderId } : {} } })));
  const items: Item[] = list.items.map((n) => ({
    id: n.id, parentId: n.parentId, kind: n.kind, name: n.name, indexNumber: n.indexNumber, state: n.state,
    allowed: n.access.allowed, version: n.version ?? null, uploadedBy: n.uploadedBy ?? null, releasedVersion: n.releasedVersion ?? null,
    renumberedFrom: n.renumberedFrom ?? null,
  }));

  const pending: Record<string, number> = {};
  const canPublishHere = isAdmin || !!folder?.access.allowed.includes('publish');
  const published = items.filter((i) => i.kind === 'document' && i.state === 'published').map((i) => i.id);
  if (canPublishHere && published.length) {
    const r = await api.POST('/v1/workspaces/{ws}/release-preview', { params: { path: { ws } }, body: { nodeIds: published } });
    for (const it of r.data?.items ?? []) if (it.versionId && it.versionNo) pending[it.id] = it.versionNo;
  }

  const release: ReleaseInfo | null = folderId && canPublishHere ? await loadReleaseInfo(api, ws, folderId) : null;

  const draftsIn = (pick: (f: (typeof shell.index)[number]) => boolean) => {
    let n = 0;
    for (const f of shell.index) if (pick(f)) n += f.drafts;
    return n;
  };
  let releaseCount: number | null = null;
  if (isAdmin) {
    releaseCount = draftsIn((f) => !f.parentId);
  } else {
    const top = folderId
      ? (await must(await api.GET('/v1/workspaces/{ws}/nodes', { params: { path: { ws }, query: {} } }))).items
      : list.items;
    const mine = new Set(top.filter((t) => t.kind === 'folder' && t.access.allowed.includes('publish')).map((t) => t.id));
    if (mine.size) releaseCount = draftsIn((f) => mine.has(f.id));
  }

  let groups: GroupAccess[] | null = null;
  const ownAccess: Record<string, Record<string, number>> = {};
  let nextInParent: string | null = null;
  if (isAdmin) {
    const [people, grants] = await Promise.all([
      api.GET('/v1/workspaces/{ws}/people', { params: { path: { ws } } }),
      api.GET('/v1/workspaces/{ws}/grants', { params: { path: { ws } } }),
    ]);
    const parties = (people.data?.parties ?? []).filter((p) => p.kind === 'bidder' || p.kind === 'financier')
      .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
    const all = parties.flatMap((p, i) => p.groups.filter((g) => !g.revoked).map((g) => ({ ...g, color: partyColour(i) })));
    const byId = new Map(all.map((g) => [g.id, g]));
    const groupGrants = (grants.data?.grants ?? []).filter((g) => g.groupId && g.effect === 'allow' && byId.has(g.groupId));
    const tree = new Map((grants.data?.nodes ?? []).map((n) => [n.id, n]));
    const path: string[] = [];
    let at = folderId ? tree.get(folderId) : undefined;
    while (at) {
      path.push(at.id);
      at = at.parentId ? tree.get(at.parentId) : undefined;
    }
    // must match group_level() in SQL
    const own = (groupId: string, nodes: string[]) => {
      for (const id of nodes) {
        const g = groupGrants.find((x) => x.groupId === groupId && x.nodeId === id);
        if (g) return g.level;
      }
      return 0;
    };
    const level = (groupId: string, nodes: string[]): number => {
      const g = byId.get(groupId)!;
      const l = own(groupId, nodes);
      return g.parentGroupId && byId.has(g.parentGroupId) ? Math.min(l, level(g.parentGroupId, nodes)) : l;
    };
    const ordered = all.filter((g) => !g.parentGroupId).flatMap((g) => [g, ...all.filter((s) => s.parentGroupId === g.id)]);
    groups = folderId ? ordered.map((g) => ({
      id: g.id, name: g.name, color: g.color, parentGroupId: g.parentGroupId,
      parentName: g.parentGroupId ? byId.get(g.parentGroupId)?.name ?? null : null, level: level(g.id, path),
    })) : [];
    const docIds = new Set(items.filter((i) => i.kind === 'document').map((i) => i.id));
    for (const g of groupGrants) {
      if (!docIds.has(g.nodeId)) continue;
      (ownAccess[g.nodeId] ??= {})[g.groupId!] = g.level;
    }
    if (folder?.parentId) {
      const siblings = (await must(await api.GET('/v1/workspaces/{ws}/nodes', { params: { path: { ws }, query: { parent: folder.parentId } } }))).items;
      const parent = shell.index.find((f) => f.id === folder.parentId);
      nextInParent = nextNumber(parent?.indexNumber ?? null, siblings);
    }
  }

  let publishers: string[] | null = null;
  const sellerSide = isAdmin || isSeller;
  const mayAdd = !!folder && (['upload', 'manage', 'publish'] as const).some((a) => folder.access.allowed.includes(a));
  if (folderId && sellerSide && (isAdmin || mayAdd)) {
    const r = await api.GET('/v1/workspaces/{ws}/nodes/{id}/audience', { params: { path: { ws, id: folderId } } });
    if (r.data) {
      publishers = r.data.publishers.map((p) => p.name);
      if (!isAdmin) {
        const colour = new Map(r.data.parties.map((p, i) => [p.id, partyColour(i)]));
        groups = r.data.groups.map((g) => ({
          id: g.id,
          name: g.name,
          color: colour.get(g.partyId) ?? PARTY_COLOURS[0]!,
          parentGroupId: g.parentGroupId,
          parentName: g.parentName,
          level: g.level,
        }));
      }
    }
  }

  const notice = !folderId && !isAdmin && items.length === 0 ? await documentsNotice(api, ws) : null;
  let viewer: DocumentsData['me']['viewer'] = 'buyer';
  if (isAdmin) viewer = 'admin';
  else if (isSeller) viewer = 'seller';
  const mainGroup = shell.me.groups.find((g) => !g.parentGroupId) ?? shell.me.groups[0];

  return {
    ws,
    notice,
    roomName: shell.room.name,
    me: { personId: shell.me.personId, timeZone: shell.me.timeZone, isAdmin, viewer, group: mainGroup?.name ?? null },
    folder: folder ? { id: folder.id, indexNumber: folder.indexNumber, name: folder.name, parentId: folder.parentId, state: folder.state, allowed: folder.access.allowed } : null,
    items,
    index: shell.index,
    groups,
    publishers,
    ownAccess,
    pending,
    releaseCount,
    release,
    nextInParent,
  };
}
