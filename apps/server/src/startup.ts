// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyRequest } from 'fastify';

// .env.example ships CHANGE_ME for every password and secret
const PLACEHOLDER = /^CHANGE_ME/;

export function refusePlaceholders(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of ['DATABASE_URL', 'QUEUE_DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
    const url = env[name];
    if (!url) continue;
    let password: string;
    try {
      password = decodeURIComponent(new URL(url).password);
    } catch {
      continue;
    }
    if (PLACEHOLDER.test(password)) {
      throw new Error(`The password in ${name} is still the CHANGE_ME placeholder from .env.example. Set a real password in .env (openssl rand -hex 32) and start again.`);
    }
  }
  for (const name of ['BETTER_AUTH_SECRET', 'VDRKIT_MASTER_KEY']) {
    if (PLACEHOLDER.test(env[name] ?? '')) {
      throw new Error(`${name} is still the CHANGE_ME placeholder from .env.example. Generate one with openssl rand -base64 32, set it in .env and start again.`);
    }
  }
}

// compose passes TRUST_PROXY= as an empty string
export function trustProxyFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRUST_PROXY?.trim() || 'loopback, linklocal, uniquelocal';
}

// tenant id, dot, random part; in the path for invitations and email changes, ?token= for sign-in
const LINK_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{20,}/gi;

export function redactedUrl(url: string): string {
  return url.replace(LINK_TOKEN, '[redacted]').replace(/([?&](?:token|otp|code)=)[^&#]*/gi, '$1[redacted]');
}

// Fastify's own request serializer, but with the URL redacted
export const LOGGER = {
  serializers: {
    req: (req: FastifyRequest) => ({
      method: req.method,
      url: redactedUrl(req.url),
      version: req.headers?.['accept-version'] as string | undefined,
      host: req.host,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }),
  },
};
