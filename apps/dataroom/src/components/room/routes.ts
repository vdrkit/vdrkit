// SPDX-License-Identifier: AGPL-3.0-only
// Node ids, never index numbers: admins renumber.
export type RoomSection = 'dashboard' | 'documents' | 'search' | 'team' | 'people' | 'permissions' | 'activity' | 'timeline' | 'settings' | 'profile'
  | 'release' | 'import';

export const LATER_SECTIONS: RoomSection[] = ['team', 'people', 'permissions', 'activity', 'settings', 'profile', 'release', 'import'];

export function roomHref(ws: string, section: RoomSection, folderId?: string): string {
  return folderId && section === 'documents' ? `/rooms/${ws}/documents/${folderId}` : `/rooms/${ws}/${section}`;
}

export function viewHref(ws: string, nodeId: string, page?: number): string {
  return `/rooms/${ws}/view/${nodeId}${page ? `?page=${page}` : ''}`;
}

/** quotedAt: after a renumbering, only the quote time says which document was meant */
export function numberHref(ws: string, indexNumber: string, quotedAt?: string | Date): string {
  const at = quotedAt ? `&at=${encodeURIComponent(new Date(quotedAt).toISOString())}` : '';
  return `/rooms/${ws}/number?n=${encodeURIComponent(indexNumber)}${at}`;
}

export function detailsHref(ws: string, nodeId: string): string {
  return `/rooms/${ws}/details/${nodeId}`;
}
