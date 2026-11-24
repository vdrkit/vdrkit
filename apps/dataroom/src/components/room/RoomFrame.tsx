// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { RoomShellData } from '@/api/server';
import { RoomShell, type Crumb, type IndexFolder, type NavEntry, type QuickSearchItem } from '@/components/shell';
import type { IndexEdit, IndexViewer } from '@/components/shell/DocumentIndex';
import { useRoom } from '@/app/rooms/[ws]/RoomContext';
import { OrgMark } from '@/components/outside/OutsideFrame';
import { SiteNotice } from '@/components/site/SiteNotice';
import { QuillmontLogo } from '@/demo/quillmont-logo';
import { RoomLogo } from '@/components/rooms/RoomLogo';
import { roomInitials } from '@/components/rooms/model';
import { authCall } from '@/lib/auth-client';
import { MY_ROOMS_HREF } from '@/components/rooms/routes';
import { IdleGuard } from './IdleGuard';
import { IndexEditContext } from './index-edit';
import { roomHref, viewHref, type RoomSection } from './routes';
import { SeeAsBar, SeeAsProvider } from './SeeAs';
import { aboutMenuItem, privacyMenuItem } from '@/components/shell/AccountMenu';
import { parseRoomPart } from './see-as';
import { SearchQueryProvider, useQuickSearchItems, useSearchQuery } from './search-state';

export interface RoomFrameProps {
  shell: RoomShellData;
  section: RoomSection;
  folderId?: string;
  tail?: Crumb[];
  crumbs?: Crumb[];
  /** off while the dev persona pill signs requests */
  idle?: boolean;
  children: ReactNode;
}

const SECTION_LABEL: Record<RoomSection, string> = {
  dashboard: 'Dashboard', documents: 'Documents', search: 'Search', team: 'My team', people: 'People', permissions: 'Permissions',
  activity: 'Activity', timeline: 'Timeline', settings: 'Settings', profile: 'Profile and notifications',
  release: 'Release review', import: 'Bulk import',
};

const ADMIN_SECTIONS = new Set<RoomSection>(['people', 'permissions', 'activity', 'timeline', 'settings']);

const n = (x: number) => x.toLocaleString('en-GB');

// Bidder count is competitive information: admins only
export function roomSubtitle(shell: RoomShellData): string {
  if (!shell.me.isAdmin || shell.room.bidderGroups === null) return `Run by ${shell.room.runBy}`;
  if (shell.room.state === 'preparing' && shell.room.bidderGroups === 0) return 'Preparing · no bidders yet';
  return `${n(shell.room.bidderGroups)} bidder ${shell.room.bidderGroups === 1 ? 'group' : 'groups'}`;
}

async function signOut() {
  await authCall('/sign-out', {});
  window.location.assign('/sign-in');
}

export function viewerOf(shell: RoomShellData): IndexViewer {
  if (shell.me.isAdmin) return 'admin';
  return shell.me.groups.some((g) => g.partyKind === 'seller') ? 'seller' : 'buyer';
}

export function roleLabel(shell: RoomShellData): string {
  if (shell.me.isAdmin) return `Room admin · ${shell.room.runBy}`;
  const g = shell.me.groups.find((x) => !x.parentGroupId) ?? shell.me.groups[0];
  if (!g) return shell.room.runBy;
  return `${g.name} · ${g.role === 'lead' ? 'Lead' : 'Member'}`;
}

export function navFor(shell: RoomShellData, section: RoomSection): NavEntry[] {
  const ws = shell.room.id;
  const link = (key: RoomSection, icon: 'dash' | 'docs' | 'search' | 'team' | 'perm' | 'act' | 'time' | 'set', extra: Partial<NavEntry> = {}): NavEntry =>
    ({ key: icon, label: SECTION_LABEL[key], icon, href: roomHref(ws, key), current: section === key, ...extra }) as NavEntry;
  const nav: NavEntry[] = [
    link('dashboard', 'dash'),
    link('documents', 'docs', { count: n(shell.documents.published) }),
    link('search', 'search'),
  ];
  const viewer = viewerOf(shell);
  const observer = !shell.me.isAdmin && shell.me.canReadActivity;
  if (viewer === 'buyer' || observer) nav.push(link('timeline', 'time'));
  if (viewer === 'buyer') nav.push(link('team', 'team', shell.me.teamSize != null ? { count: n(shell.me.teamSize) } : {}));
  if (observer) nav.push(link('activity', 'act'));
  if (shell.me.isAdmin) {
    const a = shell.attention;
    const requests = a?.accessRequests;
    const closed = a?.foldersWithoutBidderAccess;
    nav.push(
      { section: 'Administration' },
      link('people', 'team', requests ? { attention: { value: n(requests), title: `${n(requests)} ${requests === 1 ? 'request' : 'requests'} waiting` } } : {}),
      link('permissions', 'perm', closed ? { attention: { value: n(closed), title: `${n(closed)} folders have no bidder access` } } : {}),
      link('activity', 'act'), link('timeline', 'time'), link('settings', 'set'),
    );
  }
  return nav;
}

type Flat = RoomShellData['index'][number];

/** path: only the folders on the way to the open one. top: every top folder with subfolders. */
export const INDEX_OPEN_ON_ARRIVAL: 'path' | 'top' = 'path';

export function openOnArrival(flat: Flat[], path: Flat[], mode: 'path' | 'top' = INDEX_OPEN_ON_ARRIVAL): Set<string> {
  return new Set((mode === 'top' ? flat.filter((f) => !f.parentId) : path).map((f) => f.id));
}

function indexTree(flat: Flat[], openIds: Set<string>): IndexFolder[] {
  const toFolder = (f: Flat): IndexFolder => {
    const folder: IndexFolder = { ix: f.indexNumber ?? f.name, name: f.name, documents: f.documents };
    if (f.drafts) folder.drafts = f.drafts;
    if (f.noBidderAccess) folder.noBidderAccess = true;
    if (f.canUpload) folder.canUpload = true;
    return folder;
  };
  return flat.filter((f) => !f.parentId).map((top) => {
    const folder = toFolder(top);
    const kids = flat.filter((f) => f.parentId === top.id).map(toFolder);
    if (kids.length) {
      folder.children = kids;
      folder.open = openIds.has(top.id);
    }
    return folder;
  });
}

function pathTo(flat: Flat[], id: string | undefined): Flat[] {
  const out: Flat[] = [];
  let f = flat.find((x) => x.id === id);
  while (f) {
    out.unshift(f);
    const parentId = f.parentId;
    f = parentId ? flat.find((x) => x.id === parentId) : undefined;
  }
  return out;
}

const label = (f: Flat) => (f.indexNumber ? `${f.indexNumber} ${f.name}` : f.name);

export function RoomFrame(p: RoomFrameProps) {
  const params = useSearchParams();
  if (p.section !== 'search') return <Frame {...p} />;
  return (
    <SearchQueryProvider initial={params.get('q') ?? ''}>
      <LiveFrame {...p} />
    </SearchQueryProvider>
  );
}

function LiveFrame(p: RoomFrameProps) {
  const { q, setQ } = useSearchQuery();
  return <Frame {...p} live={{ value: q, onChange: setQ }} />;
}

function Frame({ shell, section, folderId, tail = [], crumbs: own, idle = true, children, live }: RoomFrameProps & { live?: { value: string; onChange: (q: string) => void } }) {
  const router = useRouter();
  const [edit, setEdit] = useState<IndexEdit | null>(null);
  const ws = shell.room.id;
  const path = pathTo(shell.index, folderId);
  const byIx = new Map(shell.index.map((f) => [f.indexNumber ?? f.name, f]));

  const crumbs: Crumb[] = [{ label: shell.room.name }];
  if (ADMIN_SECTIONS.has(section) && shell.me.isAdmin) crumbs.push({ label: 'Administration' });
  const more = path.length > 0 || tail.length > 0;
  crumbs.push(more ? { label: SECTION_LABEL[section], href: roomHref(ws, section) } : { label: SECTION_LABEL[section] });
  path.forEach((f, i) => crumbs.push(i < path.length - 1 || tail.length ? { label: label(f), href: roomHref(ws, 'documents', f.id) } : { label: label(f) }));
  crumbs.push(...tail);

  const quick = useQuickSearchItems(shell);
  const viewer = viewerOf(shell);
  const roomCtx = useRoom();
  const branding = roomCtx?.branding;
  let logo = <b>{shell.room.runBy}</b>;
  if (branding?.logos.light) logo = <OrgMark b={branding} />;
  else if (shell.room.runBy === 'Quillmont Advisory') logo = <QuillmontLogo />;
  const profileHref = roomHref(parseRoomPart(ws).room, 'profile');
  const openFolder = path.at(-1);

  return (
    <SeeAsProvider value={shell.seeAs}>
    {shell.seeAs ? <SeeAsBar ws={ws} team={shell.seeAs} /> : null}
    <IndexEditContext.Provider value={setEdit}>
    <RoomShell
      notice={<SiteNotice notice={roomCtx?.notice} />}
      instance={{ name: shell.room.runBy, logo, homeHref: MY_ROOMS_HREF }}
      room={{
        initials: roomInitials(shell.room.name), name: shell.room.name,
        logo: <RoomLogo roomId={shell.room.id} initials={roomInitials(shell.room.name)} logos={shell.room.logos} className="room-logo" />, timeZone: shell.room.timeZone, canSwitch: shell.room.myRoomCount > 1,
        subtitle: roomSubtitle(shell),
      }}
      // see-as person is a fresh stand-in per request, so key the colour by team
      person={{ avatarKey: shell.seeAs?.groupId ?? shell.me.personId, name: shell.me.name, role: roleLabel(shell), profileHref }}
      ownTimeZone={shell.me.timeZone}
      nav={navFor(shell, section)}
      crumbs={own ?? crumbs}
      index={section === 'documents' ? {
        folders: indexTree(shell.index, openOnArrival(shell.index, path)),
        viewer,
        ...(openFolder ? { currentIx: openFolder.indexNumber ?? openFolder.name } : {}),
        onSelect: (ix) => { const f = byIx.get(ix); if (f) router.push(roomHref(ws, 'documents', f.id)); },
        ...(edit ? { edit } : {}),
      } : undefined}
      search={{
        placeholder: `Search ${n(shell.documents.published)} documents`,
        items: quick.items,
        onQueryChange: quick.onQueryChange,
        loading: quick.loading,
        onOpen: (item: QuickSearchItem) => { if (item.id) router.push(item.folder ? roomHref(ws, 'documents', item.id) : viewHref(ws, item.id)); },
        onSearchAll: (q: string) => router.push(`${roomHref(ws, 'search')}?q=${encodeURIComponent(q)}`),
        ...(live ? { live } : {}),
      }}
      unread={0}
      notificationSettingsHref={`${profileHref}?tab=notifications`}
      onRoomSwitch={() => router.push(MY_ROOMS_HREF)}
      accountMenu={[
        // leaves see-as mode
        { label: 'Profile and notifications', hint: 'Opens your profile and email settings', href: profileHref },
        ...privacyMenuItem(branding?.privacy),
        aboutMenuItem(),
        { label: 'Sign out', hint: 'Ends your session on this browser', onSelect: () => { void signOut(); } },
      ]}
    >
      {children}
      {idle ? <IdleGuard roomName={shell.room.name} /> : null}
    </RoomShell>
    </IndexEditContext.Provider>
    </SeeAsProvider>
  );
}
