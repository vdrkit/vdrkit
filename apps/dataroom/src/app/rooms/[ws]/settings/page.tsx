// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getRoomShell, must, serverApi } from '@/api/server';
import { RoomPage } from '@/components/room/RoomPage';
import { SettingsScreen, type SettingsTab } from '@/components/settings/SettingsScreen';
import '@/styles/settings.css';

export const metadata: Metadata = { title: 'Room settings' };

const TABS: SettingsTab[] = ['general', 'nda', 'signin', 'wm', 'pub', 'notif', 'invite'];

export default async function Settings({ params, searchParams }: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { ws } = await params;
  const sp = await searchParams;
  const shell = await getRoomShell(ws);
  if (!shell.me.isAdmin) notFound();
  const api = await serverApi();
  const hasLogo = (variant: 'light' | 'dark') =>
    api.GET('/v1/workspaces/{ws}/logo/{variant}', { params: { path: { ws, variant } }, parseAs: 'arrayBuffer' })
      .then((r) => r.response.ok).catch(() => false);
  const [settings, nda, light, dark] = await Promise.all([
    api.GET('/v1/workspaces/{ws}/settings', { params: { path: { ws } } }).then((r) => must(r, ws)),
    api.GET('/v1/workspaces/{ws}/nda/overview', { params: { path: { ws } } }).then((r) => must(r, ws)),
    hasLogo('light'),
    hasLogo('dark'),
  ]);
  const tab = typeof sp.tab === 'string' && (TABS as string[]).includes(sp.tab) ? (sp.tab as SettingsTab) : 'general';
  return (
    <RoomPage ws={ws} section="settings">
      <SettingsScreen
        ws={ws}
        initial={settings}
        nda={nda}
        logos={{ light, dark }}
        runBy={shell.room.runBy}
        myName={shell.me.name}
        timeZone={shell.me.timeZone}
        initialTab={tab}
      />
    </RoomPage>
  );
}
