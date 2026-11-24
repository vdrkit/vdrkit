// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { serverApi } from '@/api/server';
import { NO_BRANDING, OutsideFrame, privacyLinkOf, type Branding } from './OutsideFrame';

export async function getBranding(): Promise<Branding> {
  try {
    const { data } = await (await serverApi()).GET('/v1/branding');
    if (!data) return NO_BRANDING;
    return {
      name: data.organisationName,
      logos: { light: data.logos.light?.url ?? null, dark: data.logos.dark?.url ?? null },
      privacy: privacyLinkOf(data.privacyNotice),
      source: data.sourceCode.url,
    };
  } catch {
    return NO_BRANDING;
  }
}

export async function OutsidePage({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return <OutsideFrame branding={await getBranding()} wide={wide}>{children}</OutsideFrame>;
}
