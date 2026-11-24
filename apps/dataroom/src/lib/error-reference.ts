// SPDX-License-Identifier: AGPL-3.0-only
// API faults carry the API reference in the digest; Next.js digests are shown as-is to match the server log.
export const API_DIGEST = 'vdrkit-api-';

export function referenceFrom(error: unknown): string | null {
  const e = error as { digest?: string; message?: string } | null;
  if (e?.digest?.startsWith(API_DIGEST)) return e.digest.slice(API_DIGEST.length);
  const api = /API reference ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(e?.message ?? '');
  if (api) return api[1]!;
  return e?.digest || null;
}
