// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { must, serverApi } from '@/api/server';
import type { Problem } from '@/api/client';
import { getBranding } from '@/components/outside/OutsidePage';
import { roomHref } from '@/components/room/routes';
import { SiteFrame } from '@/components/site/SiteFrame';
import { getSiteNotice } from '@/components/site/notice';
import { SiteSettings } from '@/components/site/SiteSettings';
import { SITE_TABS, type SiteTab } from '@/components/site/routes';
import '@/styles/site.css';

export const metadata: Metadata = { title: 'Site settings' };

export default async function SiteSettingsPage({ params }: { params: Promise<{ tab?: string[] }> }) {
  const { tab: parts } = await params;
  if (parts && (parts.length > 1 || !SITE_TABS.includes(parts[0] as SiteTab))) notFound();
  const tab = (parts?.[0] ?? 'branding') as SiteTab;

  const api = await serverApi();
  const first = await api.GET('/v1/site/settings');
  // 404, not 403: hide that the page exists
  if (first.response.status === 403 && (first.error as Problem | undefined)?.reason === 'not_site_admin') notFound();
  const settings = await must(first);

  const [me, rights, myRooms, rooms, staff, everyone, branding, notice] = await Promise.all([
    api.GET('/v1/me').then(must),
    api.GET('/v1/site/me').then(must),
    api.GET('/v1/me/workspaces').then(must),
    api.GET('/v1/site/rooms').then(must),
    api.GET('/v1/site/accounts', { params: { query: { filter: 'staff', limit: 50, offset: 0 } } }).then(must),
    api.GET('/v1/site/accounts', { params: { query: { filter: 'everyone', limit: 1, offset: 0 } } }).then(must),
    getBranding(),
    getSiteNotice(),
  ]);

  const org = settings.organisation.name ?? branding.name ?? 'VDRkit';
  const roomAdmin = myRooms.items.some((r) => r.isAdmin);
  const firstRoom = myRooms.items.find((r) => r.id === myRooms.openAtSignInWorkspaceId) ?? myRooms.items[0];

  return (
    <SiteFrame
      person={{ id: me.personId, name: me.name }}
      role={`${roomAdmin ? 'Room and site admin' : 'Site admin'} · ${org}`}
      roomCount={myRooms.items.length}
      isSiteAdmin={rights.isSiteAdmin}
      canCreateRooms={rights.canCreateRooms}
      branding={branding}
      notice={notice}
      profileHref={firstRoom ? roomHref(firstRoom.id, 'profile') : null}
      current="site"
      crumbs={[{ label: 'Administration' }, { label: 'Site settings' }]}
    >
      <SiteSettings
        initialTab={tab}
        settings={settings}
        rooms={rooms}
        staff={{ items: staff.items, total: staff.total }}
        everyoneTotal={everyone.total}
        me={{ personId: me.personId, name: me.name, email: me.email, timeZone: me.timeZone }}
      />
    </SiteFrame>
  );
}
