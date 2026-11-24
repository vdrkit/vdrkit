// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce, uploadOrigins } from '@/lib/security-headers';

const SESSION_COOKIES = ['vdrkit.session_token', '__Secure-vdrkit.session_token'];

const OPEN = [/^\/setup$/, /^\/sign-in(\/|$)/, /^\/invite\//, /^\/email-change\//, /^\/signed-out$/, /^\/updating$/, /^\/privacy$/, /^\/demo\//];

const devAuth = () => process.env.NODE_ENV !== 'production' && process.env.VDRKIT_DEV_AUTH === '1';

const sandbox = () => process.env.VDRKIT_SANDBOX === '1';

let connect: string[] | undefined;

const FILE = /\.[a-zA-Z0-9]+$/;

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const here = `${pathname}${search}`;
  connect ??= uploadOrigins(process.env);
  const csp = contentSecurityPolicy({ nonce: newNonce(), dev: process.env.NODE_ENV !== 'production', connect });
  const open = OPEN.some((r) => r.test(pathname)) || (sandbox() && pathname === '/try');
  if (!FILE.test(pathname) && !devAuth() && !open && !SESSION_COOKIES.some((c) => req.cookies.get(c)?.value)) {
    if (sandbox()) return NextResponse.redirect(new URL('/try', req.url));
    const to = new URL('/sign-in', req.url);
    if (here !== '/') to.searchParams.set('next', here);
    return NextResponse.redirect(to);
  }
  const headers = new Headers(req.headers);
  headers.set('x-vdrkit-path', here);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return res;
}

export const config = {
  // /health must not redirect: monitors never sign in
  matcher: ['/((?!v1/|v1$|health$|_next/|favicon\\.ico$).*)'],
};
