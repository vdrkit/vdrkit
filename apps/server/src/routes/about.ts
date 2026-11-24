// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { VDRKIT_VERSION } from '../site/health.js';

export const DEFAULT_SOURCE_URL = 'https://github.com/vdrkit/vdrkit';

// AGPL-3.0 s13: forks must point VDRKIT_SOURCE_URL at their own source
export function sourceUrl(env: string | undefined = process.env.VDRKIT_SOURCE_URL): string {
  const v = env?.trim();
  if (!v) return DEFAULT_SOURCE_URL;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return DEFAULT_SOURCE_URL;
    return u.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_SOURCE_URL;
  }
}

export const aboutRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/v1/about', {
    schema: {
      summary: 'VDRkit version and source code link (AGPL-3.0 section 13)',
      response: { 200: z.object({ version: z.string(), sourceUrl: z.string(), licence: z.literal('AGPL-3.0-only') }) },
    },
  }, async () => ({ version: VDRKIT_VERSION, sourceUrl: sourceUrl(), licence: 'AGPL-3.0-only' as const }));
};
