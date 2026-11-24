// SPDX-License-Identifier: AGPL-3.0-only
// deterministic: same index, same bytes
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export type DocKind = 'contract' | 'addendum' | 'afs' | 'letter' | 'table';

export interface DevDocument {
  ix: string;
  title: string;
  kind: DocKind;
  fullPages: number;
  /** contracts only */
  counterparty?: string;
  heronIs?: string;
  otherIs?: string;
  quotes?: { under: string; text: string }[];
  table?: { columns: string[]; rows: string[][] };
}

const COC = 'CHANGE OF CONTROL';

export const DEV_DOCUMENTS: DevDocument[] = [
  { ix: '2.4.1', title: 'Master services agreement', kind: 'contract', fullPages: 38, counterparty: 'Kwelanet SA SOC Ltd', heronIs: 'Supplier', otherIs: 'Kwelanet',
    quotes: [
      { under: COC, text: "A change of control of the Supplier entitles Kwelanet to terminate this agreement on 90 days' written notice." },
      { under: COC, text: 'The Supplier notifies Kwelanet of any proposed change of control at least 30 days before it takes effect.' }] },
  { ix: '2.4.2', title: 'Supply agreement', kind: 'contract', fullPages: 42, counterparty: 'Tarnley Logistics (Pty) Ltd', heronIs: 'Drosvelt', otherIs: 'Tarnley',
    quotes: [
      { under: COC, text: "Should Drosvelt undergo a change of control, Drosvelt shall notify Tarnley in writing within 10 Business Days. Tarnley may terminate this Agreement on 60 days' written notice within 90 days of receiving such notice." },
      { under: 'GENERAL', text: "Neither party may assign this agreement, and a change of control counts as an assignment, without the other party's prior written consent." }] },
  { ix: '2.4.3', title: 'Addendum 2024 to the supply agreement', kind: 'addendum', fullPages: 6, counterparty: 'Tarnley Logistics (Pty) Ltd', heronIs: 'Drosvelt', otherIs: 'Tarnley' },
  { ix: '2.4.4', title: 'Distribution agreement', kind: 'contract', fullPages: 27, counterparty: 'Namvista Trade Distributors (Pty) Ltd', heronIs: 'Principal', otherIs: 'Distributor' },
  { ix: '2.4.5', title: 'Freight services agreement', kind: 'contract', fullPages: 19, counterparty: 'Tsamvo Freight (Pty) Ltd', heronIs: 'Customer', otherIs: 'Tsamvo',
    quotes: [{ under: 'PRICE AND PAYMENT', text: 'Freight rates are reviewed each year on 1 March in line with the fuel index in schedule 3.' }] },
  { ix: '2.4.6', title: 'Change of control consents tracker', kind: 'table', fullPages: 3, table: consentsTracker() },
  { ix: '2.4.7', title: 'Supply agreement', kind: 'contract', fullPages: 54, counterparty: 'Ombeli Chemicals, a division of Ombeli South Africa Ltd', heronIs: 'Buyer', otherIs: 'Ombeli',
    quotes: [
      { under: 'TERMINATION', text: 'Ombeli may end this agreement at once if a competitor of Ombeli acquires control of the Buyer.' },
      { under: 'PRICE AND PAYMENT', text: 'Prices are fixed in rand per tonne for the first 24 months of the supply term.' }] },
  { ix: '2.4.8', title: 'Agency agreement', kind: 'contract', fullPages: 12, counterparty: 'Kgatlo Trade Agencies (Pty) Ltd', heronIs: 'Principal', otherIs: 'Agent' },
  { ix: '2.4.9', title: 'Packaging supply agreement', kind: 'contract', fullPages: 33, counterparty: 'Paxenfold Ltd', heronIs: 'Customer', otherIs: 'Paxenfold',
    quotes: [{ under: 'DURATION', text: 'The supply term runs for five years from 1 July 2023 and renews for two years unless either party gives notice.' }] },
  { ix: '2.4.10', title: 'Warehouse services agreement', kind: 'contract', fullPages: 21, counterparty: 'Rostrand Logistics South Africa (Pty) Ltd', heronIs: 'Customer', otherIs: 'Provider' },
  { ix: '2.4.11', title: 'Software licence agreement Ledgerva Business One', kind: 'contract', fullPages: 16, counterparty: 'Ledgerva Africa (Pty) Ltd', heronIs: 'Licensee', otherIs: 'Ledgerva' },
  { ix: '2.4.12', title: 'Fleet lease agreement', kind: 'contract', fullPages: 24, counterparty: 'Lorrivan Africa (Pty) Ltd', heronIs: 'Lessee', otherIs: 'Lessor' },
  { ix: '2.4.13', title: 'Framework agreement', kind: 'contract', fullPages: 48, counterparty: 'Velarail SOC Ltd, acting through Velarail Freight Rail', heronIs: 'Operator', otherIs: 'Velarail',
    quotes: [{ under: COC, text: "A change of control of the Operator requires Velarail's written approval, not to be unreasonably withheld." }] },
  { ix: '3.2.1', title: 'Audited consolidated financial statements for the year ended 28 February 2021', kind: 'afs', fullPages: 64 },
  { ix: '3.2.2', title: 'Audited consolidated financial statements for the year ended 28 February 2022', kind: 'afs', fullPages: 66,
    quotes: [
      { under: "DIRECTORS' REPORT", text: 'Revenue grew by 11% to R1.84 billion, driven by the logistics and supply segments.' },
      { under: 'BORROWINGS', text: "The group's revolving credit facility includes a change of control clause that allows the lender to demand repayment." }] },
  { ix: '3.2.3', title: "Independent auditor's report for the year ended 28 February 2022", kind: 'letter', fullPages: 4 },
  { ix: '3.2.4', title: 'Management letter for the year ended 28 February 2022', kind: 'letter', fullPages: 11 },
  { ix: '3.2.5', title: 'Reconciliation to management accounts FY2022', kind: 'table', fullPages: 2, table: reconciliation() },
  { ix: '3.2.6', title: 'Audited consolidated financial statements for the year ended 28 February 2023', kind: 'afs', fullPages: 71 },
];

// kept short for fast dev builds; VDRKIT_DEV_FULL_PAGES=1 for full counts
export function pagesFor(d: DevDocument, full: boolean, version = 1): number {
  const n = d.fullPages + (version - 1);
  return full ? Math.max(n, 1) : Math.min(12, Math.max(3, n));
}


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
const seedOf = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);

export function spaceThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function quotesUnder(d: DevDocument, heading: string): string[] {
  return (d.quotes ?? []).filter((q) => q.under === heading).map((q) => q.text);
}

export type Block = { t: 'title'; text: string } | { t: 'center'; text: string; bold?: boolean } | { t: 'h'; text: string } | { t: 'p'; text: string }
  | { t: 'li'; text: string } | { t: 'table'; columns: string[]; rows: string[][]; widths?: number[] } | { t: 'gap' } | { t: 'break' };

const CLAUSES: Record<string, string[]> = {
  INTERPRETATION: [
    'In this Agreement, unless the context indicates otherwise, the words and expressions set out below have the meanings assigned to them and cognate expressions have corresponding meanings.',
    '"Business Day" means any day other than a Saturday, Sunday or official public holiday in the Republic of South Africa.',
    '"Commencement Date" means 1 March 2024, notwithstanding the Signature Date.',
    '"Group Company" means, in relation to a Party, any subsidiary or holding company of that Party and any subsidiary of such holding company.',
    'Headings are for convenience only and are not taken into account in interpreting this Agreement.',
  ],
  DURATION: [
    "This Agreement commences on the Commencement Date and endures for an initial period of 36 months, after which it continues until terminated by either Party on not less than 90 days' written notice.",
    'Either Party may propose a renewal on revised terms no later than six months before the end of the initial period.',
  ],
  'SCOPE AND ORDERS': [
    'The {other} shall provide the goods and services described in Annexure A at the delivery points listed in Annexure B.',
    'Each purchase order shall specify the quantity, delivery date and delivery point, and is binding once accepted in writing or by conduct.',
    'The {heron} may change a purchase order up to 72 hours before the agreed delivery time without cost.',
  ],
  'PRICE AND PAYMENT': [
    'The prices are set out in Annexure C and are exclusive of value-added tax.',
    'The {heron} shall pay each undisputed invoice within 45 days of the end of the month in which it is received.',
    'Interest on overdue amounts runs at the prime rate of Umbila Bank of South Africa Ltd plus 2% a year, calculated daily and compounded monthly.',
  ],
  'SERVICE LEVELS': [
    'The {other} shall meet the service levels in Annexure D in every calendar month.',
    'If a service level is missed in two consecutive months, the parties meet within 10 Business Days to agree a remedial plan.',
    'Service credits are the sole financial remedy for missed service levels, without affecting the right to terminate for material breach.',
  ],
  [COC]: [
    'Each Party shall notify the other in writing of any change of control within 10 Business Days of it taking effect.',
  ],
  WARRANTIES: [
    'Each Party warrants that it has full power and authority to enter into and perform this Agreement.',
    'The {other} warrants that the goods comply with their specifications and are free from defects in material and workmanship for 12 months from delivery.',
  ],
  LIABILITY: [
    'Neither Party is liable for any indirect or consequential loss, including loss of profit, howsoever arising.',
    "The total liability of either Party in any contract year is limited to the fees paid or payable in that year, except for liability arising from fraud, wilful misconduct or a breach of clause on confidentiality.",
  ],
  INSURANCE: [
    'The {other} shall maintain public liability insurance of at least R50 million for each event, and goods-in-transit insurance for the full replacement value of the goods.',
  ],
  CONFIDENTIALITY: [
    'Each Party shall keep the terms of this Agreement and all information received from the other Party confidential and use it only to perform this Agreement.',
    'This clause survives the end of this Agreement for five years.',
  ],
  TERMINATION: [
    "Either Party may terminate this Agreement on written notice if the other Party commits a material breach and fails to remedy it within 30 days of written notice requiring it to do so.",
    'Either Party may terminate this Agreement at once if the other Party is placed in business rescue, liquidation or under judicial management.',
  ],
  'DISPUTE RESOLUTION': [
    'A dispute is first referred to the chief executives of the Parties, who meet within 10 Business Days to try to resolve it.',
    'A dispute not resolved within 30 days is referred to arbitration in Johannesburg under the rules of the Arbitration Foundation of Southern Africa.',
  ],
  'FORCE MAJEURE': [
    'Neither Party is liable for a failure to perform caused by an event beyond its reasonable control, provided that it notifies the other Party promptly and takes reasonable steps to limit the effect.',
  ],
  NOTICES: [
    'Notices are given in writing and delivered by hand or sent by email to the addresses in Annexure E.',
  ],
  GENERAL: [
    'This Agreement is the whole agreement between the Parties on its subject matter.',
    'No variation of this Agreement is of any force unless reduced to writing and signed by both Parties.',
    'This Agreement is governed by the laws of the Republic of South Africa.',
  ],
};
const SECTION_ORDER = ['INTERPRETATION', 'DURATION', 'SCOPE AND ORDERS', 'PRICE AND PAYMENT', 'SERVICE LEVELS', COC, 'WARRANTIES', 'LIABILITY',
  'INSURANCE', 'CONFIDENTIALITY', 'TERMINATION', 'DISPUTE RESOLUTION', 'FORCE MAJEURE', 'NOTICES', 'GENERAL'];

function* contract(d: DevDocument, version: number): Generator<Block> {
  const r = rng(seedOf(d.ix));
  // Roles take "the" (the Supplier), names do not (Tarnley).
  const ROLES = new Set(['Supplier', 'Customer', 'Buyer', 'Principal', 'Distributor', 'Agent', 'Provider', 'Licensee', 'Lessee', 'Lessor', 'Operator']);
  const who = (k: string) => (k === 'heron' ? d.heronIs ?? 'Drosvelt' : d.otherIs ?? 'Counterparty');
  const fill = (s: string) => s.replace(/The \{(heron|other)\}/g, (_, k: string) => (ROLES.has(who(k)) ? `The ${who(k)}` : who(k)))
    .replace(/\{(heron|other)\}/g, (_, k: string) => who(k));
  yield { t: 'title', text: d.title.toUpperCase() };
  yield { t: 'center', text: 'between' };
  yield { t: 'center', text: 'DROSVELT HOLDINGS (PTY) LTD', bold: true };
  yield { t: 'center', text: 'Registration number 2009/014522/07' };
  yield { t: 'center', text: `("${d.heronIs ?? 'Drosvelt'}")` };
  yield { t: 'center', text: 'and' };
  yield { t: 'center', text: (d.counterparty ?? 'Counterparty').toUpperCase(), bold: true };
  yield { t: 'center', text: `Registration number ${2000 + Math.floor(r() * 15)}/0${Math.floor(100000 + r() * 899999)}/07` };
  yield { t: 'center', text: `("${d.otherIs ?? 'Counterparty'}")` };
  if (version > 1) yield { t: 'center', text: `Version ${version}, updated for release review` };
  yield { t: 'gap' };
  let n = 0;
  for (const name of SECTION_ORDER) {
    n++;
    yield { t: 'h', text: `${n}. ${name}` };
    const body = [...CLAUSES[name]!.map(fill), ...quotesUnder(d, name)];
    let k = 0;
    for (let i = 0; i < body.length; i++) {
      const text = body[i]!;
      const no = name === 'INTERPRETATION' && i >= 1 && i <= 3 ? `1.1.${i}` : `${n}.${++k}`;
      yield { t: 'p', text: `${no} ${text}` };
    }
  }
  n++;
  yield { t: 'h', text: `${n}. SIGNATURES` };
  yield { t: 'p', text: `Signed at Johannesburg on behalf of Drosvelt Holdings (Pty) Ltd by its chief executive, who warrants that he is authorised to do so.` };
  yield { t: 'p', text: `Signed at Johannesburg on behalf of ${d.counterparty ?? 'the counterparty'} by its duly authorised representative.` };
  const sites = ['Germiston', 'Isando', 'Durban harbour', 'Cape Town Montague Gardens', 'Gqeberha', 'Polokwane', 'Bloemfontein', 'Walvis Bay', 'Gaborone', 'Midrand'];
  for (let a = 0; ; a++) {
    const letter = String.fromCharCode(65 + (a % 26));
    yield { t: 'h', text: `ANNEXURE ${letter}${a >= 26 ? a : ''}: ${['PRODUCTS AND SERVICES', 'DELIVERY POINTS', 'PRICES', 'SERVICE LEVELS', 'NOTICE ADDRESSES'][a % 5]}` };
    const rows: string[][] = [];
    for (let i = 0; i < 14; i++) {
      rows.push([`${letter}.${i + 1}`, `${sites[Math.floor(r() * sites.length)]} ${['pallet', 'bulk', 'crated', 'chilled', 'ambient'][Math.floor(r() * 5)]} line`,
        `R ${spaceThousands((1000 + r() * 90000).toFixed(2))}`, `${Math.floor(2 + r() * 40)} days`]);
    }
    yield { t: 'table', columns: ['Item', 'Description', 'Price excl. VAT', 'Lead time'], rows, widths: [0.12, 0.48, 0.22, 0.18] };
  }
}

function* addendum(d: DevDocument, version: number): Generator<Block> {
  yield { t: 'title', text: 'ADDENDUM 2024' };
  yield { t: 'center', text: 'to the supply agreement between' };
  yield { t: 'center', text: 'DROSVELT HOLDINGS (PTY) LTD', bold: true };
  yield { t: 'center', text: 'and' };
  yield { t: 'center', text: 'TARNLEY LOGISTICS (PTY) LTD', bold: true };
  if (version > 1) yield { t: 'center', text: `Version ${version}: revised prices in clause 3 and a new annexure F` };
  yield { t: 'gap' };
  yield { t: 'h', text: '1. BACKGROUND' };
  yield { t: 'p', text: '1.1 The Parties entered into a supply agreement on 14 February 2024 (the "Agreement").' };
  yield { t: 'p', text: '1.2 The Parties wish to amend the Agreement as set out in this addendum with effect from 1 July 2024.' };
  yield { t: 'h', text: '2. AMENDMENTS' };
  yield { t: 'p', text: '2.1 Clause 2.1 of the Agreement is amended so that the initial period is 48 months instead of 36 months.' };
  yield { t: 'p', text: '2.2 Clause 5.1 of the Agreement is replaced by: "Should Drosvelt undergo a change of control, Drosvelt shall notify Tarnley in writing within 10 Business Days, and Tarnley may terminate this Agreement on 90 days\' written notice."' };
  yield { t: 'h', text: '3. PRICES' };
  yield { t: 'p', text: `3.1 The prices in Annexure C increase by ${version > 1 ? '6.5' : '5.5'}% from 1 July 2024 and thereafter on 1 July each year by the consumer price index.` };
  yield { t: 'h', text: '4. GENERAL' };
  yield { t: 'p', text: '4.1 Except as amended by this addendum, the Agreement remains in full force and effect.' };
  yield* contract({ ...d, title: 'Schedules to the addendum' }, version);
}

function* afs(d: DevDocument): Generator<Block> {
  const r = rng(seedOf(d.ix));
  const fy = Number(/(\d{4})/.exec(d.title)?.[1] ?? 2022);
  const money = (x: number) => spaceThousands(x.toFixed(0));
  yield { t: 'title', text: 'DROSVELT HOLDINGS (PTY) LTD AND ITS SUBSIDIARIES' };
  yield { t: 'center', text: 'Registration number 2009/014522/07' };
  yield { t: 'center', text: d.title, bold: true };
  yield { t: 'gap' };
  yield { t: 'h', text: 'CONTENTS' };
  for (const [i, c] of ["Directors' responsibilities and approval", "Independent auditor's report", "Directors' report", 'Statement of financial position',
    'Statement of profit or loss and other comprehensive income', 'Statement of cash flows', 'Notes to the financial statements'].entries()) {
    yield { t: 'p', text: `${c} ${'.'.repeat(40)} ${3 + i * 2}` };
  }
  yield { t: 'h', text: "DIRECTORS' RESPONSIBILITIES AND APPROVAL" };
  yield { t: 'p', text: 'The directors are required by the Companies Act 71 of 2008 to maintain adequate accounting records and are responsible for the content and integrity of the consolidated financial statements.' };
  yield { t: 'p', text: 'The financial statements are prepared in accordance with International Financial Reporting Standards and are based on appropriate accounting policies consistently applied.' };
  yield { t: 'h', text: "INDEPENDENT AUDITOR'S REPORT" };
  yield { t: 'p', text: `We have audited the consolidated financial statements of Drosvelt Holdings (Pty) Ltd and its subsidiaries for the year ended 28 February ${fy}. In our opinion they present fairly, in all material respects, the consolidated financial position of the group.` };
  yield { t: 'h', text: "DIRECTORS' REPORT" };
  yield { t: 'p', text: 'The group provides warehousing, transport and supply chain services to retail, FMCG and chemicals customers in South Africa, Namibia and Botswana.' };
  for (const q of quotesUnder(d, "DIRECTORS' REPORT")) yield { t: 'p', text: q };
  const rev = 1500 + (fy - 2020) * 170 + r() * 40;
  const line = (label: string, x: number) => [label, money(x * 1000), money(x * 1000 * (0.88 + r() * 0.08))];
  const statement = (rows: string[][]): Block => ({ t: 'table', columns: ['R thousand', String(fy), String(fy - 1)], widths: [0.56, 0.22, 0.22], rows });
  yield { t: 'h', text: 'STATEMENT OF FINANCIAL POSITION' };
  yield statement([
    line('Property, plant and equipment', rev * 0.42), line('Right-of-use assets', rev * 0.18), line('Intangible assets', rev * 0.05),
    line('Inventories', rev * 0.07), line('Trade and other receivables', rev * 0.21), line('Cash and cash equivalents', rev * 0.06),
    line('Total assets', rev * 0.99), line('Share capital', rev * 0.02), line('Retained earnings', rev * 0.38),
    line('Borrowings', rev * 0.24), line('Lease liabilities', rev * 0.19), line('Trade and other payables', rev * 0.16), line('Total equity and liabilities', rev * 0.99)]);
  yield { t: 'h', text: 'STATEMENT OF PROFIT OR LOSS AND OTHER COMPREHENSIVE INCOME' };
  yield statement([
    line('Revenue', rev), line('Cost of sales', rev * 0.71), line('Gross profit', rev * 0.29), line('Operating expenses', rev * 0.17),
    line('Operating profit', rev * 0.12), line('Finance costs', rev * 0.03), line('Profit before tax', rev * 0.09), line('Income tax', rev * 0.025), line('Profit for the year', rev * 0.065)]);
  yield { t: 'h', text: 'STATEMENT OF CASH FLOWS' };
  yield statement([
    line('Cash generated from operations', rev * 0.15), line('Interest paid', rev * 0.03), line('Tax paid', rev * 0.024),
    line('Capital expenditure', rev * 0.08), line('Repayment of borrowings', rev * 0.02), line('Lease payments', rev * 0.04)]);
  const notes = ['ACCOUNTING POLICIES', 'REVENUE', 'PROPERTY, PLANT AND EQUIPMENT', 'LEASES', 'INVENTORIES', 'TRADE AND OTHER RECEIVABLES', 'BORROWINGS',
    'RELATED PARTIES', 'EVENTS AFTER THE REPORTING DATE', 'GOING CONCERN'];
  const texts: Record<string, string[]> = {
    'ACCOUNTING POLICIES': ['The financial statements are prepared on the historical cost basis, except for derivative financial instruments measured at fair value.'],
    REVENUE: ['Revenue from transport and warehousing is recognised over time as the services are rendered. Revenue from the sale of goods is recognised when control passes on delivery.'],
    'PROPERTY, PLANT AND EQUIPMENT': ['Vehicles are depreciated over five to eight years and warehouse equipment over ten years, on the straight-line basis to their residual values.'],
    LEASES: ['The group leases warehouses at Germiston, Isando and Durban harbour, and part of its fleet. Lease liabilities are measured at the present value of the remaining payments.'],
    INVENTORIES: ['Inventories are measured at the lower of cost and net realisable value. Cost is determined on the first-in, first-out basis.'],
    'TRADE AND OTHER RECEIVABLES': ['The expected credit loss allowance is based on the age of each balance and the payment history of each customer.'],
    BORROWINGS: ['The group has a revolving credit facility of R400 million with Umbila Bank of South Africa Ltd, maturing in 2027 and secured over the shares of the operating subsidiaries.'],
    'RELATED PARTIES': ['Transactions with related parties are concluded at arm\'s length. Key management personnel are the directors and the executive committee.'],
    'EVENTS AFTER THE REPORTING DATE': ['The directors are not aware of any material event after the reporting date that would require adjustment of the financial statements.'],
    'GOING CONCERN': ['The directors have assessed the group\'s ability to continue as a going concern and believe that it has adequate resources to continue in operation for the foreseeable future.'],
  };
  for (let round = 0; ; round++) {
    for (const [i, h] of notes.entries()) {
      const no = round * notes.length + i + 1;
      yield { t: 'h', text: `NOTE ${no}: ${h}` };
      for (const tx of texts[h]!) yield { t: 'p', text: tx };
      if (round === 0) for (const q of quotesUnder(d, h)) yield { t: 'p', text: q };
      const label = `${h.charAt(0)}${h.slice(1).toLowerCase()}`;
      yield statement(Array.from({ length: 5 }, (_, k) => line(`${label} item ${k + 1}`, rev * (0.01 + r() * 0.05))));
    }
  }
}

function* letter(d: DevDocument): Generator<Block> {
  const auditor = d.title.startsWith('Independent');
  yield { t: 'title', text: d.title.toUpperCase() };
  yield { t: 'center', text: 'To the shareholders and directors of Drosvelt Holdings (Pty) Ltd' };
  yield { t: 'gap' };
  const sections = auditor
    ? ['OPINION', 'BASIS FOR OPINION', 'KEY AUDIT MATTERS', 'OTHER INFORMATION', "RESPONSIBILITIES OF THE DIRECTORS", "AUDITOR'S RESPONSIBILITIES"]
    : ['PURPOSE OF THIS LETTER', 'REVENUE RECOGNITION', 'INVENTORY COUNTS', 'IT GENERAL CONTROLS', 'PAYROLL', 'LEASES', 'TAX'];
  const body: Record<string, string> = {
    OPINION: 'In our opinion, the consolidated financial statements present fairly, in all material respects, the consolidated financial position of Drosvelt Holdings (Pty) Ltd at 28 February 2022.',
    'BASIS FOR OPINION': 'We conducted our audit in accordance with International Standards on Auditing. We are independent of the group in accordance with the IRBA Code.',
    'KEY AUDIT MATTERS': 'Revenue from long-term logistics contracts and the measurement of lease liabilities were the matters of most significance in our audit.',
  };
  for (let round = 0; ; round++) {
    for (const [i, h] of sections.entries()) {
      yield { t: 'h', text: `${round * sections.length + i + 1}. ${h}` };
      yield { t: 'p', text: body[h] ?? `Our observations on ${h.toLowerCase()} are set out below, with management's response and the agreed date for each action.` };
      yield { t: 'p', text: 'Finding: the control operated as designed for most of the year, but evidence of review was missing for three of the 25 items tested.' };
      yield { t: 'p', text: 'Recommendation: the reviewer signs and dates each reconciliation, and exceptions are followed up within five working days.' };
      yield { t: 'p', text: 'Management response: agreed. The finance director will confirm the change to the audit committee by 30 June.' };
    }
  }
}

function* table(d: DevDocument): Generator<Block> {
  yield { t: 'title', text: d.title.toUpperCase() };
  yield { t: 'center', text: 'Drosvelt Holdings (Pty) Ltd · converted from the spreadsheet for viewing' };
  yield { t: 'gap' };
  const tb = d.table!;
  for (let i = 0; ; i += 14) {
    const rows = tb.rows.slice(i % tb.rows.length, (i % tb.rows.length) + 14);
    yield { t: 'table', columns: tb.columns, rows: rows.length ? rows : tb.rows.slice(0, 14) };
  }
}

function consentsTracker(): DevDocument['table'] {
  const r = rng(24);
  const cps = ['Kwelanet SA', 'Tarnley Logistics', 'Namvista Trade', 'Tsamvo Freight', 'Ombeli Chemicals', 'Kgatlo Trade', 'Paxenfold', 'Rostrand Logistics', 'Ledgerva Africa',
    'Lorrivan Africa', 'Velarail Freight Rail', 'Grocevia', 'Tuisvra', 'Calloway & Vine', 'Quenlo Brands', 'Melkvale', 'Korrelberg Foods', 'Grootmark', 'Hoekwinkel Group', 'Lumvera South Africa',
    'Umbila Bank', 'Stenvolk Properties', 'Marravel Property'];
  return {
    columns: ['Contract', 'Counterparty', 'Clause', 'Consent needed', 'Consent requested', 'Consent received'],
    rows: cps.map((c, i) => {
      const needed = r() < 0.7;
      const asked = needed && r() < 0.7;
      return [i < 13 ? `2.4.${i + 1}` : `4.${i - 12}`, c, `${Math.floor(5 + r() * 25)}.${Math.floor(1 + r() * 4)}`, needed ? 'Yes' : 'No',
        asked ? `${Math.floor(2 + r() * 9)} Nov 2026` : '', asked && r() < 0.5 ? `${Math.floor(10 + r() * 3)} Nov 2026` : ''];
    }),
  };
}

function reconciliation(): DevDocument['table'] {
  const r = rng(325);
  const items = ['Revenue', 'Cost of sales', 'Gross profit', 'Staff costs', 'Depreciation', 'IFRS 16 lease adjustment', 'Other operating expenses', 'Operating profit',
    'Finance costs', 'Profit before tax', 'Income tax', 'Profit for the year', 'Inventories', 'Trade receivables', 'Trade payables', 'Borrowings'];
  return {
    columns: ['Line item', 'Management accounts', 'Audited', 'Difference', 'Explanation'],
    rows: items.map((it) => {
      const m = 10_000 + r() * 1_800_000;
      const a = m * (0.98 + r() * 0.04);
      const f = (x: number) => spaceThousands(x.toFixed(0));
      return [it, f(m), f(a), f(a - m), Math.abs(a - m) > m * 0.01 ? 'Year-end audit adjustment' : 'Rounding'];
    }),
  };
}


const A4: [number, number] = [595.28, 841.89];
const MARGIN = 64;

export function blocksOf(d: DevDocument, version = 1): Generator<Block> {
  switch (d.kind) {
    case 'contract': return contract(d, version);
    case 'addendum': return addendum(d, version);
    case 'afs': return afs(d);
    case 'letter': return letter(d);
    default: return table(d);
  }
}

export async function renderPdf(d: DevDocument, pages: number, version = 1): Promise<Buffer> {
  return (await layoutPdf(blocksOf(d, version), { title: `${d.ix} ${d.title}`, pages, landscape: d.kind === 'table' })).pdf;
}

export interface LayoutOptions {
  title: string;
  pages: number;
  landscape?: boolean;
  header?: string;
}

export async function layoutPdf(blocks: Iterable<Block>, o: LayoutOptions): Promise<{ pdf: Buffer; used: Block[]; pages: number }> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(o.title);
  pdf.setProducer('VDRkit development seed');
  pdf.setCreator('VDRkit development seed');
  pdf.setCreationDate(new Date('2026-11-03T07:30:00Z'));
  pdf.setModificationDate(new Date('2026-11-03T07:30:00Z'));
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const [W, H] = o.landscape ? [A4[1], A4[0]] : A4;
  const width = W - 2 * MARGIN;
  const pages = Math.max(1, o.pages);
  const used: Block[] = [];
  // standard fonts are WinAnsi only, anything else throws
  const safe = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7e\xa0-\xff\u2022]/g, ' ');

  let page: PDFPage | null = null;
  let y = 0;
  let done = 0;
  const newPage = () => {
    if (done >= pages) return false;
    page = pdf.addPage([W, H]);
    done++;
    // not the title, or every page matches a search for it
    page.drawText(safe(o.header ?? 'Confidential'), { x: MARGIN, y: H - 36, size: 7.5, font: sans, color: rgb(0.45, 0.48, 0.52) });
    y = H - MARGIN - 8;
    return true;
  };
  const wrap = (text: string, font: PDFFont, size: number, max: number) => {
    const out: string[] = [];
    let line = '';
    for (const word of safe(text).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > max && line) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  let full = false;
  const need = (h: number) => {
    if (page && y - h >= MARGIN) return true;
    if (newPage()) return true;
    full = true;
    return false;
  };
  const lastPage = () => done >= pages;

  newPage();
  const it = blocks[Symbol.iterator]();
  while (!full) {
    const next = it.next();
    if (next.done) break;
    const b = next.value;
    if (b.t === 'gap') { y -= 14; used.push(b); continue; }
    if (b.t === 'break') {
      if (!newPage()) { full = true; break; }
      used.push(b);
      continue;
    }
    if (b.t === 'title' || b.t === 'center') {
      const font = b.t === 'title' || (b.t === 'center' && b.bold) ? serifBold : serif;
      const size = b.t === 'title' ? 15 : 11;
      const lines = wrap(b.text, font, size, width);
      if (lastPage() && y - lines.length * (size + 6) < MARGIN) { full = true; break; }
      used.push(b);
      for (const ln of lines) {
        if (!need(size + 6)) break;
        const w = font.widthOfTextAtSize(ln, size);
        page!.drawText(ln, { x: (W - w) / 2, y, size, font });
        y -= size + 6;
      }
      if (b.t === 'title') y -= 8;
    } else if (b.t === 'h') {
      if (!need(40)) break;
      used.push(b);
      y -= 8;
      for (const ln of wrap(b.text, serifBold, 11, width)) {
        page!.drawText(ln, { x: MARGIN, y, size: 11, font: serifBold });
        y -= 15;
      }
      y -= 3;
    } else if (b.t === 'p' || b.t === 'li') {
      const indent = b.t === 'li' ? 14 : 0;
      const lines = wrap(b.text, serif, 10.5, width - indent);
      if (lastPage() && y - lines.length * 14.5 < MARGIN) { full = true; break; }
      used.push(b);
      lines.forEach((ln, i) => {
        if (!need(15)) return;
        if (b.t === 'li' && i === 0) page!.drawText('\u2022', { x: MARGIN + 3, y, size: 10.5, font: serif });
        page!.drawText(ln, { x: MARGIN + indent, y, size: 10.5, font: serif });
        y -= 14.5;
      });
      y -= b.t === 'li' ? 2 : 5;
    } else if (b.t === 'table') {
      const widths = b.widths ?? b.columns.map(() => 1 / b.columns.length);
      const drawRow = (cells: string[], bold: boolean) => {
        const font = bold ? serifBold : serif;
        const lines = cells.map((c, i) => wrap(c, font, 9.5, widths[i]! * width - 6).map((ln) => {
          let s = ln;
          while (s && font.widthOfTextAtSize(s, 9.5) > widths[i]! * width - 6) s = s.slice(0, -1);
          return s;
        }));
        const extra = (Math.max(1, ...lines.map((l) => l.length)) - 1) * 11.5;
        if (!need(16 + extra)) return false;
        let x = MARGIN;
        lines.forEach((ls, i) => {
          ls.forEach((s, k) => page!.drawText(s, { x, y: y - k * 11.5, size: 9.5, font }));
          x += widths[i]! * width;
        });
        y -= 4 + extra;
        page!.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + width, y }, thickness: 0.4, color: rgb(0.8, 0.82, 0.85) });
        y -= 11;
        return true;
      };
      if (!drawRow(b.columns, true)) break;
      const rows: string[][] = [];
      for (const row of b.rows) {
        if (!drawRow(row, false)) break;
        rows.push(row);
      }
      used.push(rows.length === b.rows.length ? b : { ...b, rows });
      y -= 10;
    }
  }
  const all = pdf.getPages();
  all.forEach((pg, i) => pg.drawText(`Page ${i + 1} of ${all.length}`, { x: W / 2 - 24, y: 30, size: 8, font: sans, color: rgb(0.45, 0.48, 0.52) }));
  return { pdf: Buffer.from(await pdf.save({ useObjectStreams: false })), used, pages: all.length };
}
