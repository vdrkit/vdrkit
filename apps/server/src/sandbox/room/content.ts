// SPDX-License-Identifier: AGPL-3.0-only
// all names invented
import { DEV_DOCUMENTS, blocksOf, spaceThousands, type Block } from '../../demo/documents.js';
import type { Cell, Sheet, Slide } from './ooxml.js';
import { MONTHS, rng, seedOf, WORDS, type Params, type RoomDoc } from './catalogue.js';

export type Content = { blocks: Iterable<Block>; landscape?: boolean } | { sheets: Sheet[] } | { slides: Slide[] };

interface Ctx {
  d: RoomDoc;
  v: number;
  p: Params;
  r: () => number;
  /** 0 to 11 */
  year: number;
  month: number;
}


const HOLDCO = 'Drosvelt Holdings (Pty) Ltd';
const HOLDCO_REG = '2009/014522/07';
const P = {
  chair: 'Dawid Pretorius', ceo: 'Gideon Marais', cfo: 'Liesl van Wyk', fd: 'Johan Steyn', fm: 'Maria Botha', cosec: 'Nomvula Dlamini',
  hr: 'Busisiwe Ntuli', it: 'Kobus Erasmus', ops: 'Rajesh Naidoo', ned1: 'Farah Patel', ned2: 'Hendrik Visagie', sales: 'Lerato Mokoena',
  fleet: 'Sizwe Khumalo',
};
const ADVISERS = {
  auditor: 'Hartwell Mensah Inc.', lawyers: 'Kestwick Vanloo Attorneys', tax: 'Morrowdene Tax Partners', valuer: 'Ridgeholt Property Valuers',
  env: 'Groenkraal Environmental Consulting', pentest: 'Ironvale Cyber Assurance', broker: 'Cartwright Abbey Brokers', corporate: 'Quillmont Advisory',
};
const FIRST = ['Ayanda', 'Bongani', 'Charlene', 'Deon', 'Elmarie', 'Fikile', 'Gerhard', 'Hlengiwe', 'Ivan', 'Johanna', 'Kagiso', 'Mpho', 'Nadia', 'Oupa',
  'Precious', 'Quinton', 'Refilwe', 'Stefan', 'Tumi', 'Ursula', 'Vusi', 'Wilma', 'Xolani', 'Yusuf', 'Zanele'];
const LAST = ['Botes', 'Cele', 'Daniels', 'Ferreira', 'Govender', 'Hlophe', 'Jacobs', 'Kruger', 'Louw', 'Nkosi', 'Olivier', 'Radebe', 'Smit', 'Tshabalala',
  'Uys', 'Vermeulen', 'Wessels', 'Zwane', 'Moodley', 'Naicker', 'Coetzee', 'Mokwena'];
const STREETS = ['Steenbok', 'Kraaibos', 'Witpeer', 'Kwartel', 'Rooibok', 'Bergvlei', 'Silwerboom', 'Tarentaal', 'Mopanie', 'Kiepersol', 'Blinkblaar', 'Suikerbos'];
const ROUTES = ['Germiston to Durban harbour', 'Isando to Cape Town', 'Durban harbour to Polokwane', 'Germiston to Bloemfontein', 'Walvis Bay to Gaborone',
  'Midrand to Gqeberha', 'Isando to Walvis Bay', 'Cape Town to Gqeberha', 'Germiston to Gaborone', 'Durban harbour to Midrand'];
const PRODUCTS = ['Ambient warehousing per pallet per week', 'Chilled storage per pallet per week', 'Frozen storage per pallet per week', 'Pallet handling in and out',
  'Case picking per case', 'Full truckload, 34-ton interlink', 'Less than truckload per pallet', 'Cross-dock per pallet', 'Labelling and repacking per unit',
  'Hazardous goods storage per pallet per week', 'Container destuffing per 40-foot container', 'Returns processing per pallet'];

const fmt = (x: number, dp = 0) => {
  const [i, f] = Math.abs(x).toFixed(dp).split('.');
  return `${x < 0 ? '-' : ''}${spaceThousands(i!)}${f ? `.${f}` : ''}`;
};
const R = (x: number, dp = 0) => `R ${fmt(x, dp)}`;
const rm = (x: number) => `R${(x / 1e6).toFixed(1)} million`;
const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`;
const day = (y: number, m: number, d: number) => `${d} ${MONTHS[m]} ${y}`;

function ctxOf(d: RoomDoc, v: number): Ctx {
  const p = d.p;
  let year = 2025;
  let month = 2;
  if (p.period) { const [m, y] = p.period.split(' '); month = MONTHS.indexOf(m!); year = Number(y); }
  else if (p.year) { year = Number(p.year); month = year === 2026 ? 3 + (seedOf(d.ix) % 6) : seedOf(d.ix) % 12; }
  else if (p.fy) { year = Number(p.fy.slice(2)); month = 1; }
  return { d, v, p, r: rng(seedOf(`${d.ix}:content`)), year, month };
}

function helpers(c: Ctx) {
  const { r } = c;
  const pick = <X>(xs: readonly X[]) => xs[Math.floor(r() * xs.length)]!;
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const num = (a: number, b: number) => a + r() * (b - a);
  const person = () => `${pick(FIRST)} ${pick(LAST)}`;
  const date = (y = c.year, m = c.month) => day(y, m, int(2, 27));
  const address = (place: string) => `${int(2, 140)} ${pick(STREETS)} ${pick(['Road', 'Street', 'Avenue', 'Drive'])}, ${place}`;
  const reg = (name: string) => `${2000 + (seedOf(name) % 18)}/${String(100000 + (seedOf(`${name}:reg`) % 899999)).padStart(6, '0')}/07`;
  return { r, pick, int, num, person, date, address, reg };
}

const legal = (name: string) => (/\b(Ltd|Inc\.|SOC)\b/.test(name) ? name : `${name} (Pty) Ltd`);
const subLegal = (sub?: string) => legal(sub ?? 'Drosvelt Holdings');

// Agreements

interface Annex { h: string; columns: string[]; rows: string[][]; widths?: number[] }

interface AgreementSpec {
  title: string;
  us: [string, string];
  them: [string, string];
  sections: [string, string[]][];
  annex?: () => Annex | Annex[];
  coc?: string;
}

function agreementSpec(c: Ctx): AgreementSpec {
  const h = helpers(c);
  const { p } = c;
  const cp = p.cp ? legal(p.cp) : '';
  const site = p.site ?? h.pick(WORDS.site!);
  const start = day(c.year, h.int(0, 11), 1);
  const term = h.pick([24, 36, 48, 60]);
  const routes = () => ({ h: 'RATES PER ROUTE', columns: ['Route', 'Rate per load', 'Fuel base (R/litre)', 'Transit'], widths: [0.46, 0.2, 0.2, 0.14],
    rows: Array.from({ length: 12 }, () => [h.pick(ROUTES), R(h.int(14, 68) * 1000), h.num(19, 24).toFixed(2), `${h.int(1, 4)} days`]) });
  const products = () => ({ h: 'PRICES', columns: ['Service', 'Unit price excl. VAT', 'Minimum per month'], widths: [0.55, 0.22, 0.23],
    rows: Array.from({ length: 12 }, (_, i) => [PRODUCTS[i % PRODUCTS.length]!, R(h.num(8, 950), 2), R(h.int(20, 400) * 1000)]) });
  const common: [string, string[]][] = [
    ['WARRANTIES', ['Each Party warrants that it has full power and authority to enter into and perform this Agreement, and that doing so breaches no other agreement binding on it.',
      'Each Party warrants that it holds, and will keep, every licence and permit it needs to perform this Agreement.']],
    ['BREACH', ['If a Party breaches this Agreement and fails to remedy the breach within 14 days of written notice requiring it to do so, the other Party may claim specific performance or cancel this Agreement, in either case with damages.',
      'A breach is material if it would entitle a reasonable party to cancel.']],
    ['TERMINATION', ['Either Party may terminate this Agreement at once if the other Party is placed in business rescue, liquidation or under judicial management, or compromises with its creditors.',
      'On termination each Party returns the property and information of the other Party, and the Provider hands over the goods in its care against payment of all amounts due.']],
    ['FORCE MAJEURE', ['Neither Party is liable for a failure to perform caused by an event beyond its reasonable control, such as flood, civil unrest, strike action at a port or a national grid failure, provided that it notifies the other Party promptly and takes reasonable steps to limit the effect.',
      'If the event lasts longer than 60 days, either Party may terminate this Agreement on written notice.']],
    ['CONFIDENTIALITY', ['Each Party shall keep the terms of this Agreement and all information received from the other Party confidential and use it only to perform this Agreement.',
      'This clause survives the end of this Agreement for five years.']],
    ['DISPUTE RESOLUTION', ['A dispute is first referred to the chief executives of the Parties, who meet within 10 Business Days to try to resolve it.',
      'A dispute not resolved within 30 days is referred to arbitration in Johannesburg under the rules of the Arbitration Foundation of Southern Africa.']],
    ['NOTICES', ['The Parties choose the addresses in the annexure for notices and legal process. A notice sent by email is presumed received on the next Business Day.']],
    ['COSTS', ['Each Party pays its own costs of negotiating and signing this Agreement.']],
    ['GENERAL', ['This Agreement is the whole agreement between the Parties on its subject matter.',
      'No variation of this Agreement is of any force unless reduced to writing and signed by both Parties.',
      'No relaxation or indulgence by a Party is a waiver of its rights.',
      'This Agreement is governed by the laws of the Republic of South Africa.']],
  ];
  const coc = (who: string, days: number) => `A change of control of ${who} entitles the other Party to terminate this Agreement on ${days} days' written notice, given within 60 days of being told of it.`;
  switch (p.as) {
    case 'supply': case 'customer': return {
      title: p.as === 'supply' ? 'SUPPLY AGREEMENT' : 'LOGISTICS SERVICES AGREEMENT', us: [subLegal(), p.as === 'supply' ? 'the Buyer' : 'the Provider'], them: [cp, p.as === 'supply' ? 'the Supplier' : 'the Customer'],
      sections: [
        ['INTERPRETATION', ['"Business Day" means any day other than a Saturday, Sunday or official public holiday in the Republic of South Africa.', `"Commencement Date" means ${start}.`,
          '"Services" means the warehousing, transport and value-added services described in Annexure A.']],
        ['DURATION', [`This Agreement starts on the Commencement Date and runs for ${term} months, after which it continues until either Party gives 90 days' written notice.`]],
        ['SERVICES AND VOLUMES', [`The Customer expects to move about ${fmt(h.int(800, 9000))} pallets a month through the ${site} site.`,
          'Forecasts are given monthly for the next three months and are binding for the first month.', 'The Provider meets the service levels in Annexure B in every calendar month.']],
        ['PRICE AND PAYMENT', ['The prices are set out in Annexure A and are exclusive of value-added tax.', `Prices increase on 1 March each year by the consumer price index, capped at ${h.int(5, 8)}%.`,
          'A fuel surcharge applies when the diesel price moves more than 5% from the base price in Annexure A.', `Invoices are paid within ${h.pick([30, 45, 60])} days of statement.`]],
        ['SERVICE LEVELS', [`Order accuracy of at least ${h.num(99.2, 99.8).toFixed(1)}% and on-time delivery of at least ${h.int(94, 98)}% are measured monthly.`,
          'A service credit of 2% of the monthly fee applies for each service level missed, up to 10% in a month.']],
        ['LIABILITY', ['Neither Party is liable for indirect or consequential loss.', `Liability for goods in the Provider's care is limited to ${R(h.int(2, 10) * 1e6)} for each event.`]],
        ['CHANGE OF CONTROL', [coc('either Party', h.pick([60, 90]))]],
        ...common],
      annex: () => [products(), routes()] };
    case 'transport': return {
      title: 'TRANSPORT SERVICES AGREEMENT', us: [subLegal('Drosvelt Logistics'), 'the Carrier'], them: [cp, 'the Customer'],
      sections: [
        ['DURATION', [`This Agreement runs for ${term} months from ${start}.`]],
        ['SERVICES', ['The Carrier transports the Customer\'s goods on the routes in Annexure A with its own vehicles and drivers.',
          'Loads are booked by 14:00 on the Business Day before collection.']],
        ['RATES AND FUEL', ['The rates per load are in Annexure A. They move each month with the published diesel price against the base in Annexure A.',
          `Waiting time beyond two hours at a loading point is charged at ${R(h.int(450, 900))} an hour.`]],
        ['GOODS IN TRANSIT', [`The Carrier insures goods in transit for up to ${R(h.int(1, 4) * 1e6)} for each load.`, 'Claims are made within 7 days of delivery.']],
        ['CROSS-BORDER LOADS', ['For loads into Namibia and Botswana, the Customer supplies the customs documents and the Carrier the cross-border permits.']],
        ['CHANGE OF CONTROL', [coc('the Carrier', 60)]],
        ...common],
      annex: routes };
    case 'rebate': return {
      title: `REBATE AGREEMENT ${c.year}`, us: [subLegal(), 'Drosvelt'], them: [cp, 'the Customer'],
      sections: [
        ['REBATE', ['Drosvelt pays the Customer a rebate on the net value of services invoiced in each contract year, at the rates below.',
          `The rebate is paid by credit note within 60 days of the end of the contract year, which ends on 28 February ${c.year + 1}.`]],
        ['CONDITIONS', ['No rebate is payable on amounts more than 60 days overdue.', 'The Customer keeps the rebate rates confidential.']],
        ...common],
      annex: () => ({ h: 'REBATE TIERS', columns: ['Net annual spend from', 'Net annual spend to', 'Rebate'], rows: [
        [R(0), R(10e6), '0.0%'], [R(10e6), R(25e6), `${h.num(0.5, 1).toFixed(1)}%`], [R(25e6), R(50e6), `${h.num(1.2, 2).toFixed(1)}%`], [R(50e6), 'no limit', `${h.num(2.2, 3.5).toFixed(1)}%`]] }) };
    case 'settlement': {
      const amount = h.int(4, 60) * 50_000;
      return {
        title: 'SETTLEMENT AGREEMENT', us: [subLegal(), 'Drosvelt'], them: [cp, 'the Claimant'],
        sections: [
          ['BACKGROUND', [`The Claimant issued summons against Drosvelt for ${R(amount * 2.4)} for services it says were not paid for, which Drosvelt disputes.`,
            'The Parties wish to settle the claim without any admission of liability.']],
          ['SETTLEMENT', [`Drosvelt pays the Claimant ${R(amount)} in full and final settlement of the claim, in ${h.int(2, 6)} equal monthly instalments from ${start}.`,
            'Each Party pays its own legal costs.']],
          ['WITHDRAWAL', ['The Claimant withdraws the action within 5 Business Days of the first payment.']],
          ['CONFIDENTIALITY', ['The terms of this settlement are confidential.']],
          ['GENERAL', ['This Agreement is governed by the laws of the Republic of South Africa.']]] };
    }
    case 'lease': case 'sublease': {
      const area = h.int(4, 42) * 500;
      const rent = area * h.num(55, 95);
      return {
        title: p.as === 'lease' ? 'AGREEMENT OF LEASE' : 'AGREEMENT OF SUBLEASE',
        us: [subLegal(p.as === 'lease' ? 'Drosvelt Logistics' : 'Drosvelt Properties'), p.as === 'lease' ? 'the Tenant' : 'the Sublessor'],
        them: [legal(h.pick(['Stenvolk Properties', 'Marravel Property', 'Kloofhaven Industrial Fund', 'Vaalrand Logistics Parks'])), p.as === 'lease' ? 'the Landlord' : 'the Subtenant'],
        sections: [
          ['THE PREMISES', [`The premises are the warehouse and yard at ${h.address(site)}, measuring about ${fmt(area)} square metres of warehouse and ${fmt(area * 0.6)} square metres of yard.`]],
          ['PERIOD', [`The lease runs for ${h.pick([5, 7, 10])} years from ${start}, with one option to renew for 5 years on 6 months' written notice.`]],
          ['RENTAL', [`The monthly rental is ${R(rent)} excluding VAT, escalating by ${h.num(6, 8).toFixed(1)}% on each anniversary.`,
            'Rates, taxes and insurance of the building are paid by the Landlord; electricity and water by the Tenant on separate meters.']],
          ['DEPOSIT', [`The Tenant has paid a deposit of ${R(rent * 3)}, held in an interest-bearing account.`]],
          ['USE', ['The premises are used for warehousing and distribution, including chilled storage, and for no other purpose without consent.']],
          ['MAINTENANCE', ['The Landlord maintains the roof, structure and external walls. The Tenant maintains the interior, dock levellers and racking.']],
          ['CESSION AND SUBLETTING', ['The Tenant may not cede the lease or sublet without the Landlord\'s written consent. A change of control of the Tenant counts as a cession.']],
          ...common],
        annex: () => ({ h: 'SCHEDULE OF RENTAL', columns: ['Lease year', 'Monthly rental excl. VAT', 'Annual rental excl. VAT'],
          rows: Array.from({ length: 10 }, (_, i) => [`Year ${i + 1}`, R(rent * 1.07 ** i), R(rent * 12 * 1.07 ** i)]) }) };
    }
    case 'lease-addendum': return {
      title: 'ADDENDUM TO AGREEMENT OF LEASE', us: [subLegal('Drosvelt Logistics'), 'the Tenant'], them: [legal('Stenvolk Properties'), 'the Landlord'],
      sections: [
        ['BACKGROUND', [`The Parties signed a lease of the warehouse at ${site}, which they now wish to amend with effect from ${start}.`]],
        ['AMENDMENTS', [`The lease period is extended by ${h.int(2, 5)} years.`, `The escalation rate is reduced from 8.0% to ${h.num(6, 7.5).toFixed(1)}% a year.`,
          `The Landlord installs solar panels of ${h.int(150, 600)} kWp on the roof at its cost; the Tenant buys the power at ${R(h.num(1.4, 2.1), 2)} per kWh.`]],
        ['GENERAL', ['All other terms of the lease remain in force.']]] };
    case 'facility': {
      const amount = h.pick([250, 300, 400, 500]) * 1e6;
      return {
        title: 'REVOLVING CREDIT FACILITY AGREEMENT', us: [HOLDCO, 'the Borrower'], them: [legal(`${p.bank ?? 'Umbila Bank'} Ltd`), 'the Lender'],
        sections: [
          ['THE FACILITY', [`The Lender makes available a revolving credit facility of ${rm(amount)} for general corporate purposes and capital expenditure.`]],
          ['INTEREST', [`Interest is charged at three-month JIBAR plus a margin of ${h.num(1.9, 2.8).toFixed(2)}% a year, paid quarterly in arrears.`,
            `A commitment fee of ${h.num(0.35, 0.6).toFixed(2)}% a year is charged on the undrawn amount.`]],
          ['REPAYMENT', [`Each loan is repaid at the end of its interest period and may be redrawn. The facility ends on ${day(c.year + 3, h.int(0, 11), 30)}.`]],
          ['FINANCIAL COVENANTS', [`Net debt to EBITDA of no more than ${h.pick(['2.75', '3.00', '3.25'])} times, and interest cover of at least ${h.pick(['3.0', '3.5', '4.0'])} times, tested half-yearly.`]],
          ['SECURITY', ['The facility is secured by a pledge of the shares in the operating subsidiaries and guarantees by each of them.']],
          ['MANDATORY PREPAYMENT', [`On a change of control of the Borrower, the Lender may cancel the facility and declare all loans due on 30 days' notice. The ${p.bank ?? 'Umbila Bank'} facility is therefore part of the consents tracker for the sale.`]],
          ['EVENTS OF DEFAULT', ['Non-payment, breach of a financial covenant, cross-default above R10 million, insolvency and a material adverse change are events of default.']],
          ...common],
        annex: () => ({ h: 'COMPLIANCE CERTIFICATE', columns: ['Test date', 'Net debt (R m)', 'EBITDA (R m)', 'Net debt to EBITDA', 'Interest cover'],
          rows: Array.from({ length: 8 }, (_, i) => {
            const ebitda = h.num(260, 340);
            const debt = h.num(320, 640);
            return [`${i % 2 ? '31 August' : '28 February'} ${2022 + Math.floor(i / 2)}`, fmt(debt, 1), fmt(ebitda, 1), `${(debt / ebitda).toFixed(2)}x`, `${h.num(4, 7).toFixed(1)}x`];
          }) }) };
    }
    case 'guarantee': return {
      title: 'GUARANTEE', us: [legal(`${p.bank ?? 'Umbila Bank'} Ltd`), 'the Guarantor'], them: [cp, 'the Beneficiary'],
      sections: [
        ['GUARANTEE', [`At the request of ${HOLDCO}, the Guarantor guarantees payment to the Beneficiary of up to ${R(h.int(2, 30) * 250_000)} owed under its supply agreement.`]],
        ['DEMAND', ['The Guarantor pays within 5 Business Days of a written demand stating that the amount is due and unpaid.']],
        ['EXPIRY', [`This guarantee expires on ${day(c.year + 1, h.int(0, 11), 28)}.`]]] };
    case 'licence': case 'support': case 'escrow': case 'dpa': {
      const vendor = legal(`${p.vendor ?? 'Ledgerva'} Africa`);
      const users = h.int(40, 400);
      const sections: [string, string[]][] = p.as === 'licence' ? [
        ['LICENCE', [`The Licensor grants the Licensee a non-exclusive licence to use the ${p.vendor} software for up to ${users} named users in South Africa, Namibia and Botswana.`]],
        ['FEES', [`The annual subscription is ${R(users * h.int(3200, 9800))} excluding VAT, invoiced annually in advance and increasing by the consumer price index.`]],
        ['SUPPORT', ['Support is provided from 07:00 to 18:00 on Business Days. Priority 1 incidents are answered within one hour.']],
        ['DATA', ['The Licensee\'s data remains its property and is hosted in South Africa. It is returned in a readable format within 30 days of termination.']],
        ['ASSIGNMENT', ['Neither Party may assign this licence without consent, except to a successor of its whole business.']]]
        : p.as === 'support' ? [
          ['SERVICES', [`The Supplier supports the Customer's ${p.vendor} systems, including patches, monitoring and a service desk.`]],
          ['SERVICE LEVELS', ['Priority 1: response within 30 minutes, restoration within 4 hours. Priority 2: response within 2 hours, restoration within 1 Business Day.']],
          ['FEES', [`The monthly fee is ${R(h.int(40, 220) * 1000)} excluding VAT.`]]]
          : p.as === 'escrow' ? [
            ['DEPOSIT', [`The Owner deposits the source code of the ${p.vendor} software with the escrow agent, Kloofhaven Escrow Services, and updates it with each major release.`]],
            ['RELEASE', ['The source code is released to the Licensee if the Owner is placed in business rescue or liquidation, or stops supporting the software.']],
            ['VERIFICATION', ['The Licensee may have the deposit verified once a year at its own cost.']]]
            : [
              ['PROCESSING', [`The Operator processes personal information of the Responsible Party's employees and customers only to provide the ${p.vendor} services.`]],
              ['SECURITY MEASURES', ['The Operator maintains the security measures in the schedule, including encryption at rest and in transit, access control and logging.']],
              ['SECURITY COMPROMISES', ['The Operator notifies the Responsible Party of a security compromise within 24 hours of becoming aware of it.']],
              ['SUB-OPERATORS', ['The Operator uses no sub-operator without the Responsible Party\'s prior written consent.']],
              ['CROSS-BORDER TRANSFERS', ['Personal information is stored in South Africa and transferred abroad only as section 72 of POPIA allows.']]];
      const roles: Record<string, [string, string]> = { licence: ['the Licensee', 'the Licensor'], support: ['the Customer', 'the Supplier'], escrow: ['the Licensee', 'the Owner'], dpa: ['the Responsible Party', 'the Operator'] };
      return {
        title: { licence: 'SOFTWARE LICENCE AGREEMENT', support: 'SUPPORT AND MAINTENANCE AGREEMENT', escrow: 'SOURCE CODE ESCROW AGREEMENT', dpa: 'DATA PROCESSING AGREEMENT' }[p.as]!,
        us: [HOLDCO, roles[p.as]![0]], them: [vendor, roles[p.as]![1]], sections: [...sections, ...common],
        annex: p.as === 'licence' || p.as === 'support' ? () => ({ h: 'MODULES AND USERS', columns: ['Module', 'Users', 'Annual fee excl. VAT'],
          rows: ['Finance', 'Procurement', 'Warehouse management', 'Transport management', 'Payroll', 'Reporting', 'Mobile scanning', 'Customer portal']
            .map((m) => [m, String(h.int(5, 120)), R(h.int(30, 900) * 1000)]) }) : undefined };
    }
    case 'ip-assignment': case 'tm-licence': return {
      title: p.as === 'ip-assignment' ? 'DEED OF ASSIGNMENT OF INTELLECTUAL PROPERTY' : 'TRADE MARK LICENCE AGREEMENT',
      us: [HOLDCO, p.as === 'ip-assignment' ? 'the Assignee' : 'the Licensor'], them: [p.as === 'ip-assignment' ? cp : subLegal(p.sub), p.as === 'ip-assignment' ? 'the Assignor' : 'the Licensee'],
      sections: p.as === 'ip-assignment' ? [
        ['ASSIGNMENT', ['The Assignor assigns to the Assignee all its rights in the designs, software and know-how developed for the Assignee under their services agreement.']],
        ['CONSIDERATION', [`The Assignee pays ${R(h.int(10, 90) * 10_000)} on signature.`]],
        ['WARRANTIES', ['The Assignor warrants that the assigned rights are its own, free of encumbrances, and do not infringe the rights of any third party.']],
        ...common]
        : [
          ['LICENCE', [`The Licensor licenses the ${p.mark} trade mark to the Licensee for transport and warehousing services in South Africa, Namibia and Botswana.`]],
          ['ROYALTY', [`The Licensee pays a royalty of ${h.num(0.5, 2).toFixed(1)}% of net revenue earned under the mark, quarterly in arrears.`]],
          ['QUALITY CONTROL', ['The Licensee uses the mark only as the brand guide allows and lets the Licensor inspect its use on reasonable notice.']],
          ...common] };
    case 'shareholders': return {
      title: 'SHAREHOLDERS AGREEMENT', us: [HOLDCO, 'Drosvelt'], them: [legal(`Heron Management Partners`), 'the Management Shareholder'],
      sections: [
        ['SHAREHOLDING', [`Drosvelt holds ${h.int(70, 85)}% and the Management Shareholder the rest of the issued shares of ${subLegal(p.sub)} (the Company).`]],
        ['BOARD', ['The board has five directors: three appointed by Drosvelt, one by the Management Shareholder, and one independent director.']],
        ['RESERVED MATTERS', ['Changes to the memorandum of incorporation, new shares, acquisitions above R25 million and dividends need the approval of shareholders holding 75% of the shares.']],
        ['PRE-EMPTION', ['A shareholder who wishes to sell its shares must first offer them to the other shareholders pro rata at the same price.']],
        ['DRAG AND TAG', ['If Drosvelt sells all its shares to a third party, it may require the Management Shareholder to sell on the same terms, and the Management Shareholder may require to be included.']],
        ['DIVIDEND POLICY', ['The Company distributes at least 40% of its profit after tax each year, subject to the solvency and liquidity test.']],
        ...common],
      annex: () => ({ h: 'SHAREHOLDING', columns: ['Shareholder', 'Class', 'Shares', 'Percentage'],
        rows: [['Drosvelt Holdings (Pty) Ltd', 'Ordinary', fmt(800_000), '80.0%'], ['Heron Management Partners (Pty) Ltd', 'Ordinary', fmt(200_000), '20.0%']] }) };
    case 'employment': case 'fixed-term': case 'restraint': {
      const name = h.person();
      const role = p.role ?? h.pick(['warehouse controller', 'driver', 'forklift operator', 'dispatch clerk', 'shift supervisor']);
      const salary = p.as === 'fixed-term' ? h.int(14, 28) * 1000 : h.int(45, 260) * 1000;
      const base: [string, string[]][] = p.as === 'restraint' ? [
        ['UNDERTAKING', [`For ${h.pick([12, 18, 24])} months after leaving the Company, ${name} will not work for or hold an interest in a competing logistics business in South Africa, Namibia or Botswana.`]],
        ['NON-SOLICITATION', ['For the same period the Employee will not solicit any customer or employee of the Company.']],
        ['CONSIDERATION', [`In return the Company pays the Employee ${R(salary * 3)} in three equal instalments during the restraint period.`]]]
        : [
          ['APPOINTMENT', [`${name} is appointed as ${role}${p.as === 'fixed-term' ? ` at the ${p.site} site` : ''}, reporting to the ${h.pick(['chief executive', 'operations director', 'site manager', 'chief financial officer'])}.`]],
          ['DURATION', [p.as === 'fixed-term' ? `The appointment is for a fixed term of ${h.int(3, 11)} months from ${start}, to cover the peak season, and ends without notice on that date.`
            : `The appointment starts on ${start} and continues until terminated on ${h.pick([1, 3])} months' written notice.`]],
          ['REMUNERATION', [`The monthly salary is ${R(salary)} before deductions, reviewed each March.`, `The Employee belongs to the ${h.pick(['Drosvelt Provident Fund', 'Drosvelt Pension Fund'])} and the company medical aid.`]],
          ['WORKING HOURS', ['Ordinary hours are 45 a week. Overtime is paid as the Basic Conditions of Employment Act requires.']],
          ['LEAVE', ['Annual leave is 21 consecutive days a year, sick leave as the Act provides.']],
          ['CONFIDENTIALITY', ['The Employee keeps the Company\'s information confidential during and after employment.']]];
      let title = 'CONTRACT OF EMPLOYMENT';
      if (p.as === 'restraint') title = 'RESTRAINT OF TRADE UNDERTAKING';
      else if (p.as === 'fixed-term') title = 'FIXED-TERM CONTRACT OF EMPLOYMENT';
      return { title,
        us: [subLegal(p.sub ?? 'Drosvelt Logistics'), 'the Company'], them: [name, 'the Employee'], sections: [...base, ['GENERAL', ['This contract is governed by the laws of the Republic of South Africa.']]] };
    }
    case 'collective': {
      const rise = h.num(5.5, 7.5);
      return {
        title: 'COLLECTIVE WAGE AGREEMENT', us: [subLegal('Drosvelt Logistics'), 'the Employer'], them: ['Sebenzani Freight and Allied Workers Union', 'the Union'],
        sections: [
          ['SCOPE', ['This agreement covers all employees in the bargaining unit at the Germiston, Isando, Durban harbour and Cape Town sites.']],
          ['WAGE INCREASE', [`Minimum wages increase by ${rise.toFixed(1)}% from 1 April ${c.year}, and by the consumer price index plus 1% a year later.`]],
          ['ALLOWANCES', [`The night shift allowance increases to ${R(h.int(28, 45))} a shift and the cold store allowance to ${R(h.int(18, 30))} a shift.`]],
          ['PEACE CLAUSE', ['The Union will not strike on wage matters during the term of this agreement.']],
          ['DURATION', [`This agreement runs for three years, to 31 March ${c.year + 3}.`]]],
        annex: () => ({ h: 'MINIMUM MONTHLY WAGES', columns: ['Grade', 'Job', `From 1 April ${c.year}`, `From 1 April ${c.year + 1}`],
          rows: [['A1', 'General worker', 0], ['A2', 'Packer', 1], ['B1', 'Forklift operator', 2], ['B2', 'Reach truck operator', 3], ['B3', 'Code 10 driver', 4],
            ['C1', 'Code 14 driver', 5], ['C2', 'Stock controller', 6], ['C3', 'Shift leader', 7]].map(([g, j, i]) => {
            const w = 7800 * 1.11 ** Number(i);
            return [String(g), String(j), R(w * (1 + rise / 100)), R(w * (1 + rise / 100) * 1.065)];
          }) }) };
    }
    default: throw new Error(`No agreement of kind ${p.as}`);
  }
}

function* agreement(c: Ctx): Generator<Block> {
  const s = agreementSpec(c);
  const h = helpers(c);
  yield { t: 'title', text: s.title };
  yield { t: 'center', text: 'between' };
  yield { t: 'center', text: s.us[0].toUpperCase(), bold: true };
  if (s.us[0] === HOLDCO) yield { t: 'center', text: `Registration number ${HOLDCO_REG}` };
  yield { t: 'center', text: `(${s.us[1]})` };
  yield { t: 'center', text: 'and' };
  yield { t: 'center', text: s.them[0].toUpperCase(), bold: true };
  if (/\(Pty\) Ltd|Ltd$/.test(s.them[0])) yield { t: 'center', text: `Registration number ${h.reg(s.them[0])}` };
  yield { t: 'center', text: `(${s.them[1]})` };
  if (c.v > 1) yield { t: 'center', text: `Version ${c.v}, as amended on ${h.date(2026, 9)}` };
  yield { t: 'gap' };
  let n = 0;
  for (const [head, clauses] of s.sections) {
    n++;
    yield { t: 'h', text: `${n}. ${head}` };
    for (const [i, text] of clauses.entries()) yield { t: 'p', text: `${n}.${i + 1} ${text}` };
  }
  n++;
  yield { t: 'h', text: `${n}. SIGNATURES` };
  yield { t: 'p', text: `Signed at Johannesburg on ${h.date()} on behalf of ${s.us[0]} by ${s.us[0] === HOLDCO ? `${P.ceo}, chief executive` : 'its duly authorised representative'}.` };
  yield { t: 'p', text: `Signed at ${h.pick(['Johannesburg', 'Durban', 'Cape Town', 'Sandton'])} on ${h.date()} on behalf of ${s.them[0]}${/Ltd|Inc/.test(s.them[0]) ? ' by its duly authorised representative' : ''}.` };
  if (!s.annex) return;
  const own = [s.annex()].flat();
  const all = [...own, ...generalAnnexes(c, s)];
  for (const [a, t] of all.slice(0, Math.max(own.length, Math.min(all.length, c.d.pages - 3))).entries()) {
    yield { t: 'h', text: `ANNEXURE ${String.fromCharCode(65 + a)}: ${t.h}` };
    yield { t: 'table', columns: t.columns, rows: t.rows, widths: t.widths };
  }
}

function generalAnnexes(c: Ctx, s: AgreementSpec): Annex[] {
  const h = helpers(c);
  const slug = (n: string) => n.toLowerCase().replace(/\(pty\) ltd|ltd|inc\.|soc/g, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const many = 8 + Math.min(16, c.d.pages * 2);
  return [
    { h: 'NOTICE ADDRESSES', columns: ['Party', 'Physical address', 'Email for notices'], widths: [0.28, 0.4, 0.32], rows: [
      [s.us[0], h.address('Germiston'), 'legal@drosvelt.example'], [s.them[0], h.address(h.pick(['Sandton', 'Midrand', 'Durban', 'Cape Town', 'Pretoria'])), `contracts@${slug(s.them[0]).split('-')[0]}.example`]] },
    { h: 'AUTHORISED SIGNATORIES AND CONTACTS', columns: ['Party', 'Name', 'Role'], widths: [0.34, 0.3, 0.36], rows: [
      [s.us[0], P.ceo, 'Chief executive'], [s.us[0], P.cfo, 'Chief financial officer'], [s.us[0], P.ops, 'Operations director'],
      [s.them[0], h.person(), 'Managing director'], [s.them[0], h.person(), 'Commercial manager'], [s.them[0], h.person(), 'Finance manager']] },
    { h: 'SITES AND OPERATING HOURS', columns: ['Site', 'Address', 'Operating hours'], widths: [0.24, 0.5, 0.26], rows: WORDS.site!.slice(0, Math.min(10, 3 + c.d.pages)).map((x) => [x, h.address(x), h.pick(['24 hours', '06:00 to 22:00', '07:00 to 17:00 weekdays'])]) },
    { h: 'INSURANCE REQUIREMENTS', columns: ['Cover', 'Minimum limit', 'Who insures'], widths: [0.44, 0.3, 0.26], rows: [
      ['Public liability', R(50e6), 'Each Party'], ['Goods in transit', R(h.int(2, 5) * 1e6), 'Provider'], ['Stock and contents', 'Full replacement value', 'Owner of the goods'],
      ['Motor fleet', 'Full replacement value', 'Provider'], ['Employer\'s liability', R(20e6), 'Each Party'], ['Cyber', R(h.int(10, 25) * 1e6), 'Each Party']] },
    { h: 'KEY PERFORMANCE INDICATORS', columns: ['Indicator', 'Measure', 'Target', 'Service credit'], widths: [0.3, 0.36, 0.14, 0.2], rows: [
      ['On-time collection', 'Collected within the agreed window', '97%', '1% of the monthly fee'], ['On-time delivery', 'Delivered within the agreed window', '95%', '2% of the monthly fee'],
      ['Order accuracy', 'Orders without picking errors', '99.5%', '1% of the monthly fee'], ['Stock accuracy', 'Cycle count accuracy', '99.8%', '1% of the monthly fee'],
      ['Claims', 'Claims as % of revenue', '0.10%', 'None'], ['Reporting', 'Monthly report by the 7th business day', '100%', 'None']] },
    { h: 'RATE REVIEW HISTORY', columns: ['Effective date', 'Basis', 'Increase'], widths: [0.3, 0.5, 0.2], rows: Array.from({ length: Math.min(many, 10) }, (_, i) => [
      `1 March ${2017 + i}`, h.pick(['Consumer price index', 'CPI plus 1%', 'Fuel index and CPI', 'Agreed in the annual review']), `${h.num(3.5, 8.5).toFixed(1)}%`]) },
  ];
}

// Corporate records

function* minutes(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const company = subLegal(c.p.sub ?? 'Drosvelt Holdings');
  const body = { board: 'MEETING OF THE BOARD OF DIRECTORS', agm: 'ANNUAL GENERAL MEETING OF SHAREHOLDERS', exco: 'MEETING OF THE EXECUTIVE COMMITTEE' }[c.p.as ?? 'board'];
  const when = h.date();
  yield { t: 'title', text: company.toUpperCase() };
  yield { t: 'center', text: `Minutes of the ${body!.toLowerCase()}`, bold: true };
  yield { t: 'center', text: `held at 22 Steenbok Road, Germiston South, on ${when} at ${h.pick(['09:00', '10:00', '14:00'])}` };
  yield { t: 'gap' };
  yield { t: 'h', text: 'PRESENT' };
  const present = c.p.as === 'exco' ? [`${P.ceo} (chair)`, P.cfo, P.ops, P.hr, P.sales, P.it] : [`${P.chair} (chair)`, P.ceo, P.cfo, P.ned1, P.ned2];
  for (const x of present) yield { t: 'li', text: x };
  yield { t: 'p', text: `In attendance: ${P.cosec} (company secretary)${c.p.as === 'board' ? `, ${P.fd} (finance director, for item 4)` : ''}.` };
  if (h.r() < 0.5) yield { t: 'p', text: `Apologies: ${h.pick([P.ned2, P.it, P.sales])}.` };
  const turnover = h.num(150, 185);
  const items: [string, string[]][] = [
    ['QUORUM', ['A quorum being present, the chair declared the meeting properly constituted.']],
    ['MINUTES OF THE PREVIOUS MEETING', ['The minutes of the previous meeting were approved and signed by the chair.']],
    ['CHIEF EXECUTIVE\'S REPORT', [`Volumes for the month were ${pct(h.num(-0.03, 0.08))} against the same month last year. The ${h.pick(WORDS.site!)} site reached ${h.int(86, 97)}% occupancy.`,
      `Two new customer contracts were signed, with annual revenue of about ${rm(h.int(18, 70) * 1e6)}.`]],
    ['FINANCIAL PERFORMANCE', [`Revenue for the month was R${turnover.toFixed(1)} million, ${pct(h.num(-0.02, 0.05))} against budget. EBITDA margin was ${pct(h.num(0.13, 0.17))}.`,
      `Net debt stood at ${rm(h.int(380, 520) * 1e6)}, and the revolving credit facility headroom at ${rm(h.int(90, 180) * 1e6)}.`]],
    ['PROJECT HERON', [`${ADVISERS.corporate} reported on the sale process. Three bidders have been admitted to the data room, and non-binding offers are due on 27 November 2026.`,
      'The board noted that the process is confidential and that no employee outside the deal team is to be told of it.']],
    ['HEALTH AND SAFETY', [`The lost-time injury frequency rate was ${h.num(0.2, 0.9).toFixed(2)}. ${h.pick(['A forklift collision at Isando caused no injury; refresher training followed.', 'No serious incidents were reported.', 'A driver was injured in a road accident near Polokwane and has returned to work.'])}`]],
    ['CAPITAL EXPENDITURE', [`The board approved capital expenditure of ${R(h.int(4, 40) * 1e6)} for ${h.pick(['20 new truck tractors', 'racking at the Durban harbour site', 'a second cold store chamber in Cape Town', 'solar panels at Germiston'])}.`]],
  ];
  if (c.p.as === 'agm') items.splice(2, 5,
    ['ANNUAL FINANCIAL STATEMENTS', [`The audited consolidated financial statements for the year ended 28 February ${c.year} were presented and received.`]],
    ['AUDITOR', [`${ADVISERS.auditor} was reappointed as auditor until the next annual general meeting.`]],
    ['DIRECTORS', [`${P.ned2} retired by rotation and, being eligible, was re-elected.`]],
    ['DIVIDEND', [`A final dividend of ${h.int(30, 90)} cents a share was approved.`]]);
  let n = 0;
  for (const [head, texts] of items) {
    n++;
    yield { t: 'h', text: `${n}. ${head}` };
    for (const tx of texts) yield { t: 'p', text: tx };
  }
  yield { t: 'h', text: `${n + 1}. CLOSURE` };
  yield { t: 'p', text: `There being no further business, the chair closed the meeting at ${h.pick(['11:40', '12:15', '16:05'])}.` };
  yield { t: 'gap' };
  yield { t: 'p', text: `Signed as a correct record: ______________________  ${c.p.as === 'exco' ? P.ceo : P.chair}, chair` };
}

function* resolution(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const company = subLegal(c.p.sub);
  const shareholders = c.p.as === 'shareholders';
  yield { t: 'title', text: company.toUpperCase() };
  yield { t: 'center', text: shareholders ? 'Written resolution of the shareholders in terms of section 60 of the Companies Act 71 of 2008' : 'Resolution of the board of directors in terms of section 74 of the Companies Act 71 of 2008', bold: true };
  yield { t: 'center', text: `Passed on ${h.date()}` };
  yield { t: 'gap' };
  const subjects = shareholders ? [
    [`SPECIAL RESOLUTION 1: FINANCIAL ASSISTANCE`, 'RESOLVED THAT the company may give financial assistance to related and inter-related companies as section 45 of the Companies Act allows, for two years.'],
    ['SPECIAL RESOLUTION 2: DIRECTORS\' FEES', `RESOLVED THAT the fees of non-executive directors for the year are ${R(h.int(380, 520) * 1000)} for the chair and ${R(h.int(220, 320) * 1000)} for each other director.`],
    ['ORDINARY RESOLUTION: AUDITOR', `RESOLVED THAT ${ADVISERS.auditor} is appointed as auditor of the company.`]]
    : [
      ['FACILITY', `RESOLVED THAT the company enters into the ${h.pick(WORDS.bank!)} facility agreement on the terms tabled, and that ${P.cfo} signs it on behalf of the company.`],
      ['BANK MANDATE', `RESOLVED THAT the bank mandate is amended so that any two of ${P.ceo}, ${P.cfo} and ${P.fd} may approve payments above ${R(h.int(1, 5) * 1e6)}.`],
      ['PROJECT HERON', `RESOLVED THAT the company appoints ${ADVISERS.corporate} as adviser on the sale of the group, and that ${P.ceo} and ${P.cfo} may give bidders access to information under a confidentiality undertaking.`]];
  for (const [i, [head, text]] of subjects.slice(0, 1 + (seedOf(c.d.ix) % subjects.length)).entries()) {
    yield { t: 'h', text: `${i + 1}. ${head}` };
    yield { t: 'p', text: text! };
  }
  yield { t: 'gap' };
  yield { t: 'table', columns: [shareholders ? 'Shareholder' : 'Director', 'Signature', 'Date'], widths: [0.5, 0.3, 0.2],
    rows: (shareholders ? [HOLDCO, 'Heron Management Partners (Pty) Ltd'] : [P.chair, P.ceo, P.cfo, P.ned1, P.ned2]).map((x) => [x, '', h.date()]) };
}

function* certificate(c: Ctx): Generator<Block> {
  const h = helpers(c);
  yield* certificateBody(c);
  yield { t: 'gap' };
  yield { t: 'p', text: `Issued electronically on ${h.date()}. The authenticity of this certificate can be checked with the issuer by quoting the reference above. `
    + 'A copy is kept in the statutory records of the company at its registered office.' };
  yield { t: 'p', text: `Certified a true copy of the original: ${P.cosec}, company secretary, ${HOLDCO}.` };
}

function* certificateBody(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const company = subLegal(c.p.sub);
  const site = c.p.site ?? 'Germiston';
  const rows = (pairs: [string, string][]): Block => ({ t: 'table', columns: ['Detail', ''], rows: pairs, widths: [0.4, 0.6] });
  switch (c.p.as) {
    case 'incorporation': case 'name': case 'annual-return':
      yield { t: 'title', text: 'COMPANIES AND INTELLECTUAL PROPERTY COMMISSION' };
      yield { t: 'center', text: { incorporation: 'Registration certificate', name: 'Certificate of change of name', 'annual-return': 'Annual return confirmation' }[c.p.as]!, bold: true };
      yield { t: 'gap' };
      yield { t: 'p', text: c.p.as === 'annual-return' ? `This confirms that the annual return of ${company} for ${c.year} was filed and the fee of ${R(h.int(450, 3000))} paid on ${h.date()}.`
        : c.p.as === 'name' ? `This certifies that ${legal(`${h.pick(['Heronvale', 'Karoo Freight', 'Tsamaya'])} Logistics`)} changed its name to ${company} on ${day(h.int(2012, 2019), h.int(0, 11), h.int(1, 28))}.`
          : `This certifies that ${company} was incorporated as a private company on ${day(h.int(2009, 2016), h.int(0, 11), h.int(1, 28))}.` };
      yield rows([['Registration number', h.reg(company)], ['Registered office', h.address('Germiston')], ['Financial year end', 'February'], ['Status', 'In business']]);
      return;
    case 'share':
      yield { t: 'title', text: company.toUpperCase() };
      yield { t: 'center', text: `Share certificate number ${c.p.n}`, bold: true };
      yield { t: 'gap' };
      yield { t: 'p', text: `This certifies that ${c.p.sub === 'Drosvelt Holdings' ? 'Heron Investments (Pty) Ltd' : HOLDCO} is the registered holder of ${fmt(h.int(1, 100) * 1000)} ordinary shares of no par value in ${company}, subject to its memorandum of incorporation.` };
      yield rows([['Issued on', h.date(h.int(2010, 2022))], ['Signed by', `${P.chair} (director) and ${P.cosec} (company secretary)`]]);
      return;
    case 'tax-clearance':
      yield { t: 'title', text: 'TAX COMPLIANCE STATUS' };
      yield { t: 'center', text: 'South African Revenue Service', bold: true };
      yield { t: 'gap' };
      yield { t: 'p', text: `The tax compliance status of ${company} is compliant for income tax, VAT, PAYE and customs.` };
      yield rows([['Taxpayer reference', String(9000000000 + (seedOf(company) % 999999999))], ['PIN', `${h.pick(['K', 'M', 'T'])}${h.int(100, 999)}${h.pick(['A', 'B', 'C'])}${h.int(10, 99)}`], ['Valid until', h.date(c.year + 1)]]);
      return;
    case 'bbbee': {
      const level = h.int(1, 4);
      yield { t: 'title', text: 'B-BBEE VERIFICATION CERTIFICATE' };
      yield { t: 'center', text: `${company}: Level ${level} contributor`, bold: true };
      yield { t: 'gap' };
      yield { t: 'p', text: `Verified by Verimbo Verification Agency under the Amended Codes of Good Practice (generic scorecard) for the year ended 28 February ${c.year}.` };
      yield { t: 'table', columns: ['Element', 'Target', 'Score'], widths: [0.5, 0.25, 0.25], rows: [['Ownership', '25', (h.num(14, 25)).toFixed(2)],
        ['Management control', '19', h.num(9, 17).toFixed(2)], ['Skills development', '20', h.num(10, 19).toFixed(2)], ['Enterprise and supplier development', '42', h.num(24, 40).toFixed(2)],
        ['Socio-economic development', '5', h.num(3, 5).toFixed(2)]] };
      yield { t: 'p', text: `Procurement recognition level: ${[135, 125, 110, 100][level - 1]}%. Valid until ${h.date(c.year + 1)}.` };
      return;
    }
    case 'trade-mark':
      yield { t: 'title', text: 'CERTIFICATE OF REGISTRATION OF A TRADE MARK' };
      yield { t: 'center', text: 'Trade Marks Act 194 of 1993', bold: true };
      yield { t: 'gap' };
      yield rows([['Mark', c.p.mark ?? 'DROSVELT'], ['Class', c.p.cls ?? '39'], ['Registration number', `${h.int(2012, 2023)}/${fmt(h.int(10000, 39999)).replace(' ', '')}`],
        ['Proprietor', HOLDCO], ['Services', { 9: 'Software for tracking goods', 16: 'Printed labels and packaging', 35: 'Supply chain management', 39: 'Transport, storage and distribution of goods', 42: 'Logistics software as a service' }[c.p.cls ?? '39'] ?? 'Transport'],
        ['Renewal due', h.date(h.int(2027, 2033))]]);
      return;
    case 'title-deed': {
      yield { t: 'title', text: 'DEED OF TRANSFER' };
      yield { t: 'center', text: `Erf ${h.int(100, 9999)}, ${site}`, bold: true };
      yield { t: 'gap' };
      yield { t: 'p', text: `BE IT HEREBY MADE KNOWN THAT the conveyancer appeared before the Registrar of Deeds and declared that the seller sold the property below to ${subLegal('Drosvelt Properties')} for ${R(h.int(20, 180) * 1e6)}.` };
      yield rows([['Property', `Erf ${h.int(100, 9999)}, ${site} Extension ${h.int(1, 30)}`], ['Extent', `${fmt(h.int(8000, 60000))} square metres`], ['Registered on', h.date(h.int(2011, 2021))],
        ['Bond', `Registered in favour of ${h.pick(WORDS.bank!)} Ltd for ${R(h.int(10, 90) * 1e6)}`]]);
      yield { t: 'h', text: 'CONDITIONS OF TITLE' };
      for (const x of ['The property may be used for industrial purposes only.', 'No building may be erected within 5 metres of the street boundary.', 'The owner gives the local authority a servitude for services 2 metres wide along any boundary.'])
        yield { t: 'li', text: x };
      return;
    }
    case 'information-officer':
      yield { t: 'title', text: 'INFORMATION REGULATOR (SOUTH AFRICA)' };
      yield { t: 'center', text: 'Confirmation of registration of an information officer', bold: true };
      yield { t: 'gap' };
      yield rows([['Responsible party', company], ['Information officer', P.cfo], ['Deputy information officer', P.it], ['Registered on', h.date()], ['Reference', `IO-${h.int(100000, 999999)}`]]);
      return;
    default: {
      const what = { zoning: 'ZONING CERTIFICATE', occupation: 'CERTIFICATE OF OCCUPANCY', rates: 'RATES CLEARANCE CERTIFICATE', fire: 'FIRE SAFETY COMPLIANCE CERTIFICATE' }[c.p.as ?? 'zoning'] ?? 'CERTIFICATE';
      yield { t: 'title', text: what };
      yield { t: 'center', text: `Municipality of ${site.split(' ')[0]}`, bold: true };
      yield { t: 'gap' };
      yield { t: 'p', text: {
        zoning: `The property described below is zoned Industrial 2, which permits warehousing, distribution and ancillary offices up to a coverage of ${h.int(60, 75)}%.`,
        occupation: 'The building described below was erected in accordance with the approved plans and may be occupied for warehousing and offices.',
        rates: `All rates, taxes and service charges due on the property described below have been paid up to ${h.date()}. This certificate is valid for 120 days.`,
        fire: `The premises described below were inspected on ${h.date()} and comply with the fire safety by-laws for the storage of ${h.pick(['general goods', 'chilled food', 'Class 3 flammable liquids in the separate store'])}.`,
      }[c.p.as ?? 'zoning'] ?? '' };
      yield rows([['Owner', subLegal('Drosvelt Properties')], ['Property', `Erf ${h.int(100, 9999)}, ${site}`], ['Street address', h.address(site)], ['Reference', `${(c.p.as ?? 'X').slice(0, 3).toUpperCase()}/${c.year}/${h.int(1000, 9999)}`]]);
    }
  }
}

function* register(c: Ctx): Generator<Block> {
  const h = helpers(c);
  yield { t: 'title', text: `REGISTER OF DIRECTORS: ${subLegal(c.p.sub).toUpperCase()}` };
  yield { t: 'center', text: `As at ${h.date()}` };
  yield { t: 'gap' };
  yield { t: 'table', columns: ['Name', 'Role', 'Appointed', 'Resigned'], widths: [0.3, 0.3, 0.2, 0.2], rows: [
    [P.chair, 'Independent non-executive chair', h.date(2015), ''], [P.ceo, 'Chief executive', h.date(2017), ''], [P.cfo, 'Chief financial officer', h.date(2019), ''],
    [P.ned1, 'Independent non-executive', h.date(2020), ''], [P.ned2, 'Non-executive', h.date(2016), ''], [h.person(), 'Executive director', h.date(2012), h.date(2019)]] };
}

function* court(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const claim = h.int(12, 180) * 50_000;
  yield { t: 'title', text: 'IN THE HIGH COURT OF SOUTH AFRICA' };
  yield { t: 'center', text: 'GAUTENG DIVISION, JOHANNESBURG', bold: true };
  yield { t: 'center', text: `Case number ${h.int(2024, 2026)}/${h.int(10000, 99999)}` };
  yield { t: 'center', text: `In the matter between ${legal(c.p.cp ?? 'Tarnley Logistics').toUpperCase()} (Plaintiff) and ${subLegal(c.p.sub).toUpperCase()} (Defendant)` };
  yield { t: 'gap' };
  yield { t: 'h', text: 'COMBINED SUMMONS' };
  yield { t: 'p', text: 'To the sheriff or his deputy: inform the Defendant that the Plaintiff institutes action against it for the relief set out in the particulars of claim below.' };
  yield { t: 'h', text: 'PARTICULARS OF CLAIM' };
  const paras = [
    `The Plaintiff and the Defendant concluded a written services agreement on or about ${h.date(2022)}.`,
    `The Plaintiff rendered services to the Defendant between ${h.date(2024, 1)} and ${h.date(2024, 9)}, for which it invoiced ${R(claim)}.`,
    'Despite demand, the Defendant has failed to pay, alleging that the services were not rendered to the agreed standard.',
    'The Plaintiff denies that the services were deficient and says that the Defendant raised no complaint within the 14 days the agreement allows.',
    `WHEREFORE the Plaintiff claims payment of ${R(claim)}, interest at the prescribed rate from the date of demand, and costs of suit.`];
  for (const [i, x] of paras.entries()) yield { t: 'p', text: `${i + 1}. ${x}` };
  yield { t: 'gap' };
  yield { t: 'p', text: `Dated at Johannesburg on ${h.date()}. Plaintiff's attorneys: Odendaal Brackwater Inc.` };
  yield { t: 'h', text: 'NOTE BY THE DEFENDANT\'S ATTORNEYS' };
  yield { t: 'p', text: `${ADVISERS.lawyers} filed a notice of intention to defend. Their assessment is that the claim is likely to settle for between 30% and 50% of the amount claimed.` };
}

// Letters

function* letter(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const as = c.p.as ?? 'regulator';
  const from: Record<string, string> = {
    opinion: ADVISERS.lawyers, demand: legal(c.p.cp ?? 'Grocevia'), broker: ADVISERS.broker, sars: 'South African Revenue Service', regulator: 'National Regulator for Compulsory Specifications',
    renewal: legal(h.pick(['Stenvolk Properties', 'Marravel Property'])), retention: subLegal(c.p.sub ?? 'Drosvelt Holdings'), hedge: `${h.pick(WORDS.bank!)} Ltd, Global Markets`, auditor: ADVISERS.auditor,
  };
  let to = `${P.cfo}, ${HOLDCO}`;
  if (as === 'retention') to = `The ${c.p.role ?? 'operations director'}`;
  else if (as === 'renewal') to = 'Drosvelt Logistics (Pty) Ltd';
  yield { t: 'title', text: from[as]!.toUpperCase() };
  yield { t: 'center', text: as === 'auditor' ? `Independent auditor's report for the year ended 28 February 2023` : h.date() };
  yield { t: 'gap' };
  if (as !== 'auditor') yield { t: 'p', text: `To: ${to}` };
  const subjectOf: Record<string, string> = {
    opinion: `Claim by ${c.p.cp}: prospects and exposure`, demand: 'Letter of demand: overdue account', broker: `Renewal of the group insurance programme with ${c.p.insurer}`,
    sars: `Verification of ${h.pick(['VAT', 'PAYE', 'income tax'])} for the period ${c.p.period ?? c.year}`, regulator: 'Inspection of the vehicle testing records',
    renewal: `Lease of the warehouse at ${c.p.site}: renewal`, retention: 'Retention bonus', hedge: 'Confirmation of a foreign exchange forward contract', auditor: 'Opinion',
  };
  yield { t: 'h', text: subjectOf[as]! };
  const bodies: Record<string, string[]> = {
    opinion: [`You asked for our opinion on the claim of ${R(h.int(20, 200) * 50_000)} that ${c.p.cp} has made against the group.`,
      'Having read the agreement and the correspondence, we think the group has reasonable prospects of defending the larger part of the claim. The service level reports show that the agreed standards were met in 10 of the 12 months.',
      `We estimate the likely outcome at ${pct(h.num(0.2, 0.45), 0)} of the amount claimed, with legal costs to trial of about ${R(h.int(4, 12) * 100_000)}.`,
      'We recommend a without-prejudice offer to settle before the close of pleadings. Please treat this letter as privileged.'],
    demand: [`Our records show that ${R(h.int(4, 90) * 10_000)} is overdue on your account, made up of the invoices in the attached statement.`,
      'Unless the amount is paid within 10 days of this letter, we will refer the matter to our attorneys without further notice.'],
    broker: [`We have placed the renewal of the group's insurance from 1 March ${c.year} with ${c.p.insurer} as lead insurer.`,
      `The total premium is ${R(h.int(60, 140) * 100_000)} including VAT and SASRIA, ${pct(h.num(0.03, 0.09))} more than last year, mainly because of higher fleet claims.`,
      'Insurers have asked that the sprinkler system at the Isando warehouse be serviced before 31 May. We recommend that this is done promptly.'],
    sars: ['SARS has selected the returns for the period above for verification. Please provide the documents below within 21 business days.',
      'Documents: the general ledger, the VAT reconciliation, copies of the ten largest input tax invoices, and the export documents for zero-rated supplies.'],
    regulator: ['During the inspection at the Germiston workshop, the inspector found that roadworthiness records were complete for all vehicles checked.',
      'Two trailers had brake test certificates that had expired by fewer than 14 days. Please confirm that they have been retested.'],
    renewal: [`As the lease of the premises at ${c.p.site} expires on 28 February ${c.year + 1}, we confirm your notice to exercise the option to renew for a further five years.`,
      `The rental for the first year of the renewal period is ${R(h.int(180, 900) * 1000)} a month excluding VAT, as agreed, with annual escalation of 7%.`],
    retention: [`In recognition of your role in the group, and to encourage you to stay during the sale process, the company will pay you a retention bonus of ${R(h.int(2, 12) * 100_000)}.`,
      'Half is payable on completion of a sale of the group, and half six months after completion, as long as you are still employed and have not resigned.',
      'This letter is confidential. Please do not discuss it with colleagues.'],
    hedge: [`We confirm the forward contract below, concluded on ${h.date()}:`],
    auditor: ['We have audited the consolidated financial statements of Drosvelt Holdings (Pty) Ltd and its subsidiaries for the year ended 28 February 2023.',
      'In our opinion they present fairly, in all material respects, the consolidated financial position of the group at 28 February 2023 and its financial performance and cash flows for the year, in accordance with IFRS and the Companies Act.',
      'Key audit matters: revenue recognition on long-term logistics contracts, the measurement of lease liabilities under IFRS 16, and the impairment test of goodwill on the Cold Chain business.',
      'This report is a draft for the audit committee and is not signed.'],
  };
  for (const x of bodies[as]!) yield { t: 'p', text: x };
  if (as === 'hedge') {
    yield { t: 'table', columns: ['Term', 'Detail'], widths: [0.4, 0.6], rows: [['We buy', `USD ${fmt(h.int(2, 30) * 100_000)}`], ['You sell', 'ZAR'],
      ['Forward rate', h.num(17.6, 19.4).toFixed(4)], ['Value date', h.date(c.year, Math.min(11, c.month + 3))], ['Purpose', 'Payment for 12 refrigerated trailers']] };
  }
  yield { t: 'gap' };
  yield { t: 'p', text: as === 'retention' ? `Yours sincerely, ${P.ceo}, chief executive` : `Yours faithfully, ${h.person()}` };
}

// Reports, policies, permits

function* report(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const site = c.p.site ?? h.pick(WORDS.site!);
  const as = c.p.as ?? 'management';
  const titles: Record<string, string> = {
    management: `Management report for ${c.p.period}`, 'business-plan': `Five-year business plan ${c.year} to ${c.year + 5}`, competition: `Merger notification to the Competition Commission ${c.year}`,
    'transfer-pricing': `Transfer pricing documentation ${c.p.fy}`, tender: `Tender submission to ${c.p.cp}`, survey: `Customer satisfaction survey ${c.year}`,
    sla: `Service level report: ${c.p.cp}, ${c.p.period}`, 'key-account': `Key account plan: ${c.p.cp} ${c.year}`, training: `Training plan: ${site} ${c.year}`,
    equity: `Employment equity report ${c.year}`, recovery: `IT disaster recovery plan ${c.year}`, pentest: `External penetration test ${c.year}`,
    valuation: `Valuation of the property at ${site}`, 'env-audit': `Environmental compliance audit: ${site} ${c.year}`, emp: `Environmental management programme: ${site}`,
    patent: `Patent specification: cold chain monitoring (${c.p.mark})`, popia: `POPIA compliance assessment ${c.year}`,
  };
  const by: Record<string, string> = { valuation: ADVISERS.valuer, 'env-audit': ADVISERS.env, emp: ADVISERS.env, pentest: ADVISERS.pentest, 'transfer-pricing': ADVISERS.tax, competition: ADVISERS.lawyers };
  yield { t: 'title', text: titles[as]!.toUpperCase() };
  yield { t: 'center', text: `${HOLDCO}${by[as] ? ` · prepared by ${by[as]}` : ''}` };
  yield { t: 'center', text: h.date() };
  if (c.v > 1) yield { t: 'center', text: `Version ${c.v}: figures updated for the latest month` };
  yield { t: 'gap' };
  const sec: Record<string, [string, string[]][]> = {
    management: [['SUMMARY', [`Revenue for ${c.p.period} was R${h.num(150, 190).toFixed(1)} million, ${pct(h.num(-0.03, 0.06))} against budget. Operating profit was R${h.num(14, 26).toFixed(1)} million.`,
      `Warehouse occupancy averaged ${h.int(84, 96)}% across the network. Fleet utilisation was ${h.int(78, 91)}%.`]],
      ['TRADING', ['Retail volumes were firm ahead of the festive season. Chemicals volumes were lower because one customer moved part of its volume to rail.',
        `The Cold Chain business grew revenue by ${pct(h.num(0.06, 0.18))} year on year.`]],
      ['CASH AND DEBT', [`Cash generated from operations was R${h.num(18, 34).toFixed(1)} million. Debtors days were ${h.int(48, 58)}.`]],
      ['OUTLOOK', ['Management expects the full year to end within 2% of budget.']]],
    'business-plan': [['STRATEGY', ['The group aims to double revenue in five years by growing cold chain, cross-border and contract logistics, and by two bolt-on acquisitions.']],
      ['MARKET', ['The South African contract logistics market is estimated at R95 billion and grows at about 4% a year in real terms. Outsourcing by FMCG and retail customers drives growth.']],
      ['INVESTMENT', [`Capital expenditure of ${rm(h.int(600, 900) * 1e6)} over five years, of which 45% is for fleet renewal and 30% for new warehouse capacity.`]],
      ['RISKS', ['Customer concentration, fuel prices, port and rail performance, and labour relations are the main risks. Each has an owner and a mitigation plan.']]],
    competition: [['THE TRANSACTION', ['The notification concerns the proposed acquisition of control of the Drosvelt group by one of the bidders in Project Heron.']],
      ['THE PARTIES', ['The target provides warehousing, transport and supply chain services in South Africa, Namibia and Botswana.']],
      ['MARKET DEFINITION', ['The relevant markets are contract logistics and road freight services. The combined market share in each is below 15%.']],
      ['PUBLIC INTEREST', ['The acquirer commits to no retrenchments as a result of the merger for two years, and to keep the head office in Germiston.']]],
    'transfer-pricing': [['GROUP STRUCTURE', ['The group consists of the holding company and six operating subsidiaries in South Africa, Namibia and Botswana.']],
      ['INTRA-GROUP TRANSACTIONS', ['Management fees, trade mark royalties, interest on intra-group loans and cross-border transport services.']],
      ['METHOD', [`The transactional net margin method is used for services, with a mark-up of ${h.num(5, 8).toFixed(1)}% on costs, in line with the benchmark range.`]],
      ['CONCLUSION', ['The intra-group transactions are at arm\'s length.']]],
    tender: [['ABOUT DROSVELT', ['Drosvelt operates 14 warehouses with 310,000 square metres and a fleet of 420 vehicles across Southern Africa.']],
      ['PROPOSED SOLUTION', [`A dedicated ${fmt(h.int(12, 40) * 1000)} square metre facility at ${site}, with chilled and ambient chambers and a dedicated fleet of ${h.int(12, 40)} vehicles.`]],
      ['IMPLEMENTATION', ['A 16-week implementation plan, with a joint steering committee and a parallel run of two weeks.']],
      ['COMMERCIAL OFFER', [`Annual cost of ${rm(h.int(25, 120) * 1e6)} excluding VAT, with open-book pricing and a gain-share on savings above 3%.`]]],
    survey: [['METHOD', [`${h.int(80, 140)} customers were surveyed by telephone and online in ${MONTHS[c.month]} ${c.year}; ${h.int(60, 80)}% responded.`]],
      ['RESULTS', [`The net promoter score was ${h.int(28, 52)}, up from ${h.int(20, 40)} the year before. Customers rated delivery reliability highest and invoicing accuracy lowest.`]],
      ['ACTIONS', ['Invoice disputes will be resolved within 10 days. Account managers will hold quarterly reviews with the top 40 customers.']]],
    sla: [['PERFORMANCE', [`On-time delivery was ${pct(h.num(0.93, 0.99))} against a target of 95%. Order accuracy was ${pct(h.num(0.993, 0.999), 2)}.`]],
      ['EXCEPTIONS', [`${h.int(1, 9)} loads were late because of the port backlog at Durban. ${h.int(0, 3)} claims for damaged goods were lodged.`]]],
    'key-account': [['ACCOUNT OVERVIEW', [`${c.p.cp} spent ${rm(h.int(20, 140) * 1e6)} with the group last year, mainly on warehousing at ${site}.`]],
      ['OBJECTIVES', ['Renew the contract for five years, add the Namibian distribution, and move the customer onto the new transport management system.']],
      ['RELATIONSHIP MAP', [`Executive sponsor: ${P.sales}. Day-to-day: ${h.person()}. The customer's supply chain director is the decision maker.`]],
      ['RISKS', ['A competitor has offered rail-based pricing for the inland routes. A price review is planned for the second quarter.']]],
    training: [['PRIORITIES', ['Forklift and reach truck licences, dangerous goods handling, first aid, and the supervisor development programme.']],
      ['BUDGET', [`The training budget for ${site} is ${R(h.int(300, 1400) * 1000)}, of which 60% is recoverable from the sector education and training authority.`]]],
    equity: [['WORKFORCE PROFILE', [`The group employs ${fmt(h.int(2300, 2900))} people. The plan targets 50% women in management by ${c.year + 3}.`]],
      ['BARRIERS', ['Few women apply for driver and workshop posts. A learnership for women drivers started this year.']]],
    recovery: [['SCOPE', ['The plan covers the warehouse and transport management systems, finance, payroll and email.']],
      ['RECOVERY TARGETS', ['Warehouse management: recovery time 4 hours, data loss at most 15 minutes. Finance and payroll: 24 hours and 1 hour.']],
      ['TESTS', [`The last full failover test was on ${h.date()}. All systems were restored within their targets except the label printers at Isando.`]]],
    pentest: [['SCOPE', ['Internet-facing systems: the customer portal, VPN gateways, email and the tracking API.']],
      ['SUMMARY', [`${h.int(0, 1)} critical, ${h.int(1, 4)} high, ${h.int(3, 9)} medium and ${h.int(5, 14)} low findings. No customer data could be reached.`]],
      ['RECOMMENDATIONS', ['Enforce multi-factor sign-in on the VPN for all users, patch the reverse proxy, and remove the old test sub-domain.']]],
    valuation: [['THE PROPERTY', [`A distribution warehouse at ${h.address(site)}, built in ${h.int(1998, 2016)} and extended in ${h.int(2017, 2023)}, on an erf of ${fmt(h.int(15000, 60000))} square metres.`]],
      ['MARKET', [`Comparable industrial rentals in the area range from R${h.int(55, 70)} to R${h.int(75, 95)} per square metre a month. Capitalisation rates are between 9.0% and 10.5%.`]],
      ['VALUATION', [`On the income method, the market value at ${h.date()} is ${rm(h.int(60, 320) * 1e6)}, excluding VAT.`]]],
    'env-audit': [['PURPOSE', [`An audit of compliance with the licences and permits of the ${site} site.`]],
      ['FINDINGS', [`Compliance was ${pct(h.num(0.82, 0.96), 0)} of the conditions audited. The bunded diesel tanks and the oil separator were in good order.`,
        'The stormwater management plan is out of date and must be revised. Waste manifests were missing for two months.']],
      ['RECOMMENDATIONS', ['Revise the stormwater plan within 90 days; file waste manifests monthly; train two more staff in spill response.']]],
    emp: [['ACTIVITIES', ['Warehousing, refuelling, vehicle washing and the storage of small quantities of dangerous goods.']],
      ['IMPACTS AND MITIGATION', ['Spills: bunding and spill kits. Noise: no reversing alarms between 22:00 and 05:00. Dust: paved yards and sweeping.']],
      ['MONITORING', ['Monthly visual inspections, quarterly stormwater samples, and an annual external audit.']]],
    patent: [['FIELD', ['The invention relates to monitoring the temperature of goods in transit and in storage.']],
      ['SUMMARY', ['A sensor tag records temperature every minute and sends an alert through the tracking system when a limit is passed, with the location of the load.']],
      ['CLAIMS', ['1. A system for monitoring perishable goods, comprising sensor tags, a gateway in each vehicle and a central server.', '2. The system of claim 1, wherein alerts are sent within 60 seconds.']]],
    popia: [['SCOPE', ['Personal information of employees, drivers, customers\' consignees and visitors, at all sites and in all systems.']],
      ['FINDINGS', [`${h.int(10, 20)} of ${h.int(22, 26)} controls are in place. Gaps: retention schedules, operator agreements with two suppliers, and the CCTV notices at Walvis Bay.`]],
      ['ACTION PLAN', ['Each gap has an owner and a date. The information officer reports progress to the audit committee every quarter.']]],
  };
  yield { t: 'h', text: 'INTRODUCTION' };
  yield { t: 'p', text: `This report was prepared for the ${['management', 'sla', 'key-account', 'training'].includes(as) ? 'executive committee' : 'board'} of ${HOLDCO}. It covers the period to ${h.date()} and is based on the group's records and on discussions with management.` };
  yield { t: 'h', text: 'SCOPE AND APPROACH' };
  yield { t: 'p', text: `${by[as] ? `${by[as]} reviewed` : 'The authors reviewed'} the documents listed in the appendix, visited ${h.pick(['the site', 'two sites', 'the head office and the main warehouses'])} and interviewed the people responsible. Figures are unaudited unless stated otherwise.` };
  yield { t: 'p', text: 'Matters that need a decision or follow-up are marked as actions and carried into the action plan, with an owner and a date.' };
  for (const [head, texts] of sec[as]!) {
    yield { t: 'h', text: head };
    for (const x of texts) yield { t: 'p', text: x };
  }
  yield { t: 'h', text: 'CONCLUSION' };
  yield { t: 'p', text: h.pick(['Overall the position is sound, and the actions in the appendix address the gaps found.', 'The findings are within the risk appetite of the group, provided the actions are completed by the dates agreed.',
    'Management agrees with the findings and has started on the actions.']) };
  const tables: Record<string, () => Block> = {
    management: () => ({ t: 'table', columns: ['R thousand', 'Actual', 'Budget', 'Prior year'], rows: ['Revenue', 'Gross profit', 'Operating costs', 'EBITDA', 'Operating profit']
      .map((l) => { const a = h.num(10, 180) * 1000; return [l, fmt(a), fmt(a * h.num(0.95, 1.05)), fmt(a * h.num(0.88, 0.99))]; }) }),
    'business-plan': () => ({ t: 'table', columns: ['R million', ...Array.from({ length: 5 }, (_, i) => `FY${c.year + 1 + i}`)], rows: ['Revenue', 'EBITDA', 'Capital expenditure', 'Free cash flow']
      .map((l, k) => [l, ...Array.from({ length: 5 }, (_, i) => fmt([2050, 330, 140, 120][k]! * 1.13 ** i * h.num(0.97, 1.03)))]) }),
    sla: () => ({ t: 'table', columns: ['Measure', 'Target', 'Actual'], rows: [['On-time collection', '97%', pct(h.num(0.94, 0.99))], ['On-time delivery', '95%', pct(h.num(0.93, 0.99))],
      ['Order accuracy', '99.5%', pct(h.num(0.993, 0.999))], ['Stock accuracy', '99.8%', pct(h.num(0.996, 0.9995))], ['Claims as % of revenue', '0.10%', pct(h.num(0.0004, 0.0015), 2)]] }),
    pentest: () => ({ t: 'table', columns: ['Finding', 'Severity', 'System', 'Status'], widths: [0.46, 0.14, 0.24, 0.16], rows: Array.from({ length: 8 }, () => [
      h.pick(['Outdated TLS configuration', 'Directory listing enabled', 'Weak password policy on VPN', 'Missing security headers', 'Verbose error messages', 'Open SMB port on test server']),
      h.pick(['High', 'Medium', 'Low']), h.pick(['Customer portal', 'VPN gateway', 'Tracking API', 'Mail gateway']), h.pick(['Open', 'Fixed', 'Accepted'])]) }),
    equity: () => ({ t: 'table', columns: ['Occupational level', 'Male', 'Female', 'Total'], rows: ['Top management', 'Senior management', 'Professionals', 'Skilled', 'Semi-skilled', 'Unskilled']
      .map((l, i) => { const m = h.int(4, 90) * (i + 1); const f = h.int(2, 60) * (i + 1); return [l, String(m), String(f), String(m + f)]; }) }),
    survey: () => ({ t: 'table', columns: ['Question', 'Score out of 5', 'Last year'], rows: ['Delivery reliability', 'Communication', 'Invoicing accuracy', 'Value for money', 'Account management', 'Systems and reporting']
      .map((q) => [q, h.num(3.2, 4.6).toFixed(1), h.num(3.0, 4.4).toFixed(1)]) }),
  };
  const rows = 6 + Math.min(14, c.d.pages * 2);
  const actions = (): Block => ({ t: 'table', columns: ['Action', 'Owner', 'Due', 'Status'], widths: [0.46, 0.22, 0.16, 0.16], rows: Array.from({ length: rows }, (_, i) => [
    `${['Review', 'Update', 'Test', 'Train staff on', 'Report on', 'Close out'][i % 6]} ${['procedures', 'controls', 'records', 'equipment', 'the open findings'][h.int(0, 4)]}`,
    h.pick(Object.values(P)), h.date(), h.pick(['Open', 'In progress', 'Done'])]) });
  const documents = (): Block => ({ t: 'table', columns: ['Document', 'Date', 'Source'], widths: [0.56, 0.2, 0.24], rows: Array.from({ length: Math.min(rows, 12) }, () => [
    h.pick(['Management accounts', 'Board minutes', 'Site register', 'Licence conditions', 'Customer contract', 'Incident log', 'Asset register', 'Policy manual', 'Previous report']), h.date(), h.pick(['Finance', 'Company secretary', 'Site manager', 'IT', 'HR'])]) });
  const people = (): Block => ({ t: 'table', columns: ['Name', 'Role', 'Date'], widths: [0.34, 0.44, 0.22], rows: [
    [P.cfo, 'Chief financial officer', h.date()], [P.ops, 'Operations director', h.date()], [P.it, 'IT manager', h.date()], [h.person(), `Site manager ${site}`, h.date()], [h.person(), 'Safety officer', h.date()]] });
  const appendices: [string, () => Block][] = [...(tables[as] ? [['DETAILED FIGURES', tables[as]!] as [string, () => Block]] : []),
    ['ACTION PLAN', actions], ['DOCUMENTS REVIEWED', documents], ['PEOPLE INTERVIEWED', people]];
  for (const [a, [title, make]] of appendices.slice(0, Math.max(1, Math.min(appendices.length, c.d.pages - 2))).entries()) {
    yield { t: 'h', text: `APPENDIX ${a + 1}: ${title}` };
    yield make();
  }
}

function* policy(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const as = c.p.as ?? 'hr';
  const topic = c.p.hrPolicy ?? c.p.itPolicy;
  const titles: Record<string, string> = {
    hr: `Policy on ${topic}`, it: `IT policy on ${topic}`, doa: `Delegation of authority ${c.year}`, moi: `Memorandum of incorporation of ${subLegal(c.p.sub)}`,
    'share-scheme': `Rules of the Drosvelt share incentive scheme ${c.year}`, pension: `Rules of the ${c.p.sub ?? 'Drosvelt'} Pension Fund`, medical: `Medical aid scheme summary ${c.year}`,
    privacy: `Privacy policy ${c.year}`, paia: `Manual in terms of section 51 of the Promotion of Access to Information Act ${c.year}`,
  };
  yield { t: 'title', text: titles[as]!.toUpperCase() };
  yield { t: 'center', text: `${HOLDCO} and its subsidiaries` };
  let owner = P.cosec;
  if (as === 'it') owner = P.it;
  else if (as === 'hr' || as === 'medical' || as === 'pension') owner = P.hr;
  yield { t: 'center', text: `Approved by the ${as === 'moi' ? 'shareholders' : 'board'} on ${h.date()} · Owner: ${owner}` };
  yield { t: 'gap' };
  const generic = (subject: string): [string, string[]][] => [
    ['PURPOSE', [`This policy sets out how the group deals with ${subject}, so that employees know what is expected of them and decisions are consistent.`]],
    ['SCOPE', ['It applies to all employees, contractors and temporary staff of the group in South Africa, Namibia and Botswana.']],
    ['RESPONSIBILITIES', ['Line managers apply the policy and keep records. Human Resources advises and monitors. The executive committee reviews the policy every two years.']],
    ['PROCEDURE', [`Requests and reports about ${subject} are made in writing to the employee's line manager, or through the HR self-service portal.`,
      'The line manager responds within five working days and records the outcome.', 'Where the line manager is involved, the request goes to the next level of management.']],
    ['BREACHES', ['A breach of this policy may lead to disciplinary action under the disciplinary code.']],
    ['REVIEW', [`This policy was last reviewed in ${MONTHS[c.month]} ${c.year}.`]]];
  const sections: Record<string, [string, string[]][]> = {
    hr: generic(topic ?? 'this subject'),
    it: [...generic(topic ?? 'information technology').slice(0, 3), ['RULES', [
      { 'acceptable use': 'Company systems are for business use. Limited personal use is allowed if it does not interfere with work or breach the law.',
        'access control': 'Access is granted on the principle of least privilege, approved by the system owner and reviewed every six months.',
        backup: 'Critical systems are backed up every night to a second data centre and monthly to offline storage. Restores are tested quarterly.',
        'incident response': 'Security incidents are reported to the IT service desk at once. The IT manager decides within one hour whether the incident response team is called.',
        'remote working': 'Remote access is through the company VPN with multi-factor sign-in only. Company data may not be stored on personal devices.',
        password: 'Passwords have at least 14 characters. Multi-factor sign-in is required for email, VPN and all finance systems.',
        'change management': 'Changes to production systems are logged, tested and approved by the change board, except emergency changes, which are reviewed afterwards.' }[topic ?? 'password'] ?? '']]],
    doa: [['PRINCIPLES', ['Authority is delegated by the board to the chief executive and onwards. Each limit is per transaction, and splitting a transaction to avoid a limit is not allowed.']],
      ['LIMITS', ['The table below sets out who may approve what. Amounts exclude VAT.']]],
    moi: [['INTERPRETATION', ['Words defined in the Companies Act 71 of 2008 have the same meaning in this memorandum.']], ['SHARES', ['The company is authorised to issue 10,000,000 ordinary shares of no par value.']],
      ['DIRECTORS', ['The board consists of at least three and at most nine directors. One third of the non-executive directors retire by rotation each year.']],
      ['SHAREHOLDER MEETINGS', ['A shareholders meeting may be held by electronic communication. The quorum is shareholders holding 25% of the voting rights.']],
      ['RESTRICTIONS ON TRANSFER', ['No share may be transferred without the approval of the board, which may not be unreasonably withheld.']],
      ['FINANCIAL ASSISTANCE', ['The board may authorise financial assistance under sections 44 and 45 of the Act, subject to a special resolution.']]],
    'share-scheme': [['PURPOSE', ['The scheme lets senior employees share in the growth in value of the group.']], ['PARTICIPANTS', ['Employees at Paterson grade E and above, as the remuneration committee selects.']],
      ['AWARDS', ['Share appreciation rights vest in three equal tranches after three, four and five years.']],
      ['CHANGE OF CONTROL', ['On a change of control of Drosvelt Holdings, all unvested rights vest in full and are settled in cash within 30 days.']],
      ['LEAVERS', ['Good leavers keep vested rights; bad leavers lose all rights, vested or not.']]],
    pension: [['MEMBERSHIP', ['All permanent employees join the fund on appointment.']], ['CONTRIBUTIONS', ['Members contribute 7.5% and the employer 10% of pensionable salary.']],
      ['BENEFITS', ['On retirement at 63, the member\'s share of the fund is paid, of which at least two thirds buys an annuity.']], ['DEATH AND DISABILITY', ['Death cover of three times annual salary and disability income of 75% of salary are insured.']]],
    medical: [['SCHEME', [`Employees may join one of three options of the Thandeka Medical Scheme. The company pays ${h.int(50, 70)}% of the contribution up to a limit.`]],
      ['OPTIONS', ['The table below shows the monthly contributions for each option.']]],
    privacy: [['WHO WE ARE', [`${HOLDCO} and its subsidiaries are responsible parties under POPIA.`]], ['WHAT WE COLLECT', ['Names, contact details, delivery addresses, vehicle tracking data and CCTV footage at our sites.']],
      ['WHY', ['To deliver goods, manage our sites safely, meet legal obligations and improve our services.']], ['YOUR RIGHTS', ['You may ask for access to or correction of your information, or object to its use, by writing to the information officer.']]],
    paia: [['INTRODUCTION', ['This manual explains how to request access to records of the group under the Promotion of Access to Information Act.']],
      ['CONTACT DETAILS', [`Information officer: ${P.cfo}. Requests are sent to the head office, ${h.address('Germiston')}.`]],
      ['RECORDS', ['Company records, financial records, human resources records, customer records and supplier records.']], ['FEES', ['A request fee of R140 is payable, and an access fee as the regulations provide.']]],
  };
  let n = 0;
  for (const [head, texts] of sections[as]!) {
    n++;
    yield { t: 'h', text: `${n}. ${head}` };
    for (const [i, x] of texts.entries()) yield { t: 'p', text: `${n}.${i + 1} ${x}` };
  }
  if (as === 'doa') {
    yield { t: 'table', columns: ['Matter', 'Board', 'Chief executive', 'CFO', 'Site manager'], widths: [0.4, 0.15, 0.15, 0.15, 0.15], rows: [
      ['Capital expenditure', '> R25m', 'R25m', 'R5m', 'R250k'], ['New customer contracts (annual value)', '> R100m', 'R100m', 'R25m', '-'], ['Supplier contracts', '> R50m', 'R50m', 'R10m', 'R500k'],
      ['Write-off of debtors', '> R2m', 'R2m', 'R500k', '-'], ['Appointments', 'Executives', 'Senior managers', 'Finance staff', 'Site staff'], ['Litigation', 'All above R5m', 'Up to R5m', '-', '-']] };
  }
  if (as === 'medical') {
    yield { t: 'table', columns: ['Option', 'Main member', 'Adult dependant', 'Child'], rows: [['Essential', R(h.int(1800, 2400)), R(h.int(1500, 2000)), R(h.int(500, 800))],
      ['Comprehensive', R(h.int(3800, 4800)), R(h.int(3000, 4000)), R(h.int(900, 1300))], ['Hospital plan', R(h.int(1200, 1700)), R(h.int(1000, 1400)), R(h.int(350, 550))]] };
  }
  if (['moi', 'share-scheme', 'pension', 'paia'].includes(as)) {
    const closing: [string, string[]][] = [
      ['DEFINITIONS', ['"Board" means the board of directors of the company or, for the fund, its board of trustees.', '"Business day" means any day other than a Saturday, Sunday or public holiday in South Africa.']],
      ['RECORDS', ['Records are kept for at least seven years at the registered office.', 'Members may inspect the records that concern them on reasonable notice.']],
      ['NOTICES', ['Notices are given in writing and delivered by hand or sent by email to the address last given.', 'A notice sent by email is received on the next business day.']],
      ['AMENDMENTS', ['Any amendment needs a special resolution and is filed with the Commission within 10 business days.', 'No amendment may reduce benefits already earned.']],
      ['DISPUTES', ['A dispute about these rules is referred to the board first, and then to arbitration in Johannesburg.']],
      ['GENERAL', ['Where these rules are silent, the Companies Act applies.', 'Headings are for convenience only.']]];
    for (const [head, texts] of closing.slice(0, Math.max(2, c.d.pages - 2))) {
      n++;
      yield { t: 'h', text: `${n}. ${head}` };
      for (const [i, x] of texts.entries()) yield { t: 'p', text: `${n}.${i + 1} ${x}` };
    }
  }
}

function* permit(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const site = c.p.site ?? 'Germiston';
  const as = c.p.as ?? 'water';
  const issuer: Record<string, string> = {
    water: 'Department of Water and Sanitation', waste: `${site.split(' ')[0]} Metropolitan Municipality, Waste Management`, air: `${site.split(' ')[0]} Air Quality Officer`,
    customs: 'South African Revenue Service, Customs and Excise', crossborder: 'Cross-Border Road Transport Agency', 'dangerous-goods': 'Department of Transport',
  };
  const titles: Record<string, string> = {
    water: 'WATER USE LICENCE', waste: 'WASTE MANAGEMENT LICENCE', air: 'ATMOSPHERIC EMISSION LICENCE', customs: 'LICENCE AS A CUSTOMS BONDED WAREHOUSE AND CLEARING AGENT',
    crossborder: 'CROSS-BORDER ROAD TRANSPORT PERMIT', 'dangerous-goods': 'DANGEROUS GOODS OPERATOR LICENCE',
  };
  yield { t: 'title', text: titles[as]! };
  yield { t: 'center', text: issuer[as]!, bold: true };
  yield { t: 'gap' };
  yield { t: 'table', columns: ['Detail', ''], widths: [0.35, 0.65], rows: [['Holder', subLegal(as === 'customs' ? c.p.sub : 'Drosvelt Logistics')], ['Site', as === 'customs' ? 'Germiston and Durban harbour' : `${h.address(site)}`],
    ['Licence number', `${as.slice(0, 2).toUpperCase()}/${h.int(2018, 2025)}/${h.int(10000, 99999)}`], ['Issued', h.date(h.int(2019, 2025))], ['Valid until', h.date(h.int(2027, 2031))]] };
  const conditions: Record<string, string[]> = {
    water: [`The holder may abstract up to ${fmt(h.int(20, 120) * 1000)} cubic metres a year from the borehole on the site.`, 'Stormwater from the yard passes through the oil separator before it leaves the site.',
      'Water quality is sampled every quarter and the results sent to the regional office.'],
    waste: ['Hazardous waste is stored in a bunded area for no longer than 90 days before removal by a licensed contractor.', 'Safe disposal certificates are kept for five years.'],
    air: ['The standby generators may run for testing for at most 2 hours a week.', 'Emissions from the boiler are measured once a year by an accredited laboratory.'],
    customs: ['Goods in bond are kept apart from other goods and recorded in the bond register.', `Security of ${R(h.int(1, 5) * 1e6)} is lodged with SARS.`],
    crossborder: [`Valid for ${h.int(10, 60)} vehicles on routes to Namibia, Botswana and Zimbabwe.`, 'A copy of the permit is carried in each vehicle.'],
    'dangerous-goods': ['Only drivers with a valid dangerous goods professional driving permit may carry Class 3 and Class 8 goods.', 'Vehicles carry the emergency information system and two fire extinguishers.'],
  };
  yield { t: 'h', text: 'CONDITIONS' };
  for (const [i, x] of [...conditions[as]!, 'The holder reports any incident that affects compliance within 24 hours.', 'This licence may be suspended if a condition is breached.'].entries())
    yield { t: 'p', text: `${i + 1}. ${x}` };
  if (as === 'crossborder' || as === 'dangerous-goods') {
    yield { t: 'h', text: 'VEHICLES' };
    yield { t: 'table', columns: ['Registration', 'Make', 'Type', 'Year'], rows: Array.from({ length: h.int(8, 16) }, () => [
      `${h.pick(['JHB', 'KZN', 'GP'])} ${h.int(100, 999)} ${h.pick(['GP', 'ZN', 'WC'])}`, h.pick(['Kestwin', 'Vargo', 'Nordhauler']), h.pick(['Truck tractor', 'Rigid 8-ton', 'Tanker', 'Reefer trailer']), String(h.int(2016, 2025))]) };
  }
}

function* taxReturn(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const company = subLegal(c.p.sub);
  const as = c.p.as ?? 'vat201';
  yield { t: 'title', text: { vat201: 'VAT201: VALUE-ADDED TAX RETURN', itr14: 'ITR14: INCOME TAX RETURN FOR COMPANIES', irp6: 'IRP6: PROVISIONAL TAX RETURN', emp501: 'EMP501: EMPLOYER RECONCILIATION DECLARATION' }[as]! };
  yield { t: 'center', text: `${company} · ${c.p.period ?? `${c.year}`}`, bold: true };
  yield { t: 'center', text: `Submitted on eFiling on ${h.date()}` };
  yield { t: 'gap' };
  const f = (lo: number, hi: number) => fmt(h.num(lo, hi), 2);
  const rows: Record<string, string[][]> = {
    vat201: [['1', 'Standard-rated supplies (excl. capital goods)', f(90e6, 160e6)], ['2', 'Zero-rated supplies (exports)', f(5e6, 18e6)], ['4', 'Output tax', f(13e6, 24e6)],
      ['14', 'Capital goods and services supplied to you', f(1e6, 9e6)], ['15', 'Other goods and services supplied to you', f(50e6, 90e6)], ['19', 'Total input tax', f(8e6, 15e6)], ['20', 'VAT payable', f(3e6, 9e6)]],
    itr14: [['Gross income', '', f(1.6e9, 2.2e9)], ['Deductions', '', f(1.4e9, 1.9e9)], ['Wear and tear allowances', 'Section 11(e)', f(70e6, 120e6)], ['Taxable income', '', f(90e6, 180e6)],
      ['Normal tax at 27%', '', f(24e6, 48e6)], ['Provisional payments', '', f(24e6, 48e6)]],
    irp6: [['Estimated taxable income', '', f(90e6, 180e6)], ['Tax on estimate', '', f(24e6, 48e6)], ['Less: first payment', '', f(12e6, 24e6)], ['Amount payable', '', f(12e6, 24e6)]],
    emp501: [['PAYE', 'Employees\' tax withheld', f(60e6, 110e6)], ['UIF', 'Unemployment insurance', f(3e6, 6e6)], ['SDL', 'Skills development levy', f(6e6, 11e6)], ['ETI', 'Employment tax incentive claimed', f(0.5e6, 2e6)],
      ['IRP5 certificates', 'Issued', String(h.int(2300, 2900))]],
  };
  yield { t: 'table', columns: ['Field', 'Description', 'Amount (R)'], widths: [0.2, 0.55, 0.25], rows: rows[as]! };
  yield { t: 'p', text: `Declaration: I declare that the information in this return is true and correct. ${P.fd}, public officer.` };
  if (as === 'itr14') {
    yield { t: 'h', text: 'TAX COMPUTATION SUMMARY' };
    yield { t: 'table', columns: ['Item', 'Amount (R)'], widths: [0.7, 0.3], rows: [['Accounting profit before tax', f(110e6, 200e6)], ['Add: non-deductible expenses', f(2e6, 8e6)],
      ['Add: depreciation', f(80e6, 140e6)], ['Less: wear and tear', f(70e6, 120e6)], ['Less: section 24C allowance', f(1e6, 5e6)], ['Taxable income', f(90e6, 180e6)]] };
  }
}

function* bankStatement(c: Ctx): Generator<Block> {
  const h = helpers(c);
  let bal = h.num(20e6, 80e6);
  yield { t: 'title', text: `${(c.p.bank ?? 'Umbila Bank').toUpperCase()} LTD` };
  yield { t: 'center', text: `Business current account statement · ${c.p.period}`, bold: true };
  yield { t: 'center', text: `${HOLDCO} · account ${h.int(40, 69)}${h.int(10000000, 99999999)}` };
  yield { t: 'gap' };
  yield { t: 'p', text: `Opening balance: ${R(bal, 2)}` };
  const days = 28;
  for (let page = 0; page < 6; page++) {
    const rows: string[][] = [];
    for (let i = 0; i < 26; i++) {
      const credit = h.r() < 0.45;
      const amt = credit ? h.num(150_000, 9_000_000) : -h.num(20_000, 4_000_000);
      bal += amt;
      rows.push([`${Math.min(days, 1 + Math.floor((page * 26 + i) / 5))} ${MONTHS[c.month]!.slice(0, 3)}`,
        credit ? `Receipt ${h.pick(WORDS.cp!)}` : h.pick(['Salaries', 'Diesel card settlement', 'SARS VAT', 'Lease rental', 'Supplier payment', 'Tyres and parts', 'Toll fees', 'Insurance premium']),
        credit ? '' : fmt(-amt, 2), credit ? fmt(amt, 2) : '', fmt(bal, 2)]);
    }
    yield { t: 'table', columns: ['Date', 'Description', 'Debit', 'Credit', 'Balance'], widths: [0.12, 0.4, 0.16, 0.16, 0.16], rows };
  }
}

function* insuranceSchedule(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const fleet = c.p.as === 'fleet';
  yield { t: 'title', text: fleet ? `FLEET INSURANCE SCHEDULE ${c.year}` : 'POLICY SCHEDULE' };
  yield { t: 'center', text: `${c.p.insurer ?? 'Varsure'} · insured: ${HOLDCO} and subsidiaries`, bold: true };
  yield { t: 'center', text: `Period of insurance: 1 March ${c.year} to 28 February ${c.year + 1} · broker: ${ADVISERS.broker}` };
  yield { t: 'gap' };
  if (fleet) {
    yield { t: 'table', columns: ['Category', 'Vehicles', 'Sum insured (R)', 'Excess'], rows: [['Truck tractors', String(h.int(140, 220)), fmt(h.int(250, 400) * 1e6), '5% min R25 000'],
      ['Rigid trucks', String(h.int(80, 140)), fmt(h.int(60, 120) * 1e6), '5% min R15 000'], ['Trailers', String(h.int(200, 320)), fmt(h.int(90, 160) * 1e6), 'R10 000'],
      ['Light delivery vehicles', String(h.int(30, 60)), fmt(h.int(12, 25) * 1e6), 'R5 000']] };
    yield { t: 'p', text: `Third-party liability: ${R(20e6)} each event. Goods in transit: ${R(h.int(2, 5) * 1e6)} each load.` };
  } else {
    yield { t: 'table', columns: ['Section', 'Sum insured or limit (R)', 'Excess (R)', 'Premium (R)'], rows: [['Buildings', fmt(h.int(600, 900) * 1e6), '50 000', fmt(h.int(800, 1400) * 1000)],
      ['Stock and contents', fmt(h.int(300, 600) * 1e6), '50 000', fmt(h.int(500, 900) * 1000)], ['Business interruption (18 months)', fmt(h.int(400, 700) * 1e6), '72 hours', fmt(h.int(400, 800) * 1000)],
      ['Public liability', fmt(100e6), '25 000', fmt(h.int(150, 300) * 1000)], ['Directors and officers', fmt(50e6), '100 000', fmt(h.int(200, 400) * 1000)], ['Cyber', fmt(25e6), '250 000', fmt(h.int(180, 350) * 1000)]] };
  }
  yield { t: 'h', text: 'SITES' };
  yield { t: 'table', columns: ['Site', 'Construction', 'Sprinklered', 'Sum insured (R)'], rows: WORDS.site!.map((s) => [s, h.pick(['Steel portal frame', 'Concrete tilt-up']), h.pick(['Yes', 'Yes', 'No']), fmt(h.int(30, 180) * 1e6)]) };
  yield { t: 'h', text: 'SPECIAL CONDITIONS' };
  for (const x of ['Sprinkler systems are serviced every six months by an accredited contractor.', 'Vehicles carry tracking devices that are monitored at all times.', 'Stock of Class 3 flammable liquids is kept in the separate dangerous goods store.'])
    yield { t: 'li', text: x };
}

function* chart(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const as = c.p.as ?? 'group';
  const titles: Record<string, string> = { group: `Group structure ${c.year}`, org: `Organisation chart: ${subLegal(c.p.sub)} ${c.year}`, network: `Network diagram: ${c.p.site}`, plans: `Building plans: ${c.p.site}` };
  yield { t: 'title', text: titles[as]!.toUpperCase() };
  yield { t: 'center', text: HOLDCO };
  yield { t: 'gap' };
  if (as === 'group') {
    yield { t: 'table', columns: ['Company', 'Country', 'Held by', 'Shareholding', 'Business'], widths: [0.28, 0.13, 0.25, 0.12, 0.22], rows: [
      ['Drosvelt Holdings (Pty) Ltd', 'South Africa', 'Heron Investments (Pty) Ltd', '100%', 'Holding company'], ['Drosvelt Logistics (Pty) Ltd', 'South Africa', 'Drosvelt Holdings', '100%', 'Transport'],
      ['Drosvelt Packaging (Pty) Ltd', 'South Africa', 'Drosvelt Holdings', '100%', 'Contract packing'], ['Drosvelt Properties (Pty) Ltd', 'South Africa', 'Drosvelt Holdings', '100%', 'Property'],
      ['Drosvelt Cold Chain (Pty) Ltd', 'South Africa', 'Drosvelt Holdings', '80%', 'Chilled and frozen'], ['Drosvelt Namibia (Pty) Ltd', 'Namibia', 'Drosvelt Logistics', '100%', 'Transport, Walvis Bay'],
      ['Drosvelt Botswana (Pty) Ltd', 'Botswana', 'Drosvelt Logistics', '74%', 'Transport, Gaborone']] };
    yield { t: 'p', text: 'The remaining 20% of Drosvelt Cold Chain is held by Heron Management Partners (Pty) Ltd, and 26% of Drosvelt Botswana by Tsholofelo Holdings (Pty) Ltd, as local law requires.' };
  } else if (as === 'org') {
    const rows = [[P.ceo, 'Chief executive', 'Board'], [P.cfo, 'Chief financial officer', P.ceo], [P.ops, 'Operations director', P.ceo], [P.sales, 'Head of sales', P.ceo], [P.hr, 'Group HR manager', P.ceo],
      [P.it, 'IT manager', P.cfo], [P.fd, 'Finance director', P.cfo], [P.fm, 'Financial manager', P.fd], [P.fleet, 'Fleet manager', P.ops]];
    for (const s of WORDS.site!.slice(0, 8)) rows.push([h.person(), `Site manager ${s}`, P.ops]);
    yield { t: 'table', columns: ['Name', 'Role', 'Reports to'], widths: [0.3, 0.4, 0.3], rows };
  } else if (as === 'network') {
    yield { t: 'table', columns: ['Device', 'Location', 'Link', 'Bandwidth'], rows: [['Core switch', 'Server room', 'Fibre to data centre', '1 Gbps'], ['Firewall pair', 'Server room', 'Internet (primary)', '500 Mbps'],
      ['Firewall pair', 'Server room', 'Internet (LTE backup)', '50 Mbps'], ['Wireless controllers', 'Warehouse', `${h.int(18, 40)} access points`, '-'], ['Scanner network', 'Warehouse', 'VLAN 30', '-'], ['CCTV', 'Yard and gates', 'VLAN 40', '-']] };
  } else {
    yield { t: 'table', columns: ['Drawing', 'Title', 'Revision', 'Approved'], widths: [0.16, 0.5, 0.14, 0.2], rows: Array.from({ length: 14 }, (_, i) => [
      `A-${String(100 + i)}`, ['Site plan', 'Ground floor plan', 'Mezzanine plan', 'Roof plan', 'Elevations north and south', 'Elevations east and west', 'Sections', 'Dock levellers', 'Cold store chambers', 'Fire layout', 'Stormwater', 'Electrical layout', 'Racking layout', 'Office fit-out'][i]!,
      String.fromCharCode(65 + h.int(0, 4)), h.date(h.int(2015, 2023))]) };
  }
}

// Workbooks

function numberIn(x: Cell | undefined): number {
  if (typeof x === 'number') return x;
  if (x && typeof x === 'object' && typeof x.v === 'number') return x.v;
  return 0;
}

function totalled(name: string, title: string, columns: string[], rows: Cell[][], sumFrom = 1, label = 'Total', widths?: number[]): Sheet {
  const first = 4;
  const last = first + rows.length - 1;
  const total: Cell[] = columns.map((_, i) => {
    if (i === 0) return { v: label, bold: true };
    if (i < sumFrom) return null;
    const v = rows.reduce((s, r) => s + numberIn(r[i]), 0);
    const col = String.fromCharCode(65 + i);
    return { v: Math.round(v), f: `SUM(${col}${first}:${col}${last})`, bold: true };
  });
  return { name, title, columns, rows: [...rows, total], widths };
}

function sheets(c: Ctx): Sheet[] {
  const h = helpers(c);
  const kind = c.d.kind;
  const period = c.p.period ?? `${c.year}`;
  const k = (lo: number, hi: number) => Math.round(h.num(lo, hi));
  switch (kind) {
    case 'mgmt-accounts': {
      const lines: [string, number][] = [['Revenue', 168_000], ['Cost of sales', -118_000], ['Staff costs', -21_000], ['Fuel', -9_800], ['Property costs', -3_200], ['Other operating costs', -4_100]];
      const rows: Cell[][] = lines.map(([l, base]) => { const a = Math.round(base * h.num(0.94, 1.06)); const b = Math.round(base); return [l, a, b, { v: a - b, f: '' }, Math.round(a * (c.month + 1) * 0.98), Math.round(b * (c.month + 1))]; });
      rows.forEach((r, i) => { (r[3] as { f: string }).f = `B${4 + i}-C${4 + i}`; });
      const pl = totalled('Income statement', `Drosvelt Holdings group: income statement for ${period} (R thousand)`, ['Line', 'Actual month', 'Budget month', 'Variance', 'Actual YTD', 'Budget YTD'], rows, 1, 'EBITDA', [30, 14, 14, 12, 14, 14]);
      const bs = { name: 'Balance sheet', title: `Balance sheet at the end of ${period} (R thousand)`, columns: ['Line', 'This month', 'Last month', 'Year end'], widths: [34, 14, 14, 14],
        rows: ['Property, plant and equipment', 'Right-of-use assets', 'Inventories', 'Trade receivables', 'Cash', 'Borrowings', 'Lease liabilities', 'Trade payables', 'Equity']
          .map((l, i): Cell[] => { const v = [820_000, 360_000, 140_000, 410_000, 120_000, -480_000, -380_000, -310_000, -700_000][i]! * h.num(0.95, 1.05); return [l, Math.round(v), Math.round(v * h.num(0.97, 1.03)), Math.round(v * h.num(0.9, 1.1))]; }) };
      const kpi = { name: 'KPIs', title: `Operating measures for ${period}`, columns: ['Measure', 'Actual', 'Target'], widths: [34, 12, 12], rows: [
        ['Warehouse occupancy', { v: h.num(0.82, 0.96), pct: true }, { v: 0.9, pct: true }], ['On-time delivery', { v: h.num(0.93, 0.99), pct: true }, { v: 0.95, pct: true }],
        ['Fleet utilisation', { v: h.num(0.76, 0.92), pct: true }, { v: 0.85, pct: true }], ['Debtors days', k(46, 58), 50], ['Headcount', k(2300, 2900), 2600], ['Lost-time injury frequency rate', Math.round(h.num(20, 90)) / 100, 0.5]] as Cell[][] };
      return [pl, bs, kpi];
    }
    case 'age-analysis': {
      const parties = c.p.as === 'creditors' ? ['Diesel supplier', 'Tyre supplier', 'Kestwin Trucks', 'Stenvolk Properties', 'Marravel Property', 'Security contractor', 'Cleaning contractor', 'Labour broker', 'Ledgerva Africa', 'Toll operator', 'Insurance broker', 'Packaging supplier']
        : WORDS.cp!;
      const rows = parties.map((n): Cell[] => { const cur = k(200, 9000) * 1000; return [n, cur, k(0, 3000) * 1000, k(0, 1200) * 1000, k(0, 400) * 1000, h.r() < 0.2 ? k(10, 300) * 1000 : 0]; });
      return [totalled(c.p.as === 'creditors' ? 'Creditors' : 'Debtors', `${c.p.as === 'creditors' ? 'Creditors' : 'Debtors'} age analysis at the end of ${period} (rand)`,
        [c.p.as === 'creditors' ? 'Supplier' : 'Customer', 'Current', '30 days', '60 days', '90 days', '120 days and older'], rows, 1, 'Total', [30, 14, 14, 14, 14, 18])];
    }
    case 'budget': case 'forecast': {
      const months = Array.from({ length: 12 }, (_, i) => `${MONTHS[(i + 2) % 12]!.slice(0, 3)}`);
      const lines: [string, number][] = [['Revenue', 170_000], ['Cost of sales', -120_000], ['Staff costs', -21_000], ['Fuel', -9_600], ['Other costs', -7_000]];
      const rows: Cell[][] = lines.map(([l, b]) => {
        const vals = months.map((_, i) => Math.round(b * (1 + 0.04 * Math.sin(i / 2)) * h.num(0.97, 1.03) * (kind === 'forecast' ? 1.02 : 1)));
        return [l, ...vals, { v: vals.reduce((a, x) => a + x, 0), f: `SUM(B${0}:M${0})` }];
      });
      rows.forEach((r, i) => { (r[13] as { f: string }).f = `SUM(B${4 + i}:M${4 + i})`; });
      const title = kind === 'budget' ? `Budget ${c.p.fy}: ${c.p.sub ?? 'Drosvelt Holdings'} (R thousand)` : `Rolling forecast from ${period} (R thousand)`;
      return [totalled(kind === 'budget' ? 'Budget' : 'Forecast', title, ['Line', ...months, 'Year'], rows, 1, 'EBITDA', [22, ...months.map(() => 10), 12]),
        { name: 'Assumptions', title: 'Assumptions', columns: ['Assumption', 'Value'], widths: [44, 14], rows: [['Volume growth', { v: h.num(0.02, 0.07), pct: true }], ['Price increase from 1 March', { v: h.num(0.045, 0.065), pct: true }],
          ['Diesel price (R per litre)', Math.round(h.num(19, 24) * 100) / 100], ['Wage increase', { v: h.num(0.055, 0.07), pct: true }], ['Rand to US dollar', Math.round(h.num(17.5, 19.5) * 100) / 100]] as Cell[][] }];
    }
    case 'capex': {
      const items = ['Truck tractors (replacement)', 'Reefer trailers', 'Racking Durban harbour', 'Cold store chamber Cape Town', 'Solar panels Germiston', 'Warehouse management system upgrade', 'Forklifts and reach trucks', 'Dock levellers Isando', 'Yard paving Polokwane', 'CCTV and access control'];
      return [totalled('Capex', `Capital expenditure plan ${c.p.fy} (R thousand)`, ['Project', 'Category', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'],
        items.map((it, i): Cell[] => {
          const q = [k(0, 9000), k(0, 9000), k(0, 9000), k(0, 9000)];
          let category = 'Equipment';
          if (i < 2) category = 'Fleet';
          else if (i < 5) category = 'Property';
          return [it, category, ...q, { v: q.reduce((a, b) => a + b, 0), f: `SUM(C${4 + i}:F${4 + i})` }];
        }), 2, 'Total', [36, 12, 10, 10, 10, 10, 12])];
    }
    case 'cashflow': {
      const weeks = Array.from({ length: 13 }, (_, i) => `Week ${i + 1}`);
      const lines: [string, number][] = [['Receipts from customers', 42_000], ['Salaries and wages', -12_000], ['Suppliers', -18_000], ['Fuel', -2_400], ['Leases', -2_000], ['Tax', -1_500], ['Interest', -900]];
      return [totalled('Cash flow', `13-week cash flow forecast from ${period} (R thousand)`, ['Line', ...weeks], lines.map(([l, b]): Cell[] => [l, ...weeks.map(() => Math.round(b * h.num(0.85, 1.15)))]), 1, 'Net cash flow', [28, ...weeks.map(() => 10)])];
    }
    case 'price-list':
      return [{ name: 'Prices', title: `Price list ${c.p.seg} customers ${c.year} (rand, excl. VAT)`, columns: ['Service', 'Unit', 'Price', 'Minimum charge'], widths: [44, 18, 12, 14],
        rows: PRODUCTS.map((pr): Cell[] => [pr, pr.includes('per') ? pr.slice(pr.indexOf('per') + 4) : 'load', Math.round(h.num(8, 950) * 100) / 100, k(250, 4500)]) },
      { name: 'Lanes', title: 'Full truckload rates per lane', columns: ['Lane', 'Rate per load', 'Fuel base (R/l)'], widths: [36, 14, 14], rows: ROUTES.map((r): Cell[] => [r, k(14, 68) * 1000, Math.round(h.num(19, 24) * 100) / 100]) }];
    case 'pipeline': {
      const rows = Array.from({ length: 18 }, (_, i): Cell[] => {
        const v = k(5, 120) * 1e6; const p = [0.1, 0.25, 0.5, 0.75, 0.9][h.int(0, 4)]!;
        return [h.pick(WORDS.cp!), h.pick(['Warehousing', 'Transport', 'Cold chain', 'Cross-border', 'Contract packing']), h.pick(['Lead', 'Proposal', 'Negotiation', 'Verbal award']), v, { v: p, pct: true }, { v: Math.round(v * p), f: `D${4 + i}*E${4 + i}` }];
      });
      return [totalled('Pipeline', `Sales pipeline at the end of ${period} (annual revenue, rand)`, ['Customer', 'Service', 'Stage', 'Annual value', 'Probability', 'Weighted value'], rows, 3, 'Total', [26, 16, 14, 16, 12, 16])];
    }
    case 'payroll': {
      const deps = ['Drivers', 'Warehouse', 'Workshop', 'Cold chain', 'Sales', 'Finance', 'IT', 'HR', 'Management'];
      return [totalled('Payroll', `Payroll summary for ${period} (rand)`, ['Department', 'Employees', 'Basic pay', 'Overtime', 'Allowances', 'Employer contributions', 'Total cost'],
        deps.map((d, i): Cell[] => { const n = [620, 980, 140, 260, 45, 60, 22, 18, 25][i]!; const basic = n * k(14, 60) * 1000 / (i > 6 ? 0.5 : 1); const ot = basic * h.num(0.02, 0.12); const al = basic * h.num(0.03, 0.08); const er = basic * 0.12;
          return [d, n, Math.round(basic), Math.round(ot), Math.round(al), Math.round(er), { v: Math.round(basic + ot + al + er), f: `SUM(C${4 + i}:F${4 + i})` }]; }), 1, 'Total', [22, 11, 14, 12, 12, 16, 14])];
    }
    case 'headcount':
      return [totalled('Headcount', `Headcount by site at the end of ${period}`, ['Site', 'Permanent', 'Fixed-term', 'Labour broker', 'Total'],
        WORDS.site!.map((s, i): Cell[] => { const a = k(40, 420); const b = k(0, 60); const cc = k(0, 90); return [s, a, b, cc, { v: a + b + cc, f: `SUM(B${4 + i}:D${4 + i})` }]; }), 1, 'Total', [28, 12, 12, 14, 10])];
    case 'asset-register':
      return [{ name: 'Assets', title: `IT asset register ${c.year}`, columns: ['Asset tag', 'Type', 'Make and model', 'Site', 'Purchased', 'Cost (R)', 'Book value (R)'], widths: [12, 16, 26, 22, 12, 12, 14],
        rows: Array.from({ length: 60 }, (_, i): Cell[] => { const cost = k(4, 90) * 1000; return [`IT-${String(1000 + i)}`, h.pick(['Laptop', 'Desktop', 'Server', 'Switch', 'Handheld scanner', 'Label printer', 'Firewall']),
          h.pick(['Corvex 14 Pro', 'Nimbal T5', 'Ostrander R74', 'Brevlin 2960', 'Zentry MC9', 'Paxlo ZT6', 'Gatekeep 400F']), h.pick(WORDS.site!), `${h.int(2019, 2026)}`, cost, Math.round(cost * h.num(0.1, 0.9))]; }) }];
    case 'claims':
      return [totalled('Claims', `Claims history ${c.p.insurer} to ${c.year} (rand)`, ['Date', 'Section', 'Description', 'Paid', 'Outstanding'],
        Array.from({ length: 16 }, (): Cell[] => [h.date(h.int(c.year - 3, c.year)), h.pick(['Fleet', 'Goods in transit', 'Property', 'Liability']),
          h.pick(['Truck rollover N3', 'Hijacking of load', 'Water damage to stock', 'Forklift damage to racking', 'Theft from yard', 'Collision at depot']), k(10, 900) * 1000, h.r() < 0.3 ? k(10, 400) * 1000 : 0]), 3, 'Total', [16, 16, 30, 14, 14])];
    case 'domains':
      return [{ name: 'Domains', title: `Domain name register ${c.year}`, columns: ['Domain', 'Registrar', 'Owner', 'Expires', 'Use'], widths: [28, 16, 26, 14, 26],
        rows: ['drosvelt.example', 'drosvelt-logistics.example', 'drosveltcoldchain.example', 'drosvelt-track.example', 'skylarra.example', 'koelvars.example', 'drosvelt.example.na', 'drosvelt.example.bw']
          .map((d): Cell[] => [d, h.pick(['Webvaal Domains', 'Nomvelo Registry Services']), HOLDCO, h.date(h.int(2027, 2029)), h.pick(['Main website', 'Email', 'Customer tracking', 'Redirect', 'Brand protection'])]) }];
    case 'share-register': case 'directors-register':
      return kind === 'share-register'
        ? (() => {
          const owner = c.p.sub === 'Drosvelt Holdings' ? 'Heron Investments (Pty) Ltd' : HOLDCO;
          const minority = c.p.sub === 'Drosvelt Cold Chain' ? 'Heron Management Partners (Pty) Ltd' : c.p.sub === 'Drosvelt Botswana' ? 'Tsholofelo Holdings (Pty) Ltd' : null;
          const entries: Cell[][] = [
            ['1', h.date(2010, 2), 'Allotment', 'Founding subscriber', owner, 100, 100],
            ['2', h.date(2012, 5), 'Allotment', 'Rights issue', owner, 900, 1000],
            ['3', h.date(2016, 8), 'Allotment', 'Capitalisation of shareholder loan', owner, 4000, 5000],
            ...(minority ? [['4', h.date(2021, 6), 'Allotment', 'Management or local partner subscription', minority, 1250, 6250] as Cell[]] : []),
            [minority ? '5' : '4', h.date(2023, 2), 'Certificate replaced', 'Lost certificate, indemnity given', owner, 0, minority ? 6250 : 5000],
          ];
          return [
            { name: 'Securities register', title: `Securities register: ${subLegal(c.p.sub)} ${c.year}`, columns: ['Holder', 'Class', 'Certificate', 'Shares', 'Percentage', 'Date entered'], widths: [36, 12, 12, 12, 12, 16],
              rows: [[owner, 'Ordinary', '1', 5000, { v: minority ? 0.8 : 1, pct: true }, h.date(2016, 8)], ...(minority ? [[minority, 'Ordinary', '2', 1250, { v: 0.2, pct: true }, h.date(2021, 6)]] : [])] as Cell[][] },
            { name: 'Allotments and transfers', title: 'History of allotments, transfers and replacements', columns: ['Entry', 'Date', 'Type', 'Detail', 'Holder', 'Shares', 'Issued after'],
              widths: [8, 16, 18, 34, 34, 10, 12], rows: entries },
            { name: 'Beneficial interest', title: 'Beneficial interest disclosed under section 56 of the Companies Act', columns: ['Registered holder', 'Beneficial owner', 'Interest'], widths: [36, 40, 12],
              rows: [[owner, c.p.sub === 'Drosvelt Holdings' ? 'Heron Investments (Pty) Ltd, held for the Heron family trust and management' : HOLDCO, { v: minority ? 0.8 : 1, pct: true }]] as Cell[][] },
          ];
        })()
        : [{ name: 'Directors', title: `Register of directors: ${subLegal(c.p.sub)}`, columns: ['Name', 'Role', 'Appointed', 'Resigned', 'Other directorships'], widths: [22, 30, 16, 14, 30],
          rows: [[P.chair, 'Independent non-executive chair', h.date(2015), '', '2'], [P.ceo, 'Chief executive', h.date(2017), '', '1'], [P.cfo, 'Chief financial officer', h.date(2019), '', '0'],
            [P.ned1, 'Independent non-executive', h.date(2020), '', '3'], [h.person(), 'Executive director', h.date(2012), h.date(2019), '0']] }];
    case 'litigation-schedule':
      return [totalled('Litigation', `Litigation and claims schedule at the end of ${period} (rand)`, ['Matter', 'Court or forum', 'Status', 'Amount claimed', 'Provision'],
        WORDS.cp!.slice(0, 10).map((x): Cell[] => [`${x} v Drosvelt`, h.pick(['High Court Johannesburg', 'Magistrate Germiston', 'Arbitration', 'CCMA']), h.pick(['Pleadings', 'Discovery', 'Settlement talks', 'Trial date set', 'Settled']), k(1, 60) * 100_000, k(0, 20) * 50_000]), 3, 'Total', [30, 24, 18, 16, 14])];
    case 'tax-computation': {
      const rows: Cell[][] = [['Profit before tax', k(110, 200) * 1e6], ['Add: depreciation', k(80, 140) * 1e6], ['Add: non-deductible expenses', k(2, 8) * 1e6], ['Less: wear and tear', -k(70, 120) * 1e6],
        ['Less: section 12C allowance', -k(5, 20) * 1e6], ['Less: section 24C allowance', -k(1, 5) * 1e6]];
      const sheet = totalled('Computation', `Income tax computation ${c.p.sub} ${c.p.fy} (rand)`, ['Item', 'Amount'], rows, 1, 'Taxable income', [40, 18]);
      const ti = (sheet.rows.at(-1)![1] as { v: number }).v;
      sheet.rows.push(['Normal tax at 27%', { v: Math.round(ti * 0.27), f: `B${4 + rows.length}*0.27`, bold: true }]);
      return [sheet];
    }
    case 'dev-table': {
      const d = DEV_DOCUMENTS.find((x) => x.ix === c.d.ix)!;
      const toCell = (s: string): Cell => (/^-?\d[\d ]*$/.test(s) ? Number(s.replace(/ /g, '')) : s);
      return [{ name: 'Data', title: d.title, columns: d.table!.columns, rows: d.table!.rows.map((r) => r.map(toCell)) }];
    }
    default: throw new Error(`No workbook of kind ${kind}`);
  }
}

// Decks

function slides(c: Ctx): Slide[] {
  const h = helpers(c);
  const period = c.p.period ?? c.p.fy ?? `${c.year}`;
  const as = c.p.as ?? 'board';
  const rev = h.num(1900, 2200);
  const fin: Slide = { title: 'Financial performance', subtitle: `Year to date, ${period}`, table: { columns: ['R million', 'Actual', 'Budget', 'Prior year'],
    rows: [['Revenue', rev, rev * 1.01, rev * 0.92], ['EBITDA', rev * 0.155, rev * 0.16, rev * 0.148], ['Operating profit', rev * 0.09, rev * 0.095, rev * 0.085], ['Net debt', rev * 0.22, rev * 0.23, rev * 0.25]]
      .map(([l, ...v]) => [String(l), ...v.map((x) => fmt(Number(x) * (c.month + 1) / 12, 1))]) } };
  const decks: Record<string, Slide[]> = {
    board: [
      { title: `Board pack: ${period}`, subtitle: `${HOLDCO} · for the meeting of the board`, bullets: ['Chief executive\'s report', 'Financial performance', 'Operations and safety', 'Project Heron', 'Decisions required'] },
      { title: 'Chief executive\'s report', bullets: [`Volumes ${pct(h.num(0.01, 0.07))} up on last year; two new retail contracts signed`, `${h.pick(WORDS.site!)} reached ${h.int(88, 97)}% occupancy`, 'Port congestion at Durban eased in the month', 'Wage agreement with Sebenzani in place to March 2028'] },
      fin,
      { title: 'Operations and safety', table: { columns: ['Measure', 'Month', 'Target'], rows: [['On-time delivery', pct(h.num(0.93, 0.99)), '95.0%'], ['Order accuracy', pct(h.num(0.994, 0.999)), '99.5%'], ['Fleet utilisation', pct(h.num(0.78, 0.9)), '85.0%'], ['LTIFR', h.num(0.2, 0.8).toFixed(2), '0.50']] } },
      { title: 'Project Heron', bullets: ['Three bidders in the data room since 3 November 2026', 'Q&A round 1 closes 20 November; non-binding offers due 27 November', 'Management presentations planned for 8 and 9 December', 'Change of control consents tracked for 23 contracts'] },
      { title: 'Decisions required', bullets: [`Approve capital expenditure of ${R(h.int(8, 40) * 1e6)} for fleet renewal`, 'Note the updated risk register', 'Approve the retention arrangements for key staff'] }],
    budget: [
      { title: `Budget ${period}`, subtitle: 'For approval by the board', bullets: ['Assumptions', 'Income statement', 'Capital expenditure', 'Risks'] },
      { title: 'Assumptions', bullets: [`Volume growth of ${pct(h.num(0.02, 0.06))}`, `Price increases of ${pct(h.num(0.045, 0.065))} from 1 March`, `Diesel at R${h.num(19, 24).toFixed(2)} a litre`, 'Wage increases as agreed with the union'] },
      fin,
      { title: 'Capital expenditure', table: { columns: ['Category', 'R million'], rows: [['Fleet', fmt(h.num(60, 110), 1)], ['Property', fmt(h.num(30, 70), 1)], ['Equipment', fmt(h.num(10, 30), 1)], ['IT', fmt(h.num(8, 20), 1)]] } },
      { title: 'Risks', bullets: ['Loss of a top-10 customer', 'Fuel price above R26 a litre', 'Further port and rail disruption', 'Load shedding at the cold stores'] }],
    qbr: [
      { title: `Quarterly business review: ${c.p.cp}`, subtitle: period, bullets: ['Performance', 'Volumes', 'Improvements', 'Next quarter'] },
      { title: 'Performance against service levels', table: { columns: ['Measure', 'Target', 'Quarter'], rows: [['On-time delivery', '95%', pct(h.num(0.93, 0.99))], ['Order accuracy', '99.5%', pct(h.num(0.994, 0.999))], ['Stock accuracy', '99.8%', pct(h.num(0.996, 0.9995))], ['Claims ratio', '0.10%', pct(h.num(0.0004, 0.0015), 2)]] } },
      { title: 'Volumes', bullets: [`${fmt(h.int(9, 60) * 1000)} pallets handled, ${pct(h.num(-0.04, 0.09))} on the same quarter last year`, `${h.int(400, 2400)} loads delivered`, 'Peak week: 1,950 pallets in and out'] },
      { title: 'Improvements', bullets: ['Dock scheduling cut waiting time by 35 minutes a load', 'New slotting plan moved fast movers closer to dispatch', 'Electronic proof of delivery on all routes'] },
      { title: 'Next quarter', bullets: ['Festive season plan agreed', 'Pilot of the Namibian route', 'Price review meeting in February'] }],
    people: [
      { title: `People update: ${period}`, bullets: ['Headcount and costs', 'Wage agreement', 'Skills and transformation', 'Retention'] },
      { title: 'Headcount', table: { columns: ['Category', 'Employees'], rows: [['Permanent', fmt(h.int(2100, 2500))], ['Fixed-term', fmt(h.int(80, 200))], ['Labour broker', fmt(h.int(150, 400))]] } },
      { title: 'Wage agreement', bullets: ['Three-year agreement signed with Sebenzani Freight and Allied Workers Union', 'Increase of CPI plus 1% from year two', 'Peace clause on wage matters'] },
      { title: 'Retention', bullets: ['Retention letters issued to 12 key managers', 'Paid in two parts: on completion and six months later', 'Cost provided for in the budget'] }],
    it: [
      { title: `IT roadmap ${c.year}`, bullets: ['Where we are', 'Priorities', 'Investment', 'Risks'] },
      { title: 'Priorities', bullets: ['Replace the warehouse management system at three sites', 'Move finance to the cloud ERP', 'Multi-factor sign-in for every user', 'Second data centre for disaster recovery'] },
      { title: 'Investment', table: { columns: ['Project', 'R million', 'Quarter'], rows: [['WMS replacement', fmt(h.num(12, 24), 1), 'Q2'], ['Cloud ERP', fmt(h.num(6, 14), 1), 'Q3'], ['Security', fmt(h.num(2, 5), 1), 'Q1'], ['Disaster recovery', fmt(h.num(3, 7), 1), 'Q4']] } },
      { title: 'Risks', bullets: ['Key-person dependence in the integration team', 'Supplier lock-in on the transport system', 'Cyber attacks on logistics firms are rising'] }],
    hse: [
      { title: `Health, safety and environment: ${period}`, bullets: ['Safety performance', 'Incidents', 'Environment', 'Actions'] },
      { title: 'Safety performance', table: { columns: ['Measure', 'Month', 'Year to date'], rows: [['Lost-time injuries', String(h.int(0, 3)), String(h.int(2, 9))], ['LTIFR', h.num(0.1, 0.8).toFixed(2), h.num(0.3, 0.7).toFixed(2)], ['Road incidents', String(h.int(0, 4)), String(h.int(5, 18))], ['Near misses reported', String(h.int(10, 40)), String(h.int(80, 260))]] } },
      { title: 'Environment', bullets: [`Diesel use of ${h.num(30, 34).toFixed(1)} litres per 100 km`, `Solar supplied ${pct(h.num(0.12, 0.3))} of power at Germiston`, 'No spills reported to the authorities'] },
      { title: 'Actions', bullets: ['Refresher training for reach truck operators', 'Fatigue management on overnight routes', 'Revise the stormwater plan at Walvis Bay'] }],
  };
  const deck = decks[as]!;
  return c.v > 1 ? deck.map((s, i) => (i === 0 ? { ...s, subtitle: `${s.subtitle ?? ''} · version ${c.v}` } : s)) : deck;
}


// Neighbouring rooms

function* neighbour(c: Ctx): Generator<Block> {
  const h = helpers(c);
  const co = c.p.seller ?? 'Weaver Textiles';
  const company = legal(co);
  const title = c.p.title ?? c.d.name;
  const place = { 'Duncarrow Foods': 'Paarl', 'Kwartsrand Engineering': 'Vanderbijlpark', 'Weaver Textiles': 'Pinetown' }[co] ?? 'Midrand';
  const business = { 'Duncarrow Foods': 'makes fruit juices, canned fruit and dried fruit snacks', 'Kwartsrand Engineering': 'builds conveyors, steel structures and mining equipment',
    'Weaver Textiles': 'spins, weaves and finishes cotton and polyester fabrics' }[co] ?? 'trades';
  const rev = h.int(380, 1400) * 1e6;
  yield { t: 'title', text: title.toUpperCase() };
  yield { t: 'center', text: company, bold: true };
  yield { t: 'center', text: `${h.address(place)} · ${h.date(2026, 9)}` };
  yield { t: 'gap' };
  const money = (x: number) => fmt(x / 1000);
  const table = (columns: string[], rows: string[][], widths?: number[]): Block => ({ t: 'table', columns, rows, widths });
  const lines = (labels: string[], scale: number) => labels.map((l) => [l, money(scale * h.num(0.05, 1)), money(scale * h.num(0.05, 1))]);
  const t = title.toLowerCase();
  if (t.includes('share purchase')) {
    yield { t: 'center', text: `between the shareholders of ${company} (the Sellers) and Ironmere Industrial Partners (Pty) Ltd (the Purchaser)` };
    const price = h.int(40, 120) * 10e6;
    const clauses: [string, string[]][] = [
      ['SALE', ['The Sellers sell all the issued shares in the Company and their claims on loan account to the Purchaser, who buys them.']],
      ['PURCHASE PRICE', [`The purchase price is ${R(price)}, of which ${R(price * 0.9)} is paid on the closing date and ${R(price * 0.1)} into escrow for 18 months as security for warranty claims.`,
        `The price is adjusted rand for rand for net debt and for the difference between working capital at closing and the target of ${R(h.int(60, 140) * 1e6)}.`]],
      ['CONDITIONS', ['Closing is subject to approval by the Competition Commission and to the consent of the Company\'s bank under its facility agreement.']],
      ['WARRANTIES', ['The Sellers give the warranties in schedule 3, which are true on signature and on the closing date.',
        'Claims are limited to 30% of the purchase price, except claims for title and tax, which are limited to the purchase price.']],
      ['RESTRAINT', ['For three years after closing, no Seller may compete with the Company in Southern Africa or solicit its customers or employees.']],
      ['CLOSING', ['Closing takes place on the fifth business day after the last condition is met.', 'From the signature of this agreement the room is frozen, and its contents are the disclosure against the warranties.']],
      ['GENERAL', ['This agreement is governed by the laws of the Republic of South Africa. Disputes go to arbitration in Johannesburg.']]];
    for (const [i, [head, texts]] of clauses.entries()) {
      yield { t: 'h', text: `${i + 1}. ${head}` };
      for (const [k, x] of texts.entries()) yield { t: 'p', text: `${i + 1}.${k + 1} ${x}` };
    }
    yield { t: 'h', text: 'SCHEDULE 1: THE SELLERS' };
    yield table(['Seller', 'Shares', 'Share of the price'], [[`${h.person()} Family Trust`, '4 500', '45%'], ['Kwartsrand Management (Pty) Ltd', '3 000', '30%'], [h.person(), '2 500', '25%']], [0.5, 0.2, 0.3]);
    return;
  }
  yield { t: 'h', text: 'SUMMARY' };
  yield { t: 'p', text: `${company} ${business} from its site at ${place}. Revenue for the last financial year was ${rm(rev)} and it employs about ${fmt(h.int(250, 1400))} people.` };
  if (t.includes('information memorandum') || t.includes('company profile')) {
    yield { t: 'h', text: 'HISTORY' };
    yield { t: 'p', text: `The business was founded in ${h.int(1962, 1994)} as a family company and has been owned by its management and a private equity fund since ${h.int(2012, 2019)}.` };
    yield { t: 'h', text: 'INVESTMENT HIGHLIGHTS' };
    for (const x of ['A leading position in its markets, with long-standing customers', 'Modern plant after ten years of investment', 'Exports to more than 20 countries', 'An experienced management team that will stay after the sale'])
      yield { t: 'li', text: x };
    yield { t: 'h', text: 'FINANCIAL SUMMARY (R thousand)' };
    yield table(['Year', 'Revenue', 'EBITDA', 'Capital expenditure'], [2023, 2024, 2025].map((y, i) => [String(y), money(rev * (0.82 + i * 0.09)), money(rev * (0.82 + i * 0.09) * 0.13), money(rev * 0.04)]));
    yield { t: 'h', text: 'THE PROCESS' };
    yield { t: 'p', text: 'Bidders are asked for non-binding offers on the basis of the documents in this data room. The sellers may change the process at any time.' };
  } else if (t.includes('structure')) {
    yield table(['Company', 'Held by', 'Shareholding', 'Business'], [[company, 'Shareholders', '100%', 'Holding and operating company'],
      [legal(`${co.split(' ')[0]} Properties`), company, '100%', 'Owns the main site'], [legal(`${co.split(' ')[0]} Export`), company, '100%', 'Export sales']], [0.34, 0.24, 0.14, 0.28]);
  } else if (t.includes('accounts') || t.includes('budget')) {
    yield { t: 'h', text: t.includes('budget') ? 'BUDGET (R thousand)' : 'INCOME STATEMENT (R thousand)' };
    yield table(['Line', t.includes('budget') ? 'Budget 2027' : 'This year', t.includes('budget') ? 'Forecast 2026' : 'Last year'], lines(['Revenue', 'Cost of sales', 'Gross profit', 'Operating expenses', 'EBITDA', 'Depreciation', 'Operating profit', 'Finance costs', 'Profit before tax'], rev));
    yield { t: 'h', text: 'BALANCE SHEET (R thousand)' };
    yield table(['Line', 'This year', 'Last year'], lines(['Property, plant and equipment', 'Inventories', 'Trade receivables', 'Cash', 'Borrowings', 'Trade payables', 'Equity'], rev * 0.6));
    yield { t: 'p', text: t.includes('audited') ? `Audited by ${ADVISERS.auditor}, who gave an unmodified opinion.` : 'Unaudited management figures.' };
  } else if (t.includes('customer')) {
    yield table(['Customer', 'Country', 'Share of revenue', 'Customer since'], Array.from({ length: 20 }, (_, i) => [
      `${h.pick(['Grocevia', 'Tuisvra', 'Hoekwinkel', 'Lumvera', 'Maltrix', 'Calloway & Vine', 'Quenlo', 'Korrelberg', 'Grootmark', 'Melkvale'])} ${h.pick(['Retail', 'Trading', 'Distribution', 'Group'])}`,
      h.pick(['South Africa', 'Namibia', 'Botswana', 'Kenya', 'United Kingdom']), `${(12 - i * 0.5).toFixed(1)}%`, String(h.int(1995, 2023))]), [0.4, 0.2, 0.2, 0.2]);
  } else if (t.includes('supplier') || t.includes('lease') || t.includes('insurance')) {
    yield table(['Counterparty', 'Subject', 'Annual value (R)', 'Ends', 'Change of control'], Array.from({ length: 10 }, () => [
      legal(h.pick(['Paxenfold', 'Ombeli Chemicals', 'Tarnley Logistics', 'Stenvolk Properties', 'Varsure', 'Kloofsure', 'Ledgerva Africa'])),
      h.pick(['Raw materials', 'Packaging', 'Transport', 'Premises lease', 'Insurance', 'Software']), fmt(h.int(1, 40) * 1e6), h.date(h.int(2027, 2031)), h.pick(['Consent needed', 'Notice only', 'None'])]),
      [0.28, 0.2, 0.18, 0.16, 0.18]);
  } else if (t.includes('register') || t.includes('organisation')) {
    yield table(['Name', 'Role', 'Since'], Array.from({ length: 10 }, (_, i) => [h.person(), ['Chief executive', 'Financial director', 'Operations director', 'Sales director', 'HR manager', 'Plant manager', 'Quality manager', 'IT manager', 'Company secretary', 'Shareholder'][i]!, h.date(h.int(2005, 2024))]));
  } else {
    yield { t: 'h', text: title.toUpperCase() };
    yield { t: 'p', text: `This schedule lists the ${t} of ${company}, as at ${h.date(2026, 9)}, with the status of each item. Copies of the underlying documents are available on request through the Q&A.` };
    yield table(['Item', 'Detail', 'Status'], Array.from({ length: 12 }, (_, i) => [`${title} ${i + 1}`, h.pick(['Current', 'Renewed this year', 'Under review', 'Certified', 'Expires next year']), h.pick(['In order', 'Action open', 'In order'])]), [0.4, 0.35, 0.25]);
  }
  yield { t: 'h', text: 'CONFIDENTIALITY' };
  yield { t: 'p', text: `This document is confidential and is made available only to bidders who have signed the confidentiality undertaking for the sale of ${company}.` };
}

export function contentOf(d: RoomDoc, version = 1): Content {
  const c = ctxOf(d, version);
  switch (d.kind) {
    case 'dev': {
      const dev = DEV_DOCUMENTS.find((x) => x.ix === d.ix);
      if (!dev) throw new Error(`No development document ${d.ix}`);
      return { blocks: blocksOf(dev, version), landscape: dev.kind === 'table' };
    }
    case 'agreement': return { blocks: agreement(c) };
    case 'minutes': return { blocks: minutes(c) };
    case 'resolution': return { blocks: resolution(c) };
    case 'certificate': return { blocks: certificate(c) };
    case 'register': return { blocks: register(c) };
    case 'letter': return { blocks: letter(c) };
    case 'court': return { blocks: court(c) };
    case 'report': return { blocks: report(c) };
    case 'policy': return { blocks: policy(c) };
    case 'permit': return { blocks: permit(c) };
    case 'tax-return': return { blocks: taxReturn(c) };
    case 'bank-statement': return { blocks: bankStatement(c), landscape: true };
    case 'insurance-schedule': return { blocks: insuranceSchedule(c) };
    case 'chart': return { blocks: chart(c), landscape: true };
    case 'deck': return { slides: slides(c) };
    case 'neighbour': return { blocks: neighbour(c) };
    default: return { sheets: sheets(c) };
  }
}
