// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata, Viewport } from 'next';
import { Geist_Mono, Schibsted_Grotesk } from 'next/font/google';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { DevToolsPill } from '@dev-tools';
import { HydrationMark } from '@/components/shell/HydrationMark';
import { PlaceTracker } from '@/components/shell/PlaceTracker';
import { SandboxBanner } from '@/components/sandbox/SandboxBanner';
import { ThemeBoot } from '@/components/theme/ThemeBoot';
import './globals.css';

const schibsted = Schibsted_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-schibsted', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'VDRkit', template: 'VDRkit %s' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // must render per request, or scripts miss the CSP nonce
  await connection();
  return (
    <html lang="en-GB" className={`${schibsted.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeBoot />
      </head>
      <body>
        <SandboxBanner />
        {children}
        <HydrationMark />
        <PlaceTracker />
        <DevToolsPill />
      </body>
    </html>
  );
}
