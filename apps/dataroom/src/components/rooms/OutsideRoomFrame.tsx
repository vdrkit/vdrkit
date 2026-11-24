// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import type { ReactNode } from 'react';
import { OutsideShell, type NavEntry } from '@/components/shell';
import { IdleGuard } from '@/components/room/IdleGuard';
import { QuillmontLogo } from '@/demo/quillmont-logo';
import { aboutMenuItem, privacyMenuItem } from '@/components/shell/AccountMenu';
import type { PrivacyLink } from '@/components/outside/OutsideFrame';
import { authCall } from '@/lib/auth-client';
import { adminNav } from '@/components/site/routes';
import { CREATE_ROOM_HREF, MY_ROOMS_HREF } from './routes';

export interface OutsidePerson {
  personId: string;
  name: string;
  role: string;
}

async function signOut() {
  await authCall('/sign-out', {});
  window.location.assign('/sign-in');
}

export function OutsideRoomFrame(p: {
  runBy: string;
  person: OutsidePerson;
  current: 'rooms' | 'create' | 'site';
  roomCount: number;
  canCreateRooms: boolean;
  isSiteAdmin: boolean;
  profileHref: string | null;
  crumb: string;
  privacy: PrivacyLink | null;
  /** off while the dev persona pill signs requests */
  idle: boolean;
  children: ReactNode;
}) {
  const nav: NavEntry[] = [
    { key: 'rooms', label: 'My rooms', icon: 'rooms', href: MY_ROOMS_HREF, current: p.current === 'rooms', count: p.roomCount.toLocaleString('en-GB') },
  ];
  if (p.canCreateRooms) nav.push({ key: 'create', label: 'Create a room', icon: 'plus', href: CREATE_ROOM_HREF, current: p.current === 'create' });
  if (p.isSiteAdmin) nav.push(...adminNav(null));
  const logo = p.runBy === 'Quillmont Advisory' ? <QuillmontLogo /> : <b>{p.runBy}</b>;
  const profileHref = p.profileHref ?? undefined;
  return (
    <OutsideShell
      instance={{ name: p.runBy, logo, homeHref: MY_ROOMS_HREF }}
      person={{ avatarKey: p.person.personId, name: p.person.name, role: p.person.role, profileHref }}
      nav={nav}
      crumbs={[{ label: p.crumb }]}
      unread={0}
      notificationSettingsHref={profileHref && `${profileHref}?tab=notifications`}
      accountMenu={[
        ...(profileHref ? [{ label: 'Profile and notifications', hint: 'Opens your profile and email settings', href: profileHref }] : []),
        ...privacyMenuItem(p.privacy),
        aboutMenuItem(),
        { label: 'Sign out', hint: 'Ends your session on this browser', onSelect: () => { void signOut(); } },
      ]}
    >
      {p.children}
      {p.idle ? <IdleGuard roomName={p.crumb} /> : null}
    </OutsideShell>
  );
}
