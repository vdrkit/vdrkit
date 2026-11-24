// SPDX-License-Identifier: AGPL-3.0-only
export function displayName(name: string, kind: 'folder' | 'document' = 'document'): string {
  return kind === 'document' ? name.replace(/\.[a-z0-9]{1,5}$/i, '') : name;
}

export const byIndex = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
