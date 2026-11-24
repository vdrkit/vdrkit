// SPDX-License-Identifier: AGPL-3.0-only
import type { serverApi } from '@/api/server';
import type { paths } from '@/api/client';

type Api = Awaited<ReturnType<typeof serverApi>>;
type Review = paths['/v1/workspaces/{ws}/release-review']['get']['responses'][200]['content']['application/json'];
export type ReleaseRules = Review['room'];

export interface ReleaseTarget {
  id: string;
  versionId: string | null;
  replacesVersionNo: number | null;
  blocked: 'processing' | 'failed' | 'four_eyes' | null;
  anyBidder: boolean;
}

export interface ReleaseInfo { rules: ReleaseRules; items: Record<string, ReleaseTarget> }

// needs publish on the folder, not just on files
export async function loadReleaseInfo(api: Api, ws: string, folder: string): Promise<ReleaseInfo | null> {
  let r;
  try {
    r = await api.GET('/v1/workspaces/{ws}/release-review', { params: { path: { ws }, query: { folder } } });
  } catch {
    return null;
  }
  const d = r.data;
  if (!d || !d.me.canPublishFolder) return null;
  const folderGroups = new Map(d.folders.map((f) => [f.id, f.groups]));
  const items: Record<string, ReleaseTarget> = {};
  for (const i of d.items) {
    // API lists versions oldest first: a newer waiting version overwrites an older one
    items[i.id] = {
      id: i.id, versionId: i.versionId, replacesVersionNo: i.replacesVersionNo, blocked: i.blocked,
      anyBidder: (i.groups ?? folderGroups.get(i.folderId) ?? []).length > 0 || i.people.length > 0,
    };
  }
  return { rules: d.room, items };
}

export function releaseBlocked(rules: ReleaseRules, t: ReleaseTarget): string | null {
  if (rules.state === 'frozen') return 'The room is frozen. Nobody can publish until a room admin opens it again.';
  if (rules.state === 'closed' || rules.state === 'archived') return `The room is ${rules.state}. Nobody can publish.`;
  if (t.blocked === 'four_eyes') return 'You uploaded this. Under the four-eyes rule someone else publishes it.';
  if (t.blocked === 'processing') return 'Still being prepared for viewing. Ready in about a minute.';
  if (t.blocked === 'failed') return 'This file could not be prepared for viewing. Upload a new copy first.';
  return null;
}

export function releaseLabel(t: ReleaseTarget, versionNo?: number | null): string {
  return t.versionId && versionNo ? `Release version ${versionNo}` : 'Release';
}

function told(rules: ReleaseRules, quiet: boolean, who: 'Bidders' | 'They' = 'Bidders'): string {
  if (rules.noticeMandatory) return `${who} are emailed, because the room admins made this email mandatory.`;
  if (quiet) return 'Nobody is emailed. It shows as new in the room.';
  return `${who} hear about it as each chose in their notification settings.`;
}

export function releaseHint(rules: ReleaseRules, t: ReleaseTarget): string {
  if (!t.anyBidder) return 'Publishes it now, for the seller team only. No bidder group has access here yet.';
  const what = t.versionId && t.replacesVersionNo ? `Publishes it now in place of version ${t.replacesVersionNo}.` : 'Publishes it now.';
  return `${what} ${told(rules, false)}`;
}

export function canReleaseQuietly(rules: ReleaseRules, t: ReleaseTarget): boolean {
  return t.anyBidder && !rules.noticeMandatory;
}

export const QUIET_LABEL = 'Release quietly, no email';
export const QUIET_HINT = 'For a small fix. Publishes it now without emailing anyone. It still shows as new in the room, and is logged.';

export function releasedToast(rules: ReleaseRules, t: ReleaseTarget, label: string, versionNo: number | null, foldersAlong: number, quiet = false): { title: string; line: string } {
  const title = t.versionId && versionNo ? `Version ${versionNo} of ${label} is released` : `${label} is released`;
  const parts: string[] = [];
  if (!t.anyBidder) parts.push('Only the seller team can open it. No bidder group has access here yet.');
  else {
    parts.push(t.versionId && t.replacesVersionNo ? `Bidders see it now in place of version ${t.replacesVersionNo}.` : 'Bidders can open it now.');
    parts.push(told(rules, quiet, 'They'));
  }
  if (foldersAlong === 1) parts.push('Its draft folder is published with it.');
  else if (foldersAlong > 1) parts.push(`${foldersAlong} draft folders above it are published with it.`);
  parts.push('Logged in Activity.');
  return { title, line: parts.join(' ') };
}
