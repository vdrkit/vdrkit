// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import type { Middleware } from 'openapi-fetch';
import { createApiClient, type ApiClient, type Problem } from './client';
import { splitApiPath } from '@/components/room/see-as';
import { safeNext } from '@/lib/auth-client';

export const NO_CONNECTION = 'The server could not be reached. Check your connection and try again.';

// pages that handle a 401 themselves
const OPEN_PAGE = /^\/(setup|sign-in|signed-out|updating|privacy|try|invite\/|email-change\/)/;
const OPEN_API = /^\/v1\/(setup|public|auth)(\/|$)/;

// never reject: a lost connection comes back as a 503 problem
const guard: Middleware = {
  onError({ request, error }) {
    if (request.signal.aborted) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    const problem: Problem = { type: 'about:blank', title: 'No connection', status: 503, detail: NO_CONNECTION };
    return new Response(JSON.stringify(problem), {
      status: 503,
      headers: { 'content-type': 'application/problem+json' },
    });
  },
  async onResponse({ request, response }) {
    await followSignOut(request.url, response);
  },
};

export function toSignIn(requestUrl: string, status: number, problem: unknown): boolean {
  if (status !== 401 || OPEN_PAGE.test(window.location.pathname)) return false;
  if (OPEN_API.test(new URL(requestUrl, window.location.href).pathname)) return false;
  const type = (problem as Partial<Problem> | null)?.type;
  const next = encodeURIComponent(safeNext(`${window.location.pathname}${window.location.search}`));
  const page = type?.endsWith('/signed-out-inactive') ? '/signed-out' : '/sign-in';
  window.location.assign(`${page}?next=${next}`);
  return true;
}

// for plain fetch() calls
export async function followSignOut(requestUrl: string, response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  return toSignIn(requestUrl, 401, await response.clone().json().catch(() => null));
}

let client: ApiClient | null = null;

export function browserApi(): ApiClient {
  if (!client) {
    client = createApiClient({ baseUrl: '' });
    client.use(guard);
  }
  return client;
}

export function apiUrl(path: string): string {
  const full = path.startsWith('/v1/') ? path : `/v1/${path.replace(/^\//, '')}`;
  const split = splitApiPath(full);
  if (!split) return full;
  const sep = split.path.includes('?') ? '&' : '?';
  return `${split.path}${sep}seeAs=${split.team}`;
}
