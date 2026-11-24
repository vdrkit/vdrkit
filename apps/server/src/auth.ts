// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Principal, SignInPolicy } from '@vdrkit/core';
import type { SeeAs } from './see-as.js';

export interface Caller {
  tenantId: string;
  principal: Principal;
  actorId: string | null;
  login?: { userId: string; sessionId: string; policy: SignInPolicy };
  // see-as: principal is the team's stand-in, tx always rolled back
  seeAs?: SeeAs;
}

export interface Authenticator {
  authenticate(req: FastifyRequest, reply?: FastifyReply): Promise<Caller | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Trusts x-dev headers. Never in production
export class DevHeaderAuthenticator implements Authenticator {
  readonly devOnly = true;
  async authenticate(req: FastifyRequest): Promise<Caller | null> {
    const tenantId = req.headers['x-dev-tenant'];
    const personId = req.headers['x-dev-person'];
    if (typeof tenantId !== 'string' || typeof personId !== 'string' || !UUID.test(tenantId) || !UUID.test(personId)) return null;
    const agentCap = req.headers['x-dev-agent-max-level'];
    if (typeof agentCap === 'string') {
      const maxLevel = Number(agentCap) as 0 | 10 | 20 | 30 | 40 | 50 | 60;
      return { tenantId, principal: { kind: 'agent', principalId: 'dev-agent', onBehalfOfPersonId: personId, maxLevel }, actorId: null };
    }
    return { tenantId, principal: { kind: 'person', personId }, actorId: null };
  }
}

const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?vdrkit\.session_token=[^;\s]/;

// a real session beats x-dev headers
export function devOrSessionAuthenticator(sessions: Authenticator, devHeaders: Authenticator = new DevHeaderAuthenticator()): Authenticator & { devOnly: true } {
  return {
    devOnly: true,
    authenticate: async (req, reply) => {
      const dev = req.headers['x-dev-person'] !== undefined;
      if (!dev || SESSION_COOKIE.test(req.headers.cookie ?? '')) {
        const caller = await sessions.authenticate(req, reply);
        if (caller || !dev) return caller;
      }
      return devHeaders.authenticate(req);
    },
  };
}
