// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import type { ReactNode } from 'react';
import type { AccountMenuItem } from './AccountMenu';
import { AppShell } from './AppShell';
import { DocumentIndex, type IndexEdit, type IndexViewer } from './DocumentIndex';
import { QuickSearch } from './QuickSearch';
import { RoomClock } from './RoomClock';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import type { Crumb, IndexFolder, Instance, NavEntry, QuickSearchItem, ShellPerson, ShellRoom } from './types';

export interface RoomShellProps {
  instance: Instance;
  room: ShellRoom;
  person: ShellPerson;
  nav: NavEntry[];
  crumbs: Crumb[];
  index?: { folders: IndexFolder[]; viewer: IndexViewer; currentIx?: string; onSelect?: (ix: string) => void; edit?: IndexEdit };
  search: {
    placeholder: string;
    items: QuickSearchItem[];
    onOpen?: (item: QuickSearchItem) => void;
    onSearchAll?: (query: string) => void;
    onQueryChange?: (query: string) => void;
    loading?: boolean;
    live?: { value: string; onChange: (query: string) => void };
  };
  ownTimeZone?: string;
  unread: number;
  notificationSettingsHref?: string;
  accountMenu: AccountMenuItem[];
  onRoomSwitch?: () => void;
  notice?: ReactNode;
  children: ReactNode;
}

export function RoomShell(p: RoomShellProps) {
  return (
    <AppShell
      hasIndex={!!p.index}
      notice={p.notice}
      sidebar={
        <Sidebar
          instance={p.instance}
          room={p.room}
          nav={p.nav}
          navLabel="Room sections"
          person={p.person}
          accountMenu={p.accountMenu}
          onRoomSwitch={p.onRoomSwitch}
          documentIndex={p.index && <DocumentIndex folders={p.index.folders} viewer={p.index.viewer} currentIx={p.index.currentIx} onSelect={p.index.onSelect} edit={p.index.edit} />}
        />
      }
      topBar={(menuButton) => (
        <TopBar
          menuButton={menuButton}
          crumbs={p.crumbs}
          search={<QuickSearch {...p.search} />}
          clock={<RoomClock roomTimeZone={p.room.timeZone} ownTimeZone={p.ownTimeZone} />}
          unread={p.unread}
          notificationSettingsHref={p.notificationSettingsHref}
        />
      )}
    >
      {p.children}
    </AppShell>
  );
}

export interface OutsideShellProps {
  instance: Instance;
  person: ShellPerson;
  nav: NavEntry[];
  crumbs: Crumb[];
  unread: number;
  notificationSettingsHref?: string;
  accountMenu: AccountMenuItem[];
  notice?: ReactNode;
  children: ReactNode;
}

export function OutsideShell(p: OutsideShellProps) {
  return (
    <AppShell
      notice={p.notice}
      sidebar={<Sidebar instance={p.instance} nav={p.nav} navLabel="My rooms" person={p.person} accountMenu={p.accountMenu} />}
      topBar={(menuButton) => <TopBar menuButton={menuButton} crumbs={p.crumbs} unread={p.unread} notificationSettingsHref={p.notificationSettingsHref} />}
    >
      {p.children}
    </AppShell>
  );
}
