// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { Geist_Mono, Schibsted_Grotesk } from 'next/font/google';
import { referenceFrom, SomethingWrong, useRoomContact } from '@/components/errors/live';
import { OutsideFrame } from '@/components/outside/OutsideFrame';
import { useBranding } from '@/components/outside/useBranding';
import { ThemeBoot } from '@/components/theme/ThemeBoot';
import './globals.css';

const schibsted = Schibsted_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-schibsted', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-geist-mono', display: 'swap' });

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const branding = useBranding();
  const contact = useRoomContact(branding.name);
  return (
    <html lang="en-GB" className={`${schibsted.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <title>VDRkit Something went wrong</title>
        <ThemeBoot />
      </head>
      <body>
        <OutsideFrame branding={branding}>
          <SomethingWrong reference={referenceFrom(error)} onRetry={retry} contact={contact} />
        </OutsideFrame>
      </body>
    </html>
  );
}
