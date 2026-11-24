// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NotBuiltYet, RoomPage } from '@/components/room/RoomPage';
import { LATER_SECTIONS, type RoomSection } from '@/components/room/routes';

const TITLE: Partial<Record<RoomSection, string>> = {
  team: 'My team', people: 'People', permissions: 'Permissions', activity: 'Activity', timeline: 'Timeline', settings: 'Settings',
  profile: 'Profile and notifications', release: 'Release review', import: 'Bulk import',
};

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }): Promise<Metadata> {
  const { section } = await params;
  return { title: TITLE[section as RoomSection] ?? 'Page not available' };
}

export default async function Later({ params }: { params: Promise<{ ws: string; section: string }> }) {
  const { ws, section } = await params;
  if (!LATER_SECTIONS.includes(section as RoomSection)) notFound();
  return (
    <RoomPage ws={ws} section={section as RoomSection}>
      <NotBuiltYet title={TITLE[section as RoomSection]!} />
    </RoomPage>
  );
}
