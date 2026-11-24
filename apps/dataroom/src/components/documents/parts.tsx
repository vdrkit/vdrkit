// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState } from 'react';
import { levelLabel } from './format';
import type { GroupAccess } from './types';

export const visibleGroups = (groups: GroupAccess[]) => groups.filter((g) => g.level >= 20);

export function AccessChips({ groups }: { groups: GroupAccess[] }) {
  const vis = visibleGroups(groups);
  if (!vis.length) return <span className="gchip none">No bidder access</span>;
  return (
    <>
      {vis.map((g) => (
        <span key={g.id} className="gchip"><i style={{ background: g.color }} /><b>{g.name}</b>{levelLabel(g.level)}</span>
      ))}
    </>
  );
}

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5S21.5 12 21.5 12S18 18.5 12 18.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></svg>
);

export function VisibilityLine({ groups }: { groups: GroupAccess[] }) {
  const [open, setOpen] = useState(false);
  const vis = visibleGroups(groups);
  if (!vis.length) return <div className="access"><span className="gchip none">No bidder access</span></div>;
  return (
    <>
      <button type="button" className="vis" aria-expanded={open} aria-controls="vis-list" onClick={() => setOpen(!open)}>
        <EyeIcon />Visible to {vis.length} bidder {vis.length === 1 ? 'group' : 'groups'}
        <span className="dots" aria-hidden="true">{vis.map((g) => <i key={g.id} style={{ background: g.color }} />)}</span>
      </button>
      <div className="access" id="vis-list" hidden={!open}><AccessChips groups={groups} /></div>
    </>
  );
}
