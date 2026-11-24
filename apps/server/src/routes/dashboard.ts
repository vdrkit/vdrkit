// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, openDroppedPublishes, publishDroppedSentence, type SqlClient } from '@vdrkit/core';
import { badRequest, notFound } from '../problems.js';
import { MilestoneOut, visibleMilestones } from './timeline.js';
import { activeIn, currentMembers, downloadsBetween, lastSevenDays, readingBetween, roomZone, weekStart } from './activity-basis.js';
import { onSellerSide, publishableNodes } from './documents.js';
import { personOf, refuseIfArchived, requireMember, requireWorkspaceAdmin } from './util.js';
import { mailBranding } from '../mail/branding.js';
import { newCopyEmail, toMessage } from '../mail/templates.js';
import { mailEvent } from '../mail/proof.js';

const NAME = `case when p.erased_at is not null then 'Erased user' else p.name end`;

const WsParams = z.object({ ws: z.string().uuid() });

const NewDoc = z.object({ id: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string(), publishedAt: z.string(), read: z.boolean() });
const Dashboard = z.object({
  role: z.enum(['admin', 'member']),
  previousVisitAt: z.string().nullable(),
  milestones: z.array(MilestoneOut),
  // items capped at NEW_PER_FOLDER, count is the total
  newSinceLastVisit: z.array(z.object({
    folder: z.string().nullable(), folderId: z.string().uuid().nullable(), count: z.number(), items: z.array(NewDoc),
  })).optional(),
  // leads only
  teamCoverage: z.object({
    opened: z.number(), total: z.number(), folders: z.array(z.object({ folder: z.string(), opened: z.number(), total: z.number() })),
  }).optional(),
  myCoverage: z.object({
    opened: z.number(), total: z.number(), pagesRead: z.number(), pagesShared: z.number(),
    folders: z.array(z.object({ folder: z.string(), opened: z.number(), total: z.number(), pagesRead: z.number(), pagesShared: z.number() })),
  }).optional(),
  myRequests: z.array(z.object({ id: z.string().uuid(), name: z.string(), status: z.string(), createdAt: z.string() })).optional(),
  toPublish: z.object({
    count: z.number(), oldestAt: z.string().nullable(),
    byFolder: z.array(z.object({ folder: z.string(), folderId: z.string().uuid().nullable(), count: z.number() })),
  }).optional(),
  // max 14 days
  notPublished: z.array(z.object({
    nodeId: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string(), folderId: z.string().uuid().nullable(),
    versionNo: z.number().nullable(), reason: z.enum(['failed', 'refused']), text: z.string(), at: z.string(),
  })).optional(),
  toDo: z.object({
    drafts: z.object({ count: z.number(), oldestAt: z.string().nullable(), byFolder: z.array(z.object({ folder: z.string(), count: z.number() })) }),
    accessRequests: z.array(z.object({
      id: z.string().uuid(), name: z.string(), groupId: z.string().uuid(), groupName: z.string(), requestedBy: z.string(), createdAt: z.string(),
      reason: z.string().nullable(),
    })),
    removalRequests: z.array(z.object({ id: z.string().uuid(), name: z.string(), groupName: z.string(), requestedBy: z.string(), reason: z.string(), createdAt: z.string() })),
    failedProcessing: z.array(z.object({
      nodeId: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string(), error: z.string().nullable(), uploadedBy: z.string().nullable(),
      uploadedById: z.string().uuid().nullable(),
      uploadedAt: z.string(),
    })),
  }).optional(),
  activity: z.array(z.object({
    groupId: z.string().uuid(), groupName: z.string(), parentGroupId: z.string().uuid().nullable(), members: z.number(),
    partyKind: z.string(),
    activeToday: z.number(), openedToday: z.number(), lastSevenDays: z.array(z.number()), lastSeenAt: z.string().nullable(),
    quietThisWeek: z.number(),
  })).optional(),
});

async function notPublished(tx: SqlClient, ws: string, person: string, now: Date) {
  return (await openDroppedPublishes(tx, ws, person, now)).map((d) => ({
    nodeId: d.nodeId, indexNumber: d.indexNumber, name: d.title, folderId: d.folderId, versionNo: d.versionNo, reason: d.reason,
    text: publishDroppedSentence(d), at: d.at.toISOString(),
  }));
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export const NEW_PER_FOLDER = 5;

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/dashboard', {
    schema: {
      summary: 'Room dashboard: new items, deadlines and admin actions',
      params: WsParams,
      querystring: z.object({
        after: z.string().datetime({ offset: true }).optional(),
      }),
      response: { 200: Dashboard },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const ws = req.params.ws;
    const now = app.now();
    const me = await requireMember(tx, caller, ws, now);
    const person = personOf(caller);
    const agent = caller.principal.kind === 'agent';
    const cap = caller.principal.kind === 'agent' ? caller.principal.maxLevel : 60;
    const visit = (await tx.query<{ previous_visit_at: string | null; last_visit_at: string }>(
      `select previous_visit_at, last_visit_at from workspace_visit where workspace_id = $1 and person_id = $2`, [ws, person])).rows[0];
    const since = visit?.previous_visit_at ?? null;
    const base = { previousVisitAt: iso(since), milestones: await visibleMilestones(tx, ws, me) };
    const after = req.query.after ? new Date(req.query.after).getTime() : null;

    if (!me.isAdmin) {
      // materialise first: effective_level() per row under RLS takes minutes
      const TOPS = `tops as materialized (
          select t.id, t.path, t.index_number, t.name,
                 coalesce((select e.level >= 10 from effective_level($2, t.id, $3, record_clock()) e), false) as named
            from node t where t.workspace_id = $1 and t.deleted_at is null and nlevel(t.path) = 1)`;
      const rows = (await tx.query<any>(
        `with ${TOPS},
              -- empty for members
              team as materialized (
                select distinct m.person_id from membership m join groups g on g.id = m.group_id
                 where m.group_id = any($4::uuid[]) and m.status = 'active' and m.superseded_at = 'infinity'
                   and m.valid_from <= $3 and $3 < m.valid_to and g.valid_from <= $3 and $3 < g.valid_to
                   and not coalesce((m.metadata->>'revoked')::boolean, false)),
              seen as materialized (
                select v.node_id, bool_or(v.person_id = $2) as me, bool_or(v.person_id in (select person_id from team)) as team
                  from view_session v
                 where v.workspace_id = $1 and (v.person_id = $2 or v.person_id in (select person_id from team)) group by v.node_id),
              docs as materialized (
                select n.id, n.index_number, n.name, n.state, n.published_at, n.path, least(a.level, $5) as level, a.version_id,
                       coalesce(dv.page_count, (dv.metadata ->> 'pageCount')::int, 0) as pages
                  from readable_nodes($2, $1, $3, record_clock(), $6) a join node n on n.id = a.node_id
                  left join document_version dv on dv.id = a.version_id
                 where n.kind = 'document'),
              my_pages as materialized (
                select v.version_id, count(distinct p.page)::int as seen
                  from view_session v cross join lateral unnest(v.pages_seen) p(page)
                 where v.workspace_id = $1 and v.person_id = $2 group by v.version_id)
         select d.id, d.index_number, d.name, d.state, d.published_at, d.level, t.id as tid, t.index_number as tix, t.name as tname, t.named,
                coalesce(s.me, false) as me, coalesce(s.team, false) as team, d.pages, least(coalesce(mp.seen, 0), d.pages) as pages_read
           from docs d join tops t on t.path = subltree(d.path, 0, 1) left join seen s on s.node_id = d.id
           left join my_pages mp on mp.version_id = d.version_id
          order by case when d.index_number ~ '^[0-9]+([.][0-9]+)*$' then string_to_array(d.index_number, '.')::int[] end nulls last`,
        [ws, person, now.toISOString(), me.leadGroupIds, cap, agent])).rows;

      const sinceMs = Math.max(since ? new Date(since).getTime() : -Infinity, after ?? -Infinity);
      const fresh = rows.filter((d: any) => d.state === 'published' && d.level >= 10 && new Date(d.published_at).getTime() > sinceMs);
      const byFolder = new Map<string | null, { folderId: string | null; count: number; items: any[] }>();
      for (const d of fresh) {
        const folder = d.named ? `${d.tix} ${d.tname}` : null;
        const f = byFolder.get(folder) ?? { folderId: d.named ? d.tid : null, count: 0, items: [] as any[] };
        f.count++;
        if (f.items.length < NEW_PER_FOLDER) f.items.push(d);
        byFolder.set(folder, f);
      }
      const newSinceLastVisit = [...byFolder].map(([folder, f]) => ({
        folder, folderId: f.folderId, count: f.count,
        items: f.items.map((d) => ({ id: d.id, indexNumber: d.index_number, name: d.name, publishedAt: new Date(d.published_at).toISOString(), read: d.me })),
      }));

      const cov = new Map<string, { tix: string; tname: string; total: number; team: number; me: number; pages: number; pagesRead: number }>();
      for (const d of rows) {
        if (d.level < 20 || !d.named) continue;
        const c = cov.get(d.tix) ?? { tix: d.tix, tname: d.tname, total: 0, team: 0, me: 0, pages: 0, pagesRead: 0 };
        c.total++;
        if (d.team) c.team++;
        if (d.me) c.me++;
        c.pages += Number(d.pages);
        c.pagesRead += Number(d.pages_read);
        cov.set(d.tix, c);
      }
      const byIndex = [...cov.values()].sort((x, y) => Number(x.tix) - Number(y.tix) || x.tix.localeCompare(y.tix));
      const folders = byIndex.map((c) => ({ folder: `${c.tix} ${c.tname}`, opened: c.team, total: c.total }));
      const own = byIndex.map((c) => ({ folder: `${c.tix} ${c.tname}`, opened: c.me, total: c.total, pagesRead: c.pagesRead, pagesShared: c.pages }));
      const sum = (xs: { [k: string]: unknown }[], k: string) => xs.reduce((n, x) => n + Number(x[k]), 0);
      const isLead = me.leadGroupIds.length > 0;
      const myRequests = (await tx.query<any>(
        `select id, coalesce(payload->>'name', concat_ws(' ', payload->>'givenName', payload->>'familyName')) as name, status, created_at
           from approval where workspace_id = $1 and requested_by = $2 and kind = 'colleague_request' order by created_at desc limit 20`,
        [ws, person])).rows.map((a: any) => ({ id: a.id, name: a.name, status: a.status, createdAt: new Date(a.created_at).toISOString() }));
      let toPublish: z.infer<typeof Dashboard>['toPublish'];
      if (!agent && (await onSellerSide(tx, person, ws, now))) {
        const mine = await publishableNodes(tx, person, ws, now);
        if (mine.size) {
          const byFolder = (await tx.query<{ folder: string; folder_id: string | null; count: number; oldest: string }>(
            `select coalesce(p.index_number || ' ' || p.name, 'Top level') as folder, p.id as folder_id, count(*)::int as count, min(n.created_at) as oldest
               from node n left join node p on p.id = n.parent_id
              where n.workspace_id = $1 and n.kind = 'document' and n.state = 'draft' and n.deleted_at is null and n.parent_id is not null
                and n.id = any($2::uuid[])
              group by p.index_number, p.name, p.id
              order by case when p.index_number ~ '^[0-9]{1,9}([.][0-9]{1,9})*$' then string_to_array(p.index_number, '.')::int[] end nulls last`,
            [ws, [...mine]])).rows;
          if (byFolder.length) {
            toPublish = {
              count: byFolder.reduce((a, f) => a + Number(f.count), 0),
              oldestAt: iso(byFolder.map((f) => new Date(f.oldest).toISOString()).sort()[0] ?? null),
              byFolder: byFolder.map((f) => ({ folder: f.folder, folderId: f.folder_id, count: Number(f.count) })),
            };
          }
        }
      }
      const dropped = agent ? [] : await notPublished(tx, ws, person, now);
      const out: z.infer<typeof Dashboard> = { role: 'member', ...base, newSinceLastVisit };
      if (toPublish) out.toPublish = toPublish;
      if (dropped.length) out.notPublished = dropped;
      if (isLead) out.teamCoverage = { opened: sum(folders, 'opened'), total: sum(folders, 'total'), folders };
      out.myCoverage = {
        opened: sum(own, 'opened'), total: sum(own, 'total'), pagesRead: sum(own, 'pagesRead'), pagesShared: sum(own, 'pagesShared'),
        folders: own,
      };
      out.myRequests = myRequests;
      return out;
    }

    const drafts = (await tx.query<any>(
      `select coalesce(p.index_number || ' ' || p.name, 'Top level') as folder, count(*)::int as count, min(n.created_at) as oldest
         from node n left join node p on p.id = n.parent_id
        where n.workspace_id = $1 and n.kind = 'document' and n.state = 'draft' and n.deleted_at is null
        group by p.index_number, p.name order by count desc`, [ws])).rows;
    const requests = (await tx.query<any>(
      `select a.id, a.payload->>'name' as name, g.id as group_id, g.name as group_name, ${NAME} as requester, a.created_at,
              nullif(btrim(a.payload->>'reason'), '') as reason
         from approval a join groups g on g.id = a.group_id join person p on p.id = a.requested_by
        where a.workspace_id = $1 and a.kind = 'colleague_request' and a.status = 'pending' order by a.created_at`, [ws])).rows;
    const removals = (await tx.query<any>(
      `select a.id, case when mp.erased_at is not null then 'Erased user' else mp.name end as name, g.name as group_name, ${NAME} as requester, coalesce(a.payload->>'reason', '') as reason, a.created_at
         from approval a join groups g on g.id = a.group_id join person p on p.id = a.requested_by
         left join person mp on mp.id = (a.payload->>'person_id')::uuid
        where a.workspace_id = $1 and a.kind = 'removal_request' and a.status = 'pending' order by a.created_at`, [ws])).rows;
    const failed = (await tx.query<any>(
      `select distinct on (n.id) n.id, n.index_number, n.name, dv.processing_error, dv.created_at as uploaded_at,
              case when pe.erased_at is not null then 'Erased user' else pe.name end as uploader,
              case when pe.erased_at is null then pe.id end as uploader_id
         from document_version dv join node n on n.id = dv.node_id
         left join principal pr on pr.id = dv.uploaded_by left join person pe on pe.id = pr.person_id
        where n.workspace_id = $1 and dv.processing_status = 'failed' and n.deleted_at is null
        order by n.id, dv.version_no desc`, [ws])).rows;

    const tz = await roomZone(tx, ws);
    const days = lastSevenDays(now, tz);
    const monday = weekStart(now, tz);
    const groups = (await tx.query<any>(
      `select g.id, g.name, g.parent_group_id, pa.kind as party_kind
         from groups g join party pa on pa.id = g.party_id
        where g.workspace_id = $1 and (pa.kind <> 'seller' or g.role_template = 'observer') and g.valid_from <= $2 and $2 < g.valid_to
        order by g.name`, [ws, now.toISOString()])).rows;
    const members = await currentMembers(tx, groups.map((g: any) => g.id), now);
    const from = days[0]! < monday ? days[0]! : monday;
    const reading = await readingBetween(tx, ws, from, now);
    const downloads = await downloadsBetween(tx, ws, from, now);
    const end = new Date(now.getTime() + 1);
    const activity = [];
    for (const g of groups) {
      const people = members.get(g.id)!;
      const series = days.map((start, i) => {
        const stop = days[i + 1] ?? end;
        const opened = new Set(reading.filter((r) => people.has(r.person_id) && r.at >= start && r.at < stop).map((r) => `${r.person_id}/${r.node_id}`));
        return { opened: opened.size, active: activeIn(people, reading, downloads, start, stop).size };
      });
      const last = people.size ? (await tx.query<{ at: string | null }>(
        `select max(v.last_seen_at) as at from view_session v where v.workspace_id = $1 and v.person_id = any($2::uuid[])`,
        [ws, [...people]])).rows[0]?.at : null;
      const quiet = people.size - activeIn(people, reading, downloads, monday, end).size;
      const today = series.at(-1)!;
      activity.push({ groupId: g.id, groupName: g.name, parentGroupId: g.parent_group_id, members: people.size, partyKind: g.party_kind,
        activeToday: today.active, openedToday: today.opened, lastSevenDays: series.map((x) => x.opened), lastSeenAt: iso(last), quietThisWeek: quiet });
    }
    const dropped = agent ? [] : await notPublished(tx, ws, person, now);
    const out: z.infer<typeof Dashboard> = { role: 'admin', ...base };
    if (dropped.length) out.notPublished = dropped;
    out.toDo = {
      drafts: { count: drafts.reduce((s: number, d: any) => s + d.count, 0), oldestAt: iso(drafts.map((d: any) => d.oldest).sort()[0]),
        byFolder: drafts.map((d: any) => ({ folder: d.folder, count: d.count })) },
      accessRequests: requests.map((a: any) => ({ id: a.id, name: a.name, groupId: a.group_id, groupName: a.group_name, requestedBy: a.requester,
        createdAt: new Date(a.created_at).toISOString(), reason: a.reason })),
      removalRequests: removals.map((a: any) => ({ id: a.id, name: a.name ?? 'Unknown person', groupName: a.group_name, requestedBy: a.requester,
        reason: a.reason, createdAt: new Date(a.created_at).toISOString() })),
      failedProcessing: failed.map((f: any) => ({ nodeId: f.id, indexNumber: f.index_number, name: f.name, error: f.processing_error, uploadedBy: f.uploader,
        uploadedById: f.uploader_id, uploadedAt: new Date(f.uploaded_at).toISOString() })),
    };
    out.activity = activity;
    return out;
  }));

  r.post('/v1/workspaces/:ws/nodes/:id/ask-for-copy', {
    schema: {
      summary: 'Ask the uploader for a new copy of a failed file. Logged',
      params: WsParams.extend({ id: z.string().uuid() }),
      response: { 200: z.object({ name: z.string(), status: z.enum(['accepted', 'failed', 'no_mailer']) }) },
    },
  }, async (req) => {
    const ws = req.params.ws;
    const ask = await app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      await requireWorkspaceAdmin(tx, caller, ws, now);
      await refuseIfArchived(tx, ws);
      const v = (await tx.query<any>(
        `select dv.id as version_id, dv.processing_status, dv.processing_error, n.index_number, n.name as node_name, w.name as room_name,
                pe.id as person_id, pe.name as person_name, pe.email, pe.erased_at is not null as erased, pe.disabled_at is not null as disabled,
                me.name as asker
           from node n join workspace w on w.id = n.workspace_id
           left join lateral (select * from document_version d where d.node_id = n.id order by d.version_no desc limit 1) dv on true
           left join principal pr on pr.id = dv.uploaded_by left join person pe on pe.id = pr.person_id
           left join person me on me.id = $3
          where n.id = $1 and n.workspace_id = $2 and n.deleted_at is null`, [req.params.id, ws, personOf(caller)])).rows[0];
      if (!v) throw notFound();
      if (v.processing_status !== 'failed') throw badRequest('The latest version of this document did not fail processing, so there is nothing to ask for.');
      if (!v.person_id || v.erased) throw badRequest('Nobody can be asked: the person who uploaded this file is no longer known.');
      if (v.disabled) throw badRequest(`${v.person_name} cannot be emailed: a site admin disabled the account.`);
      // uploader must still see the document
      const sees = (await tx.query<{ ok: boolean }>(
        `select exists (select 1 from effective_level($1, $2, $3, record_clock()) e
                         where e.level >= 10 or e.can_upload or e.can_manage or e.can_publish) as ok`,
        [v.person_id, req.params.id, now.toISOString()])).rows[0]?.ok;
      if (!sees) throw badRequest(`${v.person_name} can no longer see this document, so they cannot be asked.`);
      const tz = (await tx.query<{ time_zone: string }>(`select time_zone from person where id = $1`, [v.person_id])).rows[0]?.time_zone ?? 'UTC';
      return { ...v, tz, now, actorId: caller.actorId };
    });

    const doc = [ask.index_number, ask.node_name].filter(Boolean).join(' ');
    const brand = await app.inTenant(req, (tx) => mailBranding(tx, app.deps.storage, app.deps.publicUrl));
    const mail = newCopyEmail({ brand, room: ask.room_name, asker: ask.asker ?? 'The room admin', document: doc,
      // converter errors can leak config (GOTENBERG_URL)
      passwordProtected: /password/i.test(ask.processing_error ?? ''), askedAt: ask.now, timeZone: ask.tz,
      url: `${app.deps.publicUrl.replace(/\/$/, '')}/rooms/${ws}/documents` });
    const r = app.deps.mailer
      ? await app.deps.mailer.send(toMessage(mail, ask.person_id, ask.email))
      : { status: 'no_mailer' as const, error: 'No mail server is configured' };

    await app.inTenant(req, async (tx) => {
      const m = mailEvent({ type: 'copy_request', personId: ask.person_id, to: ask.email, subject: mail.subject, result: r,
        extra: { version_id: ask.version_id, node_ids: [req.params.id] } });
      await appendEvent(tx, { action: 'document.copy_requested', workspaceId: ws, actorId: ask.actorId, resourceType: 'node', resourceId: req.params.id,
        data: m.data, context: m.context, occurredAt: app.now(), requestId: req.id });
    });
    return { name: ask.person_name as string, status: r.status };
  });
};
