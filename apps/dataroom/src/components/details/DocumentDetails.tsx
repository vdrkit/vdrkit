// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import type { paths } from '@/api/client';
import { FileAccessDialog } from '@/components/documents/FileAccessDialog';
import { limitText } from '@/components/documents/limits';
import { displayName, extensionOf, formatSize, levelLabel, plural } from '@/components/documents/format';
import { NewVersionDialog } from '@/components/documents/NewVersionDialog';
import type { GroupAccess, Item } from '@/components/documents/types';
import { canReleaseQuietly, QUIET_HINT, QUIET_LABEL, releaseBlocked, releaseHint, releaseLabel, type ReleaseInfo } from '@/components/documents/release-one';
import { pickedFromInput, type Picked } from '@/components/documents/upload';
import { useReleaseOne } from '@/components/documents/useReleaseOne';
import { useToast } from '@/components/outside/Toast';
import { roomHref, viewHref } from '@/components/room/routes';
import { useSeeAs } from '@/components/room/SeeAs';
import { formatDay, formatWhen } from '@/lib/time';
import { useModal } from '@/lib/a11y';
import { useSendOnce } from '@/lib/send-once';

export type Details = paths['/v1/workspaces/{ws}/nodes/{id}/details']['get']['responses'][200]['content']['application/json'];
type Version = Details['versions'][number];
type StepState = Version['processing']['steps']['received'];
type Problem = { detail?: string } | undefined;

const PARTY_COLOURS = ['var(--g-a)', 'var(--g-b)', 'var(--g-c)', 'var(--g-s)'];
const STEPS: [keyof Version['processing']['steps'], string][] = [
  ['received', 'Received'], ['virus', 'Virus check'], ['pages', 'Pages read'], ['images', 'Page images'], ['text', 'Text for search'],
];
const STEP_CLASS: Partial<Record<StepState, string>> = { done: 'ok', failed: 'bad', skipped: 'skip' };
const STEP_TITLE: Partial<Record<keyof Version['processing']['steps'], string>> = {
  virus: 'No virus scanner checks uploads on this site yet.',
};
const notScanned = (v: Version) => {
  const skip = v.processing.virusSkip;
  if (skip?.reason !== 'too_large') return null;
  return skip.limitBytes ? `Not scanned: larger than ${limitText(skip.limitBytes)}.` : 'Not scanned: too large for the virus scanner.';
};

const NO_PREVIEW_TITLE = {
  file_type: 'This file type cannot be shown in the browser. It is published and downloaded as the original.',
  too_large: 'This file is too large to show in the browser. It is published and downloaded as the original.',
} as const;

const UP = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" /></svg>;
const EYE = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5S21.5 12 21.5 12S18 18.5 12 18.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></svg>;

function ftype(name: string): { cls: string; label: string } {
  const e = extensionOf(name);
  if (e === 'pdf') return { cls: 'pdf', label: 'PDF' };
  if (['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods'].includes(e)) return { cls: 'xls', label: 'XLS' };
  if (['doc', 'docx', 'dot', 'dotx', 'rtf', 'odt', 'txt'].includes(e)) return { cls: 'doc', label: 'DOC' };
  return { cls: '', label: (e || 'file').slice(0, 4).toUpperCase() };
}

const names = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const grouped = (sha: string) => sha.match(/.{1,8}/g)!.join(' ');

type Dlg = { kind: 'withdraw'; v: Version } | { kind: 'remove'; v: Version } | null;

export function DocumentDetails({ ws, details, timeZone: tz, me, release = null }: {
  ws: string; details: Details; timeZone: string; me: string;
  release?: ReleaseInfo | null;
}) {
  const seeAs = useSeeAs();
  const d: Details = seeAs ? { ...details, me: { ...details.me, canUpload: false, canPublish: false } } : details;
  const router = useRouter();
  const toast = useToast();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dlgError, setDlgError] = useState<string | null>(null);
  const once = useSendOnce();
  const [newFile, setNewFile] = useState<Picked | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [ask, setAsk] = useState<{ state: 'idle' | 'busy' | 'failed'; error?: string }>({ state: 'idle' });
  const asking = useSendOnce();
  const againOnce = useSendOnce();
  const [againError, setAgainError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [relError, setRelError] = useState<string | null>(null);
  const releaser = useReleaseOne(ws, release, toast.show, setRelError);
  const [quiet, setQuiet] = useState(false);

  const doc = d.document;
  const name = displayName(doc.name);
  const label = doc.indexNumber ? `${doc.indexNumber} ${name}` : name;
  const folder = doc.path.at(-1);
  const folderLabel = folder ? (folder.indexNumber ? `${folder.indexNumber} ${folder.name}` : folder.name) : 'the top level';
  const latest = d.versions[0];
  const current = d.versions.find((v) => v.status === 'current');
  const waiting = d.versions.find((v) => v.status === 'waiting');
  const admin = d.me.isAdmin;
  const failedLatest = latest?.processing.status === 'failed';
  const canOpen = !!d.me.viewerVersionId && d.versions.find((v) => v.id === d.me.viewerVersionId)?.processing.status === 'ready';

  const colours = new Map(d.access?.parties.map((p, i) => [p.id, PARTY_COLOURS[i % PARTY_COLOURS.length]!]) ?? []);
  const bidderGroups = d.access?.groups.filter((g) => g.partyKind !== 'seller') ?? [];
  const seeing = bidderGroups.filter((g) => g.level >= 20 && !g.parentGroupId).map((g) => g.name);

  const dlgBox = useRef<HTMLDivElement>(null);
  useModal(dlgBox, { focusFirst: false, active: !!dlg });
  useEffect(() => {
    if (!dlg) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setDlg(null); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [dlg, busy]);

  // must match the withdraw endpoint's choice
  function earlierReleased(of: Version): Version | undefined {
    if (doc.state !== 'published' || of.status !== 'current') return undefined;
    return d.versions.find((v) => v.number < of.number && v.status === 'replaced' && !!v.releasedAt);
  }

  const confirm = once(async () => {
    if (!dlg) return;
    setBusy(true);
    setDlgError(null);
    const api = browserApi();
    if (dlg.kind === 'withdraw') {
      const earlier = earlierReleased(dlg.v);
      const body = { reason: reason.trim() || undefined };
      let back: number | null = null;
      let err: Problem;
      let ok: boolean;
      if (earlier) {
        const r = await api.POST('/v1/workspaces/{ws}/versions/{id}/withdraw', { params: { path: { ws, id: dlg.v.id } }, body });
        err = r.error as Problem;
        ok = r.response.ok;
        back = r.data?.fallsBackTo ?? null;
      } else {
        const r = await api.POST('/v1/workspaces/{ws}/nodes/{id}/withdraw', { params: { path: { ws, id: doc.id } }, body });
        err = r.error as Problem;
        ok = r.response.ok;
      }
      setBusy(false);
      if (err || !ok) { setDlgError(err?.detail ?? 'It could not be withdrawn. Try again.'); return; }
      setDlg(null);
      setReason('');
      const line = back != null
        ? `Bidders see version ${back} again. Logged in Activity.`
        : 'Nobody outside the seller team sees it now. Logged in Activity.';
      toast.show('Withdrawn from bidders', line);
      router.refresh();
      return;
    }
    const r = await api.POST('/v1/workspaces/{ws}/versions/{id}/remove-draft', { params: { path: { ws, id: dlg.v.id } }, body: {} });
    setBusy(false);
    const err = (r as { error?: { detail?: string } }).error;
    if (err || !r.data) { setDlgError(err?.detail ?? 'The draft could not be removed. Try again.'); return; }
    setDlg(null);
    if (r.data.removed === 'document') {
      router.push(folder ? roomHref(ws, 'documents', folder.id) : roomHref(ws, 'documents'));
      router.refresh();
      return;
    }
    toast.show('Draft removed', current ? `Bidders keep seeing version ${current.number}. Logged in Activity.` : 'Logged in Activity.');
    router.refresh();
  });

  // not necessarily the file's fault
  const processAgain = againOnce(async (v: Version) => {
    setAgainError(null);
    const r = await browserApi().POST('/v1/workspaces/{ws}/versions/{id}/process-again', { params: { path: { ws, id: v.id } }, body: {} });
    if (!r.data) {
      setAgainError((r.error as Problem)?.detail ?? 'Processing could not be started again. Try again in a moment.');
      return;
    }
    toast.show('Processing started again', `Version ${v.number} is back in the queue. Logged in Activity.`);
    router.refresh();
  });

  const askUploader = asking(async (v: Version) => {
    if (!v.uploadedBy) return;
    setAsk({ state: 'busy' });
    const r = await browserApi().POST('/v1/workspaces/{ws}/nodes/{id}/ask-for-copy', { params: { path: { ws, id: doc.id } } });
    if (r.error || !r.data || r.data.status !== 'accepted') {
      const error = (r.error as Problem)?.detail ?? `The email to ${v.uploadedBy.name} could not be sent. Try again later.`;
      setAsk({ state: 'failed', error });
      return;
    }
    setAsk({ state: 'idle' });
    const pw = /password/i.test(v.processing.error ?? '');
    toast.show(`Email sent to ${r.data.name}`, `Asks for a copy ${pw ? 'without a password' : 'VDRkit can read'}. Logged in Activity.`);
  });

  async function copyFingerprint() {
    if (!latest) return;
    try {
      // Safari: only inside the click. Undefined without HTTPS
      await navigator.clipboard.writeText(latest.sha256);
      toast.show('Fingerprint copied', `SHA-256 of version ${latest.number}.`);
    } catch {
      toast.show('The fingerprint was not copied', `SHA-256 of version ${latest.number}: ${latest.sha256}`);
    }
  }

  let badge: ReactNode;
  if (failedLatest && !current) badge = <span className="badge b-danger">Not ready: processing failed</span>;
  else if (doc.state === 'withdrawn') badge = <span className="badge b-neutral">Withdrawn</span>;
  else if (waiting) badge = <span className="badge b-warn">Version {waiting.number} waiting for release</span>;
  else if (doc.state === 'draft') badge = <span className="badge b-warn">Draft</span>;
  else badge = <span className="badge b-ok">Published</span>;

  const t = ftype(doc.name);
  const head = (
    <div className="head">
      <div className="dtitle">
        <span className={`ftype ${t.cls}`}>{t.label}</span>
        <div>
          <p className="crumb">{doc.path.map((p) => (p.indexNumber ? `${p.indexNumber} ${p.name}` : p.name)).join(' › ') || 'Documents'}</p>
          <h1>{doc.indexNumber ? <span className="n">{doc.indexNumber}</span> : null}{name}</h1>
          {badge}
        </div>
      </div>
      <div className="acts">
        {canOpen ? <Link className="btn secondary" href={viewHref(ws, doc.id)}>{EYE}Open in the viewer</Link> : null}
        {d.me.canUpload ? (
          <button type="button" className="btn primary" onClick={() => fileInput.current?.click()}>{UP}{failedLatest ? 'Upload a new copy' : 'Upload a new version'}</button>
        ) : null}
      </div>
    </div>
  );

  const nonAdminPublishers = d.publishers.filter((p) => !p.isAdmin).map((p) => p.name);
  const whoPublishes = nonAdminPublishers.length ? `${names(nonAdminPublishers)} or a room admin publishes it.` : 'A room admin publishes it.';

  function releaseButton(v: Version): ReactNode {
    const t = release?.items[doc.id];
    if (!t || !release || seeAs || !d.me.canPublish || releaser.released.has(doc.id)) return null;
    const forThis = t.versionId ? t.versionId === v.id : v.status === 'draft' && v.id === latest?.id;
    if (!forThis) return null;
    const lbl = releaseLabel(t, t.versionId ? v.number : null);
    const why = releaseBlocked(release.rules, t);
    if (why) {
      return (
        <>
          <span className="cap" id={`rel-why-${v.id}`} style={{ maxWidth: 220, textAlign: 'right' }}>{why}</span>
          <button type="button" className="btn primary sm" disabled aria-describedby={`rel-why-${v.id}`}>{lbl}</button>
        </>
      );
    }
    const quietOk = canReleaseQuietly(release.rules, t);
    return (
      <>
        {quietOk ? (
          <label className="cap" title={QUIET_HINT} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={quiet} disabled={!!releaser.busy} onChange={(e) => setQuiet(e.target.checked)} />{QUIET_LABEL}
          </label>
        ) : null}
        <button type="button" className="btn primary sm" title={quiet && quietOk ? QUIET_HINT : releaseHint(release.rules, t)} disabled={!!releaser.busy}
          onClick={() => { setRelError(null); void releaser.release(t, doc.indexNumber ?? name, t.versionId ? v.number : null, quiet && quietOk); }}>
          {releaser.busy === doc.id ? 'Releasing…' : lbl}
        </button>
      </>
    );
  }

  const steps = (v: Version) => {
    const unscanned = notScanned(v);
    return (
      <>
        <div className="psteps" aria-label="Processing">
          {STEPS.map(([k, labelText]) => {
            const s: StepState = v.processing.steps[k];
            const cls = STEP_CLASS[s] ?? 'wait';
            const title = s === 'skipped' ? (k === 'virus' && unscanned) || (STEP_TITLE[k] ?? 'Not needed for this file: it has no preview.') : undefined;
            return <span key={k} className={`step ${cls}`} title={title} data-step={k} data-state={s}><i />{labelText}</span>;
          })}
        </div>
        {unscanned ? <p className="pnote" data-testid="not-scanned">{unscanned}</p> : null}
      </>
    );
  };

  const rows = d.versions.map((v, i) => {
    let tag: ReactNode;
    let sub: string;
    let acts: ReactNode = null;
    const failed = v.processing.status === 'failed';
    let uploaded = `Uploaded ${formatWhen(v.uploadedAt, tz)}`;
    if (v.uploadedBy) uploaded += ` by ${v.uploadedBy.name}`;
    uploaded += ` · ${v.fileName} · ${formatSize(v.sizeBytes)}`;
    if (v.pageCount) uploaded += ` · ${plural(v.pageCount, 'page', 'pages')}`;
    const open = v.id === d.me.viewerVersionId && v.processing.status === 'ready'
      ? <Link className="btn ghost sm" href={viewHref(ws, doc.id)}>Open</Link> : null;
    const published = v.releasedAt ? `Published ${formatWhen(v.releasedAt, tz)}${v.releasedBy ? ` by ${v.releasedBy}` : ''}.` : null;
    const withdrawn = `${v.withdrawnAt ? ` ${formatWhen(v.withdrawnAt, tz)}` : ''}${v.withdrawnBy ? ` by ${v.withdrawnBy}` : ''}`;
    if (failed && (v.status === 'draft' || v.status === 'waiting')) {
      tag = <span className="badge b-danger">Processing failed</span>;
      sub = 'Not visible to anyone outside the seller team.';
    } else if (v.status === 'draft' || v.status === 'waiting') {
      tag = <span className="badge b-warn">Draft</span>;
      sub = v.status === 'waiting' && current ? `Bidders still see version ${current.number} until this one is published.` : 'Bidders see nothing until it is published.';
      const remove = v.canRemove ? <button type="button" className="btn ghost sm" onClick={() => { setDlgError(null); setDlg({ kind: 'remove', v }); }}>Remove draft</button> : null;
      acts = d.me.canPublish ? (
        <>
          {releaseButton(v)}
          {v.processing.status === 'ready' ? <Link className="btn secondary sm" href={roomHref(ws, 'release')}>Review and publish</Link> : null}
          {remove}
        </>
      ) : (
        <><span className="cap" style={{ maxWidth: 200, textAlign: 'right' }}>{whoPublishes}</span>{remove}</>
      );
    } else if (v.status === 'current') {
      tag = <span className="badge b-ok">Bidders see this</span>;
      sub = published ?? 'Published.';
      acts = <>{open}{d.me.canPublish ? <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }} onClick={() => { setDlgError(null); setReason(''); setDlg({ kind: 'withdraw', v }); }}>Withdraw</button> : null}</>;
    } else if (v.status === 'replaced') {
      tag = <span className="badge b-neutral">Replaced</span>;
      sub = published ?? 'Replaced before it was published.';
      acts = open;
    } else if (v.status === 'removed') {
      tag = <span className="badge b-neutral">Draft removed</span>;
      sub = `Removed${withdrawn}, before anyone outside the seller team saw it.`;
    } else {
      tag = <span className="badge b-neutral">Withdrawn</span>;
      sub = `Withdrawn from bidders${withdrawn}.`;
      acts = open;
    }
    const why = failed && v.processing.error ? (
      <div className="why" role="status">
        <span><b>{v.processing.error}</b> {/password/i.test(v.processing.error) ? 'Upload a copy without a password, or ask the person who sent it for one.' : 'Upload a new copy, or ask the person who sent it for one VDRkit can read.'}</span>
        <div className="acts">
          {(admin || d.me.canUpload || d.me.canPublish) && (v.status === 'draft' || v.status === 'waiting')
            ? <button type="button" className="btn secondary sm" onClick={() => void processAgain(v)}>Process again</button> : null}
          {d.me.canUpload && i === 0 ? <button type="button" className="btn secondary sm" onClick={() => fileInput.current?.click()}>{UP}Upload a new copy</button> : null}
          {admin && v.uploadedBy && i === 0 ? (
            <button type="button" className="btn ghost sm" disabled={ask.state === 'busy'} onClick={() => void askUploader(v)}>Ask {v.uploadedBy.name}</button>
          ) : null}
        </div>
        {ask.state === 'failed' && i === 0 ? <span>{ask.error}</span> : null}
        {againError && i === 0 ? <span>{againError}</span> : null}
      </div>
    ) : null;
    return (
      <div key={v.id} className={`vrow${i === 0 ? ' cur' : ' old'}`} data-version={v.number} data-status={v.status}>
        <span className="vn">v{v.number}</span>
        <div>
          <div className="vh"><b>Version {v.number}</b>{tag}{v.processing.noPreview ? <span className="badge b-np" title={NO_PREVIEW_TITLE[v.processing.noPreview]}>No preview</span> : null}</div>
          <div className="meta">{uploaded}</div>
          <div className="meta">{sub}</div>
        </div>
        <div className="va">{acts}</div>
        {steps(v)}
        {why}
      </div>
    );
  });

  const versions = (
    <section className="panel" aria-label="Versions">
      <div className="ph"><div><h2>Versions</h2><span className="cap">Newest first. Every published version is kept, also after it is replaced or withdrawn.</span></div></div>
      {rows}
    </section>
  );

  const file = latest ? (
    <section className="panel" aria-label="File">
      <div className="ph"><h2>File, version {latest.number}</h2><button type="button" className="linkbtn" onClick={() => void copyFingerprint()}>Copy fingerprint</button></div>
      <div className="ffacts">
        <span>Original name</span><b>{latest.fileName}</b>
        <span>Size</span><b>{formatSize(latest.sizeBytes)}</b>
        <span>Fingerprint</span><span className="hash" title="SHA-256">SHA-256 {grouped(latest.sha256)}</span>
      </div>
      <div className="pfoot"><span className="cap">The fingerprint proves later that a file is exactly the one uploaded. It is also in the activity log and the archive export.</span></div>
    </section>
  ) : null;

  const lvClass = (l: number) => (l <= 0 ? ' none' : l >= 60 ? ' orig' : '');
  const lvText = (l: number) => (l <= 0 ? 'No access' : levelLabel(l));
  const customN = d.access?.groups.filter((g) => g.custom).length ?? 0;
  const latestUnpublished = latest && (latest.status === 'draft' || latest.status === 'waiting');
  const access = d.access ? (
    <section className="panel" aria-label="Who can see it">
      <div className="ph"><div><h2>Who can see it</h2><span className="cap">{customN ? `Custom access for ${plural(customN, 'group', 'groups')}. The rest follows ${folderLabel}` : `Follows ${folderLabel}`}</span></div></div>
      {latestUnpublished ? (
        <div className="dnote info" style={{ marginTop: 12 }}><div><b>These levels apply {d.versions.length > 1 ? `to version ${latest.number} ` : ''}once it is published.</b> Until then only the seller team sees it.</div></div>
      ) : null}
      {d.access.groups.map((g) => (
        <div key={g.id} className="acc" data-group={g.name}>
          <span className="g">
            <i style={{ background: g.partyKind === 'seller' ? 'var(--g-s)' : colours.get(g.partyId) ?? PARTY_COLOURS[0] }} />{g.name}
            {g.partyKind === 'seller' ? <small>seller team</small> : null}
            {g.custom ? <small>custom access</small> : null}
          </span>
          <span className={`lv${lvClass(g.level)}`}>{lvText(g.level)}</span>
        </div>
      ))}
      {admin ? (
        <div className="pfoot">
          <button type="button" className="linkbtn" onClick={() => setAccessOpen(true)}>Set access for this file</button>
          <Link className="linkbtn" href={roomHref(ws, 'permissions')}>Change in Permissions</Link>
        </div>
      ) : null}
    </section>
  ) : null;

  const reads = admin && d.reads && d.reads.groups.length ? (
    <section className="panel" aria-label="Opened by">
      <div className="ph"><div><h2>Opened by</h2><span className="cap">Version {d.reads.versionNumber}, since it was published</span></div></div>
      {d.reads.groups.map((g) => (
        <div key={g.groupId} className="reads">
          <span>{g.name}</span>
          <span className="r">{g.opened ? `${n(g.opened)} of ${plural(g.members, 'person', 'people')}${g.lastAt ? `, last ${formatDay(g.lastAt, tz)}` : ''}` : 'Nobody yet'}</span>
        </div>
      ))}
      <div className="pfoot"><Link className="linkbtn" href={roomHref(ws, 'activity')}>See who opened it in Activity</Link></div>
    </section>
  ) : null;

  let dialog: ReactNode = null;
  if (dlg) {
    const ix = doc.indexNumber ?? name;
    let title: string;
    let body: ReactNode;
    let go: string;
    if (dlg.kind === 'withdraw') {
      const earlier = earlierReleased(dlg.v);
      title = `Withdraw ${ix} from bidders`;
      const who = seeing.length ? names(seeing) : 'Bidders';
      body = (
        <>
          {earlier
            ? <p>{who} go back to version {earlier.number} of {name} at once. Version {dlg.v.number} keeps its place in the history.</p>
            : <p>{who} stop seeing {name} at once. {waiting ? `Version ${waiting.number} is still a draft, so no earlier version takes its place.` : 'No earlier version takes its place.'}</p>}
          <p>The document keeps its number and its history.</p>
          <label className="fld"><span>Reason <i>(in the activity log, not shown to bidders)</i></span>
            <textarea className="tarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: sent in error, wrong counterparty" maxLength={500} />
          </label>
        </>
      );
      go = 'Withdraw from bidders';
    } else {
      const only = doc.state === 'draft' && d.versions.filter((v) => v.status !== 'removed').length === 1;
      title = only ? `Remove the draft ${label}` : `Remove the draft of version ${dlg.v.number}`;
      body = only ? (
        <><p>{label} leaves the index before anyone outside the seller team has seen it. Its file is deleted.</p><p>The upload and the deletion stay in the activity log. Its number is not given to another document.</p></>
      ) : (
        <><p>Version {dlg.v.number} is removed before anyone outside the seller team has seen it. Its file is deleted.{current ? ` Bidders keep seeing version ${current.number}.` : ''}</p><p>The upload and the deletion stay in the activity log.</p></>
      );
      go = 'Remove draft';
    }
    dialog = (
      <div className="d2-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) setDlg(null); }}>
        <div ref={dlgBox} className="d2-dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
          <div className="dh"><h2 id="dlg-t">{title}</h2></div>
          <div className="db">{body}{dlgError ? <p className="err" role="alert">{dlgError}</p> : null}</div>
          <div className="df">
            <button type="button" className="btn secondary" onClick={() => setDlg(null)} disabled={busy} autoFocus>Cancel</button>
            <button type="button" className="btn danger" onClick={() => void confirm()} disabled={busy}>{go}</button>
          </div>
        </div>
      </div>
    );
  }

  const item: Item | null = latest ? {
    id: doc.id, parentId: folder?.id ?? null, kind: 'document', name: doc.name, indexNumber: doc.indexNumber, state: doc.state,
    allowed: d.me.canUpload ? ['upload'] : [],
    version: { id: latest.id, number: latest.number, pageCount: latest.pageCount, uploadedAt: latest.uploadedAt,
      status: latest.processing.status, noPreview: latest.processing.noPreview },
    uploadedBy: latest.uploadedBy, releasedVersion: null, renumberedFrom: null,
  } : null;
  const groupAccess: GroupAccess[] = bidderGroups.map((g) => ({
    id: g.id, name: g.name, color: colours.get(g.partyId) ?? PARTY_COLOURS[0]!, parentGroupId: g.parentGroupId, parentName: g.parentName, level: g.folderLevel,
  }));
  const own = Object.fromEntries(bidderGroups.filter((g) => g.ownLevel != null).map((g) => [g.id, g.ownLevel!]));

  return (
    <div className="d2">
      {head}
      {relError ? <div className="dnote warn" role="alert"><div>{relError}</div></div> : null}
      <div className="grid">
        <div className="col">{versions}{file}</div>
        <div className="col">{access}{reads}</div>
      </div>
      <input ref={fileInput} type="file" hidden data-testid="d2-file" onChange={(e) => { const p = pickedFromInput(e.target.files)[0]; e.target.value = ''; if (p) setNewFile(p); }} />
      {newFile && item ? (
        <NewVersionDialog ws={ws} doc={item} picked={newFile} timeZone={tz} isAdmin={admin} canPublish={d.me.canPublish} me={me}
          onClose={(changed) => { setNewFile(null); if (changed) { toast.show('New version uploaded', 'It is a draft until it is published. Logged in Activity.'); router.refresh(); } }} />
      ) : null}
      {accessOpen && item ? (
        <FileAccessDialog ws={ws} doc={item} folderLabel={folderLabel} groups={groupAccess} own={own}
          onClose={(changed) => { setAccessOpen(false); if (changed) { toast.show('Access saved', 'This file has its own levels now. Logged in Activity.'); router.refresh(); } }} />
      ) : null}
      {dialog}
      {toast.node}
    </div>
  );
}

const n = (x: number) => x.toLocaleString('en-GB');
