// SPDX-License-Identifier: AGPL-3.0-only

// FNV-1a
export function avatarHash(key: string): number {
  let h = 2166136261;
  for (const c of key) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatarSlot(key: string): number {
  return (avatarHash(key.trim().toLowerCase()) % 8) + 1;
}

export function avatarColour(key: string): string {
  return `var(--av-${avatarSlot(key)})`;
}

// skips prefixes: "Jan de Vries" -> JV
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0]?.toUpperCase() ?? '';
  if (words.length < 2) return first;
  const rest = words.slice(1).join(' ');
  const capital = rest.match(/\p{Lu}/u)?.[0] ?? rest[0]?.toUpperCase() ?? '';
  return first + capital;
}
