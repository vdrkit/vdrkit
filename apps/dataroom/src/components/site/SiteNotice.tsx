// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import type { paths } from '@/api/client';

export type SiteNoticeData = paths['/v1/site/notice']['get']['responses'][200]['content']['application/json'];

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// API answers show: false to anyone but site admins
export function SiteNotice({ notice }: { notice: SiteNoticeData | null | undefined }) {
  if (!notice?.show) return null;
  const what = notice.items.length
    ? `${list(notice.items.map((i) => i.label))} ${notice.items.length === 1 ? 'has' : 'have'} stopped working.`
    : 'The health checks have stopped running, so nobody would be told if something stopped working.';
  return (
    <div className="site-notice" role="alert" data-site-notice>
      <span><b>{what}</b> Only site admins see this notice.</span>
      <Link href="/site/settings/health">Open Health in Site settings</Link>
    </div>
  );
}
