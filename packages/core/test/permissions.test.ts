// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessibleNodes, can, effectiveAccess, Level, resetGrant, setGrant } from '../src/index.js';
import { expectListingMatchesSingleChecks, heron, T, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { try { await expectListingMatchesSingleChecks(h); } finally { await h.pg.close(); } });

const at = { at: T.at };
const day = (d: string) => new Date(`${d}T08:00:00Z`);

async function level(personId: string, nodeId: string, when = at) {
  return h.app((tx) => effectiveAccess(tx, personId, nodeId, when));
}
async function grant(input: Omit<Parameters<typeof setGrant>[1], 'workspaceId'>) {
  await h.pin(input.now ?? T.grantsSet);
  try {
    return await h.app((tx) => setGrant(tx, { workspaceId: h.ws, ...input }));
  } finally {
    await h.pin(T.at);
  }
}

describe('gates', () => {
  it('gives nothing without a grant', async () => {
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: 'no_grant' });
  });

  it('gives nothing to non-members', async () => {
    const outsider = (await h.pg.query<{ id: string }>(
      `insert into person (tenant_id, name, email) values ($1, 'Outsider', 'out@example.com') returning id`, [h.t1])).rows[0]!.id;
    expect(await level(outsider, h.node.aud1)).toMatchObject({ level: 0, reason: 'no_membership' });
  });

  it('blocks bidders until they accept the current NDA', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf });
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.Pdf);

    await h.pin(day('2026-11-10'));
    await h.pg.query(`insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at)
      values ($1, $2, 2, 'Version 2', $3)`, [h.t1, h.nda.agreement, day('2026-11-10').toISOString()]);
    await h.pin(T.at);
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: 'nda_not_accepted' });
    expect((await level(h.person.jan, h.node.aud1, { at: day('2026-11-05') })).level).toBe(Level.Pdf);
    expect((await level(h.person.anika, h.node.aud1)).level).toBe(Level.Original);
  });

  it('ends access when the membership ends', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await h.pg.query(`update membership set valid_to = $1 where person_id = $2`, [day('2026-11-10').toISOString(), h.person.jan]);
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: 'no_membership' });
    expect((await level(h.person.jan, h.node.aud1, { at: day('2026-11-09') })).level).toBe(Level.View);
  });

  it('ends access for a revoked group and its subgroup', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.aFin }, level: Level.View });
    await h.pg.query(`update groups set valid_to = $1 where id = $2`, [day('2026-11-10').toISOString(), h.group.a]);
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(0);
    expect((await level(h.person.lars, h.node.aud1)).level).toBe(0);
  });
});

describe('inheritance and subfolders', () => {
  it('inherits a folder grant down to its documents', async () => {
    const id = await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf });
    expect(await level(h.person.jan, h.node.aud1)).toEqual({ level: Level.Pdf, canUpload: false, canManage: false, canPublish: false, reason: `grant:${id}` });
  });

  it('lets a subfolder grant raise access above its parent', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await grant({ nodeId: h.node.aud, subject: { groupId: h.group.a }, level: Level.Original });
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.Original);
    expect((await level(h.person.jan, h.node.tax1)).level).toBe(Level.View);
  });

  it('lets a subfolder grant lower access', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf });
    await grant({ nodeId: h.node.tax, subject: { groupId: h.group.a }, level: Level.None });
    expect((await level(h.person.jan, h.node.tax1)).level).toBe(0);
    const see = await h.app((tx) => can(tx, { kind: 'person', personId: h.person.jan }, 'see_name', h.node.tax, at));
    expect(see.allowed).toBe(false);
  });

  it('follows a moved folder', async () => {
    await grant({ nodeId: h.node.it, subject: { groupId: h.group.a }, level: Level.Original });
    expect((await level(h.person.jan, h.node.tax1)).level).toBe(0);
    await h.pg.query(`update node set parent_id = $1 where id = $2`, [h.node.it, h.node.tax]);
    expect((await level(h.person.jan, h.node.tax1)).level).toBe(Level.Original);
  });

  it('refuses to move a folder inside itself', async () => {
    await expect(h.pg.query(`update node set parent_id = $1 where id = $2`, [h.node.aud, h.node.fin])).rejects.toThrow(/inside itself/);
  });
});

describe('groups, subgroups and people', () => {
  it('takes the highest level across groups', async () => {
    await h.pg.query(`insert into membership (tenant_id, person_id, group_id, recorded_at) values ($1, $2, $3, $4)`,
      [h.t1, h.person.jan, h.group.aQna, T.setup.toISOString()]);
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await grant({ nodeId: h.node.aud, subject: { groupId: h.group.aQna }, level: Level.Pdf, canUpload: true });
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: Level.Pdf, canUpload: true });
    expect((await level(h.person.jan, h.node.tax1)).level).toBe(Level.View);
  });

  it('caps a subgroup at its parent level', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.aFin }, level: Level.Original });
    expect((await level(h.person.lars, h.node.aud1)).level).toBe(Level.View);
  });

  it('caps subgroup publish rights at the parent', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.aFin }, level: Level.View, canUpload: true, canPublish: true });
    expect(await level(h.person.lars, h.node.aud1)).toMatchObject({ canUpload: false, canPublish: false });
    await grant({ nodeId: h.node.aud, subject: { groupId: h.group.a }, level: Level.View, canPublish: true });
    expect(await level(h.person.lars, h.node.aud1)).toMatchObject({ canUpload: false, canPublish: true });
    expect(await level(h.person.lars, h.node.tax1)).toMatchObject({ canPublish: false });
    expect(await level(h.person.lars, h.node.audDraft)).toMatchObject({ level: Level.View, canPublish: true });
    expect(await level(h.person.jan, h.node.audDraft)).toMatchObject({ level: Level.View, canPublish: true });
  });

  it('removes subgroup access with the parent', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf });
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.aFin }, level: Level.Pdf });
    expect((await level(h.person.lars, h.node.aud1)).level).toBe(Level.Pdf);
    await h.app((tx) => resetGrant(tx, { workspaceId: h.ws, nodeId: h.node.fin, subject: { groupId: h.group.a }, now: day('2026-11-05') }));
    expect((await level(h.person.lars, h.node.aud1)).level).toBe(0);
  });

  it('refuses a subgroup of a subgroup', async () => {
    await expect(h.pg.query(`insert into groups (tenant_id, workspace_id, party_id, name, parent_group_id) values ($1, $2, $3, 'Too deep', $4)`,
      [h.t1, h.ws, h.party.bidderA, h.group.aFin])).rejects.toThrow(/cannot have its own subgroups/);
  });

  it('lets a personal deny beat every allow', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Original });
    const deny = await grant({ nodeId: h.node.aud, subject: { personId: h.person.jan }, effect: 'deny' });
    expect(await level(h.person.jan, h.node.aud1)).toMatchObject({ level: 0, reason: `deny:${deny}` });
    expect((await level(h.person.jan, h.node.tax1)).level).toBe(Level.Original);
  });

  it('combines personal and group grants', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await grant({ nodeId: h.node.tax, subject: { personId: h.person.jan }, level: Level.Original });
    expect((await level(h.person.jan, h.node.tax1)).level).toBe(Level.Original);
  });
});

describe('drafts', () => {
  it('hides drafts from bidders but shows them to uploaders and admins', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Original });
    expect(await level(h.person.jan, h.node.audDraft)).toMatchObject({ level: 0, reason: 'not_published' });
    expect(await level(h.person.maria, h.node.audDraft)).toMatchObject({ level: Level.View, canUpload: true });
    expect(await level(h.person.anika, h.node.audDraft)).toMatchObject({ level: Level.Original, canManage: true });
  });

  it('hides everything inside a draft folder', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Original });
    await h.pg.query(`update node set state = 'draft' where id = $1`, [h.node.tax]);
    expect((await level(h.person.jan, h.node.tax1)).level).toBe(0);
  });

  it('stops uploads in a frozen room', async () => {
    await h.pg.query(`update workspace set state = 'frozen' where id = $1`, [h.ws]);
    expect(await level(h.person.maria, h.node.aud1)).toMatchObject({ level: Level.View, canUpload: false });
  });
});

describe('dates and history', () => {
  it('respects grant start and end dates', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf, validFrom: day('2026-11-05'), validTo: day('2026-11-10') });
    expect((await level(h.person.jan, h.node.aud1, { at: day('2026-11-04') })).level).toBe(0);
    expect((await level(h.person.jan, h.node.aud1, { at: day('2026-11-07') })).level).toBe(Level.Pdf);
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(0);
  });

  it('reconstructs access at a past date', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf, now: day('2026-11-04') });
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View, now: day('2026-11-09') });
    expect((await level(h.person.jan, h.node.aud1)).level).toBe(Level.View);
    expect((await level(h.person.jan, h.node.aud1, { at: day('2026-11-06') })).level).toBe(Level.Pdf);
    const rows = await h.pg.query(`select level, superseded_at from access_grant where subject_group_id = $1 order by recorded_at`, [h.group.a]);
    expect(rows.rows.map((r: any) => Number(r.level))).toEqual([Level.Pdf, Level.View]);
  });

  it('refuses to change or delete a grant row', async () => {
    const id = await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf });
    await expect(h.pg.query(`update access_grant set level = 60 where id = $1`, [id])).rejects.toThrow(/never changed/);
    await expect(h.pg.query(`delete from access_grant where id = $1`, [id])).rejects.toThrow(/never deleted/);
  });
});

describe('can() and listings', () => {
  it('maps actions onto the ladder', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Pdf });
    const jan = { kind: 'person' as const, personId: h.person.jan };
    const check = (a: Parameters<typeof can>[2]) => h.app((tx) => can(tx, jan, a, h.node.aud1, at)).then((d) => d.allowed);
    expect(await check('view')).toBe(true);
    expect(await check('download_pdf')).toBe(true);
    expect(await check('download_original')).toBe(false);
    expect(await check('upload')).toBe(false);
    expect(await check('manage')).toBe(false);
    expect(await check('publish')).toBe(false);
  });

  it('caps agents at their person and own limit', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.Original, canUpload: true });
    const agent = { kind: 'agent' as const, principalId: 'agent-1', onBehalfOfPersonId: h.person.jan, maxLevel: Level.View };
    const view = await h.app((tx) => can(tx, agent, 'view', h.node.aud1, at));
    const pdf = await h.app((tx) => can(tx, agent, 'download_pdf', h.node.aud1, at));
    const up = await h.app((tx) => can(tx, agent, 'upload', h.node.aud, at));
    expect([view.allowed, pdf.allowed, up.allowed, up.reason]).toEqual([true, false, false, 'agent_needs_approval']);
    await grant({ nodeId: h.node.aud, subject: { groupId: h.group.a }, level: Level.Original, canPublish: true });
    const pub = await h.app((tx) => can(tx, agent, 'publish', h.node.aud, at));
    expect([pub.allowed, pub.reason]).toEqual([false, 'agent_needs_approval']);
    const other = { kind: 'agent' as const, principalId: 'agent-2', onBehalfOfPersonId: h.person.mei, maxLevel: Level.Original };
    expect((await h.app((tx) => can(tx, other, 'view', h.node.aud1, at))).allowed).toBe(false);
  });

  it('lists exactly the nodes a single check allows', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await grant({ nodeId: h.node.tax, subject: { groupId: h.group.a }, level: Level.None });
    const list = await h.app((tx) => accessibleNodes(tx, h.person.jan, h.ws, at));
    expect([...list.keys()].sort()).toEqual([h.node.fin, h.node.aud, h.node.aud1].sort());
    for (const id of Object.values(h.node)) {
      const single = await level(h.person.jan, id);
      expect(list.has(id)).toBe(single.level > 0 || single.canUpload || single.canManage || single.canPublish);
    }
  });
});

describe('accessible_nodes_among', () => {
  const among = (person: string, ids: string[] | null, ws = h.ws) => h.app((tx) => tx.query<{ node_id: string; level: number }>(
    `select node_id, level from accessible_nodes_among($1, $2, $3::uuid[], $4, record_clock()) order by node_id`,
    [person, ws, ids, T.at.toISOString()])).then((r) => r.rows);

  it('returns only the requested nodes', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await grant({ nodeId: h.node.tax, subject: { groupId: h.group.a }, level: Level.None });
    const whole = await among(h.person.jan, null);
    expect(whole.map((r) => r.node_id).sort()).toEqual([h.node.fin, h.node.aud, h.node.aud1].sort());
    const some = await among(h.person.jan, [h.node.aud1, h.node.tax1]);
    expect(some).toEqual(whole.filter((r) => r.node_id === h.node.aud1));
    expect(await among(h.person.jan, [])).toEqual([]);
  });

  it('applies the NDA and membership gates', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    await h.pin(new Date('2026-11-10T08:00:00Z'));
    await h.pg.query(`insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at) values ($1, $2, 2, 'Version 2', $3)`,
      [h.t1, h.nda.agreement, '2026-11-10T08:00:00Z']);
    await h.pin(T.at);
    expect(await among(h.person.jan, [h.node.fin, h.node.aud1])).toEqual([]);
  });

  it('ignores other rooms and denied people', async () => {
    await grant({ nodeId: h.node.fin, subject: { groupId: h.group.a }, level: Level.View });
    const other = (await h.pg.query<{ id: string }>(
      `insert into workspace (tenant_id, name, state) values ($1, 'Other room', 'open') returning id`, [h.t1])).rows[0]!.id;
    expect(await among(h.person.jan, [h.node.aud1], other)).toEqual([]);
    await grant({ nodeId: h.node.aud, subject: { personId: h.person.jan }, effect: 'deny' });
    expect(await among(h.person.jan, [h.node.fin, h.node.aud1])).toEqual([{ node_id: h.node.fin, level: Level.View }]);
  });
});
