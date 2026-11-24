// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { describeMinutes } from '@/components/errors/pages';
import { ClockIcon } from '@/components/outside/icons';
import { useToast } from '@/components/outside/Toast';
import { authCall, getPolicy, SIGNED_OUT_COOKIE } from '@/lib/auth-client';

// activity is shared across tabs; the ping keeps the API's idle clock in step

const WARN_MS = 2 * 60_000;
const PING_EVERY_MS = 60_000;
const SHARED_KEY = 'vdrkit-last-activity';
const ACTIVITY_EVENTS = ['click', 'keydown', 'scroll', 'wheel', 'touchstart'] as const;

function readShared(): number {
  try { return Number(localStorage.getItem(SHARED_KEY)) || 0; } catch { return 0; }
}
function writeShared(t: number) {
  try { localStorage.setItem(SHARED_KEY, String(t)); } catch { /* storage blocked: this tab only */ }
}

export function IdleGuard({ roomName }: { roomName: string }) {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const last = useRef(Date.now());
  const lastPing = useRef(Date.now());
  const ending = useRef(false);
  const stay = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const warning = left !== null && left <= WARN_MS;

  useEffect(() => {
    writeShared(Date.now());
    void getPolicy().then((r) => { if (r.ok && r.data) setMinutes(r.data.idleSignOutMinutes); });
  }, []);

  // Cookie, not the URL: a crafted link must not put words on the page
  function signedOutHref() {
    const facts = encodeURIComponent(JSON.stringify({ room: roomName, minutes }));
    document.cookie = `${SIGNED_OUT_COOKIE}=${facts}; path=/signed-out; max-age=600; samesite=strict${window.location.protocol === 'https:' ? '; secure' : ''}`;
    return `/signed-out?${new URLSearchParams({ next: `${window.location.pathname}${window.location.search}` })}`;
  }

  async function signOut() {
    if (ending.current) return;
    ending.current = true;
    await authCall('/sign-out', {});
    window.location.assign(signedOutHref());
  }

  function ping() {
    lastPing.current = Date.now();
    void getPolicy().then((r) => {
      // another tab signed out, or the machine slept
      if (r.status === 401) window.location.assign(signedOutHref());
    });
  }

  useEffect(() => {
    if (!minutes) return;
    const onActivity = () => {
      if (warning || ending.current) return;
      const now = Date.now();
      last.current = now;
      writeShared(now);
      if (now - lastPing.current >= PING_EVERY_MS) ping();
    };
    const opts = { capture: true, passive: true } as const;
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, opts);
    return () => { for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, opts); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ping and signOut change only with minutes
  }, [minutes, warning]);

  useEffect(() => {
    if (!minutes) return;
    const tick = () => {
      const latest = Math.max(last.current, readShared());
      last.current = latest;
      const remaining = latest + minutes * 60_000 - Date.now();
      setLeft(remaining);
      if (remaining <= 0) void signOut();
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signOut changes only with minutes
  }, [minutes]);

  useEffect(() => { if (warning) stay.current?.focus(); }, [warning]);

  function stayIn() {
    const now = Date.now();
    last.current = now;
    writeShared(now);
    setLeft(minutes! * 60_000);
    ping();
    toast.show('You are still signed in', `The ${describeMinutes(minutes!)} start again from now.`);
  }

  function keepFocusInside(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])') ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const lastIx = items.length - 1;
    let to: number;
    if (e.shiftKey) to = at <= 0 ? lastIx : at - 1;
    else to = at === lastIx ? 0 : at + 1;
    e.preventDefault();
    items[to]!.focus();
  }

  const s = Math.max(0, Math.ceil((left ?? 0) / 1000));
  return (
    <>
      {warning && minutes ? (
        <div ref={dialog} className="pg-dlg" role="dialog" aria-modal="true" aria-labelledby="idle-h" onKeyDown={keepFocusInside}>
          <section className="card">
            <div className="done-ico warn"><ClockIcon /></div>
            <div>
              <h1 id="idle-h">Are you still there?</h1>
              <p className="lead">
                You have not used {roomName} for almost {describeMinutes(minutes)}. For security, you will be signed out in{' '}
                <b id="still">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</b>.
              </p>
            </div>
            <div className="acts">
              <button type="button" className="btn secondary" onClick={() => void signOut()}>Sign out now</button>
              <button ref={stay} type="button" className="btn primary" onClick={stayIn}>Stay signed in</button>
            </div>
            <p className="hint">Staying signed in keeps you on the page you were on.</p>
          </section>
        </div>
      ) : null}
      {toast.node}
    </>
  );
}
