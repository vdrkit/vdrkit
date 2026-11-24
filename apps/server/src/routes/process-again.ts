// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, canSeeVersion, effectiveAccess, present } from '@vdrkit/core';
import { forbidden, HttpProblem, notFound } from '../problems.js';
import { personOf, refuseIfArchived, requireMember } from './util.js';

export const processAgainRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/v1/workspaces/:ws/versions/:id/process-again', {
    schema: {
      summary: 'Process a version again after it failed. Room admins, and people who may add files or publish there; 409 not_failed otherwise',
      params: z.object({ ws: z.string().uuid(), id: z.string().uuid() }),
      body: z.object({}).default({}),
      response: { 200: z.object({ status: z.literal('pending') }) },
    },
  }, async (req) => {
    const { ws, id } = req.params;
    const queue = app.deps.queue;
    const now = app.now();
    const tenantId = await app.inTenant(req, async (tx, caller) => {
      const member = await requireMember(tx, caller, ws, now);
      if (caller.principal.kind === 'agent') throw forbidden('Agents cannot start processing. Ask the person to do it.', 'agent_needs_approval');
      const v = (await tx.query<{ node_id: string; processing_status: string; withdrawn_at: string | null }>(
        `select dv.node_id, dv.processing_status, dv.withdrawn_at from document_version dv join node n on n.id = dv.node_id
          where dv.id = $1 and n.workspace_id = $2 and n.deleted_at is null for update of dv`, [id, ws])).rows[0];
      if (!v) throw notFound();
      if (!member.isAdmin) {
        // 404, not 403: don't reveal the version
        if (!(await canSeeVersion(tx, caller.principal, id, present(now)))) throw notFound();
        const a = await effectiveAccess(tx, personOf(caller), v.node_id, present(now));
        if (!a.canUpload && !a.canPublish && !a.canManage) {
          throw forbidden('Only room admins and people who may add files or publish here can process a file again.', 'no_upload_right');
        }
      }
      await refuseIfArchived(tx, ws);
      if (v.withdrawn_at || v.processing_status !== 'failed') {
        throw new HttpProblem({ type: 'https://vdrkit.com/problems/conflict', title: 'Nothing to process again', status: 409, reason: 'not_failed',
          detail: 'Only a file whose processing failed can be processed again.' });
      }
      if (!queue) {
        throw new HttpProblem({ type: 'https://vdrkit.com/problems/not-configured', title: 'Processing is not set up', status: 503,
          detail: 'This server has no job queue configured.' });
      }
      await tx.query(
        `update document_version set processing_status = 'pending', queued_at = $2, processing_error = null, failed_step = null,
                processing_started_at = null, processing_heartbeat_at = null, metadata = metadata - 'processing_restarts' where id = $1`,
        [id, now.toISOString()]);
      await appendEvent(tx, { action: 'document.processing_restarted', workspaceId: ws, actorId: caller.actorId, resourceType: 'node', resourceId: v.node_id,
        data: { version_id: id, reason: 'asked', person_id: personOf(caller) }, occurredAt: now, requestId: req.id });
      return caller.tenantId;
    });
    // after commit: the worker must find the version pending
    await queue!.enqueue('process-version', { tenantId, versionId: id }, { singletonKey: `version:${id}:again:${now.getTime()}` });
    return { status: 'pending' as const };
  });
};
