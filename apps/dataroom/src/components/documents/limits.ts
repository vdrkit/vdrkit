// SPDX-License-Identifier: AGPL-3.0-only
// = UPLOAD_MAX_BYTES on the server. No imports: a server test reads this file
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

export function limitText(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Number(gb.toFixed(1))} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export const MAX_FILE_TEXT = limitText(MAX_FILE_BYTES);

// server's wording, verbatim
export const TOO_LARGE_TEXT = `Files larger than ${MAX_FILE_TEXT} cannot be uploaded. Split the file or compress it.`;
