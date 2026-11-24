// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import { formatDay } from '@/lib/time';
import { Dialog } from './Dialog';
import { displayName, extensionOf, formatSize, kindWord, plural } from './format';
import type { Item } from './types';
import { sha256Hex, UNREADABLE, uploadFile, type Picked } from './upload';

// rough; misses page trees in object streams
async function pdfPages(file: File): Promise<number | null> {
  if (extensionOf(file.name) !== 'pdf' || file.size > 200 * 1024 * 1024) return null;
  const text = new TextDecoder('latin1').decode(await file.arrayBuffer());
  const n = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return n > 0 ? n : null;
}

export function NewVersionDialog({ ws, doc, picked, timeZone, isAdmin, canPublish, me, onClose }: {
  ws: string;
  doc: Item;
  me: string;
  picked: Picked;
  timeZone: string;
  isAdmin: boolean;
  canPublish: boolean;
  onClose: (changed: boolean) => void;
}) {
  const [keepName, setKeepName] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  // seconds to the next try, 0 while offline
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const cancelled = useRef(false);
  const now = doc.version?.number ?? 0;
  const next = now + 1;
  const name = displayName(doc.name);
  const published = doc.state === 'published';
  const sameType = extensionOf(picked.file.name) === extensionOf(doc.name);

  const [pages, setPages] = useState<number | null>(null);
  const [facts, setFacts] = useState<{ publishedAt: string | null; openedByGroups: number | null } | null>(null);

  useEffect(() => {
    let stop = false;
    void sha256Hex(picked.file).then((h) => { if (!stop) setHash(h); }, () => { if (!stop) setError(`${picked.file.name} ${UNREADABLE}. Close this and choose the file again.`); });
    return () => { stop = true; };
  }, [picked]);
  useEffect(() => {
    let stop = false;
    pdfPages(picked.file)
      .then((n) => { if (!stop) setPages(n); })
      .catch(() => {});
    return () => { stop = true; };
  }, [picked]);
  useEffect(() => {
    if (!published || !(isAdmin || canPublish)) return;
    let stop = false;
    void browserApi().GET('/v1/workspaces/{ws}/nodes/{id}/audience', { params: { path: { ws, id: doc.id } } })
      .then((r) => { if (!stop && r.data?.document) setFacts(r.data.document); });
    return () => { stop = true; };
  }, [ws, doc.id, published, isAdmin, canPublish]);

  const day = (at: string) => {
    const d = formatDay(at, timeZone);
    return d === formatDay(new Date(), timeZone) ? 'today' : d;
  };
  let nowLine = 'Draft';
  if (published) {
    nowLine = 'Published';
    if (facts?.publishedAt) nowLine += ` ${day(facts.publishedAt)}`;
    const opened = facts?.openedByGroups;
    if (opened != null) nowLine += opened ? ` · opened by ${plural(opened, 'bidder group', 'bidder groups')}` : ' · not opened by a bidder group yet';
  } else if (doc.version) {
    const by = doc.uploadedBy ? ` by ${doc.uploadedBy.personId === me ? 'you' : doc.uploadedBy.name}` : '';
    nowLine += `, uploaded${by} ${day(doc.version.uploadedAt)}`;
  }

  let nowPages = 'Being prepared for viewing';
  if (doc.version?.pageCount != null) nowPages = `${doc.version.pageCount} pages`;
  else if (doc.version?.noPreview) nowPages = 'No preview';
  else if (doc.version?.status === 'failed') nowPages = 'Could not be prepared';

  async function upload() {
    if (!hash) return;
    setBusy(true);
    setError(null);
    try {
      // not a rename; non-admins can pick this
      await uploadFile(ws, { file: picked.file, path: picked.file.name }, hash, { replacesNodeId: doc.id, useFileName: !keepName && picked.file.name !== doc.name },
        { onRetry: setRetryIn, cancelled: () => cancelled.current });
      if (!cancelled.current) onClose(true);
    } catch (e) {
      if (cancelled.current) return;
      setRetryIn(null);
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // closable between tries
  const locked = busy && retryIn === null;
  const close = () => { cancelled.current = true; onClose(false); };
  let live = busy ? `Uploading version ${next}` : '';
  if (busy && retryIn === 0) live = 'Connection lost. The upload continues when you are back online.';
  else if (busy && retryIn !== null) live = 'Connection problem. Trying again by itself in a few seconds.';

  const you = canPublish ? 'you publish' : 'it is published';
  return (
    <Dialog
      over="Upload a new version"
      title={`New version of ${doc.indexNumber ?? ''} ${name}`.replace(/\s+/g, ' ')}
      onClose={close}
      busy={locked}
      foot={(
        <>
          <button type="button" className="btn ghost" onClick={close} disabled={locked}>Cancel</button>
          <button type="button" className="btn primary" onClick={upload} disabled={busy || !sameType || !hash}>
            {busy ? `Uploading version ${next}` : `Upload as version ${next}`}
          </button>
        </>
      )}
    >
      <p className="sr-only" aria-live="polite">{live}</p>
      <div className="vers">
        <div className="ver">
          <span className="lab">Now · version {now}</span>
          <b>{nowPages}</b>
          <span>{nowLine}</span>
        </div>
        <div className="ver nw">
          <span className="lab">New · version {next}</span>
          <b>{pages ? plural(pages, 'page', 'pages') : kindWord(picked.file.name)}</b>
          <span>{picked.file.name} · {formatSize(picked.file.size)}{busy && retryIn !== null ? (
            <span aria-hidden="true" data-testid="retrying">{retryIn === 0 ? ' · connection lost, continues when you are back online' : ` · trying again in ${retryIn} s`}</span>
          ) : null}</span>
        </div>
      </div>
      {!sameType ? (
        <div className="ask" role="alert">
          <h3>This file is a different type</h3>
          <p>A new version must be the same type of file as the document (.{extensionOf(doc.name) || 'no extension'}). Close this and add it to the folder as a new document instead.</p>
        </div>
      ) : null}
      <label className="chk">
        <input type="checkbox" checked={keepName} onChange={(e) => setKeepName(e.target.checked)} />
        <span>Keep the name <b>{name}</b>. Leave unticked to use the new file name.</span>
      </label>
      <div className="dw-sec">
        <h3>What bidders see</h3>
        <ul className="facts">
          {published ? (
            <>
              <li>Until {you}, bidders keep seeing version {now}.</li>
              <li>When {you}, the document keeps number {doc.indexNumber} and shows &quot;Updated&quot; for 14 days.</li>
              <li>People who opened version {now} get a notification, unless they have turned that notification off.</li>
              <li>Version {now} stays in the history.{isAdmin ? ' You decide per group whether bidders can still open it.' : ''}</li>
            </>
          ) : (
            <>
              <li>Nothing yet. This document is still a draft, so the new file simply replaces the old one when it is published.</li>
              <li>Version {now} stays in the history for room admins.</li>
            </>
          )}
        </ul>
      </div>
      {error ? <div className="ask" role="alert"><p>{error}</p></div> : null}
    </Dialog>
  );
}
