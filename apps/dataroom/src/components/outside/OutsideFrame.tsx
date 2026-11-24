// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { ThemeButton } from '@/components/shell/ThemeButton';
import { QuillmontLogo } from '@/demo/quillmont-logo';

export interface Branding {
  name: string | null;
  logos: { light: string | null; dark: string | null };
  privacy?: PrivacyLink | null;
  source?: string;
}

// AGPL: source link for everyone, signed in or not
export const DEFAULT_SOURCE_URL = 'https://github.com/vdrkit/vdrkit';

export interface PrivacyLink { href: string; external: boolean }

export const NO_BRANDING: Branding = { name: null, logos: { light: null, dark: null }, privacy: null };

export const PRIVACY_HREF = '/privacy';

export function privacyLinkOf(p: { kind: 'url'; url: string } | { kind: 'page' } | null | undefined): PrivacyLink | null {
  if (!p) return null;
  if (p.kind === 'url') return /^https?:\/\//i.test(p.url) ? { href: p.url, external: true } : null;
  return { href: PRIVACY_HREF, external: false };
}

export function OrgMark({ b }: { b: Branding }) {
  const light = b.logos.light;
  const dark = b.logos.dark ?? light;
  if (light) {
    return (
      <>
        <img className="org-light" src={light} alt="" />
        <img className="org-dark" src={dark!} alt="" />
      </>
    );
  }
  // demo instance has no uploaded logo
  if (b.name === 'Quillmont Advisory') return <QuillmontLogo />;
  return b.name ? <b>{b.name}</b> : null;
}

export function OutsideFrame({ branding, wide, children }: { branding: Branding; wide?: boolean; children: ReactNode }) {
  const external = branding.privacy?.external;
  return (
    <div className="pg">
      <header className="pg-top">
        <span className="org" role="img" aria-label={branding.name ?? 'VDRkit'}>
          <OrgMark b={branding} />
        </span>
        <ThemeButton />
      </header>
      <main className="pg-main" id="main">
        <section className={`card${wide ? ' wide' : ''}`} aria-live="polite">
          {children}
        </section>
      </main>
      <footer className="pg-foot">
        {branding.name ? <span>Data rooms run by {branding.name}</span> : null}
        {branding.privacy
          ? <a href={branding.privacy.href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>Privacy notice</a>
          : null}
        <a href="https://vdrkit.com" target="_blank" rel="noopener noreferrer" aria-label="Powered by VDRkit (opens vdrkit.com in a new tab)">Powered by <b>VDRkit</b></a>
        <a href={branding.source ?? DEFAULT_SOURCE_URL} target="_blank" rel="noopener noreferrer" data-source-link="">Source code</a>
      </footer>
    </div>
  );
}
