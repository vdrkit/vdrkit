// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserApi } from '@/api/browser';
import { count, detailOf, EMAIL, formatSignIn, type Account } from './model';
import { FailedSignIns } from './FailedSignIns';
import { SiteDialog } from './SiteDialog';
import { emailChangeFacts } from '@/components/people/dialogs';
import { andList } from '@/components/people/model';
import { useSendOnce } from '@/lib/send-once';
import type { SiteMe } from './SiteSettings';

type Filter = 'staff' | 'everyone';
const PAGE = 50;

const TWO_FACTOR: Partial<Record<string, string>> = { on: 'On', off: 'Off' };

export function AccountsTab({ staff, everyoneTotal, me, toast, onSiteAdmins }: {
  staff: { items: Account[]; total: number };
  everyoneTotal: number;
  me: SiteMe;
  toast: (title: string, line: string) => void;
  onSiteAdmins: (names: string[]) => void;
}) {
  const [filter, setFilter] = useState<Filter>('staff');
  const [q, setQ] = useState('');
  const [list, setList] = useState<{ items: Account[]; total: number; loading: boolean }>({ ...staff, loading: false });
  const [allTotal, setAllTotal] = useState(everyoneTotal);
  const once = useSendOnce();
  const [dialog, setDialog] = useState<
    | { kind: 'disable' | 'enable' | 'reset'; who: Account; busy: boolean; error: string | null }
    | { kind: 'admin'; email: string; name: string; busy: boolean; error: string | null }
    | { kind: 'email'; who: Account; email: string; busy: boolean; error: string | null;
        info: { name: string; email: string; otherRooms: number; pending: { newEmail: string; expiresAt: string } | null } | null }
    | null>(null);
  const req = useRef(0);
  const first = useRef(true);

  const load = useCallback(async (f: Filter, query: string, offset = 0) => {
    const id = ++req.current;
    setList((l) => ({ ...l, loading: true }));
    const search = query.trim();
    const params = { query: { filter: f, ...(search ? { q: search } : {}), limit: PAGE, offset } };
    const r = await browserApi().GET('/v1/site/accounts', { params }).catch(() => null);
    if (id !== req.current) return;
    if (!r?.data) {
      setList((l) => ({ ...l, loading: false }));
      toast('The list could not be loaded', detailOf(r?.error, 'Try again in a moment.'));
      return;
    }
    const data = r.data;
    setList((l) => ({ items: offset ? [...l.items, ...data.items] : data.items, total: data.total, loading: false }));
    if (f === 'everyone' && !search) setAllTotal(data.total);
  }, [toast]);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => { void load(filter, q); }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [filter, q, load]);

  async function refreshAdmins() {
    const r = await browserApi().GET('/v1/site/accounts', { params: { query: { filter: 'staff', limit: 200, offset: 0 } } }).catch(() => null);
    if (r?.data) onSiteAdmins(r.data.items.filter((a) => a.isSiteAdmin && !a.disabledAt).map((a) => a.name));
  }

  async function openEmail(a: Account) {
    setDialog({ kind: 'email', who: a, email: '', busy: false, error: null, info: null });
    const r = await browserApi().GET('/v1/site/accounts/{personId}/email-change', { params: { path: { personId: a.personId } } }).catch(() => null);
    if (!r?.data) return;
    const info = r.data;
    setDialog((d) => (d?.kind === 'email' && d.who.personId === a.personId ? { ...d, info } : d));
  }

  const confirm = once(async () => {
    if (!dialog || dialog.busy) return;
    const api = browserApi();
    if (dialog.kind === 'email') {
      const email = dialog.email.trim().toLowerCase();
      if (!EMAIL.test(email)) { setDialog({ ...dialog, error: 'Enter a complete email address.' }); return; }
      setDialog({ ...dialog, busy: true, error: null });
      const r = await api.POST('/v1/site/accounts/{personId}/email-change', { params: { path: { personId: dialog.who.personId } }, body: { email } }).catch(() => null);
      if (!r?.data) { setDialog({ ...dialog, busy: false, error: detailOf(r?.error, 'The code could not be sent. Try again in a moment.') }); return; }
      const given = dialog.who.name.split(' ')[0] ?? dialog.who.name;
      setDialog(null);
      if (r.data.emailStatus === 'accepted') toast(`Code sent to ${r.data.newEmail}`, `The address changes once ${given} enters it. Logged in the site log.`);
      else toast('The email with the code was not sent', `Check the outgoing email, then try again. Nothing has changed for ${given}.`);
      return;
    }
    if (dialog.kind === 'admin') {
      const email = dialog.email.trim().toLowerCase();
      if (!EMAIL.test(email)) { setDialog({ ...dialog, error: 'Enter a complete email address.' }); return; }
      setDialog({ ...dialog, busy: true, error: null });
      const body: { email: string; name?: string } = { email };
      const name = dialog.name.trim();
      if (name) body.name = name;
      const r = await api.POST('/v1/site/admins', { body }).catch(() => null);
      if (!r?.data) { setDialog({ ...dialog, busy: false, error: detailOf(r?.error, 'The site admin could not be added. Try again in a moment.') }); return; }
      setDialog(null);
      toast(`${r.data.name} is now a site admin`, r.data.emailStatus === 'accepted'
        ? 'They got an email. Site admins see no room content unless invited. Logged in the site log.'
        : 'The email to them could not be sent, so tell them yourself. Logged in the site log.');
      void refreshAdmins();
    } else {
      setDialog({ ...dialog, busy: true, error: null });
      const path = { params: { path: { personId: dialog.who.personId } } };
      let call;
      if (dialog.kind === 'disable') call = api.POST('/v1/site/accounts/{personId}/disable', path);
      else if (dialog.kind === 'enable') call = api.POST('/v1/site/accounts/{personId}/enable', path);
      else call = api.POST('/v1/site/accounts/{personId}/reset-two-factor', path);
      const r = await call.catch(() => null);
      if (!r?.data) { setDialog({ ...dialog, busy: false, error: detailOf(r?.error, 'This did not work. Try again in a moment.') }); return; }
      const who = dialog.who.name;
      setDialog(null);
      if (dialog.kind === 'enable') {
        const names = 'roomNames' in r.data ? r.data.roomNames : [];
        toast(`${who}’s account is enabled again`, names.length
          ? `They can sign in again, but their access to ${andList(names)} stays revoked. Ask the room admins there to use Restore access, or to invite ${who} again if they never accepted. Logged in the site log.`
          : 'They can sign in again. Logged in the site log.');
        void refreshAdmins();
      } else if (dialog.kind === 'disable') {
        toast(`${who}’s account is disabled`, 'Signed out everywhere. Room admins see it in their activity logs.');
        void refreshAdmins();
      } else {
        toast(`${who}’s two-factor sign-in is reset`, 'Signed out everywhere. They set up an authenticator app at their next sign-in. Logged in the site log.');
      }
    }
    void load(filter, q);
  });

  let shown = `${count(list.total)} ${list.total === 1 ? 'person runs' : 'people run'} this site`;
  if (q.trim() !== '') shown = `${count(list.total)} found`;
  else if (filter === 'everyone') shown = `Showing ${count(list.items.length)} of ${count(list.total)}, most recent sign-in first. Search to find anyone.`;
  const more = list.total - list.items.length;

  const role = (a: Account) => {
    if (a.isSiteAdmin) return <span className="pill ok role">Site admin</span>;
    if (a.canCreateRooms) return <span className="pill off role">Can create rooms</span>;
    return null;
  };

  return (
    <>
      <section className="panel" data-accounts>
        <div className="ph"><div><h2>Accounts</h2><span className="cap">Everyone who can sign in: {count(allTotal)} {allTotal === 1 ? 'person' : 'people'} across all rooms. Who may enter which room is managed by each room’s admins.</span></div></div>
        <div className="afil">
          <label className="fsearch">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
            <input id="aq" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person by name or email" aria-label="Find a person" autoComplete="off" spellCheck={false} />
          </label>
          <div className="seg2" role="group" aria-label="Show">
            <button type="button" aria-pressed={filter === 'staff'} onClick={() => setFilter('staff')}>Site admins and room creators</button>
            <button type="button" aria-pressed={filter === 'everyone'} onClick={() => setFilter('everyone')}>Everyone</button>
          </div>
        </div>
        <div className="tbl" aria-busy={list.loading}>
          <div className="tr h acc-t"><span>Person</span><span className="r">Rooms</span><span>Last sign-in</span><span>Two-factor</span><span></span></div>
          {list.items.map((a) => (
            <div className="tr acc-t" key={a.personId} data-account={a.email}>
              <div>{a.name}{role(a)}<small>{a.email}
                {!a.disabledAt ? <> <button type="button" className="linkbtn" onClick={() => void openEmail(a)} aria-label={`Change ${a.name}’s email`}>Change email</button></> : null}
              </small></div>
              <span className="r">{count(a.rooms)}</span>
              <span>{formatSignIn(a.lastSignInAt, me.timeZone)}</span>
              <span>
                <span className={`pill ${a.twoFactor === 'on' ? 'ok' : 'off'}`}>{TWO_FACTOR[a.twoFactor] ?? 'Not set up'}</span>
                {a.twoFactor === 'on' && !a.isYou && !a.disabledAt
                  ? <button type="button" className="linkbtn" onClick={() => setDialog({ kind: 'reset', who: a, busy: false, error: null })} aria-label={`Reset ${a.name}’s two-factor sign-in`}>Reset</button>
                  : null}
              </span>
              <span className="end">
                {a.isYou ? <span className="cap">You</span>
                  : a.disabledAt ? <>
                    <span className="pill off">Disabled</span>
                    <button type="button" className="btn ghost sm" onClick={() => setDialog({ kind: 'enable', who: a, busy: false, error: null })} title="Lets them sign in again. Their room access stays revoked until a room admin restores it.">Enable account</button>
                  </>
                  : <button type="button" className="btn ghost sm" onClick={() => setDialog({ kind: 'disable', who: a, busy: false, error: null })}>Disable account</button>}
              </span>
            </div>
          ))}
          {more > 0 ? (
            <div className="tr more">
              <span><span className="dots" aria-hidden="true">···</span> {count(more)} more {more === 1 ? 'account' : 'accounts'}</span>
              <span>
                <span className="cap">1 to {count(list.items.length)} of {count(list.total)}</span>
                <button type="button" className="btn secondary sm" disabled={list.loading} onClick={() => void load(filter, q, list.items.length)}>Show {Math.min(PAGE, more)} more</button>
              </span>
            </div>
          ) : null}
        </div>
        <div className="pfoot">
          <span className="cap">{shown}</span>
          {filter === 'staff' ? <button type="button" className="btn secondary sm" onClick={() => setDialog({ kind: 'admin', email: '', name: '', busy: false, error: null })}>Add a site admin</button> : null}
        </div>
      </section>

      <FailedSignIns timeZone={me.timeZone} />

      {dialog?.kind === 'disable' ? (
        <SiteDialog title={`Disable ${dialog.who.name}’s account`} busy={dialog.busy} onClose={() => setDialog(null)}
          foot={<>
            <button type="button" className="btn secondary" onClick={() => setDialog(null)} disabled={dialog.busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void confirm()} disabled={dialog.busy}>{dialog.busy ? 'Disabling…' : 'Disable account'}</button>
          </>}>
          <p>{dialog.who.name} is signed out everywhere at once and can no longer sign in. Their history stays in every room, and room admins see it in their activity logs.</p>
          {dialog.who.roomNames.length ? <>
            <p>They can now reach {dialog.who.roomNames.length === 1 ? 'one room' : `${count(dialog.who.roomNames.length)} rooms`}: {andList(dialog.who.roomNames)}.</p>
            <div className="note warn" role="status"><div><b>Enabling the account later does not give this access back.</b> The room admins then restore it with Restore access, or invite them again if they never accepted.</div></div>
          </> : null}
          <p className="hint">{dialog.who.email}</p>
          {dialog.error ? <p className="hint err" role="alert">{dialog.error}</p> : null}
        </SiteDialog>
      ) : null}

      {dialog?.kind === 'enable' ? (
        <SiteDialog title={`Enable ${dialog.who.name}’s account`} busy={dialog.busy} onClose={() => setDialog(null)}
          foot={<>
            <button type="button" className="btn secondary" onClick={() => setDialog(null)} disabled={dialog.busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void confirm()} disabled={dialog.busy}>{dialog.busy ? 'Enabling…' : 'Enable account'}</button>
          </>}>
          <p>{dialog.who.name} can sign in again with their email address.</p>
          <p>Their room access{dialog.who.roomNames.length ? <> to {andList(dialog.who.roomNames)}</> : null} does not come back by itself. In each room they were in, their access is shown as revoked, and the room admins give it back with Restore access, or invite them again if they never accepted.</p>
          <p>It is logged in the site log and in each of their rooms.</p>
          <p className="hint">{dialog.who.email}</p>
          {dialog.error ? <p className="hint err" role="alert">{dialog.error}</p> : null}
        </SiteDialog>
      ) : null}

      {dialog?.kind === 'reset' ? (
        <SiteDialog title={`Reset ${dialog.who.name}’s two-factor sign-in`} busy={dialog.busy} onClose={() => setDialog(null)}
          foot={<>
            <button type="button" className="btn secondary" onClick={() => setDialog(null)} disabled={dialog.busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void confirm()} disabled={dialog.busy}>{dialog.busy ? 'Resetting…' : 'Reset two-factor sign-in'}</button>
          </>}>
          <p>Their authenticator app and trusted browsers stop working, and they are signed out everywhere. They set up an authenticator app again at their next sign-in.</p>
          <p>Do this only when you are sure the request comes from {dialog.who.name}, for example by calling them. Room admins can reset the people in their rooms, but never a site admin’s. It is logged in the site log and in each of their rooms.</p>
          {dialog.error ? <p className="hint err" role="alert">{dialog.error}</p> : null}
        </SiteDialog>
      ) : null}

      {dialog?.kind === 'email' ? (
        <SiteDialog title={`Change the sign-in email of ${dialog.who.name}`} busy={dialog.busy} onClose={() => setDialog(null)}
          foot={<>
            <button type="button" className="btn secondary" onClick={() => setDialog(null)} disabled={dialog.busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void confirm()} disabled={dialog.busy || !dialog.email.trim()}>{dialog.busy ? 'Sending…' : 'Send the code'}</button>
          </>}>
          <p className="hint">Current email: {dialog.info?.email ?? dialog.who.email}</p>
          <label className="fld">
            <span>New email</span>
            <input className="tin" id="ce-email" type="email" value={dialog.email} inputMode="email" autoComplete="off" spellCheck={false}
              aria-invalid={dialog.error ? true : undefined} aria-describedby={dialog.error ? 'ce-err' : undefined}
              onChange={(e) => setDialog({ ...dialog, email: e.target.value, error: null })}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }} />
          </label>
          {dialog.info?.pending ? <p className="hint">A change to {dialog.info.pending.newEmail} is waiting for its code. Sending a new code replaces it.</p> : null}
          <ul className="facts">{emailChangeFacts(dialog.who.name.split(' ')[0] ?? dialog.who.name, dialog.info, false).map((f) => <li key={f}>{f}</li>)}</ul>
          {dialog.error ? <p className="hint err" id="ce-err" role="alert">{dialog.error}</p> : null}
        </SiteDialog>
      ) : null}

      {dialog?.kind === 'admin' ? (
        <SiteDialog title="Add a site admin" busy={dialog.busy} onClose={() => setDialog(null)}
          foot={<>
            <button type="button" className="btn secondary" onClick={() => setDialog(null)} disabled={dialog.busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void confirm()} disabled={dialog.busy}>{dialog.busy ? 'Adding…' : 'Add as site admin'}</button>
          </>}>
          <p>A site admin manages this page: branding, outgoing email, who may create rooms, accounts and health. They see no room content unless a room admin invites them. They get an email.</p>
          <label className="fld">
            <span>Email address</span>
            <input className="tin" id="admin-email" value={dialog.email} inputMode="email" autoComplete="off" spellCheck={false} aria-invalid={dialog.error ? true : undefined}
              aria-describedby={dialog.error ? 'admin-err' : undefined}
              onChange={(e) => setDialog({ ...dialog, email: e.target.value, error: null })}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }} />
          </label>
          <label className="fld">
            <span>Name <i>(for someone without an account)</i></span>
            <input className="tin" id="admin-name" value={dialog.name} autoComplete="off" onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }} />
          </label>
          {dialog.error ? <p className="hint err" id="admin-err" role="alert">{dialog.error}</p> : null}
        </SiteDialog>
      ) : null}
    </>
  );
}
