// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

export const NoPreview = z.enum(['file_type', 'too_large']);
export type NoPreview = z.infer<typeof NoPreview>;

export const ProcessingStatus = z.enum(['pending', 'processing', 'ready', 'failed']);
export type ProcessingStatus = z.infer<typeof ProcessingStatus>;

export function noPreviewOf(status: string | null | undefined, pageCount: number | string | null | undefined, previewSkipped: unknown): NoPreview | null {
  if (status !== 'ready') return null;
  if (previewSkipped === 'too_large' || previewSkipped === 'file_type') return previewSkipped;
  return pageCount == null || Number(pageCount) === 0 ? 'file_type' : null;
}

export const PREVIEW_SKIPPED_COL = `dv.metadata ->> 'previewSkipped' as preview_skipped`;

// keep in step with the original download's needScanned check
export function downloadOnlyAllowed(v: { status: string | null; failed_step: string | null; virus_scan: string | null }): boolean {
  return v.status === 'failed' && v.failed_step !== 'virus' && v.failed_step !== 'hash' && v.virus_scan != null && v.virus_scan !== 'infected';
}
