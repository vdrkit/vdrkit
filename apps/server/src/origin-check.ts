// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyRequest } from 'fastify';
import { HttpProblem } from './problems.js';
import { normalisedPath } from './rate-limit.js';

// CSRF. No Origin and no Referer means not a browser: allowed unless it carries our cookie.
// x-vdrkit-render marks SSR; browsers can't send it cross-site without a preflight, which we never grant.

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const VDRKIT_COOKIE = /(?:^|;\s*)(?:__Secure-|__Host-)?vdrkit\.[^=;\s]+=/;

export const SERVER_RENDER_HEADER = 'x-vdrkit-render';

export function originsOf(urls: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const url of urls) {
    try {
      const origin = new URL(url).origin;
      if (origin !== 'null') out.add(origin);
    } catch {
    }
  }
  return out;
}

export const crossSiteRefused = () => new HttpProblem({
  type: 'https://vdrkit.com/problems/forbidden', title: 'Not allowed', status: 403, reason: 'cross_site_request',
  detail: 'This request did not come from this site, so it was refused. Open the site at its own address and try again.',
});

function originOfReferer(referer: string): string | null {
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function checkOrigin(req: FastifyRequest, allowed: Set<string>): void {
  if (!STATE_CHANGING.has(req.method)) return;
  const path = normalisedPath(req.url);
  if (path === null || !(path === '/v1' || path.startsWith('/v1/'))) return;
  const origin = header(req, 'origin');
  if (origin !== undefined) {
    if (!allowed.has(origin.trim())) throw crossSiteRefused();
    return;
  }
  const referer = header(req, 'referer');
  if (referer !== undefined) {
    const refererOrigin = originOfReferer(referer.trim());
    if (refererOrigin === null || !allowed.has(refererOrigin)) throw crossSiteRefused();
    return;
  }
  const cookie = header(req, 'cookie') ?? '';
  if (VDRKIT_COOKIE.test(cookie) && header(req, SERVER_RENDER_HEADER) !== 'server') throw crossSiteRefused();
}
