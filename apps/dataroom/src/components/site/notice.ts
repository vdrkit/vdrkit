// SPDX-License-Identifier: AGPL-3.0-only
import { serverApi } from '@/api/server';
import type { SiteNoticeData } from './SiteNotice';

export async function getSiteNotice(): Promise<SiteNoticeData | null> {
  try {
    const r = await (await serverApi()).GET('/v1/site/notice');
    return r.data?.show ? r.data : null;
  } catch {
    return null;
  }
}
