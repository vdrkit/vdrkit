// SPDX-License-Identifier: AGPL-3.0-only
// tab names are in links from the API; don't rename
import type { NavEntry } from '@/components/shell';

export { CREATE_ROOM_HREF, MY_ROOMS_HREF } from '../rooms/routes';

export const SITE_TABS = ['branding', 'email', 'rooms', 'accounts', 'health'] as const;
export type SiteTab = (typeof SITE_TABS)[number];

export function siteSettingsHref(tab: SiteTab = 'branding'): string {
  return tab === 'branding' ? '/site/settings' : `/site/settings/${tab}`;
}

// branding, outgoing mail and health
const SERVER_TABS: readonly SiteTab[] = ['branding', 'email', 'health'];

// tab is null off the settings page
export function adminNav(tab: SiteTab | null): NavEntry[] {
  return [
    { section: 'Administration' },
    { key: 'site-server', label: 'Server settings', icon: 'site', href: siteSettingsHref('branding'), current: tab !== null && SERVER_TABS.includes(tab) },
    { key: 'site-accounts', label: 'Accounts', icon: 'team', href: siteSettingsHref('accounts'), current: tab === 'accounts' },
    { key: 'site-rooms', label: 'Rooms', icon: 'rooms', href: siteSettingsHref('rooms'), current: tab === 'rooms' },
  ];
}
