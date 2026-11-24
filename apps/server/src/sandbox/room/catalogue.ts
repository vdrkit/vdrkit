// SPDX-License-Identifier: AGPL-3.0-only
import { D, MORE_ROOM_DOCUMENTS, NAMED, stableId, type Ext, type FolderSpec, type RoomPlan, type Row, type Status, type Uploader } from '../../demo/seed-demo.js';

export type Kind =
  | 'dev' | 'agreement' | 'minutes' | 'resolution' | 'certificate' | 'register' | 'letter' | 'court' | 'report' | 'policy' | 'permit'
  | 'tax-return' | 'bank-statement' | 'insurance-schedule' | 'chart'
  | 'mgmt-accounts' | 'age-analysis' | 'budget' | 'forecast' | 'capex' | 'cashflow' | 'price-list' | 'pipeline' | 'payroll' | 'headcount'
  | 'asset-register' | 'claims' | 'domains' | 'share-register' | 'directors-register' | 'litigation-schedule' | 'tax-computation' | 'dev-table'
  | 'deck' | 'neighbour';

export type Params = Record<string, string>;

export interface RoomDoc {
  ix: string;
  name: string;
  ext: Ext;
  status: Status;
  date: Date;
  uploader: Uploader;
  kind: Kind;
  p: Params;
  pages: number;
  room?: NeighbourRoom;
}

export type NeighbourRoom = 'osprey' | 'falcon' | 'weaver';
const SELLERS: Record<NeighbourRoom, string> = { osprey: 'Duncarrow Foods', falcon: 'Kwartsrand Engineering', weaver: 'Weaver Textiles' };
const OSPREY_TOPICS = ['Company profile', 'Securities register', 'Product range', 'Plant and equipment list', 'Key customers', 'Organisation chart',
  'Food safety certificates', 'Property leases', 'Insurance summary', 'IT systems', 'Management accounts summary', 'Litigation summary'];


export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const PERIODS = Array.from({ length: 34 }, (_, i) => `${MONTHS[i % 12]} ${2024 + Math.floor(i / 12)}`);

export const WORDS: Record<string, string[]> = {
  sub: ['Drosvelt Holdings', 'Drosvelt Logistics', 'Drosvelt Packaging', 'Drosvelt Properties', 'Drosvelt Namibia', 'Drosvelt Botswana', 'Drosvelt Cold Chain'],
  year: ['2024', '2025', '2026'],
  period: PERIODS,
  fy: ['FY2024', 'FY2025', 'FY2026', 'FY2027'],
  cp: ['Tarnley Logistics', 'Ombeli Chemicals', 'Paxenfold', 'Tsamvo', 'Rostrand Logistics', 'Velarail', 'Grocevia', 'Tuisvra', 'Calloway & Vine',
    'Quenlo Brands', 'Melkvale', 'Korrelberg Foods', 'Grootmark', 'Hoekwinkel Group', 'Lumvera South Africa', 'Maltrix Africa', 'Hartevlei Foods', 'Fizzanti Beverages Africa'],
  site: ['Germiston', 'Isando', 'Durban harbour', 'Cape Town Montague Gardens', 'Gqeberha', 'Polokwane', 'Bloemfontein', 'Walvis Bay', 'Gaborone', 'Midrand'],
  role: ['chief executive', 'chief financial officer', 'operations director', 'head of sales', 'site manager Germiston', 'site manager Durban',
    'group HR manager', 'IT manager', 'fleet manager', 'procurement manager', 'company secretary', 'warehouse supervisor'],
  bank: ['Umbila Bank', 'Ridgeport Bank', 'Koppiesdal Bank', 'Sablevale Bank', 'Kesterton Private Bank'],
  vendor: ['Draviqo', 'Ledgerva', 'Clientroost', 'Tabulyn', 'Bookvirk', 'Mailvorn', 'Taskquell', 'Kabelwerk Data', 'Datrovia', 'Staffrune'],
  insurer: ['Varsure', 'Amberlea Insure', 'Kloofsure', 'Vuyelo Insure', 'Gravenhok Underwriting', 'Wexbury Specialty'],
  mark: ['DROSVELT', 'Drosvelt Cold Chain', 'DrosveltTrack', 'Skylarra', 'Drosvelt Express', 'Koelvars'],
  cls: ['9', '16', '35', '39', '42'],
  hrPolicy: ['leave', 'travel', 'grievance', 'anti-bribery', 'whistle-blowing', 'health and safety', 'disciplinary procedure', 'overtime', 'recruitment'],
  itPolicy: ['acceptable use', 'access control', 'backup', 'incident response', 'remote working', 'password', 'change management'],
  seg: ['retail', 'FMCG', 'chemicals', 'cold chain', 'cross-border'],
  n: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
};


interface Template {
  name: string;
  kind: Kind;
  as?: string;
  ext?: Ext;
  pages?: [number, number];
}

const t = (name: string, kind: Kind, as?: string, ext?: Ext, pages?: [number, number]): Template => ({ name, kind, as, ext, pages });

const TEMPLATES: Record<string, Template[]> = {
  '1': [
    t('Minutes of board meeting {sub} {period}', 'minutes', 'board', 'pdf', [2, 5]),
    t('Board resolution {sub} {period}', 'resolution', 'board', 'pdf', [1, 2]),
    t('Written resolution of shareholders {sub} {year}', 'resolution', 'shareholders', 'pdf', [1, 2]),
    t('Minutes of annual general meeting {sub} {year}', 'minutes', 'agm', 'pdf', [2, 4]),
    t('Share certificate {n} {sub}', 'certificate', 'share'),
    t('Annual return {sub} {year}', 'certificate', 'annual-return'),
    t('Group structure chart {year}', 'chart', 'group'),
    t('Shareholders agreement {sub}', 'agreement', 'shareholders', 'pdf', [8, 14]),
    t('Register of directors {sub}', 'directors-register', undefined, 'xlsx'),
    t('Delegation of authority {year}', 'policy', 'doa', 'docx', [3, 6]),
    t('Board pack {period}', 'deck', 'board', 'pptx'),
    t('Minutes of executive committee {period}', 'minutes', 'exco', 'docx', [2, 3]),
  ],
  '2.1': [
    t('Memorandum of incorporation {sub}', 'policy', 'moi', 'pdf', [6, 12]),
    t('Certificate of incorporation {sub}', 'certificate', 'incorporation'),
    t('Share register {sub} {year}', 'share-register', undefined, 'xlsx'),
    t('Register of directors {sub} {year}', 'register', 'directors'),
    t('Change of name certificate {sub}', 'certificate', 'name'),
  ],
  '2.2': [
    t('Summons {cp} v {sub}', 'court', undefined, 'pdf', [2, 5]),
    t('Legal opinion on {cp} claim', 'letter', 'opinion', 'pdf', [2, 4]),
    t('Settlement agreement {cp}', 'agreement', 'settlement', 'pdf', [3, 5]),
    t('Litigation schedule {period}', 'litigation-schedule', undefined, 'xlsx'),
    t('Letter of demand {cp} {year}', 'letter', 'demand', 'pdf', [1, 2]),
  ],
  '2.3': [
    t('B-BBEE certificate {sub} {year}', 'certificate', 'bbbee'),
    t('Competition Commission filing {year}', 'report', 'competition', 'pdf', [3, 6]),
    t('Customs licence {sub}', 'permit', 'customs', 'pdf', [2, 3]),
    t('Cross-border road transport permit {site}', 'permit', 'crossborder', 'pdf', [1, 2]),
    t('Dangerous goods operator licence {site}', 'permit', 'dangerous-goods', 'pdf', [2, 3]),
    t('Regulatory correspondence {period}', 'letter', 'regulator', 'pdf', [1, 2]),
  ],
  '2.5': [
    t('Employment contract {role}', 'agreement', 'employment', 'pdf', [4, 7]),
    t('Restraint of trade undertaking {role}', 'agreement', 'restraint', 'pdf', [2, 3]),
    t('Retention bonus letter {role}', 'letter', 'retention', 'pdf', [1, 2]),
    t('Collective agreement Sebenzani Freight and Allied Workers Union {year}', 'agreement', 'collective', 'pdf', [5, 9]),
    t('Policy on {hrPolicy}', 'policy', 'hr', 'docx', [2, 5]),
    t('Share incentive scheme rules {year}', 'policy', 'share-scheme', 'pdf', [5, 9]),
    t('Fixed-term contract {site} {year}', 'agreement', 'fixed-term', 'pdf', [3, 4]),
  ],
  '2.6': [
    t('Lease agreement {site}', 'agreement', 'lease', 'pdf', [8, 14]),
    t('Addendum to lease {site} {year}', 'agreement', 'lease-addendum', 'pdf', [2, 4]),
    t('Renewal notice {site} {year}', 'letter', 'renewal', 'pdf', [1, 1]),
    t('Sublease agreement {site}', 'agreement', 'sublease', 'docx', [5, 8]),
  ],
  '3.1': [
    t('Management accounts {period}', 'mgmt-accounts', undefined, 'xlsx'),
    t('Management report {period}', 'report', 'management', 'pdf', [4, 8]),
    t('Debtors age analysis {period}', 'age-analysis', 'debtors', 'xlsx'),
    t('Creditors age analysis {period}', 'age-analysis', 'creditors', 'xlsx'),
  ],
  '3.3': [
    t('Budget {fy} {sub}', 'budget', undefined, 'xlsx'),
    t('Rolling forecast {period}', 'forecast', undefined, 'xlsx'),
    t('Five-year business plan {year}', 'report', 'business-plan', 'pdf', [8, 14]),
    t('Capital expenditure plan {fy}', 'capex', undefined, 'xlsx'),
    t('Budget presentation {fy}', 'deck', 'budget', 'pptx'),
  ],
  '3.4': [
    t('VAT201 return {period}', 'tax-return', 'vat201', 'pdf', [1, 2]),
    t('Income tax return ITR14 {sub} {year}', 'tax-return', 'itr14', 'pdf', [2, 3]),
    t('Tax clearance certificate {sub} {year}', 'certificate', 'tax-clearance'),
    t('SARS correspondence {period}', 'letter', 'sars', 'pdf', [1, 2]),
    t('Transfer pricing documentation {fy}', 'report', 'transfer-pricing', 'pdf', [6, 12]),
    t('Provisional tax IRP6 {sub} {year}', 'tax-return', 'irp6', 'pdf', [1, 1]),
    t('Tax computation {sub} {fy}', 'tax-computation', undefined, 'xlsx'),
    t('EMP501 reconciliation {sub} {year}', 'tax-return', 'emp501', 'pdf', [1, 2]),
  ],
  '3.5': [
    t('Bank statement {bank} {period}', 'bank-statement', undefined, 'pdf', [2, 4]),
    t('Facility agreement {bank} {year}', 'agreement', 'facility', 'pdf', [10, 15]),
    t('Hedging confirmation {period}', 'letter', 'hedge', 'pdf', [1, 2]),
    t('Cash flow forecast {period}', 'cashflow', undefined, 'xlsx'),
    t('Guarantee {bank} {cp}', 'agreement', 'guarantee', 'pdf', [2, 3]),
  ],
  '4': [
    t('Customer contract {cp}', 'agreement', 'customer', 'pdf', [6, 12]),
    t('Price list {seg} {year}', 'price-list', undefined, 'xlsx'),
    t('Tender submission {cp} {year}', 'report', 'tender', 'pdf', [5, 10]),
    t('Rebate agreement {cp} {year}', 'agreement', 'rebate', 'pdf', [3, 5]),
    t('Sales pipeline report {period}', 'pipeline', undefined, 'xlsx'),
    t('Customer satisfaction survey {year}', 'report', 'survey', 'pdf', [4, 8]),
    t('Service level report {cp} {period}', 'report', 'sla', 'pdf', [2, 4]),
    t('Key account plan {cp} {year}', 'report', 'key-account', 'docx', [3, 6]),
    t('Quarterly business review {cp} {period}', 'deck', 'qbr', 'pptx'),
    t('Transport services agreement {cp}', 'agreement', 'transport', 'pdf', [6, 12]),
  ],
  '5': [
    t('Organisation chart {sub} {year}', 'chart', 'org'),
    t('Payroll summary {period}', 'payroll', undefined, 'xlsx'),
    t('Headcount report {period}', 'headcount', undefined, 'xlsx'),
    t('Pension fund rules {sub}', 'policy', 'pension', 'pdf', [6, 10]),
    t('Medical aid scheme summary {year}', 'policy', 'medical', 'pdf', [2, 4]),
    t('Training plan {site} {year}', 'report', 'training', 'pdf', [3, 5]),
    t('Employment equity report {year}', 'report', 'equity', 'pdf', [4, 7]),
    t('Policy on {hrPolicy}', 'policy', 'hr', 'docx', [2, 5]),
    t('People update to the board {period}', 'deck', 'people', 'pptx'),
  ],
  '6': [
    t('IT asset register {year}', 'asset-register', undefined, 'xlsx'),
    t('Software licence {vendor}', 'agreement', 'licence', 'pdf', [5, 9]),
    t('Support agreement {vendor} {year}', 'agreement', 'support', 'pdf', [4, 8]),
    t('Disaster recovery plan {year}', 'report', 'recovery', 'pdf', [5, 9]),
    t('Penetration test report {year}', 'report', 'pentest', 'pdf', [5, 10]),
    t('IT policy on {itPolicy}', 'policy', 'it', 'docx', [2, 5]),
    t('Network diagram {site}', 'chart', 'network'),
    t('IT roadmap {year}', 'deck', 'it', 'pptx'),
  ],
  '7': [
    t('Title deed {site}', 'certificate', 'title-deed', 'pdf', [2, 4]),
    t('Valuation report {site} {year}', 'report', 'valuation', 'pdf', [6, 12]),
    t('Zoning certificate {site}', 'certificate', 'zoning'),
    t('Building plans {site}', 'chart', 'plans'),
    t('Occupation certificate {site}', 'certificate', 'occupation'),
    t('Rates clearance certificate {site} {year}', 'certificate', 'rates'),
    t('Fire compliance certificate {site} {year}', 'certificate', 'fire'),
  ],
  '8': [
    t('Insurance policy schedule {insurer} {year}', 'insurance-schedule', 'assets', 'pdf', [3, 6]),
    t('Claims history {insurer} {year}', 'claims', undefined, 'xlsx'),
    t('Broker letter {insurer} {year}', 'letter', 'broker', 'pdf', [1, 2]),
    t('Fleet insurance schedule {year}', 'insurance-schedule', 'fleet', 'pdf', [2, 4]),
  ],
  '9': [
    t('Water use licence {site}', 'permit', 'water', 'pdf', [3, 5]),
    t('Environmental audit report {site} {year}', 'report', 'env-audit', 'pdf', [6, 12]),
    t('Waste management licence {site}', 'permit', 'waste', 'pdf', [2, 4]),
    t('Air emission licence {site}', 'permit', 'air', 'pdf', [2, 4]),
    t('Environmental management programme {site}', 'report', 'emp', 'pdf', [5, 9]),
    t('Health, safety and environment update {period}', 'deck', 'hse', 'pptx'),
  ],
  '10': [
    t('Trade mark registration certificate {mark} class {cls}', 'certificate', 'trade-mark'),
    t('Patent specification {mark} {year}', 'report', 'patent', 'pdf', [4, 8]),
    t('Domain name register {year}', 'domains', undefined, 'xlsx'),
    t('Intellectual property assignment {cp}', 'agreement', 'ip-assignment', 'pdf', [3, 5]),
    t('Software source code escrow {vendor}', 'agreement', 'escrow', 'pdf', [4, 7]),
    t('Licence of trade mark {mark} to {sub}', 'agreement', 'tm-licence', 'pdf', [4, 7]),
  ],
  '11': [
    t('POPIA compliance assessment {year}', 'report', 'popia', 'pdf', [5, 9]),
    t('Privacy policy {year}', 'policy', 'privacy', 'pdf', [3, 6]),
    t('Data processing agreement {vendor}', 'agreement', 'dpa', 'pdf', [4, 7]),
    t('PAIA manual {year}', 'policy', 'paia', 'pdf', [5, 8]),
    t('Information officer registration {sub}', 'certificate', 'information-officer'),
  ],
};


export const SANDBOX_TREE: FolderSpec[] = [
  { ix: '1', name: 'Corporate', n: 30, drafts: 1 },
  { ix: '2', name: 'Legal', n: 66, kids: [
    { ix: '2.1', name: 'Constitutional documents', n: 8 }, { ix: '2.2', name: 'Litigation', n: 6 }, { ix: '2.3', name: 'Regulatory', n: 9 },
    { ix: '2.4', name: 'Material contracts', n: 13, drafts: 1 }, { ix: '2.5', name: 'Employment', n: 20, drafts: 1 }, { ix: '2.6', name: 'Property leases', n: 10, drafts: 1 }] },
  { ix: '3', name: 'Finance', n: 71, kids: [
    { ix: '3.1', name: 'Management accounts', n: 18, drafts: 1 }, { ix: '3.2', name: 'Audited financials', n: 7, drafts: 2 },
    { ix: '3.3', name: 'Budgets and forecasts', n: 10, drafts: 1 }, { ix: '3.4', name: 'Tax', n: 18, drafts: 2 }, { ix: '3.5', name: 'Treasury', n: 10, drafts: 3 }] },
  { ix: '4', name: 'Commercial', n: 56, drafts: 5 },
  { ix: '5', name: 'HR', n: 34, drafts: 2 },
  { ix: '6', name: 'IT', n: 18, drafts: 2, bidders: { a: 40, c: 20 } },
  { ix: '7', name: 'Property', n: 24, drafts: 1 },
  { ix: '8', name: 'Insurance', n: 10, drafts: 2, bidders: { a: 40 } },
  { ix: '9', name: 'Environmental', n: 10, drafts: 1, bidders: { a: 40, c: 20 } },
  { ix: '10', name: 'Intellectual property', n: 14, drafts: 2 },
  { ix: '11', name: 'Data protection', n: 9, drafts: 1, bidders: { a: 40, b: 20 } },
];

const SECOND_VERSIONS: Record<string, Status> = { '1.4': 'rev', '3.3.2': 'upd', '4.3': 'upd', '5.2': 'rev', '7.1': 'rev' };

const NAMED_PAGES: Record<string, number> = {
  '2.4.1': 12, '2.4.2': 14, '2.4.3': 6, '2.4.4': 10, '2.4.5': 9, '2.4.6': 3, '2.4.7': 15, '2.4.8': 8, '2.4.9': 11, '2.4.10': 9, '2.4.11': 8, '2.4.12': 10,
  '2.4.13': 12, '3.2.1': 13, '3.2.2': 15, '3.2.3': 4, '3.2.4': 6, '3.2.5': 2, '3.2.6': 14, '3.2.7': 4,
};


export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
export const seedOf = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;

function leaves(tree: FolderSpec[]): FolderSpec[] {
  return tree.flatMap((f) => (f.kids ? leaves(f.kids) : [f]));
}

function folderDocs(f: FolderSpec): RoomDoc[] {
  const r = rng(seedOf(`sandbox:${f.ix}`));
  const pick = <X>(xs: X[]) => xs[Math.floor(r() * xs.length)]!;
  const out: RoomDoc[] = [];
  const taken = new Set<string>();
  for (const row of NAMED[f.ix] ?? []) {
    // 'proc' becomes a draft that opens
    const status: Status = row[3] === 'proc' ? 'draft' : row[3];
    let kind: Kind = row[2] === 'xlsx' ? 'dev-table' : 'dev';
    let p: Params = {};
    if (row[0] === '3.2.7') {
      kind = 'letter';
      p = { as: 'auditor', fy: 'FY2023' };
    }
    out.push({
      ix: row[0], name: row[1], ext: row[2], status, date: row[5], uploader: row[6] ?? 'anika', kind, p, pages: NAMED_PAGES[row[0]] ?? 8,
    });
    taken.add(row[1]);
  }
  const drafts = (f.drafts ?? 0) - out.filter((d) => d.status === 'draft').length;
  const templates = TEMPLATES[f.ix] ?? [];
  const order = [...templates];
  for (let guard = 0; out.length < f.n; guard++) {
    if (guard > f.n * 60) throw new Error(`The sandbox catalogue cannot fill folder ${f.ix}.`);
    const tpl = order.length ? order.shift()! : pick(templates);
    const p: Params = {};
    const name = tpl.name.replace(/\{(\w+)\}/g, (_, k: string) => (p[k] = pick(WORDS[k]!)));
    if (taken.has(name)) continue;
    taken.add(name);
    if (tpl.as) p.as = tpl.as;
    const no = out.length + 1;
    const ix = `${f.ix}.${no}`;
    const draft = no > f.n - drafts;
    const [lo, hi] = tpl.pages ?? [1, 2];
    let date = D.thu12;
    if (!draft) date = r() < 0.8 ? D.tue3 : D.fri6;
    out.push({
      ix, name, ext: tpl.ext ?? 'pdf', status: draft ? 'draft' : SECOND_VERSIONS[ix] ?? 'pub',
      date, uploader: draft && f.ix.startsWith('3') ? 'maria' : 'anika',
      kind: tpl.kind, p, pages: lo + Math.floor(r() * (hi - lo + 1)),
    });
  }
  return out;
}

let cached: RoomDoc[] | null = null;

export function sandboxDocuments(): RoomDoc[] {
  cached ??= leaves(SANDBOX_TREE).flatMap(folderDocs);
  return cached;
}

export const SANDBOX_PLAN: RoomPlan = {
  tree: SANDBOX_TREE,
  rows: (f) => sandboxDocuments().filter((d) => d.ix.slice(0, d.ix.lastIndexOf('.')) === f.ix)
    .map((d): Row => [d.ix, d.name, d.ext, d.status, d.pages, d.date, d.uploader]),
  stableVersionIds: true,
};

export function neighbourDocuments(): RoomDoc[] {
  return (Object.keys(SELLERS) as NeighbourRoom[]).flatMap((room) => (MORE_ROOM_DOCUMENTS[room] ?? []).map((x, i): RoomDoc => ({
    ix: `1.${i + 1}`, name: x.name, ext: 'pdf', status: x.draft ? 'draft' : 'pub', date: new Date(x.at), uploader: 'anika', kind: 'neighbour',
    p: { seller: SELLERS[room], title: room === 'osprey' ? OSPREY_TOPICS[i % OSPREY_TOPICS.length]! : x.name }, pages: 6, room,
  })));
}

export const allSandboxDocuments = (): RoomDoc[] => [...sandboxDocuments(), ...neighbourDocuments()];

export const workspaceOf = (tenantId: string, d: RoomDoc): string => stableId(tenantId, d.room ? `workspace:${d.room}` : 'workspace');

/** must match seedDemo()'s stableVersionIds */
export const versionIdOf = (tenantId: string, d: RoomDoc, v: number): string =>
  stableId(tenantId, d.room ? `version:${d.room}:${d.ix}:${v}` : `version:${d.ix}:${v}`);

export const versionsOf = (d: RoomDoc): number[] => (d.status === 'upd' || d.status === 'rev' ? [1, 2] : [1]);
