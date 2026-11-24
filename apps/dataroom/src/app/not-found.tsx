// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { NotAvailable } from '@/components/errors/pages';
import { OutsidePage } from '@/components/outside/OutsidePage';

export const metadata: Metadata = { title: 'Page not available' };

// also used for rooms the caller isn't in; never name the room
export default function NotFound() {
  return <OutsidePage><NotAvailable /></OutsidePage>;
}
