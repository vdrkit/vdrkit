// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { browserApi } from '@/api/browser';
import { dayWithYear, roomAdmin } from '@/components/errors/pages';
import { LeaveIcon } from '@/components/outside/icons';
import { useToast } from '@/components/outside/Toast';
import { authCall, safeNext } from '@/lib/auth-client';
import { formatTime } from '@/lib/time';
import { useSendOnce } from '@/lib/send-once';
import { Steps } from './InvitationFlow';

export interface NdaData {
  versionId: string;
  versionNo: number;
  body: string;
  mode: 'everyone' | 'correction' | null;
  name: string | null;
  publishedAt: string | null;
  pages: number | null;
  roomName: string;
  runBy: string;
  sellerName: string | null;
  contactName: string | null;
  accessEndsAt: string | null;
}

// "# " title, "## " or short numbered line heading, blank line ends a paragraph
export function NdaText({ body, fallbackTitle }: { body: string; fallbackTitle: string }) {
  const blocks: ReactNode[] = [];
  const paras = body.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  let titled = false;
  paras.forEach((para, i) => {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    let text: string[] = [];
    const flush = (k: string) => { if (text.length) { blocks.push(<p key={k}>{text.join(' ')}</p>); text = []; } };
    lines.forEach((l, j) => {
      const k = `${i}.${j}`;
      const numbered = /^\d+(\.\d+)*\.?\s+\S/.test(l) && l.length <= 60 && !/[.;:]$/.test(l);
      if (l.startsWith('# ')) {
        flush(`${k}p`);
        blocks.push(<h2 key={k}>{l.slice(2)}</h2>);
        titled = true;
      } else if (/^#{2,3}\s/.test(l) || numbered) {
        flush(`${k}p`);
        blocks.push(<h3 key={k}>{l.replace(/^#{2,3}\s/, '')}</h3>);
      } else {
        text.push(l);
      }
    });
    flush(`${i}p`);
  });
  return <>{titled ? null : <h2>{fallbackTitle}</h2>}{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</>;
}

export function NdaForm({ ws, nda, timeZone, next, steps }: {
  ws: string; nda: NdaData; timeZone: string; next: string; steps?: { twoFactor: boolean };
}) {
  const [accept, setAccept] = useState(false);
  const [left, setLeft] = useState(false);
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [err, setErr] = useState('');
  const toast = useToast();
  const room = nda.roomName;
  const until = nda.accessEndsAt ? dayWithYear(nda.accessEndsAt, timeZone) : null;

  const enter = once(async () => {
    setBusy(true);
    const r = await browserApi().POST('/v1/workspaces/{ws}/nda/accept', { params: { path: { ws } }, body: { versionId: nda.versionId } });
    if (!r.data) {
      setBusy(false);
      setErr(r.response.status === 409
        ? 'A newer version of the agreement has just been published. Reload the page to read it.'
        : 'Your acceptance could not be recorded. Try again in a minute.');
      return;
    }
    toast.show('Agreement accepted', `Recorded at ${formatTime(r.data.acceptedAt, timeZone)}. Opening ${room}.`);
    const to = safeNext(next);
    setTimeout(() => window.location.assign(to === '/' ? `/rooms/${ws}/dashboard` : to), 900);
  });

  const leave = once(async () => {
    setBusy(true);
    await authCall('/sign-out', {});
    setBusy(false);
    setLeft(true);
  });

  if (left) {
    return (
      <>
        <div className="done-ico"><LeaveIcon /></div>
        <div>
          <h1>You have not entered the room</h1>
          <p className="lead">
            You can come back and accept the agreement at any time{until ? <> until <b>{until}</b></> : null}. Sign in again with the same email address.
            {' '}Questions about the agreement go to {nda.contactName ? `${nda.contactName} at ${nda.runBy}` : roomAdmin(null, null)}.
          </p>
        </div>
        <a className="btn secondary block" href={`/sign-in?next=${encodeURIComponent(`/rooms/${ws}/nda`)}`}>Back to the agreement</a>
      </>
    );
  }

  const published = nda.publishedAt ? ` · published ${dayWithYear(nda.publishedAt, timeZone)}` : '';
  return (
    <>
      {steps ? <Steps current={3} twoFactor={steps.twoFactor} /> : null}
      <div>
        <h1>Before you enter {room}</h1>
        <p className="lead">{nda.sellerName ?? nda.runBy} asks everyone outside the seller team to accept this confidentiality agreement. You see no documents until you do.</p>
      </div>
      <div className="nda-meta">
        <span>Version {nda.versionNo}{nda.mode === 'correction' ? ', a correction of the earlier version' : ''}{nda.name ? ` · ${nda.name}` : ''}{published}</span>
        <a className="linkbtn" href={`/v1/workspaces/${ws}/nda/pdf`} target="_blank" rel="noopener">Open as PDF{nda.pages ? `, ${nda.pages} ${nda.pages === 1 ? 'page' : 'pages'}` : ''}</a>
      </div>
      <div className="nda" tabIndex={0} aria-label={`Confidentiality agreement, version ${nda.versionNo}`}>
        <NdaText body={nda.body} fallbackTitle="Confidentiality agreement" />
      </div>
      <label className="chk">
        <input type="checkbox" id="f-accept" checked={accept} onChange={(e) => setAccept(e.target.checked)} aria-describedby={err ? 'f-err' : undefined} />
        <span>I have read the confidentiality agreement and accept it.</span>
      </label>
      <p className="hint" style={{ marginTop: -8 }}>Your acceptance is recorded with your name, the date and time, and your IP address. The room admin can see it, and you can read the agreement again in the room at any time.</p>
      {err ? <p className="hint err" id="f-err">{err}</p> : null}
      <div className="acts">
        <button type="button" className="btn secondary" onClick={leave} disabled={busy}>Leave without accepting</button>
        <button type="button" className="btn primary" onClick={enter} disabled={!accept || busy}>Accept and enter the room</button>
      </div>
      {toast.node}
    </>
  );
}
