// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { personOf, requireWorkspaceAdmin } from './util.js';

const WsParams = z.object({ ws: z.string().uuid() });

const Team = z.object({
  id: z.string().uuid(),
  name: z.string(),
  side: z.enum(['bidders', 'seller']),
  parentGroupId: z.string().uuid().nullable(),
  roleTemplate: z.string(),
  members: z.number(),
});

export const seeAsRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/see-as', {
    schema: {
      summary: 'Groups the room can be viewed as. Room admins only',
      params: WsParams,
      response: { 200: z.object({ teams: z.array(Team) }) },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const now = app.now();
    await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
    const rows = (await tx.query<{ group_id: string; name: string; side: 'bidders' | 'seller'; parent_group_id: string | null; role_template: string; members: string }>(
      `select t.group_id, t.name, t.side, t.parent_group_id, t.role_template,
              (select count(distinct m.person_id) from membership m where m.group_id = t.group_id and m.status = 'active'
                 and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= $3 and $3 < m.superseded_at) as members
         from see_as_teams($1, $2, $3) t`, [personOf(caller), req.params.ws, now.toISOString()])).rows;
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-GB');
    const ids = new Set(rows.map((t) => t.group_id));
    const tops = rows.filter((t) => !t.parent_group_id || !ids.has(t.parent_group_id)).sort(byName);
    const ordered = [];
    for (const top of tops) {
      ordered.push(top, ...rows.filter((s) => s.parent_group_id === top.group_id).sort(byName));
    }
    const teams = ordered.map((t) => ({
      id: t.group_id, name: t.name, side: t.side, parentGroupId: t.parent_group_id, roleTemplate: t.role_template, members: Number(t.members),
    }));
    return { teams };
  }));
};
