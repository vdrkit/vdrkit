// SPDX-License-Identifier: AGPL-3.0-only
// Dev only. Each entry point re-checks NODE_ENV at run time: a stray import stays inert.
import { cookies } from 'next/headers';
import { cache } from 'react';
import { PersonaPill } from './PersonaPill';
import { DEV_TENANT_ID, PERSONA_COOKIE, PERSONAS, personaFrom } from './personas';
import type { DevTools } from './types';

export const devToolsEnabled = () => process.env.NODE_ENV !== 'production' && process.env.VDRKIT_DEV_AUTH === '1';

const apiBase = () => process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '3101'}`;

export const devIdentityHeaders: DevTools['devIdentityHeaders'] = (jar): Record<string, string> => {
  if (!devToolsEnabled()) return {};
  return { 'x-dev-tenant': DEV_TENANT_ID, 'x-dev-person': personaFrom(jar.get(PERSONA_COOKIE)?.value).id };
};

const SESSION_COOKIES = ['vdrkit.session_token', '__Secure-vdrkit.session_token'];

// browser cookies only, no dev headers
export const realSignIn: DevTools['realSignIn'] = cache(async () => {
  if (!devToolsEnabled()) return null;
  const jar = await cookies();
  if (!SESSION_COOKIES.some((c) => jar.get(c)?.value)) return null;
  try {
    const res = await fetch(`${apiBase()}/v1/me`, { headers: { cookie: jar.toString(), 'x-vdrkit-render': 'server' }, cache: 'no-store' });
    if (!res.ok) return null;
    const me = (await res.json()) as { name?: string; email?: string };
    return { name: me.name || me.email || 'someone', email: me.email ?? '' };
  } catch {
    return null;
  }
});

export const DevToolsPill: DevTools['DevToolsPill'] = async () => {
  if (!devToolsEnabled()) return null;
  const current = personaFrom((await cookies()).get(PERSONA_COOKIE)?.value);
  const real = await realSignIn();
  return <PersonaPill personas={PERSONAS} current={current.key} cookie={PERSONA_COOKIE} signedIn={real} />;
};

// x-dev-*: the browser must never set its own identity
const DROP_REQUEST = ['host', 'connection', 'content-length', 'accept-encoding', 'x-dev-tenant', 'x-dev-person', 'x-dev-agent-max-level'];
const DROP_RESPONSE = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export const devApiProxy: DevTools['devApiProxy'] = async (req) => {
  if (process.env.NODE_ENV === 'production') return new Response(null, { status: 404 });
  const url = new URL(req.url);
  // tests and tools only
  if (url.pathname.startsWith('/v1/dev/')) return new Response(null, { status: 404 });
  const headers = new Headers(req.headers);
  for (const h of DROP_REQUEST) headers.delete(h);
  if (devToolsEnabled()) {
    headers.set('x-dev-tenant', DEV_TENANT_ID);
    headers.set('x-dev-person', personaFrom(cookieValue(req.headers.get('cookie'), PERSONA_COOKIE)).id);
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body;
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, body, redirect: 'manual', cache: 'no-store' };
  if (body) init.duplex = 'half';
  const res = await fetch(`${apiBase()}${url.pathname}${url.search}`, init);
  const out = new Headers(res.headers);
  for (const h of DROP_RESPONSE) out.delete(h);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
};
