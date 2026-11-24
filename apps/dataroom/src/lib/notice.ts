// SPDX-License-Identifier: AGPL-3.0-only
import type { serverApi } from '@/api/server';

type Api = Awaited<ReturnType<typeof serverApi>>;

export interface WaitingNotice { enabled: boolean; frequency: 'immediate' | 'bundled' | 'digest'; summaryTimes: string[] }

export function noticeText(n: WaitingNotice | null | undefined): string {
  if (!n) return 'We email you when the first ones are published.';
  if (!n.enabled) return 'You have switched off emails about new documents, so look here again later.';
  if (n.frequency === 'immediate') return 'We email you as soon as the first ones are published.';
  if (n.frequency === 'bundled') return 'We email you when the first ones are published, in one email once publishing pauses.';
  const times = n.summaryTimes.length ? n.summaryTimes : ['08:00'];
  return `We email you when the first ones are published, in your daily summary at ${times.join(' or ')}.`;
}

export async function documentsNotice(api: Api, ws: string): Promise<WaitingNotice | null> {
  const r = await api.GET('/v1/workspaces/{ws}/me/notifications', { params: { path: { ws } } }).catch(() => null);
  const mine = r?.data;
  const docs = mine?.events.find((e) => e.key === 'documents');
  if (!mine || !docs) return null;
  return { enabled: docs.enabled, frequency: docs.frequency, summaryTimes: mine.timing.summaryTimes };
}
