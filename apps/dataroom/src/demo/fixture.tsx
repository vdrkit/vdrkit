// SPDX-License-Identifier: AGPL-3.0-only
import type { IndexFolder, OutsideShellProps, QuickSearchItem, RoomShellProps } from '@/components/shell';
import { QuillmontLogo } from './quillmont-logo';

const instance = { name: 'Quillmont Advisory', logo: <QuillmontLogo />, homeHref: '/demo/shell-outside' };

const accountMenu = [
  { label: 'Profile and notifications', href: '#' },
  { label: 'About and source code', hint: 'Shows the version and where to get the source code', about: true as const },
  { label: 'Sign out', href: '#' },
];

const folders: IndexFolder[] = [
  { ix: '1', name: 'Corporate', documents: 86 },
  { ix: '2', name: 'Legal', documents: 213, drafts: 1, open: true, children: [
    { ix: '2.1', name: 'Constitutional documents', documents: 22 },
    { ix: '2.2', name: 'Litigation', documents: 17 },
    { ix: '2.3', name: 'Regulatory', documents: 31 },
    { ix: '2.4', name: 'Material contracts', documents: 14, drafts: 1 },
    { ix: '2.5', name: 'Employment', documents: 98 },
    { ix: '2.6', name: 'Property leases', documents: 31 },
  ] },
  { ix: '3', name: 'Finance', documents: 231, drafts: 26, open: true, canUpload: true, children: [
    { ix: '3.1', name: 'Management accounts', documents: 48 },
    { ix: '3.2', name: 'Audited financials', documents: 7, drafts: 2 },
    { ix: '3.3', name: 'Budgets and forecasts', documents: 19 },
    { ix: '3.4', name: 'Tax', documents: 133 },
    { ix: '3.5', name: 'Treasury', documents: 24, drafts: 24 },
  ] },
  { ix: '4', name: 'Commercial', documents: 498, drafts: 149 },
  { ix: '5', name: 'HR', documents: 187 },
  { ix: '6', name: 'IT', documents: 64 },
  { ix: '7', name: 'Property', documents: 145 },
  { ix: '8', name: 'Insurance', documents: 60, drafts: 60, noBidderAccess: true },
  { ix: '9', name: 'Environmental', documents: 68, drafts: 68, noBidderAccess: true },
  { ix: '10', name: 'Intellectual property', documents: 116, drafts: 116, noBidderAccess: true },
  { ix: '11', name: 'Data protection', documents: 21, drafts: 21, noBidderAccess: true },
];

const searchItems: QuickSearchItem[] = [
  { ix: '1.3', name: "Shareholders' agreement 2019", where: '1 Corporate' },
  { ix: '1.5', name: 'Board minutes 2025', where: '1 Corporate' },
  { ix: '2.4', name: 'Material contracts', where: '2 Legal', folder: true },
  { ix: '2.4.1', name: 'Master services agreement Kwelanet Business', where: '2 Legal › 2.4 Material contracts' },
  { ix: '2.4.2', name: 'Tarnley Logistics supply agreement', where: '2 Legal › 2.4 Material contracts' },
  { ix: '2.4.4', name: 'Distribution agreement Namibia', where: '2 Legal › 2.4 Material contracts' },
  { ix: '2.4.5', name: 'Tsamvo freight agreement', where: '2 Legal › 2.4 Material contracts' },
  { ix: '2.4.6', name: 'Change of control consents tracker', where: '2 Legal › 2.4 Material contracts' },
  { ix: '2.4.7', name: 'Supply agreement Ombeli Chemicals', where: '2 Legal › 2.4 Material contracts' },
  { ix: '2.4.9', name: 'Packaging supply agreement Paxenfold', where: '2 Legal › 2.4 Material contracts' },
  { ix: '2.4.12', name: 'Fleet lease agreement', where: '2 Legal › 2.4 Material contracts' },
  { ix: '3.2', name: 'Audited financials', where: '3 Finance', folder: true },
  { ix: '3.2.1', name: 'Audited financial statements FY2021', where: '3 Finance › 3.2 Audited financials' },
  { ix: '3.2.2', name: 'Audited financial statements FY2022', where: '3 Finance › 3.2 Audited financials' },
  { ix: '3.3.4', name: 'Five-year forecast model FY2027 to FY2031', where: '3 Finance › 3.3 Budgets and forecasts' },
  { ix: '3.4.2', name: 'Tax clearance certificate 2026', where: '3 Finance › 3.4 Tax' },
  { ix: '4.2.4', name: 'Customer contract Grocevia distribution', where: '4 Commercial › 4.2 Key customers' },
  { ix: '5.4.1', name: 'Executive service agreement, chief executive', where: '5 HR › 5.4 Executive contracts' },
  { ix: '7.1.3', name: 'Lease Germiston warehouse', where: '7 Property › 7.1 Leases' },
];

export const demoRoomShell: Omit<RoomShellProps, 'children'> = {
  instance,
  room: { initials: 'PH', name: 'Project Heron', subtitle: '4 bidder groups', timeZone: 'Africa/Johannesburg', canSwitch: true },
  person: { avatarKey: 'Anika Pillay', name: 'Anika Pillay', role: 'Room admin · Quillmont Advisory' },
  nav: [
    { key: 'dash', label: 'Dashboard', icon: 'dash', href: '#' },
    { key: 'docs', label: 'Documents', icon: 'docs', href: '/demo/shell', current: true, count: '1,248' },
    { key: 'search', label: 'Search', icon: 'search', href: '#' },
    { section: 'Administration' },
    { key: 'team', label: 'People', icon: 'team', href: '#', attention: { value: '2', title: '2 requests waiting' } },
    { key: 'perm', label: 'Permissions', icon: 'perm', href: '#', attention: { value: '4', title: '4 folders have no bidder access' } },
    { key: 'act', label: 'Activity', icon: 'act', href: '#' },
    { key: 'time', label: 'Timeline', icon: 'time', href: '#' },
    { key: 'set', label: 'Settings', icon: 'set', href: '#' },
  ],
  crumbs: [
    { label: 'Project Heron' },
    { label: 'Documents', href: '/demo/shell' },
    { label: '2 Legal', href: '/demo/shell' },
    { label: '2.4 Material contracts' },
  ],
  index: { folders, viewer: 'admin', currentIx: '2.4' },
  search: { placeholder: 'Search 1,248 documents', items: searchItems },
  unread: 3,
  accountMenu,
};

export const demoOutsideShell: Omit<OutsideShellProps, 'children'> = {
  instance,
  person: { avatarKey: 'Anika Pillay', name: 'Anika Pillay', role: 'Room and site admin · Quillmont Advisory' },
  nav: [
    { key: 'rooms', label: 'My rooms', icon: 'rooms', href: '/demo/shell-outside', current: true, count: '3' },
    { key: 'create', label: 'Create a room', icon: 'plus', href: '#' },
    { section: 'Instance' },
    { key: 'site', label: 'Site settings', icon: 'site', href: '#' },
  ],
  crumbs: [{ label: 'My rooms' }],
  unread: 3,
  accountMenu,
};
