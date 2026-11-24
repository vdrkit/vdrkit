// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { DEFAULT_SOURCE_URL } from '@/components/outside/OutsideFrame';
import { ThemeButton } from '@/components/shell/ThemeButton';

export const INSTALLATION_GUIDE_URL = `${DEFAULT_SOURCE_URL}/blob/main/docs/install.md`;

export function SetupFrame({ version, children }: { version: string | null; children: ReactNode }) {
  return (
    <div className="pg setup">
      <header className="pg-top">
        <span className="mark" aria-label="VDRkit"><i />VDRkit</span>
        <ThemeButton />
      </header>
      <main className="pg-main" id="main">{children}</main>
      <footer className="pg-foot">
        {version ? <span>VDRkit {version}</span> : null}
        <a href={INSTALLATION_GUIDE_URL} target="_blank" rel="noreferrer">Installation guide</a>
        {/* AGPL-3.0 s13: a modified copy must offer its own source */}
        <a href={DEFAULT_SOURCE_URL} target="_blank" rel="noopener noreferrer" data-source-link="">Source code</a>
      </footer>
    </div>
  );
}
