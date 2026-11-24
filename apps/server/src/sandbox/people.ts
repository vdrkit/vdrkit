// SPDX-License-Identifier: AGPL-3.0-only
import { stableId } from '../demo/seed-demo.js';
import { SANDBOX_TENANT_ID } from './config.js';

export const SANDBOX_WORKSPACE_ID = stableId(SANDBOX_TENANT_ID, 'workspace');

export interface SandboxPersonSpec {
  key: 'anika' | 'johan' | 'maria' | 'liesl' | 'jan' | 'pieter' | 'mei' | 'sipho' | 'lars';
  group: 'admin' | 'seller' | 'bidder' | 'financier';
  can: string;
}

export const SANDBOX_GROUPS: Record<SandboxPersonSpec['group'], string> = {
  admin: 'Runs the room',
  seller: 'Seller team',
  bidder: 'Bidders',
  financier: 'Financier',
};

export const SANDBOX_PEOPLE: readonly SandboxPersonSpec[] = [
  { key: 'anika', group: 'admin', can: 'Room admin and site admin: folders, people, permissions, publishing, release review and Activity.' },
  { key: 'johan', group: 'seller', can: 'Adds documents to 3 Finance and publishes them there.' },
  { key: 'maria', group: 'seller', can: 'Adds drafts to 3 Finance; publishing them is for Johan or the room admin.' },
  { key: 'liesl', group: 'seller', can: 'Seller observer: reads what is published, changes nothing.' },
  { key: 'jan', group: 'bidder', can: 'Leads Bidder A: reads and prints, downloads in 3.2, and sees his team’s reading.' },
  { key: 'pieter', group: 'bidder', can: 'Member of Bidder A: reads and prints what Bidder A may see.' },
  { key: 'mei', group: 'bidder', can: 'Bidder B: views documents online, with less access than Bidder A.' },
  { key: 'sipho', group: 'bidder', can: 'Bidder C: views documents online, nothing more.' },
  { key: 'lars', group: 'financier', can: 'Bidder C’s bank, a subgroup: sees 3 Finance and nothing else.' },
];

export const sandboxPersonId = (key: SandboxPersonSpec['key']) => stableId(SANDBOX_TENANT_ID, `person:${key}`);
