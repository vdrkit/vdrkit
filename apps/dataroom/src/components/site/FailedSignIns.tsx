// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import type { paths } from '@/api/client';
import { useSendOnce } from '@/lib/send-once';
import { count, formatSignIn } from './model';

type Failures = paths['/v1/site/sign-in-failures']['get']['responses'][200]['content']['application/json'];
type Reason = Failures['items'][number]['reason'];

// must never reveal whether the address has an account
const REASONS: Record<Reason, string> = {
  wrong_code: 'Wrong email code',
  expired_code: 'Expired email code',
  too_many_attempts: 'Too many wrong codes',
  link_used_or_expired: 'Link already used or expired',
  wrong_authenticator_code: 'Wrong authenticator code',
  authenticator_locked: 'Locked after wrong authenticator codes',
};

const PAGE = 20;

export function FailedSignIns({ timeZone }: { timeZone: string }) {
  const [data, setData] = useState<Failures | null | 'error'>(null);
  const [more, setMore] = useState<'idle' | 'busy' | 'error'>('idle');
  const once = useSendOnce();

  useEffect(() => {
    let live = true;
    browserApi().GET('/v1/site/sign-in-failures', { params: { query: { limit: PAGE } } })
      .then((r) => { if (live) setData(r.data ?? 'error'); }, () => { if (live) setData('error'); });
    return () => { live = false; };
  }, []);

  const showOlder = once(async () => {
    if (!data || data === 'error' || data.nextBeforeSeq === null) return;
    setMore('busy');
    try {
      const r = await browserApi().GET('/v1/site/sign-in-failures', { params: { query: { limit: PAGE, beforeSeq: data.nextBeforeSeq } } });
      if (!r.data) { setMore('error'); return; }
      const page = r.data;
      setData((d) => (d && d !== 'error' ? { ...d, items: [...d.items, ...page.items], nextBeforeSeq: page.nextBeforeSeq } : d));
      setMore('idle');
    } catch { setMore('error'); }
  });

  let body: ReactNode;
  if (data === null) body = <p className="cap fail-empty">Loading…</p>;
  else if (data === 'error') body = <p className="cap fail-empty" role="alert">The failed sign-ins could not be loaded. Reload the page to try again.</p>;
  else if (data.items.length === 0) body = <p className="cap fail-empty">No failed sign-ins.</p>;
  else {
    body = (
      <div className="tbl">
        <div className="tr h fail-t"><span>When</span><span>Address</span><span>Why</span><span>From</span></div>
        {data.items.map((f) => (
          <div className="tr fail-t" key={f.id} data-failed={f.reason}>
            <span>{formatSignIn(f.occurredAt, timeZone)}</span>
            <span>{f.email ?? 'No address'}</span>
            <span>{REASONS[f.reason]}</span>
            <span>{f.browser ?? 'Unknown browser'}{f.ip ? <small>IP address {f.ip}</small> : null}</span>
          </div>
        ))}
        {data.nextBeforeSeq !== null ? (
          <div className="pfoot">
            {more === 'error' ? <span className="cap" role="alert">The older failed sign-ins could not be loaded. Try again.</span> : <span />}
            <button type="button" className="btn ghost sm" onClick={() => void showOlder()} disabled={more === 'busy'}>{more === 'busy' ? 'Loading…' : 'Show older failed sign-ins'}</button>
          </div>
        ) : null}
      </div>
    );
  }

  const last = data && data !== 'error' ? data.last24Hours : null;
  return (
    <section className="panel" data-failed-sign-ins>
      <div className="ph"><div><h2>Failed sign-ins</h2>
        <span className="cap">Wrong or expired codes, too many wrong tries, used or expired links and wrong authenticator codes, newest first. An entry does not mean the address has an account. Kept for 30 days.{last !== null ? ` ${count(last)} in the last 24 hours.` : ''}</span></div></div>
      {body}
    </section>
  );
}
