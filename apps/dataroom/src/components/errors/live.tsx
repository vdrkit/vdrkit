// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useEffect, useState } from 'react';
import { FaultIcon, UpdateIcon } from '@/components/outside/icons';
import { useToast } from '@/components/outside/Toast';
import { safeNext } from '@/lib/auth-client';

export { referenceFrom } from '@/lib/error-reference';

export function useRoomContact(org: string | null): string | null {
  const [contact, setContact] = useState<string | null>(null);
  useEffect(() => {
    const ws = /^\/rooms\/([0-9a-f-]{36})(\/|$)/i.exec(window.location.pathname)?.[1];
    if (!ws) return;
    void fetch('/v1/me/workspaces', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { items?: { id: string; contactName: string | null }[] } | null) => {
        const name = b?.items?.find((x) => x.id === ws)?.contactName;
        if (name) setContact(name);
      })
      .catch(() => {});
  }, []);
  if (!contact) return null;
  return org ? `${contact} at ${org}` : contact;
}

export function SomethingWrong({ reference, onRetry, contact }: { reference: string | null; onRetry: () => void; contact?: string | null }) {
  const toast = useToast();
  return (
    <>
      <div className="done-ico bad"><FaultIcon /></div>
      <div>
        <h1>Something went wrong</h1>
        <p className="lead">This page did not load because of a fault on the site. Try again in a minute. If you were saving something, check afterwards that it was saved.</p>
      </div>
      {reference ? (
        <>
          <div className="ref">
            <span className="hint">Reference</span>
            <span className="key" data-testid="reference">{reference}</span>
            <button type="button" className="linkbtn" onClick={() => {
              void navigator.clipboard?.writeText(reference).then(() => toast.show('Reference copied', reference), () => undefined);
            }}>Copy</button>
          </div>
          <p className="hint" style={{ marginTop: -8 }}>If it keeps happening, send this reference to {contact ? `the room admin, ${contact}` : 'the room admin'}. It lets the site admin find the fault in the log.</p>
        </>
      ) : null}
      <div className="acts">
        <a className="btn secondary" href="/rooms">Go to my rooms</a>
        <button type="button" className="btn primary" onClick={onRetry}>Try again</button>
      </div>
      {toast.node}
    </>
  );
}

const WAIT_S = 30;

async function apiIsUp(): Promise<boolean> {
  try {
    const r = await fetch('/v1/health', { cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}

export function BeingUpdated({ org, next }: { org: string | null; next: string }) {
  const [wait, setWait] = useState(WAIT_S);
  const { show, node } = useToast();

  const check = useCallback(async (byHand: boolean) => {
    if (await apiIsUp()) { window.location.assign(safeNext(next)); return; }
    setWait(WAIT_S);
    if (byHand) show('Still updating', 'This page keeps checking every 30 seconds.');
  }, [next, show]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (wait <= 1) void check(false);
      else setWait((w) => w - 1);
    }, 1000);
    return () => clearTimeout(t);
  }, [wait, check]);

  return (
    <>
      <div className="done-ico info"><UpdateIcon /></div>
      <div>
        <h1>VDRkit is being updated</h1>
        <p className="lead">{org ?? 'The site admin'} is installing a new version. This usually takes a few minutes. Nothing in your data rooms changes.</p>
      </div>
      <div className="check">
        <span className="spin" aria-hidden="true" />
        <span id="chk">This page checks again in {wait} s and then opens where you were.</span>
      </div>
      <button type="button" className="btn secondary block" onClick={() => void check(true)}>Check now</button>
      {node}
    </>
  );
}
