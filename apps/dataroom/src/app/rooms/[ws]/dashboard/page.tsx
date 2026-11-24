// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { getRoomShell, must, serverApi, type RoomShellData } from '@/api/server';
import { AdminDashboard, NotPublishedCard } from '@/components/dashboard/AdminDashboard';
import { BidderDashboard, type OwnRequest } from '@/components/dashboard/BidderDashboard';
import { BidderWaiting, ReadyChecklist, type ReadyStep } from '@/components/dashboard/EmptyStates';
import { formatDayWithYear, plural, type Milestone } from '@/components/dashboard/model';
import { RoomPage } from '@/components/room/RoomPage';
import { roomHref } from '@/components/room/routes';
import { documentsNotice } from '@/lib/notice';
import '@/styles/dashboard.css';
import '@/styles/people.css';

export const metadata: Metadata = { title: 'Dashboard' };

type Api = Awaited<ReturnType<typeof serverApi>>;

// visit first, so "new since last visit" uses the previous one (API merges visits within 30 min)
export default async function Dashboard({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const shell = await getRoomShell(ws);
  const api = await serverApi();
  await api.POST('/v1/workspaces/{ws}/visit', { params: { path: { ws } } }).catch(() => null);
  const now = new Date().toISOString();

  let body;
  if (shell.me.isAdmin && shell.room.state === 'preparing') body = await newRoom(api, shell);
  else if (shell.me.isAdmin) body = await admin(api, shell, now);
  else body = await member(api, shell, now);

  return <RoomPage ws={ws} section="dashboard">{body}</RoomPage>;
}

function folderIds(shell: RoomShellData) {
  const out: Record<string, string> = {};
  for (const f of shell.index) {
    if (!f.indexNumber) continue;
    out[f.indexNumber] = f.id;
    if (!f.parentId) out[`${f.indexNumber} ${f.name}`] = f.id;
  }
  return out;
}

async function milestonesFor(api: Api, ws: string): Promise<Milestone[]> {
  const r = await api.GET('/v1/workspaces/{ws}/milestones', { params: { path: { ws } } });
  return r.data?.items ?? [];
}

async function admin(api: Api, shell: RoomShellData, now: string) {
  const ws = shell.room.id;
  const [dash, requests] = await Promise.all([
    api.GET('/v1/workspaces/{ws}/dashboard', { params: { path: { ws } } }).then(must),
    api.GET('/v1/workspaces/{ws}/team-requests', { params: { path: { ws }, query: { status: 'pending' } } }).then((r) => r.data?.items ?? []),
  ]);
  return (
    <AdminDashboard ws={ws} roomName={shell.room.name} timeZone={shell.me.timeZone} roomTimeZone={shell.room.timeZone} now={now}
      toDo={dash.toDo ?? { drafts: { count: 0, oldestAt: null, byFolder: [] }, accessRequests: [], removalRequests: [], failedProcessing: [] }}
      requests={requests} activity={dash.activity ?? []} milestones={dash.milestones} notPublished={dash.notPublished ?? []} folderIds={folderIds(shell)} />
  );
}

async function newRoom(api: Api, shell: RoomShellData) {
  const ws = shell.room.id;
  const [settings, created, standardLater, dash] = await Promise.all([
    api.GET('/v1/workspaces/{ws}/settings', { params: { path: { ws } } }).then((r) => r.data ?? null),
    api.GET('/v1/workspaces/{ws}/events', { params: { path: { ws }, query: { action: 'workspace.created', limit: 1 } } }).then((r) => r.data?.items[0] ?? null),
    api.GET('/v1/workspaces/{ws}/events', { params: { path: { ws }, query: { action: 'workspace.standard_index_created', limit: 1 } } }).then((r) => !!r.data?.items.length),
    api.GET('/v1/workspaces/{ws}/dashboard', { params: { path: { ws } } }).then((r) => r.data ?? null),
  ]);
  const tops = shell.index.filter((f) => !f.parentId);
  let documents = 0;
  for (const f of tops) documents += f.documents + f.drafts;
  const groups = shell.room.bidderGroups ?? 0;
  const zone = shell.me.timeZone;
  const start = standardLater ? 'standard' : (created?.data as { start?: string } | null | undefined)?.start;
  const count = plural(tops.length, 'folder', 'folders');
  let folders = `with ${count}`;
  if (!tops.length) folders = 'without folders';
  else if (start === 'standard') folders = `with the standard M&A index of ${count}`;
  else if (start === 'copy') folders = `as a copy of another room, with ${count}`;
  const steps: ReadyStep[] = [
    { done: true, title: 'Create the room',
      text: created ? `Done${created.actorName ? ` by ${created.actorName}` : ''} on ${formatDayWithYear(created.occurredAt, zone)}, ${folders}.` : `Done, ${folders}.` },
    { done: documents > 0, title: 'Add the documents',
      text: 'Import a folder from your computer, or drop files onto the folders in Documents. Everything arrives as a draft.',
      action: { label: 'Bulk import', href: roomHref(ws, 'import') } },
    { done: groups > 0, title: 'Create the bidder groups and invite people',
      text: 'One group per bidder. Invitations go out only when the room opens.', action: { label: 'Go to People', href: roomHref(ws, 'people') } },
    { done: groups > 0 && tops.length > 0 && (shell.attention?.foldersWithoutBidderAccess ?? 1) === 0, title: 'Decide who sees what',
      text: "Set each group's access per folder in Permissions.", action: { label: 'Go to Permissions', href: roomHref(ws, 'permissions') } },
    { done: !!settings?.requiresNda, title: 'Ask for the NDA', text: 'Bidders accept it before they see a document.',
      action: { label: 'Open NDA settings', href: `${roomHref(ws, 'settings')}?tab=nda` } },
    { done: shell.documents.published > 0, title: 'Release the documents',
      text: 'Review the drafts and publish them to the groups.', action: { label: 'Release review', href: roomHref(ws, 'release') } },
    { done: false, title: 'Open the room to bidders',
      text: 'Bidders get their invitation and can enter. You can still add documents and people afterwards.',
      action: { label: 'Open the room', href: roomHref(ws, 'settings') } },
  ];
  const dropped = dash?.notPublished ?? [];
  return <ReadyChecklist roomName={shell.room.name} steps={steps}
    extra={dropped.length ? <NotPublishedCard ws={ws} items={dropped} now={new Date().toISOString()} timeZone={shell.me.timeZone} /> : null} />;
}

async function member(api: Api, shell: RoomShellData, now: string) {
  const ws = shell.room.id;
  const own = shell.me.groups.find((g) => !g.parentGroupId) ?? shell.me.groups[0];
  const groupName = own?.name ?? shell.room.runBy;
  const buyer = shell.me.groups.some((g) => g.partyKind === 'bidder' || g.partyKind === 'financier');
  // subgroup leads can't send requests
  const lead = buyer && shell.me.groups.some((g) => g.role === 'lead' && !g.parentGroupId);
  let kind: 'seller' | 'lead' | 'member' = 'member';
  if (!buyer) kind = 'seller';
  else if (lead) kind = 'lead';

  if (buyer && shell.documents.published === 0) {
    const [milestones, notice] = await Promise.all([milestonesFor(api, ws), documentsNotice(api, ws)]);
    return <BidderWaiting ws={ws} roomName={shell.room.name} groupName={groupName} timeZone={shell.me.timeZone} now={now}
      milestones={milestones} notice={notice} />;
  }

  const [dash, team, requests] = await Promise.all([
    api.GET('/v1/workspaces/{ws}/dashboard', { params: { path: { ws } } }).then(must),
    buyer ? api.GET('/v1/workspaces/{ws}/my-team', { params: { path: { ws } } }).then((r) => r.data ?? null) : null,
    lead ? api.GET('/v1/workspaces/{ws}/team-requests', { params: { path: { ws } } }).then((r) => r.data?.items ?? []) : null,
  ]);

  const myTeam = team?.groups.find((g) => g.id === own?.id) ?? team?.groups[0];
  const active = myTeam?.members.filter((m) => m.status === 'active');
  const teamSize = active ? active.length : null;
  const leads = active ? active.filter((m) => m.role === 'lead').map((m) => m.name) : [];

  const decided = new Map((requests ?? []).map((r) => [r.id, r]));
  const ownRequests: OwnRequest[] | null = !lead ? null
    : (dash.myRequests ?? []).map((r) => ({ ...r, decidedAt: decided.get(r.id)?.decidedAt ?? null }));

  return (
    <BidderDashboard ws={ws} roomName={shell.room.name} groupName={groupName} kind={kind} timeZone={shell.me.timeZone} now={now}
      personId={shell.me.personId} previousVisitAt={dash.previousVisitAt}
      newSinceLastVisit={dash.newSinceLastVisit ?? []}
      // API sends team figures to members too: never pass them on
      teamCoverage={kind === 'lead' ? dash.teamCoverage ?? null : null}
      myCoverage={kind === 'member' ? dash.myCoverage ?? null : null}
      teamSize={teamSize} leads={leads} requests={ownRequests}
      toPublish={kind === 'seller' ? dash.toPublish ?? null : null}
      notPublished={kind === 'seller' ? dash.notPublished ?? null : null}
      milestones={dash.milestones} folderIds={folderIds(shell)} />
  );
}
