// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';
import { LinkExpired } from '@/components/errors/pages';
import { afterSignIn, SignInFlow, type SignInStep } from './SignInFlow';

// no callback, so JSON back; a dead link answers with a redirect
export function MagicLinkLanding({ token, next }: { token: string; next: string }) {
  const [state, setState] = useState<'checking' | 'expired' | SignInStep>('checking');
  const started = useRef(false);

  useEffect(() => {
    // single-use token, and dev runs effects twice
    if (started.current) return;
    started.current = true;
    void (async () => {
      let res: Response;
      try {
        res = await fetch(`/v1/auth/magic-link/verify?token=${encodeURIComponent(token)}`, { credentials: 'include', redirect: 'manual', cache: 'no-store' });
      } catch {
        setState('expired');
        return;
      }
      if (res.type === 'opaqueredirect' || !res.ok) { setState('expired'); return; }
      const body = (await res.json().catch(() => ({}))) as { twoFactorRedirect?: boolean };
      if (body.twoFactorRedirect) { setState('totp'); return; }
      await afterSignIn(next, (s) => setState(s));
    })();
  }, [token, next]);

  if (state === 'expired') return <LinkExpired />;
  if (state === 'checking') {
    return (
      <div>
        <h1>Signing you in</h1>
        <p className="lead">Checking the link from your email.</p>
      </div>
    );
  }
  return <SignInFlow next={next} initialStep={state} />;
}
