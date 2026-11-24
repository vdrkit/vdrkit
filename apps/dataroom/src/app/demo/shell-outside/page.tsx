// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OutsideShell } from '@/components/shell';
import { demoOutsideShell } from '@/demo/fixture';

export const metadata: Metadata = { title: 'My rooms' };

export default function OutsideShellDemo() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return (
    <OutsideShell {...demoOutsideShell}>
      <div className="head">
        <div>
          <p className="over">Quillmont Advisory</p>
          <h1>My rooms</h1>
          <p className="sub">Shell demo outside a room. The room cards come with screen B1.</p>
        </div>
      </div>
    </OutsideShell>
  );
}
