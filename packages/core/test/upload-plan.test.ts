// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseLeadingNumber, planUpload, walkPlan, type DroppedFile, type ExistingFolder } from '../src/upload-plan.js';

const folder = (id: string, number: number, name: string, children: ExistingFolder[] = [], lastDocumentNumber = 0): ExistingFolder =>
  ({ id, number, name, children, lastDocumentNumber });

const HERON = {
  lastDocumentNumber: 0,
  children: [
    folder('f1', 1, 'Corporate'),
    folder('f2', 2, 'Legal', [folder('f2-4', 4, 'Contracts', [], 13)]),
    folder('f3', 3, 'Finance', [
      folder('f3-1', 1, 'Management accounts', [], 8),
      folder('f3-2', 2, 'Audited financials', [], 5),
      folder('f3-3', 3, 'Budget 2027', [], 2),
      folder('f3-4', 4, 'Tax', [], 7),
    ]),
    folder('f4', 4, 'Commercial', [folder('f4-1', 1, 'Customers', [], 3), folder('f4-2', 2, 'Customer contracts', [], 6)]),
    folder('f5', 5, 'HR'),
    folder('f6', 6, 'IT'),
    folder('f7', 7, 'Property'),
  ],
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EXISTING = new Map([1, 2, 3, 4, 5, 6].map((i) => [sha(`dup${i}`), `4.2.${i}`]));

function many(dir: string, count: number, mbEach: number, ext = 'pdf'): DroppedFile[] {
  return Array.from({ length: count }, (_, i) => ({ path: `${dir}/Document ${String(i + 1).padStart(3, '0')}.${ext}`, size: mbEach * 1e6, sha256: sha(`${dir}/${i}`) }));
}

// 412 files in 16 folders
function tranche2(): DroppedFile[] {
  const d = 'Heron_DD_tranche2';
  return [
    { path: `03 Finance/02 Audited financials/Audited financial statements FY2023.pdf`, size: 4e6, sha256: sha('aa1') },
    { path: `03 Finance/02 Audited financials/Auditor's report FY2023.pdf`, size: 4e6, sha256: sha('aa2') },
    ...many('03 Finance/05 Treasury', 24, 4),
    ...many('04 Commercial/03 Supplier contracts', 112, 3),
    ...[1, 2, 3, 4, 5, 6].map((i) => ({ path: `04 Commercial/03 Supplier contracts/Copy ${i}.pdf`, size: 2e6, sha256: sha(`dup${i}`) })),
    ...many('04 Commercial/04 Pricing', 31, 2),
    ...many('08 Insurance/01 Policies', 38, 4),
    ...many('08 Insurance/02 Claims history', 15, 1),
    ...many('09 Environmental/01 Permits', 46, 4),
    ...many('09 Environmental/02 Site assessments', 22, 18),
    ...many('10 Intellectual property/01 Trademarks', 61, 2),
    ...many('10 Intellectual property/02 Patents', 36, 9),
    ...[1, 2, 3].map((i) => ({ path: `10 Intellectual property/02 Patents/Patent family ${i}.zip`, size: 18e6, sha256: sha(`bb${i}`) })),
    ...many('10 Intellectual property/03 Licences', 16, 2),
    { path: `03 Finance/Thumbs.db`, size: 1e4 },
    { path: `09 Environmental/.DS_Store`, size: 6e3 },
    { path: `04 Commercial/04 Pricing/~$Price list 2027.xlsx`, size: 165 },
  ].map((f) => ({ ...f, path: f.path.startsWith(d) ? f.path : f.path }));
}

describe('parseLeadingNumber', () => {
  it.each([
    ['03 Finance', 3, 'Finance'],
    ['3.2 Audited financials', 2, 'Audited financials'],
    ['10_Intellectual property', 10, 'Intellectual property'],
    ['7) Property', 7, 'Property'],
    ['Treasury', null, 'Treasury'],
    ['2027 Budget', null, '2027 Budget'],
    ['2023 Accounts', null, '2023 Accounts'],
    ['1899 Deeds', 1899, 'Deeds'],
    ['2100 Plan', 2100, 'Plan'],
    ['2023.1 Accounts', 1, 'Accounts'],
    ['12 Accounts', 12, 'Accounts'],
    ['1.2 Accounts', 2, 'Accounts'],
    ['999999999 Last', 999_999_999, 'Last'],
    ['1000000000 Too long', null, 'Too long'],
    ['1000000000000000000000 Absurd', null, 'Absurd'],
    ['FY2023 accounts', null, 'FY2023 accounts'],
  ])('reads %s', (input, number, name) => {
    expect(parseLeadingNumber(input)).toEqual({ number, name });
  });
});

describe('planUpload', () => {
  it('summarises the drop', () => {
    const plan = planUpload(HERON, tranche2(), { numbering: 'from_names', duplicates: 'skip' }, EXISTING);
    expect(plan.summary).toMatchObject({
      droppedFiles: 415, uploadFiles: 406, newFolders: 13, existingFoldersReceiving: 3,
      duplicates: 6, systemFilesSkipped: 3, noPreview: 3,
    });
  });

  it('merges into existing folders and keeps folder numbers', () => {
    const plan = planUpload(HERON, tranche2(), { numbering: 'from_names', duplicates: 'skip' }, EXISTING);
    const rows = [...walkPlan(plan.folders)].map(({ folder }) => `${folder.indexNumber} ${folder.name}${folder.existingId ? ' (existing)' : ''}`);
    expect(rows).toEqual([
      '3 Finance (existing)', '3.2 Audited financials (existing)', '3.5 Treasury',
      '4 Commercial (existing)', '4.3 Supplier contracts', '4.4 Pricing',
      '8 Insurance', '8.1 Policies', '8.2 Claims history',
      '9 Environmental', '9.1 Permits', '9.2 Site assessments',
      '10 Intellectual property', '10.1 Trademarks', '10.2 Patents', '10.3 Licences',
    ]);
  });

  it('numbers new files after existing documents', () => {
    const plan = planUpload(HERON, tranche2(), { numbering: 'from_names', duplicates: 'skip' }, EXISTING);
    const aud = plan.folders[0]!.children.find((c) => c.name === 'Audited financials')!;
    expect(aud.files.map((f) => `${f.indexNumber} ${f.name}`)).toEqual([
      '3.2.6 Audited financial statements FY2023.pdf',
      "3.2.7 Auditor's report FY2023.pdf",
    ]);
  });

  it('can number new folders alphabetically', () => {
    const plan = planUpload(HERON, tranche2(), { numbering: 'alphabetical', duplicates: 'skip' }, EXISTING);
    expect(plan.folders.map((f) => `${f.indexNumber} ${f.name}`)).toEqual([
      '3 Finance', '4 Commercial', '8 Environmental', '9 Insurance', '10 Intellectual property',
    ]);
    const ins = plan.folders.find((f) => f.name === 'Insurance')!;
    expect(ins.children.map((c) => `${c.indexNumber} ${c.name}`)).toEqual(['9.1 Claims history', '9.2 Policies']);
    const com = plan.folders.find((f) => f.name === 'Commercial')!;
    expect(com.children.map((c) => `${c.indexNumber} ${c.name}`)).toEqual(['4.3 Pricing', '4.4 Supplier contracts']);
  });

  it('skips duplicates by default', () => {
    const plan = planUpload(HERON, tranche2(), { numbering: 'from_names', duplicates: 'skip' }, EXISTING);
    const sup = plan.folders[1]!.children.find((c) => c.name === 'Supplier contracts')!;
    const dups = sup.files.filter((f) => f.status === 'duplicate_skipped');
    expect(dups.map((f) => f.duplicateOf)).toEqual(['4.2.1', '4.2.2', '4.2.3', '4.2.4', '4.2.5', '4.2.6']);
    expect(dups.every((f) => f.indexNumber === null)).toBe(true);
    expect(sup.files.filter((f) => f.indexNumber).length).toBe(112);
  });

  it('can upload duplicates', () => {
    const plan = planUpload(HERON, tranche2(), { numbering: 'from_names', duplicates: 'keep' }, EXISTING);
    expect(plan.summary.uploadFiles).toBe(412);
    expect(plan.summary.duplicates).toBe(6);
  });

  it('flags files without a preview', () => {
    const plan = planUpload(HERON, tranche2(), { numbering: 'from_names', duplicates: 'skip' }, EXISTING);
    const pat = plan.folders.find((f) => f.name === 'Intellectual property')!.children.find((c) => c.name === 'Patents')!;
    const zips = pat.files.filter((f) => f.noPreview);
    expect(zips.map((f) => f.name)).toEqual(['Patent family 1.zip', 'Patent family 2.zip', 'Patent family 3.zip']);
    expect(zips.every((f) => f.indexNumber !== null)).toBe(true);
  });
});

describe('planUpload edge cases', () => {
  it('detects duplicates within one drop', () => {
    const plan = planUpload({ children: [], lastDocumentNumber: 0 }, [
      { path: 'A/one.pdf', size: 1, sha256: sha('cc') },
      { path: 'B/same as one.pdf', size: 1, sha256: sha('cc') },
    ], { numbering: 'from_names', duplicates: 'skip' });
    expect(plan.summary).toMatchObject({ uploadFiles: 1, duplicates: 1 });
    expect(plan.folders[1]!.files[0]!.duplicateOf).toBe('1.1');
  });

  it('warns when a number is taken', () => {
    const plan = planUpload(HERON, [{ path: '03 Insurance/policy.pdf', size: 1 }], { numbering: 'from_names', duplicates: 'skip' });
    expect(plan.folders[0]!.indexNumber).toBe('8');
    expect(plan.warnings).toEqual([{ kind: 'number_taken', sourcePath: '03 Insurance', wanted: '3', given: '8', takenBy: 'Finance' }]);
  });

  it('separates new folders with the same number', () => {
    const plan = planUpload(HERON, [
      { path: '08 Insurance/a.pdf', size: 1 },
      { path: '08 Environmental/b.pdf', size: 1 },
    ], { numbering: 'from_names', duplicates: 'skip' });
    expect(plan.folders.map((f) => `${f.indexNumber} ${f.name}`)).toEqual(['8 Environmental', '9 Insurance']);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatchObject({ kind: 'number_repeated', wanted: '8', given: '9' });
  });

  it('appends unnumbered folders', () => {
    const plan = planUpload(HERON, [{ path: 'Tax rulings/ruling.pdf', size: 1 }, { path: 'Board minutes/2026.pdf', size: 1 }],
      { numbering: 'from_names', duplicates: 'skip' });
    expect(plan.folders.map((f) => `${f.indexNumber} ${f.name}`)).toEqual(['8 Board minutes', '9 Tax rulings']);
  });

  it('matches existing folders by name', () => {
    const plan = planUpload(HERON, [{ path: '99 FINANCE/new.pdf', size: 1 }], { numbering: 'from_names', duplicates: 'skip' });
    expect(plan.folders[0]).toMatchObject({ indexNumber: '3', name: 'Finance', existingId: 'f3' });
    expect(plan.folders[0]!.files[0]!.indexNumber).toBe('3.5');
  });

  it('should not reveal hidden folders', () => {
    const tree = { lastDocumentNumber: 0, children: [folder('f1', 1, 'Corporate'), { ...folder('f2', 2, 'Project Kestrel side letter'), hidden: true }] };
    const plan = planUpload(tree, [
      { path: '02 x/a.pdf', size: 1 },
      { path: 'Project Kestrel side letter/b.pdf', size: 1 },
    ], { numbering: 'from_names', duplicates: 'skip' });
    expect(JSON.stringify(plan)).not.toContain('f2');
    expect(plan.folders.map((f) => `${f.indexNumber} ${f.name} ${f.existingId}`)).toEqual(['3 x null', '4 Project Kestrel side letter null']);
    // a warning would reveal the hidden folder
    expect(plan.warnings).toEqual([]);
    const free = planUpload(tree, [{ path: '07 y/a.pdf', size: 1 }], { numbering: 'from_names', duplicates: 'skip' });
    expect(free.folders.map((f) => f.indexNumber)).toEqual(['3']);
  });

  it('plans an upload into a chosen subfolder', () => {
    const fin = HERON.children[2]!;
    const plan = planUpload(fin, [{ path: '06 Hedging/ISDA.pdf', size: 1 }, { path: 'loose file.pdf', size: 1 }],
      { numbering: 'from_names', duplicates: 'skip' }, new Map(), '3');
    expect(plan.folders[0]!.indexNumber).toBe('3.6');
    expect(plan.files[0]!.indexNumber).toBe('3.7');
  });

  it('numbers new documents after subfolders', () => {
    const legal = folder('f2', 2, 'Legal', [folder('f2-4', 4, 'Contracts'), { ...folder('f2-6', 6, 'Side letters'), hidden: true }], 2);
    const plan = planUpload({ lastDocumentNumber: 0, children: [legal] },
      [{ path: 'Legal/Board minutes.pdf', size: 1 }, { path: 'Legal/Articles.pdf', size: 1 }],
      { numbering: 'from_names', duplicates: 'skip' });
    expect(plan.folders[0]!.files.map((f) => f.indexNumber)).toEqual(['2.7', '2.8']);
    const plain = planUpload({ lastDocumentNumber: 3, children: [] }, [{ path: 'x.pdf', size: 1 }], { numbering: 'from_names', duplicates: 'skip' }, new Map(), '5');
    expect(plain.files[0]!.indexNumber).toBe('5.4');
  });

  it('does not reuse document numbers for folders', () => {
    const ip = { lastDocumentNumber: 116, children: [] };
    const plan = planUpload(ip, [{ path: 'Trade secrets/a.pdf', size: 1 }, { path: '03 Licences/b.pdf', size: 1 }],
      { numbering: 'from_names', duplicates: 'skip' }, new Map(), '10');
    expect(plan.folders.map((f) => f.indexNumber)).toEqual(['10.117', '10.118']);
    expect(plan.warnings).toEqual([{ kind: 'number_taken', sourcePath: '03 Licences', wanted: '10.3', given: '10.117', takenBy: null }]);
  });

  it('ignores folder numbers next to hidden documents', () => {
    const plan = planUpload({ lastDocumentNumber: 4, hiddenDocuments: true, children: [] },
      [{ path: '09 Permits/a.pdf', size: 1 }], { numbering: 'from_names', duplicates: 'skip' }, new Map(), '3');
    expect(plan.folders[0]!.indexNumber).toBe('3.5');
    expect(plan.warnings).toEqual([]);
  });
});
