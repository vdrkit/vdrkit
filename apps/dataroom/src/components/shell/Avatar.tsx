// SPDX-License-Identifier: AGPL-3.0-only
import { avatarColour, initials } from '@/lib/avatar';

export function Avatar({ name, colourKey, invited = false }: { name: string; colourKey?: string; invited?: boolean }) {
  if (invited) return <span className="avatar inv">{initials(name)}</span>;
  return (
    <span className="avatar" style={{ background: avatarColour(colourKey ?? name), color: '#FFFFFF' }}>
      {initials(name)}
    </span>
  );
}
