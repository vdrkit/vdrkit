// SPDX-License-Identifier: AGPL-3.0-only
import createClient from 'openapi-fetch';
import type { paths } from './schema';
import { splitApiPath } from '@/components/room/see-as';

export type { paths } from './schema';

export interface ApiClientOptions {
  baseUrl?: string;
  tenantId?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  reason?: string;
  reference?: string;
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? '',
    credentials: 'include',
    headers: opts.headers,
    fetch: opts.fetch,
  });
  client.use({
    async onRequest({ request }) {
      const split = splitApiPath(request.url);
      if (!split) return request;
      const headers = new Headers(request.headers);
      headers.set('X-VDRkit-See-As', split.team);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      return new Request(split.path, { method: request.method, headers, body, signal: request.signal, credentials: request.credentials });
    },
  });
  const tenantId = opts.tenantId;
  if (tenantId) {
    client.use({
      onRequest({ request }) {
        request.headers.set('X-VDRkit-Tenant', tenantId);
        return request;
      },
    });
  }
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
