// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import { Dialog } from './Dialog';
import { displayName, formatSize, join, kindWord, lastNumberIn, plural, publishersLine } from './format';
import { AccessChips, visibleGroups } from './parts';
import type { GroupAccess, Item } from './types';
import { MAX_FILE_BYTES, MAX_FILE_TEXT } from './limits';
import { Transient } from '@/lib/retry';
import { useSendOnce } from '@/lib/send-once';
import { pickedFromDrop, pickedFromInput, sha256Hex, UNREADABLE, uploadFile, type Picked } from './upload';

export type UploaderRole = 'admin' | 'publisher' | 'contributor';

interface PlannedFile { sourcePath: string; name: string; indexNumber: string | null; status: 'new' | 'duplicate_skipped' | 'duplicate_kept' | 'system_skipped'; duplicateOf?: string; duplicateName?: string }
interface PlannedFolder { files: PlannedFile[]; children: PlannedFolder[] }
interface Plan { folders: PlannedFolder[]; files: PlannedFile[] }

type Choice = 'version' | 'new' | 'skip';
type Step = 'choose' | 'check' | 'done';

const UpIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" /></svg>;
const tooLarge = (f: Picked) => f.file.size > MAX_FILE_BYTES;

const KIND_ORDER = { new: 0, ver: 1, skip: 2 };

const XIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;

function flatten(plan: Plan): Map<string, PlannedFile> {
  const out = new Map<string, PlannedFile>();
  const walk = (f: PlannedFolder) => { f.files.forEach((x) => out.set(x.sourcePath, x)); f.children.forEach(walk); };
  plan.files.forEach((x) => out.set(x.sourcePath, x));
  plan.folders.forEach(walk);
  return out;
}

export function AddFilesDialog({ ws, target, items, initial, role, groups, publishers, fourEyes = false, canPublishNow = false, chooseFolder, onClose }: {
  ws: string;
  target: { id: string | null; ix: string | null; name: string };
  items: Item[];
  initial: Picked[] | null;
  role: UploaderRole;
  groups: GroupAccess[] | null;
  publishers: string[] | null;
  fourEyes?: boolean;
  canPublishNow?: boolean;
  chooseFolder?: boolean;
  onClose: (changed: boolean, notice?: { title: string; line: string }) => void;
}) {
  const [files, setFiles] = useState<Picked[]>(initial ?? []);
  const [step, setStep] = useState<Step>(initial?.length ? 'check' : 'choose');
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [unreadable, setUnreadable] = useState<Record<string, true>>({});
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [plan, setPlan] = useState<Map<string, PlannedFile> | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ done: number; of: number } | null>(null);
  const [results, setResults] = useState<{ path: string; ok: boolean; error?: string; retryable?: boolean;
    publish?: { nodeId: string } | { versionId: string } }[]>([]);
  const [publishing, setPublishing] = useState<'ask' | 'busy' | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const [retryIn, setRetryIn] = useState<Record<string, number>>({});
  const once = useSendOnce();
  const publishOnce = useSendOnce();
  const input = useRef<HTMLInputElement>(null);
  const label = target.ix ? `${target.ix} ${target.name}` : target.name;
  const docs = items.filter((i) => i.kind === 'document');

  const sameAs = useMemo(() => {
    const m = new Map<string, Item>();
    for (const f of files) {
      if (f.path.includes('/') || tooLarge(f)) continue;
      const hit = docs.find((d) => d.name.toLocaleLowerCase('en') === f.file.name.toLocaleLowerCase('en'));
      if (hit) m.set(f.path, hit);
    }
    return m;
  }, [files, docs]);
  const choiceOf = (p: string): Choice => (sameAs.has(p) ? choice[p] ?? 'version' : 'new');

  const queued = useRef(new WeakSet<File>());
  const queue = useRef(Promise.resolve());
  const current = useRef(files);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);
  useEffect(() => {
    current.current = files;
    for (const f of files) {
      if (queued.current.has(f.file) || tooLarge(f)) continue;
      queued.current.add(f.file);
      queue.current = queue.current.then(async () => {
        if (!open.current || !current.current.some((x) => x.file === f.file)) { queued.current.delete(f.file); return; }
        const h = await sha256Hex(f.file).catch(() => null);
        if (h === null) setUnreadable((x) => ({ ...x, [f.path]: true }));
        else setHashes((x) => ({ ...x, [f.path]: h }));
      });
    }
  }, [files]);

  const left = (f: Picked) => tooLarge(f) || !!unreadable[f.path];
  const newOnes = files.filter((f) => choiceOf(f.path) === 'new' && !left(f));
  const ready = files.every((f) => hashes[f.path] || left(f));
  const planKey = ready ? newOnes.map((f) => `${f.path}:${hashes[f.path]}`).join('|') : '';

  useEffect(() => {
    if (step !== 'check' || !ready) return;
    if (!newOnes.length) { setPlan(new Map()); return; }
    let stop = false;
    setPlan(null);
    setPlanError(null);
    void browserApi().POST('/v1/workspaces/{ws}/upload-plans', {
      params: { path: { ws } },
      body: { targetFolderId: target.id, numbering: 'from_names', duplicates: 'skip', files: newOnes.map((f) => ({ path: f.path, size: f.file.size, sha256: hashes[f.path]! })) },
    }).then((r) => {
      if (stop) return;
      if (r.response.ok) setPlan(flatten((r as unknown as { data: Plan }).data));
      else setPlanError((r.error as { detail?: string } | undefined)?.detail ?? 'The files could not be checked.');
    });
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- planKey covers files and hashes
  }, [planKey, step]);

  function add(more: Picked[]) {
    if (!more.length) return;
    setFiles((cur) => {
      const have = new Set(cur.map((f) => f.path));
      return [...cur, ...more.filter((f) => !have.has(f.path))];
    });
    setStep('check');
  }
  function remove(path: string) {
    const rest = files.filter((f) => f.path !== path);
    setFiles(rest);
    if (!rest.length) setStep('choose');
  }

  type Row = { f: Picked; ix: string; kind: 'new' | 'ver' | 'skip'; note: string; why?: string };
  const rows: Row[] = files.map((f) => {
    const c = choiceOf(f.path);
    const same = sameAs.get(f.path);
    const meta = `${kindWord(f.file.name)} · ${formatSize(f.file.size)}${f.path.includes('/') ? ` · in ${f.path.slice(0, f.path.lastIndexOf('/'))}` : ''}`;
    if (tooLarge(f)) return { f, ix: '–', kind: 'skip', note: `${meta} · larger than ${MAX_FILE_TEXT}, so it cannot be uploaded` };
    if (unreadable[f.path]) return { f, ix: '–', kind: 'skip', note: `${meta} · ${UNREADABLE}` };
    if (same && c === 'version') return { f, ix: same.indexNumber ?? '', kind: 'ver', note: `${meta} · same name as ${same.indexNumber}` };
    if (same && c === 'skip') return { f, ix: '–', kind: 'skip', note: `${meta} · same name as ${same.indexNumber}` };
    const p = plan?.get(f.path);
    if (p?.status === 'duplicate_skipped') return { f, ix: '–', kind: 'skip', note: meta, why: `Not added: the same file is already ${[p.duplicateOf, p.duplicateName].filter(Boolean).join(' ')}.` };
    if (p?.status === 'system_skipped') return { f, ix: '–', kind: 'skip', note: `${meta} · a system file` };
    return { f, ix: p?.indexNumber ?? '…', kind: 'new', note: same ? `${meta} · same name as ${same.indexNumber}` : meta };
  });
  // server numbers files in arrival order; keep list order
  const numeric = (ix: string) => (/^\d+(\.\d+)*$/.test(ix) ? ix.split('.').map(Number) : null);
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    const na = a.kind === 'new' ? numeric(a.ix) : null;
    const nb = b.kind === 'new' ? numeric(b.ix) : null;
    if (!na || !nb) return 0;
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const x = na[i] ?? -1;
      const y = nb[i] ?? -1;
      if (x !== y) return x - y;
    }
    return 0;
  });
  const toAdd = rows.filter((r) => r.kind !== 'skip');
  const n = toAdd.length;
  const identical = rows.filter((r) => r.why).length;
  const checking = !ready || plan === null;

  const send = once(async (list: Row[], prior: typeof results = []) => {
    setBusy({ done: 0, of: list.length });
    const out: typeof results = [];
    for (const r of list) {
      try {
        const same = sameAs.get(r.f.path);
        const onRetry = (s: number | null) => setRetryIn((x) => {
          const next = { ...x };
          delete next[r.f.path];
          if (s !== null) next[r.f.path] = s;
          return next;
        });
        let up;
        try {
          up = await uploadFile(ws, r.f, hashes[r.f.path]!, r.kind === 'ver' && same ? { replacesNodeId: same.id } : { targetFolderId: target.id }, { onRetry });
        } finally {
          onRetry(null);
        }
        out.push({ path: r.f.path, ok: true, publish: up.awaitingRelease ? { versionId: up.versionId } : { nodeId: up.nodeId } });
      } catch (e) {
        out.push({ path: r.f.path, ok: false, error: (e as Error).message, retryable: e instanceof Transient });
      }
      setBusy({ done: out.length, of: list.length });
    }
    const again = new Map(out.map((x) => [x.path, x]));
    setResults(prior.length ? prior.map((x) => again.get(x.path) ?? x) : out);
    setBusy(null);
    setStep('done');
  });

  const steps = (
    <ol className="steps" aria-label="Steps">
      {['Choose', 'Check', 'Done'].map((t, i) => {
        const cur = { choose: 0, check: 1, done: 2 }[step];
        return (
          <li key={t} className={i < cur ? 'done' : i === cur ? 'on' : ''} aria-current={i === cur ? 'step' : undefined}>
            <span>{i < cur ? '✓' : i + 1}</span>{t}
          </li>
        );
      })}
    </ol>
  );

  const fileInput = (
    <input
      ref={input}
      type="file"
      multiple
      hidden
      onChange={(e) => { add(pickedFromInput(e.target.files)); e.target.value = ''; }}
      {...(chooseFolder ? { webkitdirectory: '' } : {})}
      data-testid="add-files-input"
    />
  );

  // starting button may be gone
  useEffect(() => {
    if (step !== 'done' || busy) return;
    const box = document.querySelector<HTMLElement>('.drawer[role="dialog"]');
    // not one selector list: "Publish now" comes first in the DOM
    if (box && !box.contains(document.activeElement)) {
      (box.querySelector<HTMLElement>('.dw-f .btn.primary:not(:disabled)') ?? box.querySelector<HTMLElement>('.dw-f .btn:not(:disabled), .dw-h .icon-btn'))?.focus();
    }
  }, [step, busy]);

  useEffect(() => {
    if (publishing === 'ask') document.querySelector<HTMLElement>('.drawer[role="dialog"] .dw-f .btn.primary')?.focus();
  }, [publishing]);

  const added = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const retryable = failed.filter((r) => r.retryable);
  let publishLine = `${publishersLine(publishers)} them.`;
  if (role === 'admin') publishLine = 'You publish them in Release review.';
  else if (role === 'publisher') publishLine = 'You can publish them yourself in Release review.';

  const adding = (b: { done: number; of: number }) => `Adding ${Math.min(b.done + 1, b.of)} of ${plural(b.of, 'file', 'files')}`;
  const retryNote = (path: string) => (path in retryIn ? (
    <span aria-hidden="true" data-testid="retrying">{retryIn[path] === 0 ? ' · connection lost, continues when you are back online' : ` · trying again in ${retryIn[path]} s`}</span>
  ) : null);

  let title = `Add files to ${label}`;
  let body;
  let foot;
  if (step === 'choose') {
    body = (
      <>
        {steps}
        <div
          className={`pick${hot ? ' hot' : ''}`}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setHot(true); }}
          onDragLeave={() => setHot(false)}
          onDrop={async (e) => { e.preventDefault(); e.stopPropagation(); setHot(false); add(await pickedFromDrop(e.dataTransfer)); }}
        >
          <UpIcon />
          <b>Drop files here</b>
          <span>or</span>
          <button type="button" className="btn primary" onClick={() => input.current?.click()} data-autofocus>Browse your computer</button>
          <small>PDF, Word, Excel, PowerPoint and images, up to {MAX_FILE_TEXT} each. A dropped folder keeps its subfolders.</small>
        </div>
        <ul className="facts">
          <li>Nothing is uploaded until you have checked the list in the next step.</li>
          <li>Files arrive as drafts in {label}. Bidders see nothing until they are published.</li>
        </ul>
      </>
    );
    foot = <button type="button" className="btn ghost" onClick={() => onClose(false)}>Cancel</button>;
  } else if (step === 'check') {
    const dups = rows.filter((r) => sameAs.has(r.f.path));
    const last = lastNumberIn(items);
    const lastItem = items.find((i) => i.indexNumber === join(target.ix, last));
    let numbering = `The numbers above start at ${join(target.ix, 1)}, as ${label} is empty. You can change them until the files are published.`;
    if (!target.id) numbering = 'Folders keep the numbers in their names where those are free. You can change the numbers until the files are published.';
    else if (last && lastItem) numbering = `The numbers above follow ${join(target.ix, last)}, the last ${lastItem.kind === 'folder' ? 'folder' : 'document'} in ${label}. You can change them until the files are published.`;
    let duplicates = 'No file is identical to a document already in the room.';
    if (checking) duplicates = 'Checking whether a file is identical to a document already in the room.';
    else if (identical) duplicates = `${plural(identical, 'file is', 'files are')} already in the room, so ${identical === 1 ? 'it is' : 'they are'} not added.`;
    let addLabel = 'No files to add';
    if (busy) addLabel = adding(busy);
    else if (n === 1) addLabel = 'Add 1 file as a draft';
    else if (n) addLabel = `Add ${plural(n, 'file', 'files')} as drafts`;
    body = (
      <>
        {steps}
        <div className="dw-sec">
          <h3>You chose {plural(files.length, 'file', 'files')}{n < files.length ? ` · ${n} will be added` : ''}</h3>
          <div className="fl">
            {rows.map((r) => (
              <div key={r.f.path} className={`fl-r${r.kind === 'skip' ? ' skipped' : ''}`} data-file={r.f.path}>
                <span className="ix">{r.ix}</span>
                <span className="nm">{r.f.file.name}{r.why ? <span className="why">{r.why}</span> : null}<small>{r.note}{retryNote(r.f.path)}</small></span>
                <span className={`k ${r.kind === 'ver' ? 'k-ver' : r.kind === 'skip' ? 'k-skip' : 'k-new'}`}>{r.kind === 'ver' ? `Replaces ${r.ix}` : r.kind === 'skip' ? 'Not added' : 'Added'}</span>
                <button type="button" className="icon-btn" aria-label={`Remove ${r.f.file.name}`} title="Remove from the list" onClick={() => remove(r.f.path)} disabled={!!busy}><XIcon /></button>
              </div>
            ))}
          </div>
          <button type="button" className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => input.current?.click()} disabled={!!busy}>Add more files</button>
        </div>
        {dups.length ? (
          <div className="ask" role="group" aria-labelledby="ask-h">
            <h3 id="ask-h">{dups.length === 1 ? 'One question before you add' : `${dups.length} questions before you add`}</h3>
            {dups.map((r) => {
              const d = sameAs.get(r.f.path)!;
              const c = choiceOf(r.f.path);
              const dn = `${d.indexNumber} ${displayName(d.name)}`;
              const seen = d.state === 'published';
              const set = (v: Choice) => setChoice((x) => ({ ...x, [r.f.path]: v }));
              return (
                <div key={r.f.path} className="ask-one">
                  <p>{r.f.file.name} has the same name as {dn}{seen ? ', which bidders can already see' : ''}. Is it a newer version of that document?</p>
                  <label className="opt"><input type="radio" name={`ver-${r.f.path}`} value="version" checked={c === 'version'} onChange={() => set('version')} /><div><b>Yes, a new version of {d.indexNumber}</b><span>It keeps number {d.indexNumber}.{seen ? ` Bidders keep seeing version ${d.version?.number ?? 1} until you publish version ${(d.version?.number ?? 1) + 1}.` : ''}</span></div></label>
                  <label className="opt"><input type="radio" name={`ver-${r.f.path}`} value="new" checked={c === 'new'} onChange={() => set('new')} /><div><b>No, a separate document</b><span>It gets its own number at the end of the folder.</span></div></label>
                  <label className="opt"><input type="radio" name={`ver-${r.f.path}`} value="skip" checked={c === 'skip'} onChange={() => set('skip')} /><div><b>Skip this file</b><span>It is not uploaded. Choose this if it is the same document as {d.indexNumber}, or if you are not sure yet.</span></div></label>
                </div>
              );
            })}
          </div>
        ) : null}
        {planError ? <div className="ask" role="alert"><p>{planError}</p></div> : null}
        <div className="dw-sec">
          <h3>What happens when you add them</h3>
          <ul className="facts">
            <li>{numbering}</li>
            <li>{duplicates}</li>
            <li>They arrive as drafts. {publishLine}</li>
          </ul>
        </div>
        {groups ? (
          <div className="dw-sec"><h3>Who will see them once published</h3><div className="access"><AccessChips groups={groups} /></div></div>
        ) : null}
      </>
    );
    foot = (
      <>
        <button type="button" className="btn ghost" onClick={() => setStep('choose')} disabled={!!busy}>Back</button>
        <button type="button" className="btn primary" onClick={() => { if (!busy) void send(toAdd); }} disabled={checking || n === 0} aria-disabled={busy ? true : undefined}>
          {addLabel}
        </button>
      </>
    );
  } else {
    title = `${plural(added, 'file', 'files')} added to ${label}`;
    const it = added === 1 ? 'it' : 'them';
    const later = `in Release review or ${added === 1 ? 'from its' : 'one at a time from the'} ⋯ menu`;
    let who = `${publishersLine(publishers)} ${it}. You get a notice when they do.`;
    if (canPublishNow) who = `Keep ${it} as ${added === 1 ? 'a draft' : 'drafts'}, or publish ${it} now. You can also publish ${it} later ${later}.`;
    else if (role === 'admin') who = `You release ${it} ${later}.`;
    else if (role === 'publisher' && fourEyes) who = `Under the four-eyes rule someone else releases ${it}, ${later}.`;
    else if (role === 'publisher') who = `You can release ${it} yourself ${later}.`;
    const toPublish = results.filter((r) => r.ok && r.publish);
    const seen = groups ? visibleGroups(groups).map((g) => g.name) : [];
    const names = seen.length > 1 ? `${seen.slice(0, -1).join(', ')} and ${seen[seen.length - 1]}` : seen[0] ?? '';
    const audience = seen.length
      ? `${names} will see ${it}${seen.length === 1 ? '' : ', each at the level set for the folder'}.`
      : `No bidder group has access to ${label} yet, so only the seller team will see ${it}.`;
    body = (
      <>
        {steps}
        {added ? (
          <div className="okbox" role="status"><i>✓</i><h3>{plural(added, 'file is', 'files are')} in {label} as {added === 1 ? 'a draft' : 'drafts'}</h3><p>Bidders cannot see {it} yet. {who}</p></div>
        ) : null}
        {failed.length ? (
          <div className="ask" role="alert">
            <h3>{plural(failed.length, 'file was', 'files were')} not added</h3>
            {failed.map((f) => (
              <p key={f.path} data-file={f.path}><b>{f.path}</b>: {f.error}{retryNote(f.path)}</p>
            ))}
          </div>
        ) : null}
        {publishing ? (
          <div className="ask pubnow" role="group" aria-labelledby="pn-h" aria-describedby="pn-p">
            <h3 id="pn-h">Publish {plural(toPublish.length, 'file', 'files')} now?</h3>
            <p id="pn-p">{audience} A file still being prepared for viewing is published as soon as it is ready. Each bidder hears about it as they chose in their notification settings.</p>
          </div>
        ) : null}
        {publishError ? <div className="ask" role="alert"><p>{publishError}</p></div> : null}
        {added && !publishing ? (
          <ul className="facts">
            {added === 1
              ? <><li>It is being prepared for viewing. This takes about a minute per 100 pages.</li><li>You can replace your draft with a new version until it is published.</li></>
              : <><li>They are being prepared for viewing. This takes about a minute per 100 pages.</li><li>You can replace your drafts with a new version until they are published.</li></>}
            <li>Once released, each bidder hears about {it} as they chose in their notification settings, unless the release is quiet.</li></ul>
        ) : null}
      </>
    );
    const publishNow = publishOnce(async () => {
      setPublishing('busy');
      setPublishError(null);
      const nodeIds = toPublish.flatMap((r) => (r.publish && 'nodeId' in r.publish ? [r.publish.nodeId] : []));
      const versionIds = toPublish.flatMap((r) => (r.publish && 'versionId' in r.publish ? [r.publish.versionId] : []));
      const r = await browserApi().POST('/v1/workspaces/{ws}/publish', { params: { path: { ws } }, body: { nodeIds, versionIds, whenReady: true } });
      if (!r.data) {
        const p = r.error as { detail?: string; title?: string } | undefined;
        setPublishError(`${p?.detail ?? p?.title ?? 'Publishing did not work.'} The files are still drafts.`);
        setPublishing(null);
        return;
      }
      const waiting = r.data.waiting ?? 0;
      const now = toPublish.length - waiting;
      const title = waiting ? `${plural(toPublish.length, 'file is', 'files are')} being published` : `${plural(toPublish.length, 'file is', 'files are')} published`;
      const parts = [];
      if (now) parts.push(seen.length ? `${plural(now, 'file', 'files')} can be opened now.` : `${plural(now, 'file is', 'files are')} published for the seller team.`);
      if (waiting) parts.push(`${plural(waiting, 'file is', 'files are')} published as soon as ${waiting === 1 ? 'it is' : 'they are'} ready for viewing.`);
      parts.push('Logged in Activity.');
      onClose(true, { title, line: parts.join(' ') });
    });
    foot = publishing ? (
      <>
        <button type="button" className="btn ghost" onClick={() => setPublishing(null)} disabled={publishing === 'busy'}>Cancel</button>
        <button type="button" className="btn primary" data-autofocus onClick={() => { if (publishing === 'ask') void publishNow(); }}
          aria-disabled={publishing === 'busy' ? true : undefined}>
          {publishing === 'busy' ? 'Publishing…' : `Publish ${plural(toPublish.length, 'file', 'files')}`}
        </button>
      </>
    ) : (
      <>
        {canPublishNow && toPublish.length && !busy ? (
          <button type="button" className="btn secondary" onClick={() => { setPublishError(null); setPublishing('ask'); }}>Publish now</button>
        ) : null}
        {/* transient failures only */}
        {retryable.length ? (
          <button type="button" className="btn secondary" aria-disabled={busy ? true : undefined}
            onClick={() => { if (!busy) void send(toAdd.filter((r) => retryable.some((x) => x.path === r.f.path)), results); }}>
            {busy ? adding(busy) : `Try again (${plural(retryable.length, 'file', 'files')})`}
          </button>
        ) : null}
        <button type="button" className="btn primary" onClick={() => onClose(added > 0)} disabled={!!busy}>{added ? 'Keep as draft' : 'Close'}</button>
      </>
    );
  }

  const live: string[] = [];
  if (busy) live.push(`${adding(busy)}.`);
  if (Object.values(retryIn).some((s) => s === 0)) live.push('Connection lost. The upload continues when you are back online.');
  else if (Object.keys(retryIn).length) live.push('Connection problem. Trying again by itself in a few seconds.');

  return (
    <Dialog over="Add files" title={title} onClose={() => onClose(step === 'done' && added > 0)} busy={!!busy || publishing === 'busy'} foot={foot}>
      {fileInput}
      {body}
      {/* countdown not live: too chatty */}
      <p className="sr-only" aria-live="polite">{live.join(' ')}</p>
    </Dialog>
  );
}
