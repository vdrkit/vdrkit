// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { effectiveAccess, present } from '@vdrkit/core';
import { notFound } from '../problems.js';
import { capAccess, isWorkspaceAdmin, personOf } from './util.js';

const Params = z.object({ ws: z.string().uuid(), id: z.string().uuid() });

export const AudienceOut = z.object({
  // all parties, keeps colours stable
  parties: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  groups: z.array(z.object({
    id: z.string().uuid(), name: z.string(), partyId: z.string().uuid(),
    parentGroupId: z.string().uuid().nullable(), parentName: z.string().nullable(), level: z.number(),
  })),
  publishers: z.array(z.object({ personId: z.string().uuid(), name: z.string(), isAdmin: z.boolean() })),
  document: z.object({ publishedAt: z.string().nullable(), openedByGroups: z.number().nullable() }).nullable(),
});

// 404 for anyone outside the seller side: group names are confidential
export const audienceRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/nodes/:id/audience', {
    schema: {
      summary: 'Bidder groups that will see a node once published, and its publishers',
      params: Params,
      response: { 200: AudienceOut },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { ws, id } = req.params;
    const now = app.now();
    const at = now.toISOString();
    const person = personOf(caller);
    if (caller.principal.kind === 'agent') throw notFound();

    const node = (await tx.query<{ kind: 'folder' | 'document'; published_at: string | Date | null }>(
      `select kind, published_at from node where id = $1 and workspace_id = $2 and deleted_at is null`, [id, ws])).rows[0];
    if (!node) throw notFound();
    const admin = await isWorkspaceAdmin(tx, person, ws, now);
    if (!admin) {
      const seller = (await tx.query<{ ok: boolean }>(
        `select exists (select 1 from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
                         where m.person_id = $1 and g.workspace_id = $2 and pa.kind = 'seller' and m.status = 'active'
                           and m.valid_from <= $3 and $3 < m.valid_to and m.recorded_at <= $3 and $3 < m.superseded_at
                           and g.valid_from <= $3 and $3 < g.valid_to) as ok`, [person, ws, at])).rows[0]?.ok;
      const a = capAccess(caller, await effectiveAccess(tx, person, id, present(now)));
      if (!seller || !(a.canUpload || a.canManage || a.canPublish)) throw notFound();
    }

    const parties = (await tx.query<{ id: string; name: string }>(
      `select id, name from party where workspace_id = $1 and kind in ('bidder', 'financier') order by name, id`, [ws])).rows;
    const groups = (await tx.query<{ id: string; name: string; party_id: string; parent_group_id: string | null; parent_name: string | null; level: number }>(
      `select g.id, g.name, g.party_id, g.parent_group_id, pg.name as parent_name, group_level(g.id, $2, $3::timestamptz) as level
         from groups g join party pa on pa.id = g.party_id left join groups pg on pg.id = g.parent_group_id
        where g.workspace_id = $1 and pa.kind in ('bidder', 'financier') and g.valid_from <= $3 and $3 < g.valid_to
        order by pa.name, coalesce(g.parent_group_id, g.id), g.parent_group_id nulls first, g.name`, [ws, id, at])).rows;

    const sellers = (await tx.query<{ id: string; name: string }>(
      `select distinct p.id, p.name from membership m join groups g on g.id = m.group_id join party pa on pa.id = g.party_id
         join person p on p.id = m.person_id
        where g.workspace_id = $1 and pa.kind = 'seller' and m.status = 'active' and p.erased_at is null
          and m.valid_from <= $2 and $2 < m.valid_to and m.recorded_at <= $2 and $2 < m.superseded_at
          and g.valid_from <= $2 and $2 < g.valid_to`, [ws, at])).rows;
    const publishers: z.infer<typeof AudienceOut>['publishers'] = [];
    for (const s of sellers) {
      const isAdmin = await isWorkspaceAdmin(tx, s.id, ws, now);
      if (isAdmin || (await effectiveAccess(tx, s.id, id, present(now))).canPublish) publishers.push({ personId: s.id, name: s.name, isAdmin });
    }
    publishers.sort((a, b) => Number(a.isAdmin) - Number(b.isAdmin) || a.name.localeCompare(b.name, 'en-GB'));

    let document: z.infer<typeof AudienceOut>['document'] = null;
    if (node.kind === 'document') {
      let openedByGroups: number | null = null;
      if (admin) {
        openedByGroups = Number((await tx.query<{ n: string }>(
          `select count(distinct coalesce(g.parent_group_id, g.id)) as n
             from view_session s join membership m on m.person_id = s.person_id join groups g on g.id = m.group_id
             join party pa on pa.id = g.party_id
            where s.node_id = $1 and g.workspace_id = $2 and pa.kind in ('bidder', 'financier')
              and m.status = 'active' and m.valid_from <= s.opened_at and s.opened_at < m.valid_to`, [id, ws])).rows[0]?.n ?? 0);
      }
      document = { publishedAt: node.published_at ? new Date(node.published_at).toISOString() : null, openedByGroups };
    }

    return {
      parties,
      groups: groups.map((g) => ({ id: g.id, name: g.name, partyId: g.party_id, parentGroupId: g.parent_group_id, parentName: g.parent_name, level: Number(g.level) })),
      publishers,
      document,
    };
  }));
};
