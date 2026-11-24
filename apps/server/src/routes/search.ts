// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Level } from '@vdrkit/core';
import { badRequest } from '../problems.js';
import { blockedLink, capAccess, personOf } from './util.js';
import { pageExtract } from './search-extract.js';

// ts_headline markers; indexText strips control chars from page text
const START = '\u0001';
const STOP = '\u0002';
const HEADLINE_OPTS = `StartSel=${START}, StopSel=${STOP}, MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=1`;
const PAGES_SHOWN = 2;
const INDEX_NUMBER = /^[0-9]{1,9}([.][0-9]{1,9}){0,19}[.]?$/;

export function splitQuery(raw: string): { rest: string; prefix: string } {
  const q = raw.trim();
  const m = /^(.*?)(?:^|\s)([\p{L}\p{N}]+)$/u.exec(q);
  if (!m || (q.split('"').length - 1) % 2 === 1) return { rest: q, prefix: '' };
  const word = m[2]!;
  if (word.toLowerCase() === 'or') return { rest: q, prefix: '' };
  return { rest: m[1]!.trim(), prefix: word.toLowerCase() };
}

const Ancestor = z.object({ nodeId: z.string().uuid(), indexNumber: z.string().nullable(), name: z.string() });

const Result = z.object({
  nodeId: z.string().uuid(),
  indexNumber: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['folder', 'document']),
  path: z.array(Ancestor),
  snippet: z.string().nullable(),
  highlights: z.array(z.tuple([z.number(), z.number()])),
  page: z.number().nullable(),
  matchedIn: z.enum(['name', 'content']),
  pages: z.array(z.object({ page: z.number(), snippet: z.string(), highlights: z.array(z.tuple([z.number(), z.number()])) })),
  pagesMatched: z.number(),
  state: z.enum(['draft', 'published', 'withdrawn']),
  isNew: z.boolean(),
  wasNumber: z.string().nullable(),
});

// never hand document text to the UI as HTML
function splitHeadline(marked: string | null): { snippet: string | null; highlights: [number, number][] } {
  if (marked == null) return { snippet: null, highlights: [] };
  let out = '';
  const highlights: [number, number][] = [];
  let start = -1;
  for (const ch of marked) {
    if (ch === START) start = out.length;
    else if (ch === STOP) {
      if (start >= 0) highlights.push([start, out.length]);
      start = -1;
    } else out += ch;
  }
  return { snippet: out, highlights };
}

export const searchRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/search', {
    schema: {
      summary: 'Search names and document text',
      params: z.object({ ws: z.string().uuid() }),
      querystring: z.object({
        q: z.string().max(200),
        folder: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).max(10_000).default(0),
        match: z.enum(['all', 'names']).default('all'),
      }),
      response: { 200: z.object({ items: z.array(Result), total: z.number() }) },
    },
  }, async (req) => {
    const q = req.query.q.trim();
    if (!q) throw badRequest('Type what you are looking for.');
    const { rest, prefix } = splitQuery(q);

    return app.inTenant(req, async (tx, caller) => {
      const cap = capAccess(caller, { level: Level.Original, canUpload: true, canManage: true, canPublish: true });
      const params = [
        personOf(caller), req.params.ws, app.now().toISOString(),
        cap.level, cap.canUpload, cap.canManage,
        rest, prefix, req.query.folder ?? null,
        req.query.limit, req.query.offset, HEADLINE_OPTS,
        Level.Fence, Level.View,
        cap.canPublish,
        caller.principal.kind === 'agent',
        req.query.match === 'names',
        INDEX_NUMBER.test(q) ? q.replace(/[.]$/, '') : null,
      ];

      const { rows } = await tx.query<{
        node_id: string; by_name: boolean; pages: string; total: string; name: string; kind: 'folder' | 'document';
        index_number: string | null; state: 'draft' | 'published' | 'withdrawn'; is_new: boolean; was: string | null;
        shown: { page: number; body: string; headline: string }[]; ancestors: { nodeId: string; indexNumber: string | null; name: string }[];
      }>(
        `with acc as materialized (
           -- only the shown version is searched
           select node_id, least(level, $4::smallint) as level, can_upload and $5::boolean as up, can_manage and $6::boolean as mg,
                  can_publish and $15::boolean as pb, version_id
             from readable_nodes($1, $2, $3::timestamptz, record_clock(), $16::boolean)
         ),
         seen as (select node_id, level, version_id from acc where level >= $13 or up or mg or pb),
         q as (
           select case
             when $7::text = '' and $8::text = '' then ''::tsquery
             when $8::text = '' then websearch_to_tsquery('simple', $7::text)
             when $7::text = '' then to_tsquery('simple', $8::text || ':*')
             else websearch_to_tsquery('simple', $7::text) && to_tsquery('simple', $8::text || ':*')
           end as q
         ),
         scope as (
           select n.path from node n join seen s on s.node_id = n.id where n.id = $9::uuid and n.workspace_id = $2
         ),
         -- first half must match the index expression
         named as (
           select n.id, n.path,
                  to_tsvector('simple', n.name) || to_tsvector('simple', regexp_replace(n.name, '[._/\-]+', ' ', 'g')) as v
             from node n join seen s on s.node_id = n.id
            where n.workspace_id = $2 and n.deleted_at is null
         ),
         number_hits as (
           select n.id as node_id, null::text as was
             from node n join seen s on s.node_id = n.id
            where $18::text is not null and n.workspace_id = $2 and n.deleted_at is null and n.index_number = $18::text
              and ($9::uuid is null or n.path <@ (select path from scope))
           union
           select n.id, r.from_number
             from index_renumber r join seen s on s.node_id = r.node_id join node n on n.id = r.node_id
            where $18::text is not null and r.workspace_id = $2 and r.from_number = $18::text and n.deleted_at is null
              and n.index_number is distinct from $18::text
              and ($9::uuid is null or n.path <@ (select path from scope))
         ),
         name_hits as (
           select node_id, max(rank) as rank from (
             select n.id as node_id, ts_rank(n.v, q.q) as rank
               from named n cross join q
              where n.v @@ q.q
                and ($9::uuid is null or n.path <@ (select path from scope))
             union all
             select node_id, 1::real from number_hits
           ) x group by node_id
         ),
         content_pages as materialized (
           select dt.node_id, dt.id as text_id, dt.page, ts_rank(dt.tsv, q.q) as rank,
                  row_number() over (partition by dt.node_id order by ts_rank(dt.tsv, q.q) desc, dt.page) as rn,
                  count(*) over (partition by dt.node_id) as pages
             from document_text dt join seen s on s.node_id = dt.node_id join node n on n.id = dt.node_id cross join q
            where not $17::boolean and dt.workspace_id = $2 and s.level >= $14 and dt.tsv @@ q.q
              and ($9::uuid is null or n.path <@ (select path from scope))
              and dt.version_id = s.version_id
         ),
         content_hits as (select node_id, rank, pages from content_pages where rn = 1),
         hits as (
           select coalesce(nh.node_id, ch.node_id) as node_id, nh.node_id is not null as by_name,
                  coalesce(nh.rank, 0) as name_rank, coalesce(ch.rank, 0) as content_rank, coalesce(ch.pages, 0) as pages
             from name_hits nh full join content_hits ch on ch.node_id = nh.node_id
         ),
         ranked as (
           select h.*, (case when h.by_name then 10 else 0 end) + h.pages
                         + (case when exists (select 1 from number_hits nh where nh.node_id = h.node_id) then 100 else 0 end) as score,
                  case when hn.index_number ~ '^[0-9]{1,9}([.][0-9]{1,9})*$' then string_to_array(hn.index_number, '.')::int[] end as ix,
                  hn.name as sort_name, count(*) over () as total
             from hits h join node hn on hn.id = h.node_id
            order by score desc, ix asc nulls last, sort_name, h.node_id
            limit $10 offset $11
         )
         select r.node_id, r.by_name, r.pages, r.total, n.name, n.kind, n.index_number, n.state,
                (select max(nh.was) from number_hits nh where nh.node_id = r.node_id) as was,
                coalesce(n.kind = 'document' and n.state = 'published' and n.published_at >
                  (select v.previous_visit_at from workspace_visit v where v.workspace_id = $2 and v.person_id = $1), false) as is_new,
                (select coalesce(jsonb_agg(jsonb_build_object('page', cp.page, 'body', d.body,
                                                              'headline', ts_headline('simple', d.body, q.q, $12)) order by cp.rn), '[]'::jsonb)
                   from content_pages cp join document_text d on d.id = cp.text_id
                  where cp.node_id = r.node_id and cp.rn <= ${PAGES_SHOWN}) as shown,
                (select coalesce(jsonb_agg(jsonb_build_object('nodeId', a.id, 'indexNumber', a.index_number, 'name', a.name)
                                           order by nlevel(a.path)), '[]'::jsonb)
                   from node a join seen s on s.node_id = a.id
                  where a.id = any (path_ids(n.path)) and a.path @> n.path and a.id <> n.id) as ancestors
           from ranked r join node n on n.id = r.node_id cross join q
          order by r.score desc, r.ix asc nulls last, r.sort_name, r.node_id`,
        params,
      );

      if (req.query.folder && rows.length === 0) {
        const { rows: f } = await tx.query<{ ok: boolean }>(
          `select exists (
             select 1 from accessible_nodes_among($1, $2, array[$4::uuid], $3::timestamptz, record_clock()) a
              where a.node_id = $4 and (least(a.level, $5::smallint) >= $6 or (a.can_upload and $7::boolean) or (a.can_manage and $8::boolean)
                                        or (a.can_publish and $9::boolean))
           ) as ok`,
          [personOf(caller), req.params.ws, app.now().toISOString(), req.query.folder, cap.level, Level.Fence, cap.canUpload, cap.canManage, cap.canPublish],
        );
        if (!f[0]?.ok) throw blockedLink({ workspaceId: req.params.ws, nodeId: req.query.folder, route: 'search.folder' });
      }

      return {
        total: Number(rows[0]?.total ?? 0),
        items: rows.map((row) => {
          // e.g. "FY2025.pdf" tokenises differently
          const pages = row.shown.map((p) => {
            const own = pageExtract(p.body, q);
            if (own) return { page: p.page, ...own };
            const db = splitHeadline(p.headline);
            return { page: p.page, snippet: db.snippet ?? '', highlights: db.highlights };
          });
          const first = pages[0];
          return {
            nodeId: row.node_id,
            indexNumber: row.index_number,
            name: row.name,
            kind: row.kind,
            path: row.ancestors,
            snippet: first?.snippet ?? null,
            highlights: first?.highlights ?? [],
            page: first?.page ?? null,
            matchedIn: row.by_name ? 'name' as const : 'content' as const,
            pages,
            pagesMatched: Number(row.pages),
            state: row.state,
            isNew: row.is_new,
            wasNumber: row.was,
          };
        }),
      };
    });
  });
};
