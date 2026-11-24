// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { LinkExpired } from '@/components/errors/pages';
import { OutsidePage } from '@/components/outside/OutsidePage';

export const metadata: Metadata = { title: 'Link expired' };

export default function Expired() {
  return <OutsidePage><LinkExpired /></OutsidePage>;
}
