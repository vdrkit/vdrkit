// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendEvent, type SqlClient } from '@vdrkit/core';
import { badRequest, forbidden, notFound } from '../problems.js';
import { visibleText } from './util.js';

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const IanaTimeZone = z.string().max(64)
  .refine((tz) => /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz) && isTimeZone(tz), 'Use a time zone name such as Africa/Johannesburg');

export const GivenName = visibleText(z.string().trim().min(1, 'Give a first name').max(100));
export const FamilyName = visibleText(z.string().trim().min(1, 'Give a last name').max(100));
export const Company = visibleText(z.string().trim().min(1, 'Give a company').max(200));
export const JobTitle = visibleText(z.string().trim().max(200));

export interface PersonDetails { givenName: string; familyName: string; company: string | null; jobTitle: string | null }

export async function readDetails(tx: SqlClient, personId: string): Promise<PersonDetails | null> {
  const p = (await tx.query<{ given_name: string; family_name: string; company: string | null; job_title: string | null }>(
    `select given_name, family_name, company, job_title from person where id = $1 and erased_at is null`, [personId])).rows[0];
  return p ? { givenName: p.given_name, familyName: p.family_name, company: p.company, jobTitle: p.job_title } : null;
}

export async function roomsOf(tx: SqlClient, personId: string, now: Date): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `select distinct g.workspace_id as id
       from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
      where m.person_id = $1 and m.status = 'active' and m.superseded_at = 'infinity'
        and m.valid_from <= $2 and $2 < m.valid_to and g.valid_from <= $2 and $2 < g.valid_to and w.state <> 'deleted'`,
    [personId, now.toISOString()]);
  return rows.map((r) => r.id);
}

// old/new values in event_context.personal (erasable), not the hashed data
export async function recordDetailsChange(tx: SqlClient, a: {
  personId: string; before: PersonDetails; after: PersonDetails; now: Date; actorId: string | null; requestId: string;
  ip?: string | null; userAgent?: string | null; rooms?: string[];
}): Promise<number> {
  const fields: string[] = [];
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  if (a.before.givenName !== a.after.givenName || a.before.familyName !== a.after.familyName) {
    fields.push('name');
    before.givenName = a.before.givenName;
    before.familyName = a.before.familyName;
    after.givenName = a.after.givenName;
    after.familyName = a.after.familyName;
  }
  for (const k of ['company', 'jobTitle'] as const) {
    if ((a.before[k] ?? null) !== (a.after[k] ?? null)) {
      fields.push(k === 'jobTitle' ? 'job_title' : k);
      before[k] = a.before[k] ?? null;
      after[k] = a.after[k] ?? null;
    }
  }
  if (fields.length === 0) return 0;
  const rooms = a.rooms ?? (await roomsOf(tx, a.personId, a.now));
  for (const ws of rooms) {
    await appendEvent(tx, {
      action: 'person.details_changed', workspaceId: ws, actorId: a.actorId, resourceType: 'person', resourceId: a.personId,
      data: { person_id: a.personId, fields }, requestId: a.requestId,
      context: { ip: a.ip ?? null, userAgent: a.userAgent ?? null, personal: { before, after }, subjectPersonId: a.personId },
    });
  }
  return rooms.length;
}

const Profile = z.object({
  personId: z.string().uuid(),
  email: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  name: z.string(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  timeZone: z.string(),
  canCreateRooms: z.boolean(),
  isSiteAdmin: z.boolean(),
  organisation: z.string(),
});

async function readProfile(tx: SqlClient, personId: string): Promise<z.infer<typeof Profile>> {
  const p = (await tx.query<any>(
    `select id, email, given_name, family_name, name, company, job_title, time_zone,
            person_can_create_rooms(id) as can_create_rooms, is_site_admin and disabled_at is null as is_site_admin,
            (select t.name from tenant t where t.id = person.tenant_id) as organisation
       from person where id = $1 and erased_at is null`,
    [personId])).rows[0];
  if (!p) throw notFound();
  return { personId: p.id, email: p.email, givenName: p.given_name, familyName: p.family_name, name: p.name,
    company: p.company, jobTitle: p.job_title, timeZone: p.time_zone, canCreateRooms: !!p.can_create_rooms, isSiteAdmin: !!p.is_site_admin,
    organisation: p.organisation ?? '' };
}

export const profileRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/me', {
    schema: { summary: 'My details', response: { 200: Profile } },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    if (caller.principal.kind !== 'person') throw forbidden('Only the person themselves can read their profile.');
    return readProfile(tx, caller.principal.personId);
  }));

  r.patch('/v1/me', {
    schema: {
      summary: 'Change my details',
      body: z.object({
        givenName: GivenName.optional(),
        familyName: FamilyName.optional(),
        company: Company.optional(),
        jobTitle: JobTitle.nullable().optional(),
        timeZone: IanaTimeZone.optional(),
      }).strict(),
      response: { 200: Profile },
    },
  }, async (req) => app.inTenant(req, async (tx, caller) => {
    if (caller.principal.kind !== 'person') throw forbidden('Only the person themselves can change their profile.');
    const id = caller.principal.personId;
    const now = app.now();
    const before = await readDetails(tx, id);
    if (!before) throw notFound();
    const b = req.body;
    const after: PersonDetails = {
      givenName: b.givenName ?? before.givenName,
      familyName: b.familyName ?? before.familyName,
      company: b.company ?? before.company,
      jobTitle: b.jobTitle === undefined ? before.jobTitle : (b.jobTitle || null),
    };
    if (!after.givenName || !after.familyName) throw badRequest('Give both a first name and a last name.');
    await tx.query(
      `update person set given_name = $2, family_name = $3, company = $4, job_title = $5, time_zone = coalesce($6, time_zone), updated_at = $7
        where id = $1`,
      [id, after.givenName, after.familyName, after.company, after.jobTitle, b.timeZone ?? null, now.toISOString()]);
    await recordDetailsChange(tx, { personId: id, before, after, now, actorId: caller.actorId, requestId: req.id,
      ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    return readProfile(tx, id);
  }));
};
