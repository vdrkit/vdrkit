// SPDX-License-Identifier: AGPL-3.0-only
import type { WaitingNotice } from '@/lib/notice';
import type { ReleaseInfo } from './release-one';

export type Viewer = 'admin' | 'seller' | 'buyer';

export interface Item {
  id: string;
  parentId: string | null;
  kind: 'folder' | 'document';
  name: string;
  indexNumber: string | null;
  state: 'draft' | 'published' | 'withdrawn';
  allowed: string[];
  version: {
    id: string; number: number; pageCount: number | null; uploadedAt: string;
    status: 'pending' | 'processing' | 'ready' | 'failed'; noPreview: 'file_type' | 'too_large' | null;
  } | null;
  uploadedBy: { personId: string; name: string } | null;
  releasedVersion: { id: string; pageCount: number | null; noPreview: 'file_type' | 'too_large' | null } | null;
  renumberedFrom: string | null;
}

export interface IndexEntry {
  id: string;
  parentId: string | null;
  indexNumber: string | null;
  name: string;
  documents: number;
  drafts: number;
  canUpload: boolean;
  noBidderAccess: boolean | null;
  renumberedFrom: string | null;
}

export interface GroupAccess {
  id: string;
  name: string;
  color: string;
  parentGroupId: string | null;
  parentName: string | null;
  // capped by parent group
  level: number;
}

export interface DocumentsData {
  ws: string;
  notice: WaitingNotice | null;
  roomName: string;
  me: { personId: string; timeZone: string; isAdmin: boolean; viewer: Viewer; group: string | null };
  folder: null | {
    id: string;
    indexNumber: string | null;
    name: string;
    parentId: string | null;
    state: 'draft' | 'published' | 'withdrawn';
    allowed: string[];
  };
  items: Item[];
  index: IndexEntry[];
  groups: GroupAccess[] | null;
  publishers: string[] | null;
  // doc id -> group id -> level
  ownAccess: Record<string, Record<string, number>>;
  pending: Record<string, number>;
  releaseCount: number | null;
  release: ReleaseInfo | null;
  nextInParent: string | null;
}
