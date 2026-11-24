// SPDX-License-Identifier: AGPL-3.0-only
// public: status only
import { apiInternalUrl } from '@/api/server';

export const dynamic = 'force-dynamic';

async function apiIsUp(): Promise<boolean> {
  const res = await fetch(`${apiInternalUrl()}/health`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (res.status !== 200) return false;
  const body = (await res.json()) as { status?: string } | null;
  return body?.status === 'ok';
}

async function health(): Promise<Response> {
  const ok = await apiIsUp().catch(() => false);
  return new Response(JSON.stringify({ status: ok ? 'ok' : 'failing' }), {
    status: ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const GET = health;
export async function HEAD(): Promise<Response> {
  const r = await health();
  return new Response(null, { status: r.status, headers: r.headers });
}
