// SPDX-License-Identifier: AGPL-3.0-only
export interface AuthAnswer<T> {
  ok: boolean;
  status: number;
  data: T | null;
  code: string | null;
}

export async function authCall<T = unknown>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<AuthAnswer<T>> {
  const init: RequestInit = { method, credentials: 'include', headers: {}, cache: 'no-store' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path.startsWith('/v1/') ? path : `/v1/auth${path}`, init);
  } catch {
    return { ok: false, status: 0, data: null, code: 'NETWORK' };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data: json as T, code: null };
  const j = (json ?? {}) as { code?: string; reason?: string; type?: string };
  return { ok: false, status: res.status, data: null, code: j.code ?? j.reason ?? j.type ?? null };
}

export interface SignInPolicy {
  requireTwoFactor: boolean;
  allowTrustedBrowser: boolean;
  trustedBrowserDays: number;
  idleSignOutMinutes: number;
  rooms: number;
  twoFactorEnabled: boolean | null;
  twoFactorSetupRequired: boolean;
}

export const getPolicy = () => authCall<SignInPolicy>('/v1/me/sign-in-policy', undefined, 'GET');

export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  // browsers strip tabs/newlines: "/<tab>/evil.com" becomes "//evil.com"
  if (/[\u0000- \u007f-\u009f]/.test(next)) return '/';
  const base = 'http://vdrkit.invalid';
  let url: URL;
  try { url = new URL(next, base); } catch { return '/'; }
  if (url.origin !== base) return '/';
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  if (/^\/(sign-in|signed-out|updating)(\/|\?|$)/.test(path)) return '/';
  return path;
}

export const SIGNED_OUT_COOKIE = 'vdrkit-signed-out';

export const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export function manualKey(totpURI: string): string {
  let secret: string;
  try {
    secret = new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
  return secret.replace(/(.{4})/g, '$1 ').trim();
}
