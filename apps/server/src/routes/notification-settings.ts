// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  appendEvent, FREQUENCIES, loadPolicies, notificationEvent, NOTIFICATION_EVENTS, resolveForPerson, roomTiming,
  type Frequency, type NotificationAudience, type SqlClient,
} from '@vdrkit/core';
import type { Caller } from '../auth.js';
import { badRequest, forbidden } from '../problems.js';
import { personOf, requireMember } from './util.js';

const WsParams = z.object({ ws: z.string().uuid() });
export const FrequencySchema = z.enum(FREQUENCIES as unknown as [Frequency, ...Frequency[]])
  .describe('How often: immediate (right away), bundled (one email once things go quiet), digest (in the daily summary)');

const EventSetting = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  frequency: FrequencySchema,
  mandatory: z.boolean(),
  locked: z.boolean(),
  personal: z.boolean(),
  roomDefault: z.object({ enabled: z.boolean(), frequency: FrequencySchema }),
  allowedFrequencies: z.array(FrequencySchema),
  canSwitchOff: z.boolean(),
});

const MyNotifications = z.object({
  workspaceId: z.string().uuid(),
  timeZone: z.string(),
  isRoomAdmin: z.boolean(),
  timing: z.object({ bundleQuietMinutes: z.number(), bundleMaxMinutes: z.number(), summaryTimes: z.array(z.string()) }),
  events: z.array(EventSetting),
});
type MyNotifications = z.infer<typeof MyNotifications>;

interface Standing {
  groupIds: string[]; isAdmin: boolean; isLead: boolean; isPublisher: boolean;
  onlyObserver: boolean;
}

async function standing(tx: SqlClient, ws: string, personId: string, at: Date, isAdmin: boolean, groupIds: string[]): Promise<Standing> {
  const r = (await tx.query<{ lead: boolean; publisher: boolean; only_observer: boolean }>(
    `select exists (select 1 from membership m join groups g on g.id = m.group_id
                     where m.person_id = $2 and g.workspace_id = $1 and m.role = 'lead' and m.status = 'active'
                       and m.valid_from <= $3 and $3 < m.valid_to and m.superseded_at = 'infinity'
                       and g.parent_group_id is null) as lead,
            exists (select 1 from access_grant ag
                     where ag.workspace_id = $1 and ag.can_publish and ag.effect = 'allow' and ag.superseded_at = 'infinity'
                       and ag.valid_from <= $3 and $3 < ag.valid_to
                       and (ag.subject_person_id = $2 or ag.subject_group_id = any($4::uuid[]))) as publisher,
            coalesce((select bool_and(g.role_template = 'observer') from groups g where g.id = any($4::uuid[])), false) as only_observer`,
    [ws, personId, at.toISOString(), groupIds])).rows[0]!;
  return { groupIds, isAdmin, isLead: r.lead, isPublisher: r.publisher, onlyObserver: !isAdmin && r.only_observer };
}

function wording(key: string, label: string, description: string, s: Standing): { label: string; description: string } {
  if (key !== 'requests') return { label, description };
  return s.isAdmin ? { label: 'Requests to add a colleague', description: 'A lead asks to add someone' }
    : { label: 'Your requests to add a colleague', description: 'When the room admin decides' };
}

function applies(key: string, audience: NotificationAudience, s: Standing): boolean {
  if (key === 'agreements' && s.onlyObserver) return false;
  switch (audience) {
    case 'everyone': return true;
    case 'admins_and_leads': return s.isAdmin || s.isLead;
    case 'publishers': return s.isAdmin || s.isPublisher;
    case 'admins': return s.isAdmin;
  }
}

async function readMine(tx: SqlClient, ws: string, personId: string, s: Standing): Promise<MyNotifications> {
  const [policies, timing] = await Promise.all([loadPolicies(tx, ws), roomTiming(tx, ws)]);
  const tz = (await tx.query<{ time_zone: string }>(`select time_zone from person where id = $1`, [personId])).rows[0]!.time_zone;
  const events = NOTIFICATION_EVENTS.filter((e) => applies(e.key, e.audience, s)).map((e) => {
    const who = { personId, groupIds: s.groupIds, isAdmin: s.isAdmin };
    const p = resolveForPerson(policies, e.key, who, timing);
    const own = policies.find((x) => x.scope === 'user' && x.category === e.key && x.person_id === personId);
    const room = resolveForPerson(policies.filter((x) => x !== own), e.key, who, timing);
    return {
      key: e.key, ...wording(e.key, e.label, e.description, s),
      enabled: p.enabled, frequency: p.frequency, mandatory: p.mandatory, locked: p.locked,
      personal: !!own && (own.enabled !== null || own.mode !== null),
      roomDefault: { enabled: room.enabled, frequency: room.frequency },
      allowedFrequencies: p.allowedModes.filter((m): m is Frequency => m !== 'off'),
      canSwitchOff: p.allowedModes.includes('off'),
    };
  });
  return { workspaceId: ws, timeZone: tz, isRoomAdmin: s.isAdmin, timing, events };
}

async function enter(tx: SqlClient, caller: Caller, ws: string, at: Date): Promise<{ personId: string; s: Standing }> {
  const me = await requireMember(tx, caller, ws, at, { beforeNda: true });
  const personId = personOf(caller);
  return { personId, s: await standing(tx, ws, personId, at, me.isAdmin, me.groupIds) };
}

export const notificationSettingsRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/workspaces/:ws/me/notifications', {
    schema: {
      summary: 'My email notifications in this room',
      params: WsParams,
      response: { 200: MyNotifications },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    const { personId, s } = await enter(tx, caller, req.params.ws, app.now());
    return readMine(tx, req.params.ws, personId, s);
  }));

  r.put('/v1/workspaces/:ws/me/notifications', {
    schema: {
      summary: 'Change my email notifications in this room. Null restores the room default',
      params: WsParams,
      body: z.object({
        events: z.record(z.string().max(40), z.object({ enabled: z.boolean().optional(), frequency: FrequencySchema.optional() }).nullable()),
      }),
      response: { 200: MyNotifications },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    if (caller.principal.kind !== 'person') throw forbidden('Only the person themselves can change their notifications.', 'agent_needs_approval');
    const ws = req.params.ws;
    const now = app.now();
    const { personId, s } = await enter(tx, caller, ws, now);
    const before = await readMine(tx, ws, personId, s);
    const byKey = new Map(before.events.map((e) => [e.key, e]));

    for (const [key, change] of Object.entries(req.body.events)) {
      const known = notificationEvent(key);
      if (!known) throw badRequest(`There is no event called "${key}". Choose one of: ${NOTIFICATION_EVENTS.map((e) => e.key).join(', ')}.`);
      const current = byKey.get(key);
      if (!current) throw badRequest(`"${known.label}" does not apply to you in this room.`);
      if (change?.enabled === false && !current.canSwitchOff) {
        if (current.locked) {
          throw forbidden(`${known.label} is mandatory in this room. You can choose how often, but not switch it off.`, 'mandatory_event');
        }
        throw forbidden(`The room admin does not let you switch off ${known.label}.`, 'not_allowed_by_room');
      }
      if (change?.frequency && !current.allowedFrequencies.includes(change.frequency)) {
        throw badRequest(`The room admin does not allow "${change.frequency}" for ${known.label}. Choose one of: ${current.allowedFrequencies.join(', ')}.`);
      }
      const reset = change === null;
      await tx.query(
        `insert into notification_policy (tenant_id, workspace_id, scope, person_id, category, enabled, mode)
         values (current_tenant_id(), $1, 'user', $2, $3, $4, $5)
         on conflict (workspace_id, scope, coalesce(group_id, person_id, workspace_id), category) do update
           set enabled = case when $6 then excluded.enabled else notification_policy.enabled end,
               mode = case when $7 then excluded.mode else notification_policy.mode end`,
        [ws, personId, key, change?.enabled ?? null, change?.frequency ?? null, reset || change.enabled !== undefined, reset || change.frequency !== undefined]);
    }

    const after = await readMine(tx, ws, personId, s);
    const changes: Record<string, unknown> = {};
    for (const a of after.events) {
      const b = byKey.get(a.key)!;
      if (a.enabled !== b.enabled || a.frequency !== b.frequency || a.personal !== b.personal) {
        changes[a.key] = { before: { enabled: b.enabled, frequency: b.frequency, personal: b.personal },
          after: { enabled: a.enabled, frequency: a.frequency, personal: a.personal } };
      }
    }
    if (Object.keys(changes).length) {
      await appendEvent(tx, { action: 'notification.preferences_changed', workspaceId: ws, actorId: caller.actorId,
        resourceType: 'person', resourceId: personId, data: { person_id: personId, changes }, occurredAt: now, requestId: req.id });
    }
    return after;
  }));
};
