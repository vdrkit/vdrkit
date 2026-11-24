// SPDX-License-Identifier: AGPL-3.0-only
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { devIdentityHeaders } from '@dev-tools';
import { createApiClient, type Problem } from './client';
import { deadLink } from './links';
import { API_DIGEST } from '@/lib/error-reference';

export function apiInternalUrl(): string {
  return process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '3101'}`;
}

export async function serverApi() {
  const jar = await cookies();
  const extra: Record<string, string> = { ...devIdentityHeaders(jar) };
  // API rate limits key on this. Only safe behind the proxy.
  const xff = (await headers()).get('x-forwarded-for');
  // real sign-in beats the persona pill
  const cookie = jar.toString();
  if (cookie) extra.cookie = cookie;
  // can't set a renewed cookie from a render
  extra['x-vdrkit-render'] = 'server';
  if (xff) extra['x-forwarded-for'] = xff;
  return createApiClient({ baseUrl: apiInternalUrl(), headers: extra, fetch: reachApi });
}

async function reachApi(req: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(req, { ...init, cache: 'no-store' });
  } catch {
    redirect(`/updating?next=${await nextParam()}`);
  }
}

export async function currentPath(): Promise<string> {
  const p = (await headers()).get('x-vdrkit-path');
  return p && p.startsWith('/') && !p.startsWith('//') ? p : '/';
}

const nextParam = async () => encodeURIComponent(await currentPath());

export class ApiError extends Error {
  // only the digest reaches the error page in production
  readonly digest: string | undefined;
  constructor(readonly status: number, readonly problem: Problem | undefined) {
    const ref = problem?.reference;
    let message = problem?.detail ?? problem?.title ?? `The API answered ${status}`;
    if (ref) message += ` (API reference ${ref})`;
    super(message);
    this.digest = ref ? `${API_DIGEST}${ref}` : undefined;
  }
}

type Answer<T> = { data?: T; error?: unknown; response: Response; request?: Request };

// a 400 on a GET renders as not-found too: never confirm an id exists
export async function must<T>(r: Answer<T>, ws?: string): Promise<T> {
  const status = r.response.status;
  const problem = r.error as Problem | undefined;
  const isGet = (r.request?.method ?? 'GET') === 'GET';
  if (status === 404 || (status === 400 && isGet)) notFound();
  if (status === 401) {
    const next = await nextParam();
    if (problem?.type?.endsWith('/signed-out-inactive')) redirect(`/signed-out?next=${next}`);
    redirect(`/sign-in?next=${next}`);
  }
  if (status === 403) {
    const reason = problem?.reason;
    if (reason === 'see_as_read_only' && isGet) notFound();
    if (reason === 'two_factor_setup_required') redirect(`/sign-in?setup=1&next=${await nextParam()}`);
    if (reason === 'nda_not_accepted' && ws) redirect(`/rooms/${ws}/nda?next=${await nextParam()}`);
  }
  const updating = status === 502 || status === 504 || (status === 503 && !problem?.type?.endsWith('/not-configured'));
  if (updating) redirect(`/updating?next=${await nextParam()}`);
  if (r.error !== undefined || r.data === undefined) throw new ApiError(status, problem);
  return r.data;
}

export async function linkAnswer<T>(r: Answer<T>): Promise<T | null> {
  if (r.data !== undefined) return r.data;
  if (deadLink(r.response.status)) return null;
  return must(r);
}

export const getRoomShellAnswer = cache(async (ws: string) => {
  const api = await serverApi();
  return api.GET('/v1/workspaces/{ws}/shell', { params: { path: { ws } } });
});

export type RoomShellData = Awaited<ReturnType<typeof fetchRoomShell>>;

async function fetchRoomShell(ws: string) {
  const shell = await must(await getRoomShellAnswer(ws), ws);
  // keeps the see-as team in links
  return { ...shell, room: { ...shell.room, id: ws } };
}

export const getRoomShell = cache(fetchRoomShell);
