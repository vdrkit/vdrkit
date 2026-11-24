// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OutsidePage } from '@/components/outside/OutsidePage';
import { SandboxPeople } from '@/components/sandbox/SandboxPeople';
import { sandboxInfo } from '@/lib/sandbox';

export const metadata: Metadata = { title: 'Try VDRkit' };

export default async function TryPage() {
  const info = await sandboxInfo();
  if (!info) notFound();
  const mb = Math.round(info.limits.maxFileBytes / 1024 / 1024);
  return (
    <OutsidePage wide>
      <div>
        <h1>Try VDRkit</h1>
        <p className="lead">
          This is a sandbox: a shared copy of VDRkit with an invented sale, {info.roomName}. Choose a person below to see the
          data room as they do. No sign-in, no email: everything here is made up.
        </p>
      </div>
      <div className="note warn" role="note">
        <span>
          <b>Everyone who visits sees what you add, and everything is wiped every day at {info.resetTime}.</b> Do not upload
          confidential or personal files. Files up to {mb} MB, {info.limits.uploadsPerVisitorPerDay} a day.
        </span>
      </div>
      <SandboxPeople people={info.people} />
      <p className="hint">
        To keep your own rooms, run VDRkit yourself: it is open source.
      </p>
    </OutsidePage>
  );
}
