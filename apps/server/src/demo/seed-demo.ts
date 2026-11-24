// SPDX-License-Identifier: AGPL-3.0-only
// runs under Node type stripping: no relative .js imports
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { appendEvent, setGrant, withTenant, type Database, type LevelValue, type SqlClient, type TenantOptions } from '@vdrkit/core';

export const DEMO_TENANT_ID = 'de300000-0000-4000-8000-000000000001';

// front-end tests depend on these ids
export function stableId(tenantId: string, key: string): string {
  const h = createHash('sha256').update(`vdrkit-demo:${tenantId}:${key}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// story dates shift by whole weeks to keep weekdays

export const STORY_TODAY = '2026-11-12';
const DAY_MS = 86_400_000;
const STORY_LOAD_FROM = Date.parse(`${STORY_TODAY}T00:00:00Z`) + DAY_MS;
const WEEK_MS = 7 * DAY_MS;
// SAST, UTC+2 all year.
const ROOM_OFFSET_MS = 2 * 3_600_000;

export function roomDay(at: Date = new Date()): string {
  return new Date(at.getTime() + ROOM_OFFSET_MS).toISOString().slice(0, 10);
}

export function demoShiftMs(today: string | undefined = process.env.VDRKIT_DEMO_TODAY || undefined): number {
  const day = today?.trim() || roomDay();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day) {
    throw new Error(`VDRKIT_DEMO_TODAY: "${day}" is not a day as YYYY-MM-DD`);
  }
  return Math.floor((t - STORY_LOAD_FROM) / WEEK_MS) * WEEK_MS;
}

export const shiftDate = (d: Date | string, shift: number): Date => new Date(new Date(d).getTime() + shift);
export const shiftDay = (day: string, shift: number): string => shiftDate(`${day}T00:00:00Z`, shift).toISOString().slice(0, 10);

export const D = {
  created: new Date('2026-10-01T08:00:00Z'),
  ndaPublished: new Date('2026-10-30T08:00:00Z'),
  grants: new Date('2026-11-02T08:00:00Z'),
  ndaAccepted: new Date('2026-11-02T12:00:00Z'),
  tue3: new Date('2026-11-03T07:30:00Z'),
  fri6: new Date('2026-11-06T09:00:00Z'),
  mon9: new Date('2026-11-09T10:15:00Z'),
  thu12: new Date('2026-11-12T13:40:00Z'),
};


export interface FolderSpec {
  ix: string; name: string; n: number; drafts?: number; kids?: FolderSpec[]; noBidders?: boolean; bidders?: Partial<Record<'a' | 'b' | 'c', number>>;
}

export const TREE: FolderSpec[] = [
  { ix: '1', name: 'Corporate', n: 86 },
  { ix: '2', name: 'Legal', n: 213, drafts: 1, kids: [
    { ix: '2.1', name: 'Constitutional documents', n: 22 }, { ix: '2.2', name: 'Litigation', n: 17 }, { ix: '2.3', name: 'Regulatory', n: 31 },
    { ix: '2.4', name: 'Material contracts', n: 14, drafts: 1 }, { ix: '2.5', name: 'Employment', n: 98 }, { ix: '2.6', name: 'Property leases', n: 31 }] },
  { ix: '3', name: 'Finance', n: 231, drafts: 26, kids: [
    { ix: '3.1', name: 'Management accounts', n: 48 }, { ix: '3.2', name: 'Audited financials', n: 7, drafts: 2 },
    { ix: '3.3', name: 'Budgets and forecasts', n: 19 }, { ix: '3.4', name: 'Tax', n: 133 }, { ix: '3.5', name: 'Treasury', n: 24, drafts: 24 }] },
  { ix: '4', name: 'Commercial', n: 498, drafts: 149 },
  { ix: '5', name: 'HR', n: 187 },
  { ix: '6', name: 'IT', n: 64 },
  { ix: '7', name: 'Property', n: 145 },
  { ix: '8', name: 'Insurance', n: 60, drafts: 60, noBidders: true },
  { ix: '9', name: 'Environmental', n: 68, drafts: 68, noBidders: true },
  { ix: '10', name: 'Intellectual property', n: 116, drafts: 116, noBidders: true },
  { ix: '11', name: 'Data protection', n: 21, drafts: 21, noBidders: true },
];

export type Ext = 'pdf' | 'xlsx' | 'docx' | 'pptx';
// upd: version 2 in draft awaiting release. rev: version 2 already released.
export type Status = 'pub' | 'upd' | 'rev' | 'draft' | 'proc';
export type Uploader = 'anika' | 'maria';
export type Row = [string, string, Ext, Status, number | null, Date, Uploader?];

export const NAMED: Record<string, Row[]> = {
  '2.4': [
    ['2.4.1', 'Master services agreement Kwelanet Business', 'pdf', 'pub', 38, D.tue3],
    ['2.4.2', 'Tarnley Logistics supply agreement', 'pdf', 'pub', 42, D.tue3],
    ['2.4.3', 'Tarnley Logistics addendum 2024', 'pdf', 'upd', 6, D.mon9],
    ['2.4.4', 'Distribution agreement Namibia', 'pdf', 'pub', 27, D.tue3],
    ['2.4.5', 'Tsamvo freight agreement', 'pdf', 'pub', 19, D.tue3],
    ['2.4.6', 'Change of control consents tracker', 'xlsx', 'pub', 3, D.fri6],
    ['2.4.7', 'Supply agreement Ombeli Chemicals', 'pdf', 'pub', 54, D.tue3],
    ['2.4.8', 'Agency agreement Botswana', 'docx', 'pub', 12, D.tue3],
    ['2.4.9', 'Packaging supply agreement Paxenfold', 'pdf', 'pub', 33, D.tue3],
    ['2.4.10', 'Warehouse services agreement', 'pdf', 'pub', 21, D.fri6],
    ['2.4.11', 'Software licence Ledgerva Business One', 'pdf', 'pub', 16, D.fri6],
    ['2.4.12', 'Fleet lease agreement', 'pdf', 'pub', 24, D.fri6],
    ['2.4.13', 'Framework agreement Velarail Freight Rail', 'pdf', 'draft', 48, D.mon9, 'maria'],
  ],
  '3.2': [
    ['3.2.1', 'Audited financial statements FY2021', 'pdf', 'pub', 64, D.tue3],
    ['3.2.2', 'Audited financial statements FY2022', 'pdf', 'pub', 66, D.tue3],
    ['3.2.3', "Auditor's report FY2022", 'pdf', 'pub', 4, D.tue3],
    ['3.2.4', 'Management letter FY2022', 'pdf', 'pub', 11, D.tue3],
    ['3.2.5', 'Reconciliation to management accounts FY2022', 'xlsx', 'pub', 2, D.fri6],
    ['3.2.6', 'Audited financial statements FY2023', 'pdf', 'draft', 71, D.thu12, 'maria'],
    ['3.2.7', "Auditor's report FY2023", 'pdf', 'proc', null, D.thu12, 'maria'],
  ],
};


function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W: Record<string, string[]> = {
  sub: ['Drosvelt Holdings', 'Drosvelt Logistics', 'Drosvelt Packaging', 'Drosvelt Properties', 'Drosvelt Namibia', 'Drosvelt Botswana', 'Drosvelt Cold Chain'],
  year: ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'],
  fy: ['FY2021', 'FY2022', 'FY2023', 'FY2024', 'FY2025', 'FY2026'],
  month: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  cp: ['Tarnley Logistics', 'Ombeli Chemicals', 'Paxenfold', 'Tsamvo', 'Rostrand Logistics', 'Velarail', 'Grocevia', 'Tuisvra', 'Calloway & Vine',
    'Quenlo Brands', 'Melkvale', 'Korrelberg Foods', 'Grootmark', 'Hoekwinkel Group', 'Lumvera South Africa', 'Maltrix Africa', 'Hartevlei Foods', 'Fizzanti Beverages Africa'],
  site: ['Germiston', 'Isando', 'Durban harbour', 'Cape Town Montague Gardens', 'Gqeberha', 'Polokwane', 'Bloemfontein', 'Walvis Bay', 'Gaborone', 'Midrand'],
  role: ['chief executive', 'chief financial officer', 'operations director', 'head of sales', 'site manager Germiston', 'site manager Durban',
    'group HR manager', 'IT manager', 'fleet manager', 'procurement manager', 'company secretary', 'warehouse supervisor'],
  bank: ['Umbila Bank', 'Ridgeport Bank', 'Koppiesdal Bank', 'Sablevale Bank', 'Kesterton Private Bank'],
  vendor: ['Draviqo', 'Ledgerva', 'Clientroost', 'Tabulyn', 'Bookvirk', 'Mailvorn', 'Taskquell', 'Kabelwerk Data', 'Datrovia', 'Staffrune'],
  insurer: ['Varsure', 'Amberlea Insure', 'Kloofsure', 'Vuyelo Insure', 'Gravenhok Underwriting', 'Wexbury Specialty'],
  mark: ['DROSVELT', 'Drosvelt Cold Chain', 'DrosveltTrack', 'Skylarra', 'Drosvelt Express', 'Koelvars'],
  policy: ['acceptable use', 'access control', 'backup', 'incident response', 'remote working', 'password', 'change management', 'leave',
    'travel', 'grievance', 'anti-bribery', 'whistle-blowing', 'health and safety'],
  seg: ['retail', 'FMCG', 'chemicals', 'cold chain', 'cross-border'],
  n: ['1', '2', '3', '4', '5', '6', '7', '8'],
};

const T: Record<string, string[]> = {
  '1': ['Board resolution {sub} {month} {year}', 'Minutes of board meeting {sub} {month} {year}', 'Share certificate {n} {sub}',
    'Annual return {sub} {year}', 'Group structure chart {year}', 'Shareholders agreement {sub}', 'Register of directors {sub}:xlsx',
    'Minutes of annual general meeting {sub} {year}', 'Written resolution of shareholders {sub} {year}', 'Delegation of authority {year}'],
  '2.1': ['Memorandum of incorporation {sub}', 'Certificate of incorporation {sub}', 'Share register {sub} {year}:xlsx', 'Register of directors {sub} {year}',
    'Change of name certificate {sub}'],
  '2.2': ['Summons {cp} v {sub}', 'Legal opinion on {cp} claim', 'Settlement agreement {cp}', 'Litigation schedule {month} {year}:xlsx', 'Letter of demand {cp} {year}'],
  '2.3': ['B-BBEE certificate {sub} {year}', 'Competition Commission filing {year}', 'Customs licence {sub}', 'Cross-border road transport permit {site}',
    'Dangerous goods operator licence {site}', 'Regulatory correspondence {month} {year}'],
  '2.4': ['Transport services agreement {cp}', 'Supply agreement {cp}', 'Rebate agreement {cp} {year}', 'Confidentiality agreement {cp}'],
  '2.5': ['Employment contract {role}', 'Restraint of trade undertaking {role}', 'Retention bonus letter {role}', 'Collective agreement Sebenzani Freight and Allied Workers Union {year}',
    'Policy on {policy}', 'Share incentive scheme rules {year}', 'Fixed-term contract {site} {year}'],
  '2.6': ['Lease agreement {site}', 'Addendum to lease {site} {year}', 'Renewal notice {site} {year}', 'Sublease agreement {site}'],
  '3.1': ['Management accounts {month} {year}:xlsx', 'Management report {month} {year}', 'Debtors age analysis {month} {year}:xlsx', 'Creditors age analysis {month} {year}:xlsx'],
  '3.3': ['Budget {fy} {sub}:xlsx', 'Rolling forecast {month} {year}:xlsx', 'Five-year business plan {year}', 'Capital expenditure plan {fy}:xlsx'],
  '3.4': ['VAT201 return {month} {year}', 'Income tax return ITR14 {sub} {year}', 'Tax clearance certificate {sub} {year}', 'SARS correspondence {month} {year}',
    'Transfer pricing documentation {fy}', 'Provisional tax IRP6 {sub} {year}', 'Tax computation {sub} {fy}:xlsx', 'EMP501 reconciliation {sub} {year}'],
  '3.5': ['Bank statement {bank} {month} {year}', 'Facility agreement {bank} {year}', 'Hedging confirmation {month} {year}', 'Cash flow forecast {month} {year}:xlsx',
    'Guarantee {bank} {cp}'],
  '4': ['Customer contract {cp}', 'Price list {seg} {year}:xlsx', 'Tender submission {cp} {year}', 'Rebate agreement {cp} {year}',
    'Sales pipeline report {month} {year}:xlsx', 'Customer satisfaction survey {year}', 'Service level report {cp} {month} {year}', 'Key account plan {cp} {year}:docx'],
  '5': ['Organisation chart {sub} {year}', 'Payroll summary {month} {year}:xlsx', 'Headcount report {month} {year}:xlsx', 'Pension fund rules {sub}',
    'Medical aid scheme summary {year}', 'Training plan {site} {year}', 'Employment equity report {year}', 'Policy on {policy}:docx'],
  '6': ['IT asset register {year}:xlsx', 'Software licence {vendor}', 'Support agreement {vendor} {year}', 'Disaster recovery plan {year}',
    'Penetration test report {year}', 'IT policy on {policy}:docx', 'Network diagram {site}'],
  '7': ['Title deed {site}', 'Valuation report {site} {year}', 'Zoning certificate {site}', 'Building plans {site}', 'Occupation certificate {site}',
    'Rates clearance certificate {site} {year}', 'Fire compliance certificate {site} {year}'],
  '8': ['Insurance policy schedule {insurer} {year}', 'Claims history {insurer} {year}:xlsx', 'Broker letter {insurer} {year}', 'Fleet insurance schedule {year}'],
  '9': ['Water use licence {site}', 'Environmental audit report {site} {year}', 'Waste management licence {site}', 'Air emission licence {site}',
    'Environmental management programme {site}'],
  '10': ['Trade mark registration certificate {mark} class {n}', 'Patent specification {mark} {year}', 'Domain name register {year}:xlsx',
    'Intellectual property assignment {cp}', 'Software source code escrow {vendor}', 'Licence of trade mark {mark} to {sub}'],
  '11': ['POPIA compliance assessment {year}', 'Privacy policy {year}', 'Data processing agreement {vendor}', 'PAIA manual {year}', 'Information officer registration {sub}'],
};

function generateNames(ix: string, count: number, taken: Set<string>): { name: string; ext: Ext }[] {
  const r = rng([...ix].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261));
  const pick = <X>(xs: X[]) => xs[Math.floor(r() * xs.length)]!;
  const out: { name: string; ext: Ext }[] = [];
  for (let i = 0; out.length < count; i++) {
    const [tpl, ext] = pick(T[ix]!).split(':') as [string, Ext | undefined];
    let name = tpl.replace(/\{(\w+)\}/g, (_, k: string) => pick(W[k]!));
    if (i > count * 50) name = `${name} part ${out.length + 1}`;
    if (taken.has(name)) continue;
    taken.add(name);
    out.push({ name, ext: ext ?? 'pdf' });
  }
  return out;
}

export const MIME: Record<Ext, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface RoomPlan {
  tree: FolderSpec[];
  rows(f: FolderSpec): Row[];
  stableVersionIds?: boolean;
}


const BIDDER_TOP: Record<'a' | 'b' | 'c', number> = { a: 40, b: 20, c: 20 };
const FOLDER_ACCESS: Record<string, Partial<Record<'a' | 'b' | 'c' | 'cFin', number>>> = {
  '3': { cFin: 20 },
  '2.4': { a: 40, b: 20, c: 20 },
  // effective_level() caps this at Bidder C's 20
  '3.2': { a: 50, b: 40, c: 20, cFin: 50 },
};

// example.com is reserved: never mail a stranger from dev
export const DEFAULT_DEMO_DOMAINS = {
  seller: 'seller.example.com', a: 'bidder-a.example.com', b: 'bidder-b.example.com', c: 'bidder-c.example.com',
} as const;
export type DemoSide = keyof typeof DEFAULT_DEMO_DOMAINS;

export function demoDomains(value: string | undefined = process.env.VDRKIT_DEMO_EMAIL_DOMAINS): Record<DemoSide, string> {
  const out: Record<DemoSide, string> = { ...DEFAULT_DEMO_DOMAINS };
  const v = value?.trim();
  if (!v) return out;
  const domain = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
  if (!v.includes('=')) {
    if (!domain.test(v)) throw new Error(`VDRKIT_DEMO_EMAIL_DOMAINS: "${v}" is not a domain`);
    for (const k of Object.keys(out) as DemoSide[]) out[k] = v.toLowerCase();
    return out;
  }
  for (const pair of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [side, d] = pair.split('=').map((x) => x.trim());
    if (!side || !(side in out)) throw new Error(`VDRKIT_DEMO_EMAIL_DOMAINS: unknown side "${side}" (use seller, a, b or c)`);
    if (!d || !domain.test(d)) throw new Error(`VDRKIT_DEMO_EMAIL_DOMAINS: "${d ?? ''}" is not a domain`);
    out[side as DemoSide] = d.toLowerCase();
  }
  return out;
}

export const DEMO_DOMAINS = demoDomains();
const S = DEMO_DOMAINS;
export const DEMO_PEOPLE = {
  anika: { name: 'Anika Pillay', email: `anika@${S.seller}`, timeZone: 'Africa/Johannesburg', company: 'Quillmont Advisory', jobTitle: 'Director' },
  maria: { name: 'Maria Botha', email: `maria@${S.seller}`, timeZone: 'Africa/Johannesburg', company: 'Drosvelt Holdings', jobTitle: 'Financial manager' },
  johan: { name: 'Johan Steyn', email: `johan@${S.seller}`, timeZone: 'Africa/Johannesburg', company: 'Drosvelt Holdings', jobTitle: 'Finance director' },
  liesl: { name: 'Liesl van Wyk', email: `liesl@${S.seller}`, timeZone: 'Africa/Johannesburg', company: 'Drosvelt Holdings', jobTitle: 'CFO' },
  jan: { name: 'Jan de Vries', email: `jan@${S.a}`, timeZone: 'Europe/London', company: 'Orrinby Capital', jobTitle: 'Partner' },
  pieter: { name: 'Pieter Nel', email: `pieter@${S.a}`, timeZone: 'Europe/London', company: 'Orrinby Capital', jobTitle: 'Analyst' },
  mei: { name: 'Mei Tanaka', email: `mei@${S.b}`, timeZone: 'Africa/Johannesburg', company: 'Delmora Partners', jobTitle: 'Head of M&A' },
  sipho: { name: 'Sipho Ndlovu', email: `sipho@${S.c}`, timeZone: 'Africa/Johannesburg', company: 'Seratwe Equity', jobTitle: 'Associate' },
  lars: { name: 'Lars Eriksen', email: `lars@${S.c}`, timeZone: 'Africa/Johannesburg', company: 'Skarvik Bank', jobTitle: 'Lead arranger' },
} as const;
export type PersonKey = keyof typeof DEMO_PEOPLE;

export interface DemoRoom {
  tenantId: string;
  workspaceId: string;
  skipped: boolean;
  person: Record<PersonKey, string>;
  group: Record<'admins' | 'finance' | 'observers' | 'a' | 'b' | 'c' | 'cFin', string>;
  node: Record<string, string>;
  counts: { folders: number; published: number; drafts: number; newVersions: number };
}

export interface SeedOptions extends TenantOptions {
  tenantId?: string;
  plan?: RoomPlan;
  today?: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tenantOptions = (opts: SeedOptions): TenantOptions => (opts.role ? { role: opts.role } : {});

async function id(tx: SqlClient, sql: string, params: unknown[]): Promise<string> {
  const row = (await tx.query<{ id: string }>(sql, params)).rows[0];
  if (!row) throw new Error(`No row from: ${sql}`);
  return row.id;
}

export async function seedDemo(db: Database, opts: SeedOptions = {}): Promise<DemoRoom> {
  const tenantId = opts.tenantId ?? DEMO_TENANT_ID;
  const tenantOpts = tenantOptions(opts);
  const tree = opts.plan?.tree ?? TREE;
  const vid = (ix: string, n: number) => (opts.plan?.stableVersionIds ? stableId(tenantId, `version:${ix}:${n}`) : null);
  // Every story date must go through at() or day().
  const shift = demoShiftMs(opts.today);
  const at = (d: Date | string) => shiftDate(d, shift).toISOString();
  const day = (d: string) => shiftDay(d, shift);
  return withTenant(db, tenantId, async (tx) => {
    const existing = (await tx.query<{ id: string }>(`select w.id from tenant t join workspace w on w.tenant_id = t.id where t.id = $1
      order by w.id = $2 desc limit 1`, [tenantId, stableId(tenantId, 'workspace')])).rows[0];
    if (existing) {
      return { tenantId, workspaceId: existing.id, skipped: true, person: {} as DemoRoom['person'], group: {} as DemoRoom['group'], node: {}, counts: { folders: 0, published: 0, drafts: 0, newVersions: 0 } };
    }

    await tx.query(`insert into tenant (id, name) values ($1, 'Quillmont Advisory')`, [tenantId]);
    const sid = (key: string) => stableId(tenantId, key);
    const ws = await id(tx, `insert into workspace (id, tenant_id, name, state, requires_nda, time_zone, created_at)
      values ($2, current_tenant_id(), 'Project Heron', 'open', true, 'Africa/Johannesburg', $1) returning id`, [at(D.created), sid('workspace')]);

    const party = (name: string, kind: string) =>
      id(tx, `insert into party (id, tenant_id, workspace_id, name, kind) values ($4, current_tenant_id(), $1, $2, $3) returning id`, [ws, name, kind, sid(`party:${name}`)]);
    const seller = await party('Drosvelt Holdings', 'seller');
    const pA = await party('Bidder A', 'bidder');
    const pB = await party('Bidder B', 'bidder');
    const pC = await party('Bidder C', 'bidder');

    const grp = (partyId: string, name: string, role = 'member', parent: string | null = null) =>
      id(tx, `insert into groups (id, tenant_id, workspace_id, party_id, name, role_template, parent_group_id) values ($6, current_tenant_id(), $1, $2, $3, $4, $5) returning id`,
        [ws, partyId, name, role, parent, sid(`group:${name}`)]);
    const group: DemoRoom['group'] = {
      admins: await grp(seller, 'Room admins', 'admin'),
      finance: await grp(seller, 'Drosvelt Holdings finance'),
      observers: await grp(seller, 'Heron management', 'observer'),
      a: await grp(pA, 'Bidder A'),
      b: await grp(pB, 'Bidder B'),
      c: await grp(pC, 'Bidder C'),
      cFin: '',
    };
    group.cFin = await grp(pC, 'Bidder C financiers', 'member', group.c);
    const ORGANISATION: Record<keyof DemoRoom['group'], string> = {
      admins: 'Quillmont Advisory', finance: 'Drosvelt Holdings', observers: 'Drosvelt Holdings',
      a: 'Orrinby Capital', b: 'Delmora Partners', c: 'Seratwe Equity', cFin: 'Skarvik Bank',
    };
    for (const [k, org] of Object.entries(ORGANISATION)) await tx.query(`update groups set organisation = $2 where id = $1`, [group[k as keyof DemoRoom['group']], org]);
    await tx.query(`update groups set valid_to = $2 where id = $1`, [group.a, at('2027-01-29T15:00:00Z')]);

    const person = {} as DemoRoom['person'];
    for (const [key, p] of Object.entries(DEMO_PEOPLE) as [PersonKey, (typeof DEMO_PEOPLE)[PersonKey]][]) {
      person[key] = await id(tx, `insert into person (id, tenant_id, name, email, time_zone, company, job_title) values ($4, current_tenant_id(), $1, $2, $3, $5, $6) returning id`,
        [p.name, p.email, p.timeZone, sid(`person:${key}`), p.company, p.jobTitle]);
    }
    const principal: Partial<Record<keyof DemoRoom['person'], string>> = {};
    for (const p of ['anika', 'maria', 'johan'] as const) {
      principal[p] = await id(tx, `insert into principal (id, tenant_id, kind, person_id, name) values ($3, current_tenant_id(), 'person', $1, $2) returning id`,
        [person[p], p, sid(`principal:${p}`)]);
    }
    await tx.query(`update person set can_create_rooms = true where id = $1`, [person.anika]);

    const member = (p: string, g: string, role = 'member') =>
      tx.query(`insert into membership (tenant_id, person_id, group_id, role, recorded_at) values (current_tenant_id(), $1, $2, $3, $4)`,
        [p, g, role, at(D.created)]);
    await member(person.anika, group.admins, 'admin');
    await member(person.maria, group.finance);
    await member(person.johan, group.finance);
    await member(person.liesl, group.observers);
    await member(person.jan, group.a, 'lead');
    await member(person.pieter, group.a);
    await member(person.mei, group.b);
    await member(person.sipho, group.c);
    await member(person.lars, group.cFin);

    const agreement = await id(tx, `insert into agreement (tenant_id, workspace_id, kind, name) values (current_tenant_id(), $1, 'nda', 'Project Heron confidentiality undertaking') returning id`, [ws]);
    const ndaV1 = await id(tx, `insert into agreement_version (tenant_id, agreement_id, version_no, body, published_at) values (current_tenant_id(), $1, 1, $2, $3) returning id`,
      [agreement, 'Confidentiality undertaking for Project Heron, version 1.', at(D.ndaPublished)]);
    for (const p of [person.jan, person.pieter, person.mei, person.sipho, person.lars]) {
      await tx.query(`insert into acceptance (tenant_id, agreement_version_id, person_id, accepted_at) values (current_tenant_id(), $1, $2, $3)`,
        [ndaV1, p, at(D.ndaAccepted)]);
    }

    const milestone = (key: string, title: string, dueAt: string, groups: string[] = [], phase: [string, string] | null = null) =>
      tx.query(`insert into milestone (id, tenant_id, workspace_id, title, due_at, visible_to_group_ids, phase_name, phase_starts_on, created_at, updated_at)
                values ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $8)`,
        [sid(`milestone:${key}`), ws, title, dueAt, groups, phase?.[0] ?? null, phase?.[1] ?? null, at(D.grants)]);
    await milestone('opened', 'Room opened', at('2026-11-03T07:00:00Z'));
    await milestone('qa1', 'Q&A round 1 closes', at('2026-11-20T15:00:00Z'));
    await milestone('nbo', 'Non-binding offers due', at('2026-11-27T15:00:00Z'), [], ['First round', day('2026-11-03')]);
    await milestone('mp-a', 'Management presentation, Bidder A', at('2026-12-08T08:00:00Z'), [group.a]);
    await milestone('mp-c', 'Management presentation, Bidder C', at('2026-12-09T08:00:00Z'), [group.c]);
    await milestone('qa-cut', 'Q&A cut-off', at('2027-01-22T15:00:00Z'));
    await milestone('bo', 'Binding offers due', at('2027-02-12T15:00:00Z'), [], ['Second round', day('2026-11-30')]);

    await appendEvent(tx, { action: 'workspace.created', workspaceId: ws, actorId: principal.anika, resourceType: 'workspace', resourceId: ws,
      data: { time_zone: 'Africa/Johannesburg', top_folders: tree.length, seed: 'demo' }, occurredAt: shiftDate(D.created, shift) });

    const node: Record<string, string> = {};
    const counts = { folders: 0, published: 0, drafts: 0, newVersions: 0 };
    const grant = (nodeId: string, subject: { groupId: string } | { personId: string }, level: number, sw: { up?: boolean; manage?: boolean; publish?: boolean } = {}) =>
      setGrant(tx, { workspaceId: ws, nodeId, subject, level: level as LevelValue, canUpload: sw.up ?? false, canManage: sw.manage ?? false,
        canPublish: sw.publish ?? false, actorId: principal.anika, now: shiftDate(D.grants, shift) });

    async function folder(f: FolderSpec, parentId: string | null, sort: number): Promise<void> {
      const fid = await id(tx, `insert into node (id, tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state, published_at, published_by, created_at)
        values ($9, current_tenant_id(), $1, $2, 'folder', $3, $4, $5, 'published', $6, $7, $8) returning id`,
        [ws, parentId, f.name, f.ix, sort, at(D.tue3), person.anika, at(D.created), sid(`node:${f.ix}`)]);
      node[f.ix] = fid;
      counts.folders++;

      if (!parentId) {
        await grant(fid, { groupId: group.admins }, 60, { up: true, manage: true, publish: true });
        if (!f.noBidders) {
          await grant(fid, { groupId: group.finance }, 20, f.ix === '3' ? { up: true } : {});
          await grant(fid, { groupId: group.observers }, 20);
          const bidders = f.bidders ?? BIDDER_TOP;
          for (const k of ['a', 'b', 'c'] as const) if (bidders[k]) await grant(fid, { groupId: group[k] }, bidders[k]);
        }
        if (f.ix === '3') await grant(fid, { personId: person.johan }, 20, { up: true, publish: true });
      }
      for (const [k, level] of Object.entries(FOLDER_ACCESS[f.ix] ?? {})) await grant(fid, { groupId: group[k as keyof typeof group] }, level);

      if (f.kids) {
        let s = 0;
        for (const k of f.kids) await folder(k, fid, ++s);
        return;
      }
      await insertDocuments(fid, opts.plan ? opts.plan.rows(f) : defaultRows(f));
    }

    function defaultRows(f: FolderSpec): Row[] {
      const named = NAMED[f.ix] ?? [];
      const taken = new Set(named.map((r) => r[1]));
      const draftsLeft = (f.drafts ?? 0) - named.filter((r) => r[3] === 'draft' || r[3] === 'proc').length;
      const extra = generateNames(f.ix, f.n - named.length, taken);
      const r = rng(f.n * 7919 + f.ix.length);
      const generated = extra.map((e, i): Row => {
        const no = named.length + i + 1;
        const draft = i >= extra.length - draftsLeft;
        let date = D.thu12;
        if (!draft) date = r() < 0.8 ? D.tue3 : D.fri6;
        const uploader = draft && f.ix.startsWith('3') ? 'maria' : 'anika';
        return [`${f.ix}.${no}`, e.name, e.ext, draft ? 'draft' : 'pub', 1 + Math.floor(r() * 80), date, uploader];
      });
      return [...named, ...generated];
    }

    async function insertDocuments(fid: string, rows: Row[]): Promise<void> {
      const live = (x: Row) => x[3] === 'pub' || x[3] === 'upd' || x[3] === 'rev';
      const ids = await tx.query<{ id: string; index_number: string }>(
        `insert into node (id, tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state, published_at, published_by, created_at)
         select u.id, current_tenant_id(), $1, $2, 'document', u.name, u.ix, u.sort, u.state, u.pub_at, case when u.pub_at is null then null else $3::uuid end, u.created
           from unnest($10::uuid[], $4::text[], $5::text[], $6::int[], $7::text[], $8::timestamptz[], $9::timestamptz[]) as u(id, name, ix, sort, state, pub_at, created)
         returning id, index_number`,
        [ws, fid, person.anika,
          rows.map((x) => `${x[1]}.${x[2]}`), rows.map((x) => x[0]), rows.map((_, i) => i + 1),
          rows.map((x) => (live(x) ? 'published' : 'draft')),
          rows.map((x) => (live(x) ? at(x[5]) : null)),
          rows.map((x) => at(x[5])), rows.map((x) => sid(`node:${x[0]}`))]);
      const byIx = new Map(ids.rows.map((x) => [x.index_number, x.id]));
      for (const x of rows) {
        node[x[0]] = byIx.get(x[0])!;
        if (live(x)) counts.published++; else counts.drafts++;
      }

      await tx.query(
        `insert into document_version (id, tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, created_at,
            processing_status, page_count, metadata, queued_at)
         select coalesce(u.vid, gen_random_uuid()), current_tenant_id(), u.node_id, 1, 'demo/' || $1 || '/' || u.node_id, u.sha, u.size, u.mime, u.uploader, u.created,
            u.status, u.pages, '{"demo": true, "placeholder": "no file stored"}'::jsonb,
            -- no file; the stuck sweep fails it after two hours
            case when u.status = 'pending' then $10::timestamptz end
           from unnest($2::uuid[], $3::text[], $4::bigint[], $5::text[], $6::uuid[], $7::timestamptz[], $8::text[], $9::int[], $11::uuid[])
             as u(node_id, sha, size, mime, uploader, created, status, pages, vid)`,
        [ws,
          rows.map((x) => byIx.get(x[0])), rows.map((x) => sha(`${ws}:${x[0]}:${x[1]}`)),
          rows.map((x) => (x[4] ?? 1) * 61_440 + 18_000), rows.map((x) => MIME[x[2]]),
          rows.map((x) => principal[x[6] ?? 'anika']), rows.map((x) => at(x[5])),
          rows.map((x) => (x[3] === 'proc' ? 'pending' : 'ready')), rows.map((x) => x[4]), new Date().toISOString(), rows.map((x) => vid(x[0], 1))]);

      // bidders keep v1 until release
      for (const x of rows.filter((r) => r[3] === 'upd')) {
        const nodeId = byIx.get(x[0]);
        const pages = (x[4] ?? 1) + 1;
        await tx.query(
          `insert into document_version (id, tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, created_at,
              processing_status, page_count, visible_to_group_ids, awaiting_release, metadata)
           values (coalesce($10::uuid, gen_random_uuid()), current_tenant_id(), $1, 2, $2, $3, $4, $5, $6, $7, 'ready', $8, $9::uuid[], true,
              '{"demo": true, "placeholder": "no file stored"}'::jsonb)`,
          [nodeId, `demo/${ws}/${nodeId}/v2`, sha(`${ws}:${x[0]}:${x[1]}:v2`), pages * 61_440 + 18_000, MIME[x[2]],
            principal.anika, at(D.thu12), pages, [group.admins, group.finance], vid(x[0], 2)]);
        counts.newVersions++;
      }
      for (const x of rows.filter((r) => r[3] === 'rev')) {
        const nodeId = byIx.get(x[0]);
        const pages = (x[4] ?? 1) + 1;
        await tx.query(
          `insert into document_version (id, tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, created_at,
              processing_status, page_count, metadata)
           values (coalesce($9::uuid, gen_random_uuid()), current_tenant_id(), $1, 2, $2, $3, $4, $5, $6, $7, 'ready', $8,
              '{"demo": true, "placeholder": "no file stored"}'::jsonb)`,
          [nodeId, `demo/${ws}/${nodeId}/v2`, sha(`${ws}:${x[0]}:${x[1]}:v2`), pages * 61_440 + 18_000, MIME[x[2]],
            principal.anika, at(D.fri6), pages, vid(x[0], 2)]);
      }
    }

    let s = 0;
    for (const f of tree) await folder(f, null, ++s);

    await appendEvent(tx, { action: 'demo.seeded', workspaceId: ws, actorId: principal.anika, resourceType: 'workspace', resourceId: ws,
      data: { ...counts }, occurredAt: shiftDate(D.thu12, shift) });
    return { tenantId, workspaceId: ws, skipped: false, person, group, node, counts };
  }, tenantOpts);
}

// server tests expect seedDemo() alone to leave one room

export const MORE_ROOMS = ['osprey', 'falcon', 'kingfisher', 'weaver', 'marlin'] as const;
export type MoreRoomKey = (typeof MORE_ROOMS)[number];

export const MORE_ROOM_DOCUMENTS: Partial<Record<MoreRoomKey, { name: string; at: string; draft?: boolean }[]>> = {
  osprey: Array.from({ length: 12 }, (_, i) => ({ name: `Osprey company document ${i + 1}`, at: '2026-11-12T09:00:00Z', draft: true })),
  falcon: [{ name: 'Share purchase agreement, final', at: '2026-11-09T10:00:00Z' }],
  weaver: [
    { name: 'Information memorandum', at: '2026-11-02T08:00:00Z' }, { name: 'Group structure chart', at: '2026-11-02T08:00:00Z' },
    { name: 'Audited accounts 2025', at: '2026-11-02T08:00:00Z' }, { name: 'Management accounts September 2026', at: '2026-11-12T08:00:00Z' },
    { name: 'Customer list, top 20', at: '2026-11-12T08:00:00Z' }, { name: 'Supplier contracts summary', at: '2026-11-12T08:00:00Z' },
    { name: 'Draft budget 2027', at: '2026-11-12T08:00:00Z', draft: true },
  ],
};

export interface MoreRooms {
  skipped: boolean;
  workspace: Record<MoreRoomKey, string>;
  thandi: string;
}

export async function seedDemoRooms(db: Database, opts: SeedOptions = {}): Promise<MoreRooms> {
  const tenantId = opts.tenantId ?? DEMO_TENANT_ID;
  const tenantOpts = tenantOptions(opts);
  const sid = (key: string) => stableId(tenantId, key);
  const workspace = Object.fromEntries(MORE_ROOMS.map((k) => [k, sid(`workspace:${k}`)])) as Record<MoreRoomKey, string>;
  const thandi = sid('person:thandi');
  const shift = demoShiftMs(opts.today);
  const at = (d: string) => shiftDate(d, shift).toISOString();
  return withTenant(db, tenantId, async (tx) => {
    const done = (await tx.query(`select 1 from workspace where id = $1`, [workspace.osprey])).rows.length > 0;
    if (done) return { skipped: true, workspace, thandi };
    const anika = sid('person:anika');
    const jan = sid('person:jan');
    const heron = sid('workspace');
    await tx.query(`insert into person (id, tenant_id, name, email, time_zone, company, job_title) values ($1, current_tenant_id(), 'Thandi Mokoena', $2, 'Africa/Johannesburg', 'Quillmont Advisory', 'Associate')`, [thandi, `thandi@${S.seller}`]);
    const actor = await id(tx, `insert into principal (id, tenant_id, kind, person_id, name) values ($2, current_tenant_id(), 'person', $1, 'thandi') returning id`, [thandi, sid('principal:thandi')]);
    const anikaActor = sid('principal:anika');
    await tx.query(`update person set is_site_admin = true, open_at_sign_in_workspace_id = $2 where id = $1`, [anika, heron]);
    await tx.query(`update person set job_title = 'Partner', company = 'Orrinby Capital' where id = $1 and company is null and job_title is null`, [jan]);

    const created = at('2026-09-01T08:00:00Z');
    const actorOf = (admin: string) => (admin === anika ? anikaActor : actor);
    async function room(key: MoreRoomKey, name: string, seller: string, admin: string) {
      const ws = workspace[key];
      await tx.query(`insert into workspace (id, tenant_id, name, state, requires_nda, time_zone, created_at) values ($1, current_tenant_id(), $2, 'open', false, 'Africa/Johannesburg', $3)`,
        [ws, name, created]);
      const party = await id(tx, `insert into party (id, tenant_id, workspace_id, name, kind) values ($3, current_tenant_id(), $1, $2, 'seller') returning id`, [ws, seller, sid(`party:${key}:seller`)]);
      const admins = await id(tx, `insert into groups (id, tenant_id, workspace_id, party_id, name, role_template) values ($3, current_tenant_id(), $1, $2, 'Room admins', 'admin') returning id`,
        [ws, party, sid(`group:${key}:admins`)]);
      await tx.query(`insert into membership (tenant_id, person_id, group_id, role, recorded_at) values (current_tenant_id(), $1, $2, 'admin', $3)`, [admin, admins, created]);
      const folder = await id(tx, `insert into node (id, tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state, published_at, published_by, created_at)
        values ($2, current_tenant_id(), $1, null, 'folder', 'Company', '1', 1, 'published', $3, $4, $3) returning id`, [ws, sid(`node:${key}:1`), created, admin]);
      await setGrant(tx, { workspaceId: ws, nodeId: folder, subject: { groupId: admins }, level: 60 as LevelValue, canUpload: true, canManage: true, canPublish: true,
        actorId: actorOf(admin), now: new Date(created) });
      await appendEvent(tx, { action: 'workspace.created', workspaceId: ws, actorId: actorOf(admin), resourceType: 'workspace', resourceId: ws,
        data: { time_zone: 'Africa/Johannesburg', seed: 'demo' }, occurredAt: new Date(created) });
      return { ws, folder };
    }
    async function documents(key: MoreRoomKey, ws: string, folder: string, uploader: string, rows: { name: string; at: string; draft?: boolean }[]) {
      for (const [i, r] of rows.entries()) {
        const ix = `1.${i + 1}`;
        const node = await id(tx, `insert into node (id, tenant_id, workspace_id, parent_id, kind, name, index_number, sort_key, state, published_at, published_by, created_at)
          values ($1, current_tenant_id(), $2, $3, 'document', $4, $5, $6, $7, $8, $9, $10) returning id`,
          [sid(`node:${key}:${ix}`), ws, folder, `${r.name}.pdf`, ix, i + 1, r.draft ? 'draft' : 'published', r.draft ? null : at(r.at), r.draft ? null : uploader, at(r.at)]);
        await tx.query(`insert into document_version (id, tenant_id, node_id, version_no, storage_key, sha256, size_bytes, mime, uploaded_by, created_at, processing_status, page_count, metadata)
          values (coalesce($6::uuid, gen_random_uuid()), current_tenant_id(), $1, 1, $2, $3, 120000, 'application/pdf', $4, $5, 'ready', 4, '{"demo": true, "placeholder": "no file stored"}'::jsonb)`,
          [node, `demo/${ws}/${node}`, sha(`${ws}:${ix}`), actorOf(uploader), at(r.at), opts.plan?.stableVersionIds ? sid(`version:${key}:${ix}:1`) : null]);
      }
    }
    async function setState(ws: string, state: string, since: string) {
      await tx.query(`select set_config('vdrkit.state_valid_from', $1, true)`, [at(since)]);
      await tx.query(`update workspace set state = $2 where id = $1`, [ws, state]);
      await tx.query(`select set_config('vdrkit.state_valid_from', '', true)`);
    }
    const visit = (ws: string, person: string, when: string, previous: string | null = null) =>
      tx.query(`insert into workspace_visit (tenant_id, workspace_id, person_id, last_visit_at, previous_visit_at) values (current_tenant_id(), $1, $2, $3, $4)`,
        [ws, person, at(when), previous === null ? null : at(previous)]);

    const osprey = await room('osprey', 'Project Osprey', 'Duncarrow Foods', anika);
    await documents('osprey', osprey.ws, osprey.folder, anika, MORE_ROOM_DOCUMENTS.osprey!);
    await setState(osprey.ws, 'preparing', '2026-09-01T08:00:00Z');
    await visit(osprey.ws, anika, '2026-11-13T14:05:00Z');

    const falcon = await room('falcon', 'Project Falcon', 'Kwartsrand Engineering', anika);
    await documents('falcon', falcon.ws, falcon.folder, anika, MORE_ROOM_DOCUMENTS.falcon!);
    // relative to loading; a fixed date would go stale
    const today = new Date();
    const signing = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 7, 8));
    await tx.query(`insert into milestone (id, tenant_id, workspace_id, title, due_at) values ($1, current_tenant_id(), $2, 'Signing', $3)`,
      [sid('milestone:falcon:signing'), falcon.ws, signing.toISOString()]);
    await setState(falcon.ws, 'frozen', '2026-11-11T08:00:00Z');
    await visit(falcon.ws, anika, '2026-11-10T08:20:00Z');

    const kingfisher = await room('kingfisher', 'Project Kingfisher', 'Mosvelder Logistics', anika);
    await setState(kingfisher.ws, 'closed', '2026-10-30T15:00:00Z');
    await visit(kingfisher.ws, anika, '2026-10-30T14:10:00Z');

    const weaver = await room('weaver', 'Project Weaver', 'Weaver Textiles', thandi);
    const wParty = await id(tx, `insert into party (id, tenant_id, workspace_id, name, kind) values ($2, current_tenant_id(), $1, 'Bidder 2', 'bidder') returning id`, [weaver.ws, sid('party:weaver:bidder2')]);
    const wGroup = await id(tx, `insert into groups (id, tenant_id, workspace_id, party_id, name) values ($3, current_tenant_id(), $1, $2, 'Bidder 2') returning id`, [weaver.ws, wParty, sid('group:weaver:bidder2')]);
    await tx.query(`insert into membership (tenant_id, person_id, group_id, role, recorded_at) values (current_tenant_id(), $1, $2, 'member', $3)`, [jan, wGroup, created]);
    await setGrant(tx, { workspaceId: weaver.ws, nodeId: weaver.folder, subject: { groupId: wGroup }, level: 20 as LevelValue, canUpload: false, canManage: false, canPublish: false,
      actorId: actor, now: new Date(created) });
    await documents('weaver', weaver.ws, weaver.folder, thandi, MORE_ROOM_DOCUMENTS.weaver!);
    const presentation = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 8, 9));
    await tx.query(`insert into milestone (id, tenant_id, workspace_id, title, due_at, visible_to_group_ids) values ($1, current_tenant_id(), $2, 'Management presentation', $3, $4)`,
      [sid('milestone:weaver:mp'), weaver.ws, presentation.toISOString(), [wGroup]]);
    await visit(weaver.ws, jan, '2026-11-09T10:00:00Z', '2026-11-04T09:00:00Z');

    const marlin = await room('marlin', 'Project Marlin', 'Marlin Marine', thandi);
    const mParty = await id(tx, `insert into party (id, tenant_id, workspace_id, name, kind) values ($2, current_tenant_id(), $1, 'Bidder 1', 'bidder') returning id`, [marlin.ws, sid('party:marlin:bidder1')]);
    const mGroup = await id(tx, `insert into groups (id, tenant_id, workspace_id, party_id, name) values ($3, current_tenant_id(), $1, $2, 'Bidder 1') returning id`, [marlin.ws, mParty, sid('group:marlin:bidder1')]);
    await tx.query(`insert into membership (tenant_id, person_id, group_id, role, valid_from, valid_to, recorded_at) values (current_tenant_id(), $1, $2, 'member', $3, $4, $3)`,
      [jan, mGroup, created, at('2026-10-01T00:00:00Z')]);
    await visit(marlin.ws, jan, '2026-09-30T13:00:00Z');

    return { skipped: false, workspace, thandi };
  }, tenantOpts);
}

export const SITE_PEOPLE = {
  thabo: { name: 'Thabo Molefe', email: `thabo@${S.seller}`, siteAdmin: true, company: 'Quillmont Advisory', jobTitle: 'Head of IT' },
  ruth: { name: 'Ruth Mahlangu', email: `ruth@${S.seller}`, siteAdmin: false, company: 'Quillmont Advisory', jobTitle: 'Partner' },
  lindiwe: { name: 'Lindiwe Zulu', email: `lindiwe@${S.seller}`, siteAdmin: false, company: 'Quillmont Advisory', jobTitle: 'Senior associate' },
} as const;

const SITE_ROOMS = [
  { key: 'osprey', name: 'Project Osprey', seller: 'Duncarrow Foods', state: 'preparing', created: '2026-11-09T08:00:00Z' },
  { key: 'falcon', name: 'Project Falcon', seller: 'Kwartsrand Engineering', state: 'frozen', created: '2026-09-07T08:00:00Z' },
  { key: 'kingfisher', name: 'Project Kingfisher', seller: 'Mosvelder Logistics', state: 'closed', created: '2026-04-02T08:00:00Z' },
] as const;

export async function seedSiteDemo(db: Database, opts: SeedOptions = {}): Promise<{ skipped: boolean; person: Record<keyof typeof SITE_PEOPLE, string> }> {
  const tenantId = opts.tenantId ?? DEMO_TENANT_ID;
  const tenantOpts = tenantOptions(opts);
  const sid = (key: string) => stableId(tenantId, key);
  const person = Object.fromEntries(Object.keys(SITE_PEOPLE).map((k) => [k, sid(`person:${k}`)])) as Record<keyof typeof SITE_PEOPLE, string>;
  const shift = demoShiftMs(opts.today);
  return withTenant(db, tenantId, async (tx) => {
    await tx.query(`insert into site_instance (tenant_id) values (current_tenant_id()) on conflict do nothing`);
    if ((await tx.query(`select 1 from person where id = $1`, [person.thabo])).rows.length) return { skipped: true, person };
    await tx.query(`update person set is_site_admin = true where id = $1`, [sid('person:anika')]);
    for (const [key, p] of Object.entries(SITE_PEOPLE)) {
      await tx.query(`insert into person (id, tenant_id, name, email, time_zone, is_site_admin, can_create_rooms, company, job_title) values ($1, current_tenant_id(), $2, $3, 'Africa/Johannesburg', $4, true, $5, $6)`,
        [person[key as keyof typeof SITE_PEOPLE], p.name, p.email, p.siteAdmin, p.company, p.jobTitle]);
    }
    await tx.query(`insert into site_settings (tenant_id, org_name, org_domain) values (current_tenant_id(), 'Quillmont Advisory', $1) on conflict (tenant_id) do nothing`, [S.seller]);
    for (const s of SITE_ROOMS) {
      const r = { ...s, created: shiftDate(s.created, shift).toISOString() };
      if ((await tx.query(`select 1 from workspace where name = $1`, [r.name])).rows.length) continue;
      const ws = sid(`site-room:${r.key}`);
      await tx.query(`insert into workspace (id, tenant_id, name, state, requires_nda, time_zone, created_at) values ($1, current_tenant_id(), $2, $3, false, 'Africa/Johannesburg', $4)`,
        [ws, r.name, r.state, r.created]);
      const party = sid(`site-room:${r.key}:seller`);
      await tx.query(`insert into party (id, tenant_id, workspace_id, name, kind) values ($1, current_tenant_id(), $2, $3, 'seller')`, [party, ws, r.seller]);
      const group = sid(`site-room:${r.key}:admins`);
      await tx.query(`insert into groups (id, tenant_id, workspace_id, party_id, name, role_template) values ($1, current_tenant_id(), $2, $3, 'Room admins', 'admin')`, [group, ws, party]);
      await tx.query(`insert into membership (tenant_id, person_id, group_id, role, recorded_at) values (current_tenant_id(), $1, $2, 'admin', $3)`, [person.thabo, group, r.created]);
    }
    return { skipped: false, person };
  }, tenantOpts);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const { default: pg } = await import('pg');
  const { fromPgPool } = await import('@vdrkit/core');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const room = await seedDemo(fromPgPool(pool), { tenantId: process.env.DEMO_TENANT_ID });
    if (room.skipped) console.log(`The demo tenant ${room.tenantId} already exists. Nothing changed.`);
    else console.log(`Seeded Project Heron in tenant ${room.tenantId}: ${room.counts.folders} folders, ${room.counts.published} published documents, ${room.counts.drafts} drafts.`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
