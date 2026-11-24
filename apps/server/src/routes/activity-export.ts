// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, partsIn, zoneAbbreviation } from '@vdrkit/core';
import { notFound } from '../problems.js';
import { personOf, requireWorkspaceAdmin } from './util.js';
import { coverageText, parseBound, type LogFilters } from './activity-log.js';
import { LogQuery, readEntries, readerZone } from './events.js';
import { proofText } from './activity-proof.js';

export { ACTION_LABELS, EVENT_PERSON } from './activity-log.js';

// formula injection
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | null | undefined): string {
  let v = value ?? '';
  if (FORMULA_START.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function csvTime(d: Date, timeZone: string): string {
  const p = partsIn(d, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${zoneAbbreviation(d, timeZone)}`;
}

function localDate(d: Date, timeZone: string): string {
  const p = partsIn(d, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function humanKey(k: string): string {
  return k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  return null;
}

export function summarise(data: Record<string, unknown>): string {
  if (Array.isArray(data.cells)) {
    const n = data.cells.length;
    return `${n} permission ${n === 1 ? 'change' : 'changes'}`;
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k.endsWith('_id') || k.endsWith('Id') || k === 'hash') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const s = scalar(v2);
        if (s !== null && !k2.endsWith('_id') && !k2.endsWith('Id')) parts.push(`${humanKey(k2)}: ${s}`);
      }
      continue;
    }
    const s = scalar(v);
    if (s !== null) parts.push(`${humanKey(k)}: ${s}`);
  }
  const out = parts.join(', ');
  return out.length > 200 ? `${out.slice(0, 197)}...` : out;
}

const PERSONAL_LABELS: Record<string, string> = { givenName: 'first name', familyName: 'last name', company: 'company', jobTitle: 'job title' };

export function summarisePersonal(personal: unknown): string {
  if (!personal || typeof personal !== 'object') return '';
  const { before, after } = personal as { before?: Record<string, unknown>; after?: Record<string, unknown> };
  if (!before || !after) return '';
  // jsonb key order is arbitrary
  const order = Object.keys(PERSONAL_LABELS);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const changed = Object.keys(after)
    .sort((x, y) => rank(x) - rank(y))
    .filter((k) => before[k] !== after[k]);
  const lines = changed.map((k) => {
    const label = PERSONAL_LABELS[k] ?? humanKey(k);
    return `${label}: ${before[k] ?? '(none)'} -> ${after[k] ?? '(none)'}`;
  });
  return lines.join(', ');
}

function filename(room: string, day: string): { ascii: string; utf8: string } {
  const base = `${room} activity ${day}.csv`.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { ascii: base.replace(/[^\x20-\x7e]/g, '_'), utf8: encodeURIComponent(base) };
}

const HEADER = ['Time', 'Person', 'Group', 'Action', 'Document', 'Details', 'Proof'];

export const activityExportRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/events/export.csv', {
    schema: {
      summary: 'Export the activity log as CSV. Room admins only; the export is logged',
      params: z.object({ ws: z.string().uuid() }),
      querystring: LogQuery,
      produces: ['text/csv'],
    },
  }, async (req, reply) => {
    const { body, name } = await app.inTenant(req, async (tx, caller) => {
      const now = app.now();
      await requireWorkspaceAdmin(tx, caller, req.params.ws, now);
      const ws = (await tx.query<{ name: string; time_zone: string }>(
        'select name, time_zone from workspace where id = $1', [req.params.ws])).rows[0];
      if (!ws) throw notFound();
      const tz = await readerZone(tx, personOf(caller), req.params.ws);
      const q = req.query;
      const f: LogFilters = {
        action: q.action, kind: q.kind as LogFilters['kind'], person: q.person, group: q.group, node: q.node, q: q.q,
        from: parseBound(q.from, tz, false), to: parseBound(q.to, tz, true),
      };
      const rows = await readEntries(tx, caller, req.params.ws, 'admin', now, f, { timeZone: tz });
      const lines = [HEADER.map(csvCell).join(',')];
      for (const e of rows) {
        const person = e.person?.name ?? e.actorName ?? 'VDRkit';
        let group = e.person ? '' : 'System';
        if (e.group) group = e.group.isAdmin ? 'Room admin' : e.group.name;
        const doc = e.node && e.resourceType === 'node' ? [e.node.indexNumber, e.node.name].filter(Boolean).join(' ') : '';
        const detail = e.coverage ? coverageText(e.coverage) : e.detail;
        const extra = !detail && e.kind === 'other' ? summarise(e.data ?? {}) : '';
        lines.push([
          csvTime(new Date(e.occurredAt), tz),
          person,
          group,
          e.verb.label,
          doc,
          [doc ? null : e.item, detail, extra, summarisePersonal(e.personal)].filter(Boolean).join('; '),
          proofText(e.proof),
        ].map(csvCell).join(','));
      }

      await appendEvent(tx, {
        action: 'activity.exported', workspaceId: req.params.ws, actorId: caller.actorId,
        resourceType: 'workspace', resourceId: req.params.ws,
        data: {
          filters: {
            from: q.from ?? null, to: q.to ?? null, action: q.action ?? null, person_id: q.person ?? null,
            // may contain names; record use only
            ...(q.kind ? { kind: q.kind } : {}), ...(q.group ? { group_id: q.group } : {}), ...(q.node ? { node_id: q.node } : {}),
            ...(q.q ? { words: true } : {}),
          },
          rows: rows.length,
        },
        requestId: req.id, occurredAt: now,
      });

      return { body: `\uFEFF${lines.join('\r\n')}\r\n`, name: filename(ws.name, localDate(now, tz)) };
    });

    return reply
      .header('content-disposition', `attachment; filename="${name.ascii}"; filename*=UTF-8''${name.utf8}`)
      .header('cache-control', 'no-store')
      .type('text/csv; charset=utf-8')
      .send(body);
  });
};
