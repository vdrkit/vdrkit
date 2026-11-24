// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import type { IconName } from './icons';

export interface Instance {
  name: string;
  /** currentColor and var(--logo-mark), to follow the theme */
  logo: ReactNode;
  homeHref: string;
}

export interface ShellPerson {
  avatarKey: string;
  name: string;
  role: string;
  profileHref?: string;
}

export interface ShellRoom {
  initials: string;
  logo?: ReactNode;
  name: string;
  subtitle: string;
  /** IANA, e.g. Africa/Johannesburg */
  timeZone: string;
  canSwitch: boolean;
}

export interface NavLink {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  current?: boolean;
  count?: string;
  attention?: { value: string; title: string };
}

export type NavEntry = NavLink | { section: string };

export interface Crumb {
  label: string;
  href?: string;
}

export interface QuickSearchItem {
  id?: string;
  ix: string;
  name: string;
  where: string;
  folder?: boolean;
  was?: string;
}

export interface IndexFolder {
  ix: string;
  name: string;
  documents: number;
  drafts?: number;
  noBidderAccess?: boolean;
  canUpload?: boolean;
  open?: boolean;
  children?: IndexFolder[];
}
