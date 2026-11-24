// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { OrgMark, type Branding } from '@/components/outside/OutsideFrame';
import { OutsideShell, type NavEntry } from '@/components/shell';
import { QuillmontLogo } from '@/demo/quillmont-logo';
import { SiteNotice, type SiteNoticeData } from './SiteNotice';
import { aboutMenuItem, privacyMenuItem } from '@/components/shell/AccountMenu';
import { authCall } from '@/lib/auth-client';
import { adminNav, CREATE_ROOM_HREF, MY_ROOMS_HREF, SITE_TABS, type SiteTab } from './routes';

export interface SiteFrameProps {
  person: { id: string; name: string };
  role: string;
  roomCount: number;
  isSiteAdmin: boolean;
  canCreateRooms: boolean;
  branding: Branding;
  profileHref: string | null;
  current: 'rooms' | 'create' | 'site';
  crumbs: { label: string; href?: string }[];
  notice?: SiteNoticeData | null;
  children: ReactNode;
}

async function signOut() {
  await authCall('/sign-out', {});
  window.location.assign('/sign-in');
}

export function SiteFrame(p: SiteFrameProps) {
  // the settings page switches tabs with replaceState, which usePathname follows
  const shown = usePathname().split('/')[3] ?? 'branding';
  const tab = SITE_TABS.includes(shown as SiteTab) ? shown as SiteTab : null;
  const name = p.branding.name ?? 'VDRkit';
  let logo = <b>{name}</b>;
  if (p.branding.logos.light) logo = <OrgMark b={p.branding} />;
  else if (name === 'Quillmont Advisory') logo = <QuillmontLogo />;

  const nav: NavEntry[] = [
    { key: 'rooms', label: 'My rooms', icon: 'rooms', href: MY_ROOMS_HREF, current: p.current === 'rooms', count: p.roomCount.toLocaleString('en-GB') },
  ];
  if (p.canCreateRooms) nav.push({ key: 'create', label: 'Create a room', icon: 'plus', href: CREATE_ROOM_HREF, current: p.current === 'create' });
  if (p.isSiteAdmin) nav.push(...adminNav(p.current === 'site' ? tab : null));
  return (
    <OutsideShell
      notice={<SiteNotice notice={p.notice} />}
      instance={{ name, logo, homeHref: MY_ROOMS_HREF }}
      person={{ avatarKey: p.person.id, name: p.person.name, role: p.role, ...(p.profileHref ? { profileHref: p.profileHref } : {}) }}
      nav={nav}
      crumbs={p.crumbs}
      unread={0}
      notificationSettingsHref={p.profileHref ? `${p.profileHref}?tab=notifications` : undefined}
      accountMenu={[
        ...(p.profileHref ? [{ label: 'Profile and notifications', hint: 'Opens your profile and email settings', href: p.profileHref }] : []),
        ...privacyMenuItem(p.branding.privacy),
        aboutMenuItem(),
        { label: 'Sign out', hint: 'Ends your session on this browser', onSelect: () => { void signOut(); } },
      ]}
    >
      {p.children}
    </OutsideShell>
  );
}
