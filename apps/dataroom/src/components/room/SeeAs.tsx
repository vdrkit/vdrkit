// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import { FloatMenu, type MenuItem } from '@/components/documents/FloatMenu';
import { parseRoomPart, seeAsRoomPart, withoutSeeAs } from './see-as';

export interface SeeAsTeam {
  groupId: string; name: string; side: 'bidders' | 'seller';
  roomNotOpen?: boolean;
}

const SeeAsContext = createContext<SeeAsTeam | null>(null);
export const SeeAsProvider = SeeAsContext.Provider;

/** set in see-as mode: hide or disable actions */
export const useSeeAs = () => useContext(SeeAsContext);

// height goes into --see-as-h for the sticky menu and the viewer
export function SeeAsBar({ ws, team }: { ws: string; team: SeeAsTeam }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const stop = withoutSeeAs(`${pathname}${query ? `?${query}` : ''}`, ws);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    root.classList.add('see-as');
    const set = () => root.style.setProperty('--see-as-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.classList.remove('see-as'); root.style.removeProperty('--see-as-h'); };
  }, []);

  return (
    <div ref={ref} className="see-as-bar" role="status" data-testid="see-as-bar">
      <EyeIcon />
      <span className="grow"><b>You are seeing the room as {team.name}.</b> Nothing you do here is recorded.{team.roomNotOpen ? ' The room is not open yet.' : null}</span>
      <Link className="btn secondary sm" href={stop} prefetch={false}>Stop seeing as {team.name}</Link>
    </div>
  );
}

interface Team { id: string; name: string; side: 'bidders' | 'seller'; parentGroupId: string | null; roleTemplate: string; members: number }

const people = (n: number) => (n === 1 ? '1 person' : `${n.toLocaleString('en-GB')} people`);

export function SeeAsPicker({ ws }: { ws: string }) {
  const router = useRouter();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [failed, setFailed] = useState(false);
  const room = parseRoomPart(ws).room;

  useEffect(() => {
    if (!open || teams) return;
    let live = true;
    void browserApi().GET('/v1/workspaces/{ws}/see-as', { params: { path: { ws: room } } }).then((r) => {
      if (!live) return;
      if (r.data) setTeams(r.data.teams); else setFailed(true);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [open, teams, room]);

  const items: MenuItem[] = [];
  if (teams) {
    const parentName = new Map(teams.map((t) => [t.id, t.name]));
    for (const side of ['bidders', 'seller'] as const) {
      const heading = side === 'bidders' ? 'Bidders' : 'Seller team';
      teams.filter((t) => t.side === side).forEach((t, i) => {
        const hint = [people(t.members)];
        if (t.parentGroupId) hint.unshift(`Subgroup of ${parentName.get(t.parentGroupId) ?? 'a group'}`);
        if (t.roleTemplate === 'observer') hint.push('read only');
        items.push({
          label: t.parentGroupId ? `↳ ${t.name}` : t.name,
          hint: hint.join(' · '),
          heading: i === 0 ? heading : undefined,
          onSelect: () => router.push(`/rooms/${seeAsRoomPart(room, t.id)}/dashboard`),
        });
      });
    }
  }

  let status: string | null = null;
  if (failed) status = 'The teams could not be loaded. Try again.';
  else if (teams === null) status = 'Loading the teams…';
  else if (items.length === 0) status = 'No teams in this room yet. Create one in People.';

  return (
    <>
      <button ref={btn} type="button" className="btn secondary" aria-haspopup="menu" aria-expanded={open} data-testid="see-as-picker"
        title="Shows the room exactly as the team you choose sees it. Nothing changes and nothing is recorded." onClick={() => { setFailed(false); setOpen(!open); }}>
        <EyeIcon />See the room as…
      </button>
      {open && btn.current ? (
        <FloatMenu anchor={btn.current} label="See the room as" onClose={() => setOpen(false)}
          items={status ? [{ label: status, onSelect: () => undefined, disabled: true }] : items} />
      ) : null}
    </>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}
