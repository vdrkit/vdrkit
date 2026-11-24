// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectListingMatchesSingleChecks, heron, T, type Heron } from './fixture.js';

let h: Heron;
beforeEach(async () => { h = await heron(); });
afterEach(async () => { await h.pg.close(); });

const days = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

async function groupGrant(node: string, group: string, level: number, opts: { from?: Date; to?: Date; upload?: boolean; manage?: boolean } = {}) {
  await h.pg.query(
    `insert into access_grant (tenant_id, workspace_id, node_id, subject_group_id, level, can_upload, can_manage, valid_from, valid_to, recorded_at)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz,'-infinity'), coalesce($9::timestamptz,'infinity'), $10)`,
    [h.t1, h.ws, node, group, level, opts.upload ?? false, opts.manage ?? false,
     opts.from ? opts.from.toISOString() : null,
     opts.to ? opts.to.toISOString() : null,
     T.grantsSet.toISOString()]);
}
async function personDeny(node: string, person: string) {
  await h.pg.query(
    `insert into access_grant (tenant_id, workspace_id, node_id, subject_person_id, effect, level, valid_from, valid_to, recorded_at)
     values ($1,$2,$3,$4,'deny',0,'-infinity','infinity',$5)`,
    [h.t1, h.ws, node, person, T.grantsSet.toISOString()]);
}

describe('ladder equivalence under edge cases', () => {
  it('matches effective_level with denies, subgroup caps and dated grants', async () => {
    await h.pin(T.grantsSet);

    await groupGrant(h.node.fin, h.group.a, 20);
    // capped at the parent's 20
    await groupGrant(h.node.tax, h.group.aFin, 60);
    await personDeny(h.node.aud, h.person.jan);
    // not started yet
    await groupGrant(h.node.it, h.group.b, 20, { from: days(T.at, 10) });
    // expired
    await groupGrant(h.node.fin, h.group.b, 20, { to: days(T.at, -1) });

    await h.pin(T.at);

    const times = [T.ndaAccepted, T.at, days(T.at, 5), days(T.at, 11), days(T.at, 15), days(T.at, 400)];
    let totalCompared = 0;
    const ran: string[] = [];
    for (const at of times) {
      const c = await expectListingMatchesSingleChecks(h, at); // throws on any divergence
      totalCompared += c;
      ran.push(`${at.toISOString().slice(0, 10)}:${c}`);
    }
    console.log('ladder equivalence comparisons by date →', ran.join('  '));
    expect(totalCompared).toBeGreaterThan(0);
  });

  it('holds right after a folder is added', async () => {
    await h.pin(T.grantsSet);
    await groupGrant(h.node.fin, h.group.a, 20);
    await personDeny(h.node.aud, h.person.jan);
    // tree_changed_since(T.at) is true from here
    await h.pin(T.at);
    await h.pg.query(
      `insert into node (tenant_id, workspace_id, parent_id, kind, name, index_number, state)
       values ($1,$2,$3,'folder','Late addition','3.9','published')`, [h.t1, h.ws, h.node.fin]);
    // the helper skips changed rooms, so compare here
    const people = (await h.pg.query<{ id: string }>(`select id from person where tenant_id=$1`, [h.t1])).rows.map(r => r.id);
    for (const person of people) {
      const single = (await h.app(tx => tx.query(
        `select nd.id as node_id, e.level, e.can_upload, e.can_manage, e.can_publish
           from node nd cross join lateral effective_level($1, nd.id, $2, null) e
          where nd.workspace_id=$3 and nd.deleted_at is null and (e.level>0 or e.can_upload or e.can_manage or e.can_publish)
          order by nd.id`, [person, T.at.toISOString(), h.ws]))).rows;
      const among = (await h.app(tx => tx.query(
        `select node_id, level, can_upload, can_manage, can_publish
           from accessible_nodes($1, $3, $2, null) order by node_id`, [person, T.at.toISOString(), h.ws]))).rows;
      expect(JSON.stringify(among), `person ${person} in tree-changed state`).toBe(JSON.stringify(single));
    }
  });
});
