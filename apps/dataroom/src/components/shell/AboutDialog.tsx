// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import { DEFAULT_SOURCE_URL } from '@/components/outside/OutsideFrame';
import { useModal } from '@/lib/a11y';

const CloseIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;

type About = { version: string | null; sourceUrl: string };

const UNKNOWN: About = { version: null, sourceUrl: DEFAULT_SOURCE_URL };

const shortUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

// AGPL-3.0 s.13: network users must be offered the source. Modified copies set VDRKIT_SOURCE_URL on the API.
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLElement>(null);
  useModal(box, { onClose, focusFirst: false });
  const [about, setAbout] = useState<About | null>(null);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    let gone = false;
    void browserApi().GET('/v1/about')
      .then((r) => r.data ? { version: r.data.version, sourceUrl: r.data.sourceUrl } : UNKNOWN, () => UNKNOWN)
      .then((a) => { if (!gone) setAbout(a); });
    return () => { gone = true; };
  }, []);

  return (
    <>
      <div className="scrim about-scrim" onClick={onClose} />
      <aside ref={box} className="drawer nf about-dlg" role="dialog" aria-modal="true" aria-labelledby="about-t" aria-describedby="about-d">
        <div className="dw-h">
          <div><p className="over">VDRkit</p><h2 id="about-t">About and source code</h2></div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><CloseIcon /></button>
        </div>
        <div className="dw-b">
          <p id="about-d">
            VDRkit is free software under the GNU Affero General Public License, version 3. You may get its source code,
            change it and share it under the same licence.
          </p>
          <dl className="about-kv" aria-busy={about === null}>
            <dt>Version</dt>
            <dd data-about="version">{about === null ? 'Checking…' : about.version ?? 'Not known: the server did not answer.'}</dd>
            <dt>Licence</dt>
            <dd>GNU Affero General Public License v3.0 (AGPL-3.0-only)</dd>
            <dt>Source code</dt>
            <dd>
              {about === null ? 'Checking…' : (
                <a href={about.sourceUrl} target="_blank" rel="noopener noreferrer" data-about="source">
                  {shortUrl(about.sourceUrl)}<span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </dd>
          </dl>
        </div>
        <div className="dw-f">
          <button type="button" className="btn primary sm" data-autofocus onClick={onClose}>Close</button>
        </div>
      </aside>
    </>
  );
}
