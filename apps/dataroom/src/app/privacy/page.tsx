// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverApi } from '@/api/server';
import { OutsidePage } from '@/components/outside/OutsidePage';

export const metadata: Metadata = { title: 'Privacy notice' };

async function loadNotice() {
  const r = await (await serverApi()).GET('/v1/branding/privacy');
  return r.data;
}

export default async function PrivacyPage() {
  const notice = await loadNotice().catch(() => undefined);
  if (!notice) notFound();
  const paragraphs = notice.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <OutsidePage wide>
      <div>
        <h1>Privacy notice</h1>
        {notice.organisationName ? <p className="lead">From {notice.organisationName}, who runs these data rooms.</p> : null}
      </div>
      <div className="privacy-text">
        {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
      </div>
    </OutsidePage>
  );
}
