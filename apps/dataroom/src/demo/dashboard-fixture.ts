// SPDX-License-Identifier: AGPL-3.0-only
import type { Coverage, GroupActivity, Milestone, NewFolder, TeamCoverage, TeamRequest, ToDo } from '@/components/dashboard/model';
import type { OwnRequest } from '@/components/dashboard/BidderDashboard';

export const DEMO_WS = 'demo';
export const DEMO_NOW = '2026-11-12T08:24:00.000Z';

const G = { A: 'demo-g-a', AF: 'demo-g-af', B: 'demo-g-b', C: 'demo-g-c', CF: 'demo-g-cf', S: 'demo-g-s' };

export const demoMilestones: Milestone[] = [
  { id: 'm1', title: 'Room opened', dueAt: '2026-11-03T07:00:00.000Z', phase: null, visibleToGroupIds: [] },
  { id: 'm2', title: 'Q&A round 1 closes', dueAt: '2026-11-20T15:00:00.000Z', phase: null, visibleToGroupIds: [] },
  { id: 'm3', title: 'Non-binding offers due', dueAt: '2026-11-27T15:00:00.000Z', phase: { name: 'First round', startsOn: '2026-11-03' }, visibleToGroupIds: [] },
  { id: 'm4', title: 'Management presentation, Bidder A', dueAt: '2026-12-08T08:00:00.000Z', phase: null, visibleToGroupIds: [G.A] },
  { id: 'm5', title: 'Management presentation, Bidder C', dueAt: '2026-12-09T08:00:00.000Z', phase: null, visibleToGroupIds: [G.C] },
  { id: 'm6', title: 'Q&A cut-off', dueAt: '2027-01-22T15:00:00.000Z', phase: null, visibleToGroupIds: [] },
  { id: 'm7', title: 'Binding offers due', dueAt: '2027-02-12T15:00:00.000Z', phase: { name: 'Second round', startsOn: '2026-11-30' }, visibleToGroupIds: [] },
];

export const demoBidderMilestones: Milestone[] = demoMilestones
  .filter((m) => !m.visibleToGroupIds?.length || m.visibleToGroupIds.includes(G.A))
  .map(({ id, title, dueAt, phase }) => ({ id, title, dueAt, phase }));

const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T09:00:00.000Z`;
let seq = 0;
const doc = (indexNumber: string, name: string, day: number) => ({ id: `demo-doc-${++seq}`, indexNumber, name, publishedAt: at(day), read: false });

export const demoNew: NewFolder[] = [
  { folder: '2 Legal', folderId: 'demo-f2', count: 3, items: [
    doc('2.4.12', 'Supply agreement Tarnley Logistics.pdf', 11), doc('2.4.13', 'Amendment 1 to Tarnley supply agreement.pdf', 11),
    doc('2.6.3', 'Litigation summary November 2026.pdf', 12)] },
  { folder: '3 Finance', folderId: 'demo-f3', count: 6, items: [
    doc('3.1.7', 'Management accounts October 2026.pdf', 12), doc('3.1.8', 'Commentary on October management accounts.docx', 12),
    doc('3.2.4', 'IFRS 16 lease reconciliation.xlsx', 10), doc('3.3.2', 'Budget 2027 board pack.pdf', 11),
    doc('3.4.6', 'Tax clearance certificate 2026.pdf', 11), doc('3.4.7', 'VAT reconciliation FY2026.xlsx', 11)] },
  { folder: '4 Commercial', folderId: 'demo-f4', count: 2, items: [
    doc('4.2.5', 'Top 20 customer contracts summary.xlsx', 11), doc('4.2.6', 'Customer churn analysis FY2023 to FY2026.xlsx', 11)] },
  { folder: '5 HR', folderId: 'demo-f5', count: 2, items: [
    doc('5.1.4', 'Organisation chart November 2026.pdf', 12), doc('5.3.2', 'Key employee contracts summary.pdf', 12)] },
  { folder: '7 Property', folderId: 'demo-f7', count: 1, items: [doc('7.1.2', 'Lease schedule Johannesburg and Cape Town.xlsx', 11)] },
];

export const demoPreviousVisit = '2026-11-10T14:42:00.000Z';

const cover: [string, number, number][] = [
  ['1 Corporate', 31, 38], ['2 Legal', 96, 214], ['3 Finance', 152, 186], ['4 Commercial', 88, 342], ['5 HR', 12, 61], ['6 IT', 0, 27], ['7 Property', 19, 19],
];
export const demoCoverage: TeamCoverage = {
  opened: 398, total: 887, folders: cover.map(([folder, opened, total]) => ({ folder, opened, total })),
};

export const demoOwnCoverage: Coverage = (() => {
  const folders = cover.map(([folder, opened, total]) => ({ folder, opened: Math.round(opened * 0.22), total }));
  return { opened: folders.reduce((s, f) => s + f.opened, 0), total: 887, folders };
})();

export const demoOwnRequests: OwnRequest[] = [
  { id: 'r1', name: 'Thandi Mokoena', status: 'pending', createdAt: '2026-11-11T13:20:00.000Z', decidedAt: null },
  { id: 'r2', name: 'Ruan Venter', status: 'approved', createdAt: '2026-11-06T09:00:00.000Z', decidedAt: '2026-11-09T09:00:00.000Z' },
];

export const demoLeads = ['Jan de Vries', 'Sipho Dlamini'];

export const demoToDo: ToDo = {
  drafts: { count: 23, oldestAt: '2026-11-09T08:00:00.000Z', byFolder: [
    { folder: '4.2 Customer contracts', count: 9 }, { folder: '3.1 Management accounts', count: 6 },
    { folder: '5.3 Employment contracts', count: 5 }, { folder: '2.6 Litigation', count: 3 }] },
  accessRequests: [],
  removalRequests: [],
  failedProcessing: [{ nodeId: 'demo-failed', indexNumber: '4.2.14', name: 'Customer master data export.xlsb',
    error: 'The file is password protected, so VDRkit cannot convert it for viewing.', uploadedBy: 'Maria Botha',
    uploadedById: 'demo-maria', uploadedAt: '2026-11-12T07:40:00.000Z' }],
};

function request(id: string, name: string, groupId: string, groupName: string, requestedBy: string, createdAt: string, reason: string): TeamRequest {
  const [givenName, ...rest] = name.split(' ');
  return { id, status: 'pending', groupId, groupName, requestedBy, name, givenName: givenName!, familyName: rest.join(' '),
    email: '', company: '', jobTitle: '', reason, createdAt, decidedAt: null, decisionNote: null, decidedBy: null };
}
export const demoRequests: TeamRequest[] = [
  request('q1', 'Thandi Mokoena', G.A, 'Bidder A', 'Jan de Vries', '2026-11-11T13:20:00.000Z', 'Tax adviser on our team'),
  request('q2', 'Lars Eriksen', G.CF, 'Bidder C · financier', 'Mei Tanaka', '2026-11-12T06:10:00.000Z', 'Lead arranger, Skarvik Bank'),
];

const act = (groupId: string, groupName: string, parentGroupId: string | null, members: number, activeToday: number, openedToday: number,
  lastSevenDays: number[], lastSeenAt: string | null, quietThisWeek = 0, partyKind = 'bidder'): GroupActivity =>
  ({ groupId, groupName, parentGroupId, members, partyKind, activeToday, openedToday, lastSevenDays, lastSeenAt, quietThisWeek });
export const demoActivity: GroupActivity[] = [
  act(G.C, 'Bidder C', null, 8, 5, 112, [40, 15, 8, 72, 96, 130, 112], '2026-11-12T08:22:00.000Z'),
  act(G.A, 'Bidder A', null, 7, 4, 63, [55, 10, 3, 61, 70, 48, 63], '2026-11-12T08:10:00.000Z'),
  act(G.AF, 'Bidder A · financier', G.A, 2, 1, 9, [0, 0, 0, 0, 12, 20, 9], '2026-11-12T07:12:00.000Z'),
  act(G.B, 'Bidder B', null, 5, 1, 4, [22, 0, 0, 14, 9, 6, 4], '2026-11-11T13:10:00.000Z', 3),
  act(G.S, 'Seller observers', null, 3, 0, 0, [5, 0, 0, 2, 0, 3, 0], '2026-11-11T09:00:00.000Z', 3, 'seller'),
];
