// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { getRoomShell } from '@/api/server';
import { devAuthOn } from '@/lib/dev-auth';
import type { Crumb } from '@/components/shell';
import { RoomFrame } from './RoomFrame';
import type { RoomSection } from './routes';

export async function RoomPage(p: { ws: string; section: RoomSection; folderId?: string; tail?: Crumb[]; crumbs?: Crumb[]; children: ReactNode }) {
  const shell = await getRoomShell(p.ws);
  return (
    <RoomFrame shell={shell} section={p.section} folderId={p.folderId} tail={p.tail} crumbs={p.crumbs} idle={!devAuthOn()}>
      {p.children}
    </RoomFrame>
  );
}

export function NotBuiltYet({ over, title }: { over?: string; title: string }) {
  return (
    <div className="head" data-placeholder="not-built-yet">
      <div>
        {over ? <p className="over">{over}</p> : null}
        <h1>{title}</h1>
        <p className="sub">Not built yet</p>
      </div>
    </div>
  );
}
