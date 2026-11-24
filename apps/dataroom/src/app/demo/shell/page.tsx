// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RoomShell } from '@/components/shell';
import { demoRoomShell } from '@/demo/fixture';

export const metadata: Metadata = { title: 'Documents' };

export default function ShellDemo() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return (
    <RoomShell {...demoRoomShell}>
      <div className="head">
        <div>
          <p className="over">2 Legal</p>
          <h1><span className="ix">2.4</span>Material contracts</h1>
          <p className="sub">Shell demo with the Project Heron example data. The folder contents come with screen C2.</p>
        </div>
      </div>
    </RoomShell>
  );
}
