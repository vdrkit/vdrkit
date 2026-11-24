// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminDashboard } from '@/components/dashboard/AdminDashboard';
import { BidderDashboard } from '@/components/dashboard/BidderDashboard';
import { BidderWaiting, ReadyChecklist } from '@/components/dashboard/EmptyStates';
import { RoomShell, type NavEntry } from '@/components/shell';
import {
  DEMO_NOW, DEMO_WS, demoActivity, demoBidderMilestones, demoCoverage, demoLeads, demoMilestones, demoNew, demoOwnCoverage, demoOwnRequests,
  demoPreviousVisit, demoRequests, demoToDo,
} from '@/demo/dashboard-fixture';
import { demoRoomShell } from '@/demo/fixture';
import '@/styles/dashboard.css';

export const metadata: Metadata = { title: 'Dashboard demo' };

const VIEWS = { lead: 'Bidder lead', member: 'Bidder member', admin: 'Room admin', new: 'New room', waiting: 'Bidder before publishing' } as const;
type View = keyof typeof VIEWS;

const bidderNav: NavEntry[] = [
  { key: 'dash', label: 'Dashboard', icon: 'dash', href: '#', current: true },
  { key: 'docs', label: 'Documents', icon: 'docs', href: '#', count: '887' },
  { key: 'search', label: 'Search', icon: 'search', href: '#' },
  { key: 'team', label: 'My team', icon: 'team', href: '#', count: '7' },
];

export default async function DashboardDemo({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  if (process.env.NODE_ENV !== 'development') notFound();
  const as = (await searchParams).as;
  const view: View = as && as in VIEWS ? (as as View) : 'lead';
  const adminSide = view === 'admin' || view === 'new';
  let person = { avatarKey: 'Jan de Vries', name: 'Jan de Vries', role: 'Bidder A · Lead' };
  if (view === 'member') person = { avatarKey: 'Pieter Nel', name: 'Pieter Nel', role: 'Bidder A · Member' };
  else if (adminSide) person = demoRoomShell.person;
  let subtitle = 'Run by Quillmont Advisory';
  if (view === 'new') subtitle = 'Preparing · no bidders yet';
  else if (view === 'admin') subtitle = '4 bidder groups';
  const nav = adminSide ? demoRoomShell.nav.map((e) => ('key' in e ? { ...e, current: e.key === 'dash' } : e)) : bidderNav;

  let body;
  if (view === 'admin') {
    body = <AdminDashboard ws={DEMO_WS} roomName="Project Heron" timeZone="Africa/Johannesburg" roomTimeZone="Africa/Johannesburg" now={DEMO_NOW}
      toDo={demoToDo} requests={demoRequests} activity={demoActivity} milestones={demoMilestones} folderIds={{}} demo />;
  } else if (view === 'new') {
    body = <ReadyChecklist roomName="Project Heron" steps={[
      { done: true, title: 'Create the room', text: 'Done by Anika Pillay on Sat 14 Nov 2026, with the standard M&A index of 11 folders.' },
      { done: false, title: 'Add the documents', text: 'Import a folder from your computer, or drop files onto the folders in Documents. Everything arrives as a draft.', action: { label: 'Bulk import', href: '#' } },
      { done: false, title: 'Create the bidder groups and invite people', text: 'One group per bidder. Invitations go out only when the room opens.', action: { label: 'Go to People', href: '#' } },
      { done: false, title: 'Decide who sees what', text: "Set each group's access per folder in Permissions.", action: { label: 'Go to Permissions', href: '#' } },
      { done: false, title: 'Ask for the NDA', text: 'Bidders accept it before they see a document.', action: { label: 'Open NDA settings', href: '#' } },
      { done: false, title: 'Release the documents', text: 'Review the drafts and publish them to the groups.', action: { label: 'Release review', href: '#' } },
      { done: false, title: 'Open the room to bidders', text: 'Bidders get their invitation and can enter. You can still add documents and people afterwards.', action: { label: 'Open the room', href: '#' } },
    ]} />;
  } else if (view === 'waiting') {
    body = <BidderWaiting ws={DEMO_WS} roomName="Project Heron" groupName="Bidder A" timeZone="Europe/London" now={DEMO_NOW} milestones={[]}
      notice={{ enabled: true, frequency: 'digest', summaryTimes: ['08:00'] }} />;
  } else {
    body = <BidderDashboard ws={DEMO_WS} roomName="Project Heron" groupName="Bidder A" kind={view} timeZone="Europe/London" now={DEMO_NOW}
      personId={`demo-${view}`} previousVisitAt={demoPreviousVisit} newSinceLastVisit={demoNew}
      teamCoverage={view === 'lead' ? demoCoverage : null} myCoverage={view === 'member' ? demoOwnCoverage : null} teamSize={7} leads={demoLeads}
      requests={view === 'lead' ? demoOwnRequests : null} milestones={demoBidderMilestones} folderIds={{}} live={false} />;
  }

  return (
    <RoomShell {...demoRoomShell} person={person} nav={nav} index={undefined}
      room={{ ...demoRoomShell.room, subtitle, canSwitch: adminSide }}
      ownTimeZone={adminSide ? 'Africa/Johannesburg' : 'Europe/London'}
      crumbs={[{ label: 'Project Heron' }, { label: 'Dashboard' }]}
      search={{ ...demoRoomShell.search, placeholder: adminSide ? 'Search 1,248 documents' : 'Search 887 documents' }}>
      <p className="cap" data-demo-switch="">
        Demo data, development only:{' '}
        {(Object.keys(VIEWS) as View[]).map((k, i) => (
          <span key={k}>{i ? ' · ' : ''}{k === view ? <b>{VIEWS[k]}</b> : <Link href={`/demo/dashboard?as=${k}`}>{VIEWS[k]}</Link>}</span>
        ))}
      </p>
      {body}
    </RoomShell>
  );
}
