// SPDX-License-Identifier: AGPL-3.0-only
// Previews waiting changes with effective_level()'s rules: nearest setting up the tree wins,
// a subgroup is capped by its parent.
import type { paths } from '@/api/schema';

export type PermissionsData = paths['/v1/workspaces/{ws}/permissions']['get']['responses'][200]['content']['application/json'];

export const LV: Record<number, string> = { 0: 'No access', 10: 'Fence view', 20: 'View', 30: 'Encrypted PDF', 40: 'Print', 50: 'Download PDF', 60: 'Original' };
export const LV_DESC: Record<number, string> = {
  0: 'Folder and document names hidden', 20: 'Online only, watermarked', 30: 'Download an encrypted PDF, no printing',
  40: 'Also print the encrypted PDF', 50: 'Standard watermarked PDF', 60: 'The native file, such as the Excel model',
};
export const R2: Record<number, boolean> = { 30: true, 40: true };
export const VERB: Record<number, string> = {
  10: 'see the folder masked', 20: 'view online', 30: 'download an encrypted PDF', 40: 'print', 50: 'download a watermarked PDF', 60: 'download the original file',
};
export const LEVELS = [0, 20, 30, 40, 50, 60] as const;

export type Side = 'bidders' | 'seller';

export interface Group {
  id: string;
  name: string;
  partyId: string;
  parentGroupId: string | null;
  side: Side;
  color: string;
  who: string;
}

export interface Row {
  id: string;
  parentId: string | null;
  kind: 'folder' | 'document';
  name: string;
  ix: string;
  depth: number;
  published: number;
  drafts: number;
  kids: string[];
}

export interface Setting {
  l: number;
  u: boolean;
  p: boolean;
  /** not in the matrix; kept as stored */
  m: boolean;
  from: string | null;
  until: string | null;
  later?: boolean;
}
export type PendingValue = Setting | { inherit: true };
export type Pending = Record<string, PendingValue>;

export interface Eff {
  l: number;
  u: boolean;
  p: boolean;
  own: boolean;
  from: string | null;
  capped: boolean;
  capAt: number;
  until: string | null;
}

export const key = (nodeId: string, groupId: string) => `${nodeId}|${groupId}`;
const PALETTE = ['var(--g-a)', 'var(--g-b)', 'var(--g-c)'];

export function dayIn(at: Date | string, timeZone: string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function startOfDay(day: string, timeZone: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  let t = Date.UTC(y, m - 1, d);
  // second pass settles summer time on the day
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t));
    const n = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
    const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
    t -= local - Date.UTC(y, m - 1, d);
  }
  return new Date(t).toISOString();
}

export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// non-numeric parts sort last
const rank = (v: number) => (Number.isNaN(v) ? 1e9 : v);

const byIndex = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return rank(x) - rank(y);
  }
  return a.localeCompare(b);
};

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-GB');

export class Matrix {
  readonly rows = new Map<string, Row>();
  readonly tops: string[] = [];
  readonly groups: Group[];
  readonly byGroup = new Map<string, Group>();
  readonly stored = new Map<string, Setting>();
  private readonly server = new Map<string, PermissionsData['effective'][number]>();

  constructor(readonly data: PermissionsData, readonly timeZone: string) {
    for (const n of data.nodes) {
      this.rows.set(n.id, { id: n.id, parentId: n.parentId, kind: n.kind, name: n.name, ix: n.indexNumber ?? '', depth: 0, published: n.published, drafts: n.drafts, kids: [] });
    }
    const folders = [...this.rows.values()].filter((r) => r.kind === 'folder').sort((a, b) => byIndex(a.ix, b.ix));
    for (const r of folders) {
      const parent = r.parentId ? this.rows.get(r.parentId) : undefined;
      if (parent) parent.kids.push(r.id);
      else this.tops.push(r.id);
    }
    const depth = (r: Row): number => (r.parentId && this.rows.get(r.parentId) ? depth(this.rows.get(r.parentId)!) + 1 : 0);
    for (const r of this.rows.values()) r.depth = depth(r);

    const partyKind = new Map(data.parties.map((p) => [p.id, p.kind]));
    const bidderParties = data.parties.filter((p) => p.kind === 'bidder' || p.kind === 'financier').map((p) => p.id);
    const uploads = new Set(data.grants.filter((g) => g.canUpload).map((g) => g.groupId));
    const visible = data.groups.filter((g) => g.roleTemplate !== 'admin');
    const mains = visible.filter((g) => !g.parentGroupId || !visible.some((p) => p.id === g.parentGroupId)).sort(byName);
    const ordered = mains.flatMap((g) => [g, ...visible.filter((s) => s.parentGroupId === g.id).sort(byName)]);
    this.groups = ordered.map((g) => {
      const kind = partyKind.get(g.partyId) ?? 'other';
      const side: Side = kind === 'bidder' || kind === 'financier' ? 'bidders' : 'seller';
      const i = bidderParties.indexOf(g.partyId);
      const color = side === 'bidders' ? PALETTE[(i < 0 ? 0 : i) % PALETTE.length]! : 'var(--g-s)';
      const people = g.people === 1 ? '1 person' : `${g.people.toLocaleString('en-GB')} people`;
      let who = side === 'seller' && g.soleMember ? g.soleMember : people;
      if (side === 'seller' && g.roleTemplate === 'observer') who += ' · read only';
      else if (side === 'seller' && uploads.has(g.id) && !g.soleMember) who += ' · contributors';
      return { id: g.id, name: g.name, partyId: g.partyId, parentGroupId: g.parentGroupId, side, color, who };
    });
    for (const g of this.groups) this.byGroup.set(g.id, g);

    for (const g of data.grants) {
      if (!this.rows.has(g.nodeId)) continue;
      const k = key(g.nodeId, g.groupId);
      if (this.stored.has(k) && !g.inForce) continue;
      const setting: Setting = {
        l: g.level, u: g.canUpload, p: g.canPublish, m: g.canManage,
        from: g.validFrom && !g.inForce ? dayIn(g.validFrom, timeZone) : null,
        until: g.validTo ? dayIn(new Date(new Date(g.validTo).getTime() - 1), timeZone) : null,
      };
      if (!g.inForce) setting.later = true;
      this.stored.set(k, setting);
    }
    for (const e of data.effective) this.server.set(key(e.nodeId, e.groupId), e);
  }

  cols(side: Side): Group[] {
    return this.groups.filter((g) => g.side === side);
  }

  rec(nodeId: string, groupId: string, pending: Pending | null): Setting | undefined {
    const k = key(nodeId, groupId);
    if (pending && k in pending) {
      const v = pending[k]!;
      return 'inherit' in v ? undefined : v;
    }
    return this.stored.get(k);
  }

  private touched(groupId: string, pending: Pending | null): boolean {
    if (!pending) return false;
    const g = this.byGroup.get(groupId);
    return Object.keys(pending).some((k) => {
      const gid = k.split('|')[1];
      return gid === groupId || (!!g?.parentGroupId && gid === g.parentGroupId);
    });
  }

  eff(nodeId: string, groupId: string, pending: Pending | null = null): Eff {
    const g = this.byGroup.get(groupId);
    if (!this.touched(groupId, pending)) {
      const s = this.server.get(key(nodeId, groupId));
      if (s) {
        const src = s.sourceNodeId ? this.stored.get(key(s.sourceNodeId, groupId)) : undefined;
        const capAt = g?.parentGroupId ? (this.server.get(key(nodeId, g.parentGroupId))?.level ?? 0) : 60;
        return { l: s.level, u: s.canUpload, p: s.canPublish, own: s.sourceNodeId === nodeId, from: s.sourceNodeId, capped: s.capped, capAt, until: src?.until ?? null };
      }
    }
    return this.compute(nodeId, groupId, pending);
  }

  private compute(nodeId: string, groupId: string, pending: Pending | null): Eff {
    let r: Setting | undefined;
    let from: string | null = null;
    for (let n = this.rows.get(nodeId); n; n = n.parentId ? this.rows.get(n.parentId) : undefined) {
      const s = this.rec(n.id, groupId, pending);
      // starts later: not in force yet
      if (s && !s.later) { r = s; from = n.id; break; }
    }
    const out: Eff = { l: r ? r.l : 0, u: !!r?.u, p: !!r?.p, own: from === nodeId, from, capped: false, capAt: 60, until: r?.until ?? null };
    const g = this.byGroup.get(groupId);
    if (g?.parentGroupId) {
      const pe = this.compute(nodeId, g.parentGroupId, pending);
      out.capAt = pe.l;
      if (r && out.l > pe.l) { out.l = pe.l; out.capped = true; }
      if (r && !pe.from) { out.l = 0; out.capped = true; }
      out.u = out.u && pe.u;
      out.p = out.p && pe.p;
    }
    return out;
  }

  descendants(nodeId: string): Row[] {
    const out: Row[] = [];
    const walk = (id: string) => {
      for (const k of this.rows.get(id)?.kids ?? []) {
        out.push(this.rows.get(k)!);
        walk(k);
      }
    };
    walk(nodeId);
    return out;
  }

  files(nodeId: string, groupId: string, deep: boolean): Row[] {
    const folders = new Set([nodeId, ...(deep ? this.descendants(nodeId).map((r) => r.id) : [])]);
    return [...this.rows.values()].filter((r) => r.kind === 'document' && r.parentId && folders.has(r.parentId) && this.stored.has(key(r.id, groupId)));
  }

  // a person's deny beats any group level for them and below; an allow adds
  people(nodeId: string, groupId: string, deep: boolean): PersonGrant[] {
    const folders = new Set([nodeId, ...(deep ? this.descendants(nodeId).map((r) => r.id) : [])]);
    return this.data.personGrants.filter((pg) => {
      if (!pg.groupIds.includes(groupId)) return false;
      const r = this.rows.get(pg.nodeId);
      if (!r) return false;
      return folders.has(r.id) || (r.kind === 'document' && !!r.parentId && folders.has(r.parentId));
    });
  }

  peopleOn(side: Side): PersonGrant[] {
    return this.data.personGrants.filter((pg) => this.rows.has(pg.nodeId) && pg.groupIds.some((g) => this.byGroup.get(g)?.side === side));
  }

  noBidderAccess(): string[] {
    const bidders = this.cols('bidders');
    return this.tops.filter((t) => [t, ...this.descendants(t).map((r) => r.id)].every((id) => bidders.every((g) => this.eff(id, g.id).l === 0)));
  }

  documents(nodeId: string, groupId: string, pending: Pending | null, test: (l: number) => boolean): { published: number; drafts: number } {
    let published = 0, drafts = 0;
    for (const r of [this.rows.get(nodeId)!, ...this.descendants(nodeId)]) {
      if (!test(this.eff(r.id, groupId, pending).l)) continue;
      published += r.published;
      drafts += r.drafts;
    }
    return { published, drafts };
  }

  sees(groupId: string, pending: Pending | null): { folders: number; total: number; published: number; hidden: string[] } {
    let folders = 0, published = 0;
    const hidden: string[] = [];
    for (const t of this.tops) {
      const top = this.rows.get(t)!;
      const all = [top, ...this.descendants(t)];
      const seen = all.filter((r) => this.eff(r.id, groupId, pending).l > 0);
      for (const r of seen) published += r.published;
      if (seen.length) {
        folders++;
        for (const k of top.kids) {
          const kid = this.rows.get(k)!;
          if (![kid, ...this.descendants(k)].some((r) => this.eff(r.id, groupId, pending).l > 0)) hidden.push(label(kid));
        }
      } else hidden.push(label(top));
    }
    for (const d of this.rows.values()) {
      if (d.kind !== 'document' || !d.parentId || !this.stored.has(key(d.id, groupId))) continue;
      const folderSees = this.eff(d.parentId, groupId, pending).l > 0;
      const fileSees = this.eff(d.id, groupId, pending).l > 0;
      if (folderSees && !fileSees) published--;
      if (!folderSees && fileSees) published++;
    }
    return { folders, total: this.tops.length, published: Math.max(0, published), hidden };
  }
}

export type PersonGrant = PermissionsData['personGrants'][number];

export function personLine(pg: PersonGrant, row: Row): string {
  if (pg.effect === 'deny') return `${pg.name} blocked in ${label(row)}`;
  return `${pg.name}: ${LV[pg.level]}${pg.canUpload ? ', may add files' : ''}${pg.canPublish ? ', may publish' : ''} in ${label(row)}`;
}

export const label = (r: Row) => (r.ix ? `${r.ix} ${r.name}` : r.name);

export function same(a: Setting | undefined, b: Setting | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.l === b.l && a.u === b.u && a.p === b.p && (a.from ?? '') === (b.from ?? '') && (a.until ?? '') === (b.until ?? '');
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
