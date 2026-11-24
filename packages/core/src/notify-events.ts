// SPDX-License-Identifier: AGPL-3.0-only
import type { Frequency } from './notify-schedule.js';

export type NotificationAudience = 'everyone' | 'admins_and_leads' | 'publishers' | 'admins';

export interface NotificationEvent {
  key: string;
  label: string;
  description: string;
  audience: NotificationAudience;
  defaultFrequency: Frequency;
  actions: readonly string[];
}

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  { key: 'documents', label: 'New documents', description: 'Published in a folder you can see', audience: 'everyone',
    defaultFrequency: 'bundled', actions: ['document.published'] },
  { key: 'versions', label: 'New versions', description: 'A document you can see has a new version', audience: 'everyone',
    defaultFrequency: 'bundled', actions: ['document.version_published'] },
  { key: 'access', label: 'Your access changed', description: 'A level raised, lowered or ended', audience: 'everyone',
    defaultFrequency: 'immediate', actions: [] },
  { key: 'deadlines', label: 'Timeline changes', description: 'A deadline or event added or moved', audience: 'everyone',
    defaultFrequency: 'immediate', actions: ['milestone.changed'] },
  { key: 'agreements', label: 'New NDA version', description: 'A new NDA to read and accept', audience: 'everyone',
    defaultFrequency: 'immediate', actions: ['agreement.version_published'] },
  { key: 'requests', label: 'Requests to add a colleague', description: 'A lead asks to add someone, and the decision on it',
    audience: 'admins_and_leads', defaultFrequency: 'immediate', actions: [] },
  { key: 'drafts', label: 'Drafts waiting', description: 'Uploads waiting in Release review', audience: 'publishers',
    defaultFrequency: 'digest', actions: [] },
  { key: 'processing_failed', label: 'Files that failed processing', description: 'An upload could not be read', audience: 'admins',
    defaultFrequency: 'immediate', actions: [] },
  { key: 'publish_dropped', label: 'A publish I asked for did not happen', description: 'A Publish now that could not go ahead, with the reason',
    audience: 'publishers', defaultFrequency: 'immediate', actions: [] },
];

export const NOTIFICATION_EVENT_KEYS = NOTIFICATION_EVENTS.map((e) => e.key);

export function notificationEvent(key: string): NotificationEvent | undefined {
  return NOTIFICATION_EVENTS.find((e) => e.key === key);
}

export const CATEGORY_OF: Record<string, string> = Object.fromEntries(
  NOTIFICATION_EVENTS.flatMap((e) => e.actions.map((a) => [a, e.key])),
);
