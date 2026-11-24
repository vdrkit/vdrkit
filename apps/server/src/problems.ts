// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  reason: z.string().optional(),
  items: z.array(z.unknown()).optional(),
  reference: z.string().optional(),
  tagDays: z.number().optional(),
  noPreview: z.enum(['file_type', 'too_large', 'failed']).optional(),
});
export type Problem = z.infer<typeof Problem>;

export class HttpProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
  }
}

// same 404 for missing and hidden
export const notFound = () =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/not-found', title: 'Not found', status: 404, detail: 'Nothing exists here that you can see.' });

export const forbidden = (detail: string, reason?: string, items?: unknown[]) =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/forbidden', title: 'Not allowed', status: 403, detail, reason, items });

export const unauthenticated = () =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/unauthenticated', title: 'Sign in required', status: 401 });

export const badRequest = (detail: string, items?: unknown[]) =>
  new HttpProblem({ type: 'https://vdrkit.com/problems/bad-request', title: 'Invalid request', status: 400, detail, items });

export function send(reply: FastifyReply, p: Problem) {
  return reply.code(p.status).type('application/problem+json').send(p);
}

// no 0/O, 1/I/L, U: read out over the phone
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function errorReference(requestId: string): string {
  const h = createHash('sha256').update(requestId).digest();
  let s = '';
  for (let i = 0; i < 8; i++) s += REF_ALPHABET[h[i]! % REF_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
