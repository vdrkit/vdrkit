// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import { detailsHref, roomHref } from '@/components/room/routes';
import { MAX_FILE_BYTES, MAX_FILE_TEXT } from '@/components/documents/limits';
import { pickedFromDrop, pickedFromInput, sha256Hex, hasFiles, UNREADABLE, type Picked } from '@/components/documents/upload';
import { formatDay, formatWhen, partsIn, zoneAbbreviation } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import { BulkUpload, type Job } from './engine';
import {
  andList, compareIndex, filesUnder, gb, parseLeadingNumber, placedPaths, rewritePath, size, stripCollectingRoot, uploadOrder, walkFolders,
  type PlannedFolder, type UploadPlan,
} from './plan';

export interface ImportTarget { id: string | null; label: string; ix: string | null; canPublish: boolean }

export interface RecentUpload { at: string; person: string | null; files: number; drafts: number; folders: { indexNumber: string | null; name: string }[]; first: boolean }

export interface ImportData {
  ws: string;
  roomName: string;
  timeZone: string;
  isAdmin: boolean;
  targets: ImportTarget[];
  initialTarget: string | null;
  draftsBefore: number;
  recent: RecentUpload[];
}

type Step = 'choose' | 'check' | 'upload' | 'done';

// planner limit
const MAX_FILES = 5000;
const MAX_BYTES = 20e9;

const n = (x: number) => x.toLocaleString('en-GB');
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;
const last = (ix: string) => Number(ix.split('.').at(-1));
const parentIx = (ix: string) => (ix.includes('.') ? ix.slice(0, ix.lastIndexOf('.')) : '');

const CHEV = <svg viewBox="0 0 12 12"><path d="M4 2.5L7.5 6L4 9.5" /></svg>;
const FOLDER = <svg className="fold" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
const DROP = <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 15a3 3 0 0 1 3-3h8l3 3h15a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3z" /><path d="M24 31V21M19.5 25.5L24 21l4.5 4.5" /></svg>;

function Stepper({ on }: { on: Step }) {
  const idx = { choose: 0, check: 1, upload: 2, done: 3 }[on];
  return (
    <ol className="d1-steps" aria-label="Upload steps">
      {['Choose files', 'Check the index', 'Upload'].map((t, i) => {
        let cls = '';
        if (i < idx) cls = 'done';
        else if (i === idx) cls = 'on';
        return <li key={t} className={cls} aria-current={i === idx ? 'step' : undefined}>{t}</li>;
      })}
    </ol>
  );
}

function Head({ title, sub }: { title: string; sub: ReactNode }) {
  return <div className="head"><div><p className="over">Documents · Bulk import</p><h1>{title}</h1><p className="sub">{sub}</p></div></div>;
}

function shortWhen(at: string, tz: string) {
  const p = partsIn(new Date(at), tz);
  return `${formatDay(at, tz)}, ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function recentLine(r: RecentUpload): string {
  const who = r.person ?? 'Someone';
  if (r.first) return `${who} uploaded ${plural(r.files, 'file', 'files')}, the first index`;
  const ixs = r.folders.map((f) => f.indexNumber).filter((x): x is string => !!x);
  if (!r.folders.length) return `${who} uploaded ${plural(r.files, 'file', 'files')}`;
  if (r.folders.length === 1) {
    const f = r.folders[0]!;
    return `${who} uploaded ${plural(r.files, 'file', 'files')} into ${f.indexNumber ? `${f.indexNumber} ${f.name}` : 'the top level'}`;
  }
  if (ixs.length <= 4) return `${who} uploaded ${plural(r.files, 'file', 'files')} into ${andList(ixs)}`;
  const tops = [...new Set(ixs.map((x) => x.split('.')[0]!))];
  const into = tops.length <= 4 ? andList(tops.sort((a, b) => Number(a) - Number(b))) : `${n(tops.length)} folders`;
  return `${who} uploaded ${plural(r.files, 'file', 'files')} into ${into}`;
}

export function BulkImport({ data }: { data: ImportData }) {
  const { ws, timeZone: tz, isAdmin } = data;
  const router = useRouter();
  // count before upload adds drafts
  const [draftsBefore, setDraftsBefore] = useState(data.draftsBefore);
  const [step, setStep] = useState<Step>('choose');
  const [target, setTarget] = useState<string>(data.initialTarget ?? '');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [setName, setSetName] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const tgt = data.targets.find((t) => (t.id ?? '') === target) ?? data.targets[0]!;
  const tgtId = tgt.id;
  const intoTop = tgtId === null;

  const hashes = useRef(new Map<string, string>());
  const [hashed, setHashed] = useState(0);
  useEffect(() => {
    let stop = false;
    hashes.current = new Map();
    setHashed(0);
    async function hashAll() {
      for (const p of picked) {
        if (stop) return;
        const h = await sha256Hex(p.file).catch(() => null);
        if (stop) return;
        if (h === null) {
          // back to choosing; unsendable files would fail later
          setPicked([]); setPlan(null); setStep('choose');
          setPickError(`${p.path} ${UNREADABLE}. Choose the files again.`);
          return;
        }
        hashes.current.set(p.path, h);
        setHashed((x) => x + 1);
      }
    }
    void hashAll();
    return () => { stop = true; };
  }, [picked]);
  const allHashed = picked.length > 0 && hashed === picked.length;

  const [typed, setTyped] = useState<Map<string, number>>(new Map());
  const [dups, setDups] = useState<'skip' | 'keep'>('skip');
  const [plan, setPlan] = useState<UploadPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const seq = useRef(0);
  const back = useMemo(() => {
    const files = new Map<string, Picked>();
    const folders = new Map<string, string>();
    for (const p of picked) {
      const rw = rewritePath(p.path, typed);
      files.set(rw, p);
      const a = p.path.split('/').slice(0, -1);
      const b = rw.split('/').slice(0, -1);
      for (let i = 1; i <= a.length; i++) folders.set(b.slice(0, i).join('/'), a.slice(0, i).join('/'));
    }
    return { files, folders };
  }, [picked, typed]);

  useEffect(() => {
    if (step !== 'check' || !picked.length) return;
    const my = ++seq.current;
    setPlanning(true);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the one await is caught
    const t = setTimeout(async () => {
      const r = await browserApi().POST('/v1/workspaces/{ws}/upload-plans', {
        params: { path: { ws } },
        body: {
          targetFolderId: tgtId, numbering: 'from_names', duplicates: dups,
          files: picked.map((p) => {
            const file: { path: string; size: number; sha256?: string } = { path: rewritePath(p.path, typed), size: p.file.size };
            if (allHashed) file.sha256 = hashes.current.get(p.path)!;
            return file;
          }),
        },
      }).catch(() => null);
      if (my !== seq.current) return;
      setPlanning(false);
      if (r && r.response.ok) {
        setPlan(r.data as unknown as UploadPlan);
        setPlanError(null);
      } else {
        setPlanError((r?.error as { detail?: string } | undefined)?.detail ?? 'The index could not be checked. Try again in a moment.');
      }
    }, 150);
    return () => clearTimeout(t);
  }, [step, picked, typed, dups, tgtId, allHashed, ws]);

  function choose(files: Picked[]) {
    const real = files.filter((f) => f.file.size > 0 || !/^(thumbs\.db|\.ds_store)$/i.test(f.file.name));
    if (!real.length) return;
    const bytes = real.reduce((a, f) => a + f.file.size, 0);
    if (real.length > MAX_FILES || bytes > MAX_BYTES) {
      setPickError(`That is ${plural(real.length, 'file', 'files')} and ${size(bytes)}. Import up to 5,000 files and 20 GB at a time, for example one top-level folder after another.`);
      return;
    }
    const big = real.filter((f) => f.file.size > MAX_FILE_BYTES);
    if (big.length) {
      setPickError(big.length === 1
        ? `${big[0]!.path} is larger than ${MAX_FILE_TEXT}, the most one file can be. Split it or compress it, then choose again.`
        : `${plural(big.length, 'file is', 'files are')} larger than ${MAX_FILE_TEXT}, the most one file can be, for example ${big[0]!.path}. Split or compress them, then choose again.`);
      return;
    }
    const { set, files: kept } = stripCollectingRoot(real);
    setPickError(null);
    setSetName(set);
    setPicked(kept);
    setTyped(new Map());
    setDups('skip');
    setPlan(null);
    setOpen(new Set());
    setStep('check');
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setHot(false);
    choose(await pickedFromDrop(e.dataTransfer));
  }

  const [open, setOpen] = useState<Set<string>>(new Set());
  const clash = useMemo(() => {
    const out = new Set<string>();
    if (!plan) return out;
    const all = [...walkFolders(plan.folders)];
    // clash: both folders marked, upload waits
    for (const w of plan.warnings) {
      const orig = back.folders.get(w.sourcePath) ?? w.sourcePath;
      const holder = all.find((x) => x.folder.indexNumber === w.wanted)?.folder;
      const holderKey = holder ? (holder.existingId ? `existing:${holder.existingId}` : back.folders.get(holder.sourcePath) ?? holder.sourcePath) : null;
      if (!typed.has(orig) && !(holderKey && typed.has(holderKey))) continue;
      out.add(orig);
      if (holderKey) out.add(holderKey);
    }
    return out;
  }, [plan, back, typed]);
  const clashes = clash.size > 0;

  function setNumber(orig: string, raw: string) {
    const v = Number.parseInt(raw, 10);
    setTyped((cur) => {
      const next = new Map(cur);
      if (v > 0 && v < 1000) next.set(orig, v); else next.delete(orig);
      return next;
    });
  }

  function origin(f: PlannedFolder, orig: string): string {
    const raw = orig.split('/').at(-1) ?? f.sourceName;
    if (typed.has(orig)) return `from ${raw} · number set by you`;
    const w = plan?.warnings.find((x) => x.sourcePath === f.sourcePath);
    if (w) return `from ${raw} · ${w.wanted} is taken, so placed at ${w.given}`;
    if (!f.existingId && parseLeadingNumber(raw).number == null) return `from ${raw} · no number in the name, so placed after ${last(f.indexNumber) - 1}`;
    return `from ${raw}`;
  }

  function folderRows(): ReactNode[] {
    if (!plan) return [];
    const rows: ReactNode[] = [];
    for (const { folder: f, depth } of walkFolders(plan.folders)) {
      const orig = back.folders.get(f.sourcePath) ?? f.sourcePath;
      const all = filesUnder(f).filter((x) => x.status !== 'system_skipped');
      const own = f.files;
      const dupN = own.filter((x) => x.status === 'duplicate_skipped' || x.status === 'duplicate_kept').length;
      const nopN = own.filter((x) => x.noPreview && (x.status === 'new' || x.status === 'duplicate_kept')).length;
      const isNew = !f.existingId;
      const isClash = clash.has(isNew ? orig : `existing:${f.existingId}`);
      const prefix = parentIx(f.indexNumber);
      const listed = own.filter((x) => x.indexNumber);
      const isOpen = open.has(orig) && listed.length > 0;
      const lv = Math.min(depth, 4);
      const asked = isClash ? plan.warnings.find((w) => w.sourcePath === f.sourcePath)?.wanted : undefined;
      const shown = typed.get(orig) ?? (asked ? last(asked) : last(f.indexNumber));
      rows.push(
        <div key={orig} className={`trow2${depth === 0 ? ' top' : ` lv${lv}`}${isNew ? ' new' : ''}`} role="row" data-folder={orig}>
          {isNew && isAdmin ? (
            <span className={`ixin${isClash ? ' clash' : ''}`}>{prefix ? `${prefix}.` : ''}
              <input type="text" inputMode="numeric" defaultValue={shown} key={`${orig}:${shown}`} aria-label={`Index number for ${f.name}`}
                onBlur={(e) => setNumber(orig, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setNumber(orig, (e.target as HTMLInputElement).value); }} />
            </span>
          ) : <span className="ix">{f.indexNumber}</span>}
          <span className="nm">
            {listed.length ? (
              <button type="button" className="tog" aria-expanded={isOpen} aria-label={`Show files in ${f.name}`}
                onClick={() => setOpen((s) => { const x = new Set(s); if (x.has(orig)) x.delete(orig); else x.add(orig); return x; })}>{CHEV}</button>
            ) : <span className="tog ph" />}
            {FOLDER}
            <div><b>{f.name}</b><small title={origin(f, orig)}>{origin(f, orig)}</small></div>
          </span>
          <span className="r">{n(all.length)}</span>
          <span className="r cap">{size(all.reduce((a, x) => a + x.size, 0))}</span>
          <span className="what">
            {isNew ? <span className="k k-new">New folder</span> : <span className="k k-old">Existing folder</span>}
            {isNew && depth === 0 && intoTop ? <span className="k k-lock">No bidder access</span> : null}
            {dupN ? <span className="k k-dup">{plural(dupN, 'duplicate', 'duplicates')}</span> : null}
            {nopN ? <span className="k k-nop">{n(nopN)} without preview</span> : null}
            {isClash ? <span className="k k-lock">Number used twice</span> : null}
          </span>
        </div>,
      );
      if (isOpen) {
        const first = listed[0]!.indexNumber!;
        const before = last(first) - 1;
        listed.slice(0, 5).forEach((x) => rows.push(
          <div key={`${orig}/${x.sourcePath}`} className={`trow2 lv${Math.min(lv + 1, 4)} file`} role="row">
            <span className="ix">{x.indexNumber}</span><span className="nm"><span>{x.name}</span></span>
            <span className="what"><span className="k k-new">New</span></span>
          </div>,
        ));
        const more = listed.length - 5;
        let moreText = `Numbered from ${first} in alphabetical order`;
        if (more > 0) moreText = `+ ${n(more)} more files, numbered in alphabetical order`;
        else if (before > 0) moreText = `Numbered after the ${n(before)} documents already in ${f.indexNumber}`;
        rows.push(
          <div key={`${orig}/more`} className={`trow2 lv${Math.min(lv + 1, 4)} more`} role="row">
            <span /><span className="nm">{moreText}</span><span />
          </div>,
        );
      }
    }
    const loose = plan.files.filter((x) => x.indexNumber);
    if (loose.length) {
      rows.push(
        <div key="loose" className="trow2 top" role="row">
          <span className="ix">{tgt.ix ?? '–'}</span>
          <span className="nm"><span className="tog ph" />{FOLDER}<div><b>Files without a folder</b><small>straight into {intoTop ? 'the top level' : tgt.label}</small></div></span>
          <span className="r">{n(loose.length)}</span><span className="r cap">{size(loose.reduce((a, x) => a + x.size, 0))}</span>
          <span className="what"><span className="k k-new">New</span></span>
        </div>,
      );
    }
    return rows;
  }

  const [runner, setRunner] = useState<BulkUpload | null>(null);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((x) => x + 1), []);
  const [finishedAt, setFinishedAt] = useState<Date | null>(null);
  const once = useSendOnce();

  // held for the whole run, or a second click resends everything
  const startUpload = once(() => {
    if (!plan || !allHashed) return;
    const paths = placedPaths(plan);
    const order = uploadOrder(plan);
    const rowOf = new Map<string, string>();
    plan.folders.forEach((f) => filesUnder(f).forEach((x) => rowOf.set(x.sourcePath, f.indexNumber)));
    const jobs: Job[] = order.map((x) => {
      const p = back.files.get(x.sourcePath)!;
      const own = x.indexNumber ? Number(x.indexNumber.split('.').at(-1)) : NaN;
      return { key: x.sourcePath, picked: p, sha256: hashes.current.get(p.path)!, serverPath: paths.get(x.sourcePath)!, targetFolderId: tgtId, row: rowOf.get(x.sourcePath) ?? '',
        plannedNumber: Number.isInteger(own) && own > 0 ? own : undefined, plannedIndex: x.indexNumber };
    });
    setDraftsBefore(data.draftsBefore);
    const r = new BulkUpload(ws, jobs, bump);
    setRunner(r);
    setStep('upload');
    return r.run().then(() => { setFinishedAt(new Date()); setStep('done'); router.refresh(); });
  });

  // stray drops would navigate away mid-import
  useEffect(() => {
    if (step === 'choose') return;
    const hold = (e: globalThis.DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    window.addEventListener('dragover', hold);
    window.addEventListener('drop', hold);
    return () => {
      window.removeEventListener('dragover', hold);
      window.removeEventListener('drop', hold);
    };
  }, [step]);

  useEffect(() => {
    if (step !== 'upload') return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [step]);

  const [processing, setProcessing] = useState<Map<string, { status: string; error: string | null; nodeId: string; indexNumber: string | null; name: string }>>(new Map());
  // ref, or the poll restarts after every answer
  const known = useRef(processing);
  useEffect(() => {
    if (!runner || (step !== 'upload' && step !== 'done')) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const seen = known.current;
      const ids: string[] = [];
      for (const s of runner.states) {
        if (s.status !== 'done' || !s.versionId) continue;
        const p = seen.get(s.versionId);
        if (!p || p.status === 'pending' || p.status === 'processing') ids.push(s.versionId);
      }
      // uploads may still be finishing
      if (!ids.length) {
        if (step === 'upload' && !stop) t = setTimeout(() => void poll(), 3000);
        return;
      }
      const next = new Map(seen);
      for (let i = 0; i < ids.length; i += 5000) {
        const body = { ids: ids.slice(i, i + 5000) };
        const r = await browserApi().POST('/v1/workspaces/{ws}/versions/processing', { params: { path: { ws } }, body }).catch(() => null);
        for (const it of r?.data?.items ?? []) {
          next.set(it.versionId, { status: it.status, error: it.error, nodeId: it.nodeId, indexNumber: it.indexNumber, name: it.name });
        }
      }
      if (stop) return;
      known.current = next;
      setProcessing(next);
      t = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { stop = true; clearTimeout(t); };
  }, [runner, step, ws]);

  function reset() {
    setPicked([]); setPlan(null); setRunner(null); known.current = new Map(); setProcessing(new Map()); setTyped(new Map()); setSetName(null); setFinishedAt(null); setStep('choose');
  }

  const fileInputs = (
    <>
      <input ref={filesInput} type="file" multiple hidden data-testid="d1-files" onChange={(e) => { choose(pickedFromInput(e.target.files)); e.target.value = ''; }} />
      <input ref={folderInput} type="file" multiple hidden data-testid="d1-folder" onChange={(e) => { choose(pickedFromInput(e.target.files)); e.target.value = ''; }}
        {...{ webkitdirectory: '' }} />
    </>
  );

  if (step === 'choose') {
    const docsHref = tgtId ? roomHref(ws, 'documents', tgtId) : roomHref(ws, 'documents');
    return (
      <div className="d1">
        <Head title={`Import a set of documents into ${data.roomName}`}
          sub="For filling the room from a folder tree you have already collected. Everything arrives as a draft. Bidders see nothing until you publish it." />
        <section className="panel hint" aria-label="Other ways to upload">
          <div><b>Adding a few files, or a new version of one?</b><span className="cap">Drag them straight onto a folder or a document in Documents. The same checks run there.</span></div>
          <Link className="btn secondary sm" href={docsHref}>Go to Documents</Link>
        </section>
        <Stepper on="choose" />
        <section className="panel" aria-label="Choose files">
          <div className="target">
            <label htmlFor="into">Upload into</label>
            <select className="select" id="into" value={target} onChange={(e) => setTarget(e.target.value)}>
              {data.targets.map((t) => <option key={t.id ?? ''} value={t.id ?? ''}>{t.label}</option>)}
            </select>
            <span className="cap">Folders you drop go inside this folder.</span>
          </div>
          <div className={`d1-drop${hot ? ' hot' : ''}`}
            onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) folderInput.current?.click(); }}
            onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setHot(true); } }} onDragLeave={() => setHot(false)} onDrop={onDrop}>
            {DROP}
            <b>Drop files or a whole folder here</b>
            <p>Up to 5,000 files and 20 GB at a time, {MAX_FILE_TEXT} per file. If your connection drops, the upload carries on once you are back online.</p>
            <div className="row">
              <button type="button" className="btn secondary sm" onClick={() => filesInput.current?.click()}>Choose files</button>
              <button type="button" className="btn secondary sm" onClick={() => folderInput.current?.click()}>Choose a folder</button>
            </div>
          </div>
          {pickError ? <p className="err" role="alert">{pickError}</p> : null}
          <ul className="d1-rules">
            <li><b>Folders become index folders</b>A folder tree from your drive keeps its structure.</li>
            <li><b>Numbers in folder names are used</b>A folder named 03 Finance goes into 3 Finance. A folder without a number goes after the last one. You can change every number before anything uploads.</li>
            <li><b>Duplicates are caught</b>Files identical to a document already in the room are flagged, even under another name.</li>
          </ul>
          {fileInputs}
        </section>
        <section className="panel" aria-label="Recent uploads">
          <div className="ph"><h2>Recent uploads</h2><span className="cap">Times in {zoneAbbreviation(new Date(), tz)}</span></div>
          {data.recent.length ? data.recent.map((r) => (
            <div key={`${r.at}-${r.person}`} className="hist">
              <span className="m">{shortWhen(r.at, tz)}</span>
              <span>{recentLine(r)}</span>
              {r.drafts ? <span className="badge b-warn">{plural(r.drafts, 'draft', 'drafts')}</span> : <span className="badge b-ok">Published</span>}
            </div>
          )) : <p className="none">Nothing uploaded yet. The first import becomes the room&apos;s index.</p>}
        </section>
      </div>
    );
  }

  if (step === 'check') {
    const s = plan?.summary;
    const dropped = picked.reduce((a, p) => a + p.file.size, 0);
    const folderCount = new Set(picked.flatMap((p) => { const a = p.path.split('/').slice(0, -1); return a.map((_, i) => a.slice(0, i + 1).join('/')); })).size;
    const newTops = plan ? plan.folders.filter((f) => !f.existingId) : [];
    const existingTops = plan ? plan.folders.filter((f) => f.existingId && filesUnder(f).some((x) => x.indexNumber)) : [];
    const allFiles = plan ? [...plan.files, ...plan.folders.flatMap(filesUnder)] : [];
    const allFolders = plan ? [...walkFolders(plan.folders)] : [];
    const dupFiles = allFiles.filter((x) => x.duplicateOf);
    const nopFiles = allFiles.filter((x) => x.noPreview && x.indexNumber);
    const up = s?.uploadFiles ?? 0;
    const ready = !!plan && !planning && allHashed && !clashes && up > 0;
    const exNamed = allFolders.find((x) =>
      !x.folder.existingId
      && parseLeadingNumber(x.folder.sourceName).number != null
      && !typed.has(back.folders.get(x.folder.sourcePath) ?? ''));
    const exNext = allFolders.find((x) => {
      if (x.folder.existingId) return false;
      const sourceName = back.folders.get(x.folder.sourcePath)?.split('/').at(-1) ?? x.folder.sourceName;
      return parseLeadingNumber(sourceName).number == null;
    });
    const exts = [...new Set(nopFiles.map((x) => (x.name.includes('.') ? x.name.split('.').pop()!.toUpperCase() : 'FILE')))];
    const nopWhere = [...new Set(nopFiles.map((x) => parentIx(x.indexNumber!)))];
    const folderLabel = (ix: string) => {
      const f = allFolders.find((x) => x.folder.indexNumber === ix)?.folder;
      return f ? `${ix} ${f.name}` : ix || tgt.label;
    };
    const tops = data.targets.map((x) => Number(x.ix)).filter((x) => Number.isInteger(x) && x > 0);
    let topRange: string | null = null;
    if (tops.length === 1) topRange = String(tops[0]);
    else if (tops.length > 1) topRange = `${Math.min(...tops)} to ${Math.max(...tops)}`;
    let barCap = `${plural(up, 'file', 'files')}, ${plural(s?.newFolders ?? 0, 'new folder', 'new folders')}. Nothing is visible to bidders until ${isAdmin ? 'you publish' : 'it is published'}.`;
    if (clashes) barCap = 'Two folders have the same number. Change one of them to continue.';
    else if (!allHashed) barCap = `Reading the files to find duplicates: ${n(hashed)} of ${n(picked.length)}.`;
    return (
      <div className="d1">
        <Head title="Check the index before you upload"
          sub={`${setName ? `${setName} · ` : ''}${plural(picked.length, 'file', 'files')} in ${plural(folderCount, 'folder', 'folders')} · ${size(dropped)} · into ${intoTop ? 'the top level of the index' : tgt.label}`} />
        <Stepper on="check" />
        <div className="d1-grid">
          <section className="panel" aria-label="Index after upload">
            <div className="ph"><h2>Where each folder will go</h2><span className="cap">{isAdmin ? 'Type in a number to change it' : 'Numbers follow the folders already there'}</span></div>
            {planError ? <p className="err" role="alert">{planError}</p> : null}
            <div style={{ overflowX: 'auto' }}>
              <div role="table" aria-label="Index after upload">
                <div className="tree-h" role="row"><span>Index</span><span>Folder</span><span className="r">Files</span><span className="r">Size</span><span>What happens</span></div>
                <div id="tree" aria-busy={!plan}>{plan ? folderRows() : <div className="trow2" role="row"><span /><span className="nm cap">Checking the index…</span></div>}</div>
              </div>
            </div>
            <div className="pfoot"><span className="cap">
              {intoTop ? (topRange ? `Index numbers ${topRange} already in the room do not change.` : 'Index numbers already in the room do not change.') : `Numbers already in ${tgt.label} do not change.`} Open a folder to see its file numbers. You can reorder anything later in Documents, edit mode.
            </span></div>
          </section>
          <div className="col">
            <section className="panel" aria-label="Summary">
              <div className="ph"><h3>Summary</h3></div>
              <div className="pad">
                <div className="big2" id="up-n">{n(up)}</div><div className="cap">files will arrive as drafts</div>
                <ul className="d1-facts">
                  <li><span>New folders</span><span>{n(s?.newFolders ?? 0)}</span></li>
                  <li><span>Existing folders that receive files</span><span>{n(s?.existingFoldersReceiving ?? 0)}</span></li>
                  <li><span>Size</span><span>{size(s?.uploadBytes ?? 0)}</span></li>
                  <li><span>System files left out (Thumbs.db, .DS_Store)</span><span>{n(s?.systemFilesSkipped ?? 0)}</span></li>
                </ul>
              </div>
            </section>
            {!allHashed ? (
              <section className="panel" aria-label="Duplicates">
                <div className="ph"><h3>Looking for duplicates</h3></div>
                <div className="pad"><p className="cap" style={{ margin: 0 }}>Reading {n(hashed)} of {plural(picked.length, 'file', 'files')} to compare them with the documents already in the room.</p></div>
              </section>
            ) : dupFiles.length ? (
              <section className="panel" aria-label="Duplicates">
                <div className="ph"><h3>{dupFiles.length === 1 ? '1 file is already in the room' : `${n(dupFiles.length)} files are already in the room`}</h3><span className="k k-dup">Duplicates</span></div>
                <div className="pad">
                  <ul className="ex">
                    {dupFiles.slice(0, 2).map((x) => <li key={x.sourcePath}>{x.name} is identical to <span className="n">{x.duplicateOf}</span></li>)}
                    {dupFiles.length > 2 ? (() => {
                      const rest = dupFiles.slice(2);
                      const where = [...new Set(rest.map((x) => parentIx(x.indexNumber ?? x.duplicateOf ?? '') || ''))];
                      const inOne = rest.every((x) => x.sourcePath.split('/').slice(0, -1).join('/') === rest[0]!.sourcePath.split('/').slice(0, -1).join('/'));
                      const folder = allFolders.find((y) => y.folder.files.includes(rest[0]!))?.folder;
                      let tail = '';
                      if (inOne && folder) tail = `, all in ${folder.indexNumber} ${folder.name}`;
                      else if (where.length > 1) tail = ` in ${n(where.length)} folders`;
                      return <li className="cap">and {n(rest.length)} more{tail}</li>;
                    })() : null}
                  </ul>
                  <label className="opt"><input type="radio" name="dups" value="skip" checked={dups === 'skip'} onChange={() => setDups('skip')} /><div><b>Leave them out</b><span>Recommended. The documents already in the room stay as they are.</span></div></label>
                  <label className="opt"><input type="radio" name="dups" value="keep" checked={dups === 'keep'} onChange={() => setDups('keep')} /><div><b>Upload them as separate documents</b><span>Bidders would see the same file twice.</span></div></label>
                </div>
              </section>
            ) : null}
            <section className="panel" aria-label="Numbering">
              <div className="ph"><h3>How new folders are numbered</h3></div>
              <div className="pad">
                <ul className="rule-list">
                  <li><b>A number in the name is kept.</b> {exNamed ? <>{back.folders.get(exNamed.folder.sourcePath)?.split('/').at(-1)} becomes <span className="n">{last(exNamed.folder.indexNumber)}</span> {exNamed.folder.name}.</> : <>03 Finance becomes <span className="n">3</span> Finance.</>}</li>
                  <li><b>A folder without one goes after the last number,</b> in alphabetical order.{exNext ? <> {exNext.folder.name} becomes <span className="n">{exNext.folder.indexNumber}</span>.</> : null}</li>
                  <li><b>{isAdmin ? 'A number you type wins.' : 'A number that is taken is not used.'}</b> Two folders cannot share a number.</li>
                </ul>
                <p className="cap" style={{ margin: '10px 0 0' }}>The numbers are removed from the names, so {exNamed ? `${back.folders.get(exNamed.folder.sourcePath)?.split('/').at(-1)} shows as ${exNamed.folder.name}` : '09 Environmental shows as Environmental'}.</p>
              </div>
            </section>
            {intoTop && newTops.length ? (
              <section className="panel" aria-label="Bidder access">
                <div className="ph"><h3>{newTops.length === 1 ? '1 new top-level folder has no bidder access' : `${n(newTops.length)} new top-level folders have no bidder access`}</h3><span className="k k-lock">No bidder access</span></div>
                <div className="pad"><p className="cap" style={{ margin: 0 }}>
                  No bidder group can see {newTops.length === 1 ? 'it' : 'them'} until you give access. They stay marked in Documents and on your dashboard until you do.
                  {existingTops.length ? ` Folders inside ${andList(existingTops.map((f) => f.indexNumber))} take the access of their parent.` : ''}
                </p></div>
              </section>
            ) : null}
            {nopFiles.length ? (
              <section className="panel" aria-label="Files without preview">
                <div className="ph"><h3>{nopFiles.length === 1 ? '1 file has no preview' : `${n(nopFiles.length)} files have no preview`}</h3><span className="k k-nop">{exts.slice(0, 3).join(', ')}</span></div>
                <div className="pad"><p className="cap" style={{ margin: 0 }}>
                  The {exts.slice(0, 3).join(', ')} files in {andList(nopWhere.slice(0, 3).map(folderLabel))}{nopWhere.length > 3 ? ' and other folders' : ''} are stored as they are. Only people with the right to download originals can open them.
                </p></div>
              </section>
            ) : null}
          </div>
        </div>
        <div className="actionbar">
          <span className="cap" id="bar-cap" aria-live="polite">{barCap}</span>
          <div className="btns">
            <button type="button" className="btn ghost" onClick={reset}>Choose different files</button>
            <button type="button" className="btn primary" id="go-up" disabled={!ready} onClick={startUpload}>{up === 1 ? 'Upload 1 file as a draft' : `Upload ${plural(up, 'file', 'files')} as drafts`}</button>
          </div>
        </div>
        {fileInputs}
      </div>
    );
  }

  const r = runner!;
  const total = r.totalBytes;
  const sent = r.sentBytes;
  const pct = total ? Math.floor((sent / total) * 100) : 100;
  const done = r.states.filter((x) => x.status === 'done');
  const failed = r.states.map((x, i) => ({ x, j: r.jobs[i]! })).filter(({ x }) => x.status === 'failed');
  const cancelled = r.states.filter((x) => x.status === 'cancelled').length;
  const moved = r.states.map((x, i) => ({ x, j: r.jobs[i]! })).filter(({ x, j }) => x.status === 'done' && j.plannedIndex && x.indexNumber && x.indexNumber !== j.plannedIndex);
  const rows = [...new Set(r.jobs.map((j) => j.row))].sort(compareIndex).map((row) => {
    const idx = r.jobs.map((j, i) => (j.row === row ? i : -1)).filter((i) => i >= 0);
    const bytes = idx.reduce((a, i) => a + r.jobs[i]!.picked.file.size, 0);
    const got = idx.reduce((a, i) => a + Math.min(r.states[i]!.sent, r.jobs[i]!.picked.file.size), 0);
    const f = plan?.folders.find((x) => x.indexNumber === row);
    const st = idx.map((i) => r.states[i]!);
    const vers = st.map((x) => (x.versionId ? processing.get(x.versionId) : undefined));
    const allIn = st.every((x) => x.status === 'done' || x.status === 'failed' || x.status === 'cancelled');
    const bad = st.filter((x) => x.status === 'failed').length + vers.filter((v) => v?.status === 'failed').length;
    let badge: ReactNode;
    if (bad) badge = <span className="badge b-danger">{n(bad)} failed</span>;
    else if (allIn && st.some((x) => x.status === 'done') && vers.every((v) => v?.status === 'ready')) badge = <span className="badge b-ok">Ready</span>;
    else if (allIn && st.some((x) => x.status === 'done')) badge = <span className="badge b-info">Processing</span>;
    else if (st.every((x) => x.status === 'waiting')) badge = <span className="cap">Waiting</span>;
    else if (st.every((x) => x.status === 'cancelled')) badge = <span className="cap">Cancelled</span>;
    else badge = <span className="cap">{bytes ? Math.floor((got / bytes) * 100) : 100}%</span>;
    return (
      <div key={row || 'loose'} className="frow">
        <span className="ix">{row || tgt.ix || '–'}</span>
        <span>{f?.name ?? 'Files without a folder'} <span className="cap">· {plural(idx.length, 'file', 'files')}</span></span>
        <span className="mini"><i style={{ width: `${bytes ? (got / bytes) * 100 : 100}%` }} /></span>
        <span className="st">{badge}</span>
      </div>
    );
  });

  if (step === 'upload') {
    const left = r.rate > 0 ? Math.max(0, (total - sent) / r.rate) : null;
    let eta = '';
    if (left != null) eta = left > 60 ? ` · about ${Math.ceil(left / 60)} min left` : ` · about ${Math.max(1, Math.round(left))} s left`;
    let status = `${eta}${r.rate > 0 ? ` · ${Math.round(r.rate / 1e6)} MB/s` : ''}`;
    if (r.retryIn === 0) status = ' · connection lost, continues when you are back online';
    else if (r.retryIn !== null) status = ` · trying again in ${r.retryIn} s`;
    else if (r.isPaused) status = ' · paused';
    let announce = '';
    if (r.retryIn === 0) announce = 'Connection lost. The upload continues when you are back online.';
    else if (r.retryIn !== null) announce = 'Connection problem. Trying again by itself in a few seconds.';
    else if (r.isPaused) announce = 'Upload paused.';
    else if (pct >= 25) announce = `${Math.floor(pct / 25) * 25}% uploaded.`;
    return (
      <div className="d1">
        <Head title={`Uploading ${plural(r.jobs.length, 'file', 'files')}`} sub="Keep this tab open until the upload finishes. If your connection drops, it carries on once you are back online." />
        <Stepper on="upload" />
        <section className="panel" aria-label="Upload progress">
          <div className="prog">
            {/* not live: too chatty */}
            <p className="sr-only" aria-live="polite">{announce}</p>
            <div className="top2"><span className="pct" id="pct">{pct}%</span><span className="cap" id="eta">{total >= 1e9 ? `${(sent / 1e9).toFixed(2)} GB of ${gb(total)}` : `${size(sent)} of ${size(total)}`}{status}</span></div>
            <div className="track2" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {r.isPaused
                ? <button type="button" className="btn secondary sm" onClick={() => r.continue()}>Continue</button>
                : <button type="button" className="btn secondary sm" onClick={() => r.pause()}>Pause</button>}
              <button type="button" className="btn ghost sm" onClick={() => void r.cancelRest()}>Cancel the rest</button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>{rows}</div>
          <div className="pfoot"><span className="cap">After each file arrives, VDRkit converts it for the viewer. That continues on the server, so you can close the tab once the upload reaches 100%.</span></div>
        </section>
      </div>
    );
  }

  const vers = done.map((x) => (x.versionId ? processing.get(x.versionId) : undefined));
  const readyN = vers.filter((v) => v?.status === 'ready').length;
  const failedProc = done.map((x) => ({ x, p: x.versionId ? processing.get(x.versionId) : undefined })).filter(({ p }) => p?.status === 'failed');
  const stillN = done.length - readyN - failedProc.length;
  const created = new Map<string, { id: string; indexNumber: string; name: string }>();
  done.forEach((x) => x.createdFolders?.forEach((c) => created.set(c.id, c)));
  const newTops = [...created.values()].filter((c) => !c.indexNumber.includes('.')).sort((a, b) => compareIndex(a.indexNumber, b.indexNumber));
  const tops = new Set(done.map((x) => (x.indexNumber ?? '').split('.')[0]!));
  const existingTops = [...tops].filter((t) => t && !newTops.some((c) => c.indexNumber === t)).sort(compareIndex);
  const canPublish = tgt.canPublish;
  const when = finishedAt ?? new Date();
  const title = failed.length || cancelled
    ? `${n(done.length)} of ${plural(r.jobs.length, 'file', 'files')} uploaded as drafts`
    : `${plural(done.length, 'file', 'files')} uploaded as drafts`;
  return (
    <div className="d1">
      <Head title={title}
        sub={`${formatWhen(when, tz)}. ${done.length ? `VDRkit is converting them for the viewer: ${n(readyN)} ready, ${n(stillN)} still processing${failedProc.length ? `, ${n(failedProc.length)} could not be processed` : ''}.` : 'Nothing was uploaded.'}`} />
      <Stepper on="done" />
      {failed.length || failedProc.length || cancelled || moved.length ? (
        <section className="panel fails" aria-label="Files that need attention">
          <div className="ph"><h2>Files that need attention</h2><span className="cap">{cancelled ? `${plural(cancelled, 'file was', 'files were')} not uploaded because you cancelled the rest.` : ''}</span></div>
          {failed.map(({ x, j }) => (
            <div key={j.key} className="hist"><span className="m">Not uploaded</span><span>{j.picked.path}<span className="why">{x.error}</span></span><span className="badge b-danger">Failed</span></div>
          ))}
          {moved.map(({ x, j }) => (
            <div key={j.key} className="hist">
              <span className="m">{x.indexNumber}</span>
              <span>{j.picked.file.name}<span className="why">Numbered {x.indexNumber}, not {j.plannedIndex} as the check step showed, because that number was taken.</span></span>
              {x.nodeId ? <Link className="btn ghost sm" href={detailsHref(ws, x.nodeId)}>Versions and details</Link> : null}
            </div>
          ))}
          {failedProc.map(({ x, p }) => (
            <div key={x.versionId} className="hist">
              <span className="m">{p!.indexNumber}</span>
              <span>{p!.name}<span className="why">{p!.error}</span></span>
              <Link className="btn ghost sm" href={detailsHref(ws, p!.nodeId)}>Versions and details</Link>
            </div>
          ))}
        </section>
      ) : null}
      <div className="next">
        <section className="panel">
          {isAdmin ? <span className="badge b-warn" style={{ alignSelf: 'flex-start' }}>{plural(draftsBefore + done.length, 'draft', 'drafts')} in the room</span> : null}
          <h3>{canPublish ? 'Publish when you are ready' : 'They wait for publishing'}</h3>
          <p>{canPublish
            ? `${draftsBefore && isAdmin ? `These ${n(done.length)} join the ${n(draftsBefore)} drafts already waiting. ` : ''}In Release review you choose what to publish and see which bidder groups will get each folder.`
            : 'They are drafts in the folders you chose. A publisher or a room admin publishes them in Release review, and bidders see nothing until then.'}</p>
          {canPublish ? <div className="row"><Link className="btn primary" href={roomHref(ws, 'release')}>Go to Release review</Link></div> : null}
        </section>
        {isAdmin && newTops.length ? (
          <section className="panel">
            <span className="k k-lock" style={{ alignSelf: 'flex-start' }}>{plural(newTops.length, 'folder', 'folders')} without bidder access</span>
            <h3>Give bidders access to the new folders</h3>
            <p>New top-level {newTops.length === 1 ? 'folder' : 'folders'} {andList(newTops.map((c) => c.indexNumber))} {newTops.length === 1 ? 'has' : 'have'} no access for any bidder group yet. They stay marked in Documents and on your dashboard until you set it.{existingTops.length ? ` Folders inside ${andList(existingTops)} take the access of their parent.` : ''}</p>
            <div className="row"><Link className="btn secondary" href={roomHref(ws, 'permissions')}>Open the permission matrix</Link><button type="button" className="btn ghost" onClick={reset}>Upload more</button></div>
          </section>
        ) : (
          <section className="panel">
            <h3>See them in the index</h3>
            <p>{tgtId ? `Open ${tgt.label} in Documents to check the new numbers and names.` : 'Open Documents to check the new numbers and names.'} You can reorder and renumber drafts there until they are published.</p>
            <div className="row"><Link className="btn secondary" href={tgtId ? roomHref(ws, 'documents', tgtId) : roomHref(ws, 'documents')}>Go to Documents</Link><button type="button" className="btn ghost" onClick={reset}>Upload more</button></div>
          </section>
        )}
      </div>
    </div>
  );
}
