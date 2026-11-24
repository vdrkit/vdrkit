// SPDX-License-Identifier: AGPL-3.0-only
export interface TemplateFolder {
  name: string;
  children?: readonly TemplateFolder[];
}

const f = (name: string, children: string[]): TemplateFolder => ({ name, children: children.map((c) => ({ name: c })) });

export const STANDARD_MA_INDEX: readonly TemplateFolder[] = [
  f('Corporate', ['Company overview', 'Group structure', 'Share capital and shareholders', 'Board and governance', 'Minutes and resolutions', 'Statutory registers']),
  f('Legal', ['Constitutional documents', 'Litigation', 'Regulatory', 'Material contracts', 'Competition', 'Compliance and sanctions']),
  f('Finance', ['Management accounts', 'Audited financials', 'Budgets and forecasts', 'Tax', 'Treasury']),
  f('Commercial', ['Market and strategy', 'Key customers', 'Key suppliers', 'Sales and pricing']),
  f('HR', ['Organisation and headcount', 'Pay and benefits', 'Policies and procedures', 'Executive contracts']),
  f('IT', ['Systems and infrastructure', 'Software licences', 'Cyber security']),
  f('Property', ['Leases', 'Owned property', 'Plant and equipment']),
  f('Insurance', ['Policies', 'Claims history']),
  f('Environmental', ['Permits and compliance', 'Health and safety']),
  f('Intellectual property', ['Trade marks', 'Patents and designs', 'Domain names and licences']),
  f('Data protection', ['Policies and registers', 'Breaches and requests']),
];
