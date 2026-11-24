// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { browserApi } from '@/api/browser';
import { roomHref } from '@/components/room/routes';
import { useSendOnce } from '@/lib/send-once';
import { InviteFields, peopleToInvite, type InviteState } from './InviteFields';
import { dayInput, endOfDay, isEmail, problemText, untilWords, type Folder, type Group, type Side } from './model';
import { Dlg, ErrorLine } from './ui';

const LV: [number, string][] = [[0, 'No access'], [20, 'View'], [40, 'Print (release 2)'], [50, 'Download PDF'], [60, 'Original']];

interface Rights { levels: number[]; up: boolean[]; pub: boolean[] }
const noRights = (n: number): Rights => ({ levels: Array(n).fill(0), up: Array(n).fill(false), pub: Array(n).fill(false) });

export interface NewGroupStart {
  side: Side;
  parentId?: string;
  name?: string;
  organisation?: string;
  copyFrom?: string;
}

export function NewGroupDialog({ ws, start, groups, folders, sellerPartyId, roomTz, standard, leadParagraph, defaultUntil, roomHolds, onClose, onCreated }: {
  ws: string;
  start: NewGroupStart;
  groups: Group[];
  folders: Folder[];
  sellerPartyId: string | null;
  roomTz: string;
  standard: string;
  leadParagraph: string;
  defaultUntil: string | null;
  roomHolds: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const n = folders.length;
  const [step, setStep] = useState(0);
  const [name, setName] = useState(start.name ?? '');
  const [side, setSide] = useState<Side>(start.side);
  const [parent, setParent] = useState(start.parentId ?? '');
  const [org, setOrg] = useState(start.organisation ?? '');
  const parentGroup = groups.find((g) => g.id === parent) ?? null;
  const [until, setUntil] = useState(dayInput(parentGroup?.until ?? defaultUntil, roomTz));
  const [startFrom, setStartFrom] = useState(start.copyFrom ?? 'none');
  const [rights, setRights] = useState<Rights>(() => noRights(n));
  const [byGroup, setByGroup] = useState<Map<string, Rights> | null>(null);
  const [inv, setInv] = useState<InviteState>({ mails: '', lead: '', tab: 'lead', msg: null });
  const [busy, setBusy] = useState(false);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ visible: number; invited: number; waiting: boolean; id: string } | null>(null);
  const waits = roomHolds && side === 'bid';

  useEffect(() => {
    let live = true;
    void browserApi().GET('/v1/workspaces/{ws}/grants', { params: { path: { ws } } }).then((r) => {
      if (!live || !r.data) return;
      const map = new Map<string, Rights>();
      for (const g of r.data.grants) {
        if (!g.groupId || g.effect !== 'allow') continue;
        const i = folders.findIndex((f) => f.id === g.nodeId);
        if (i < 0) continue;
        const x = map.get(g.groupId) ?? noRights(n);
        x.levels[i] = g.level; x.up[i] = g.canUpload; x.pub[i] = g.canPublish;
        map.set(g.groupId, x);
      }
      setByGroup(map);
    });
    return () => { live = false; };
  }, [ws, folders, n]);

  const cap = parent && byGroup ? byGroup.get(parent)?.levels ?? Array(n).fill(0) : null;
  const capped = (levels: number[]) => levels.map((v, i) => (cap ? Math.min(v, cap[i]!) : v));
  useEffect(() => {
    if (!byGroup || startFrom === 'none' || startFrom === '') return;
    const src = byGroup.get(startFrom) ?? noRights(n);
    const sell = side === 'sell';
    setRights({
      levels: capped(src.levels),
      up: sell ? [...src.up] : Array(n).fill(false),
      pub: sell ? [...src.pub] : Array(n).fill(false),
    });
    // capped() only reads parent and byGroup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byGroup, startFrom, parent, side]);

  const copyable = groups.filter((g) => g.side === side && !g.admin && (g.id === start.copyFrom || (!g.revoked && !g.ended))
    && byGroup?.get(g.id)?.levels.some((l) => l > 0));
  const visible = rights.levels.filter((l) => l > 0).length;
  const groupName = name.trim() || 'the new group';
  const untilIso = until ? endOfDay(until, roomTz) : null;
  const standardFilled = standard.split('{until}').join(untilWords(untilIso, roomTz));
  const subgroup = side === 'bid' && !!parent;
  const people = peopleToInvite(inv, subgroup);

  const create = once(async (invite: boolean) => {
    const bad = people.map((p) => p.email).filter((e) => !isEmail(e));
    if (invite && bad.length) { setError(`Check these addresses: ${bad.join(', ')}.`); return; }
    setBusy(true);
    setError(null);
    const api = browserApi();
    const all = folders.map((f, i) => ({
      nodeId: f.id,
      level: rights.levels[i]! as 0 | 20 | 40 | 50 | 60,
      canUpload: side === 'sell' && rights.up[i]!,
      canPublish: side === 'sell' && rights.pub[i]!,
    }));
    const access = all.filter((a) => a.level > 0 || a.canUpload || a.canPublish);
    let where;
    if (side === 'sell') where = { partyId: sellerPartyId ?? undefined };
    else if (parent) where = { parentGroupId: parent };
    else where = { newParty: { name: org.trim() || name.trim(), kind: 'bidder' as const } };
    const r = await api.POST('/v1/workspaces/{ws}/groups', { params: { path: { ws } }, body: {
      name: name.trim(), ...where, organisation: org.trim() || undefined, accessEndsAt: untilIso, access, roleTemplate: 'member' } });
    if (!r.data) { setBusy(false); setError(problemText(r.error, 'The group could not be created.')); return; }
    let invited = 0;
    let waiting = false;
    if (invite && people.length) {
      const s = await api.POST('/v1/workspaces/{ws}/invitations', { params: { path: { ws } }, body: {
        groupId: r.data.id, people, role: 'member', accessExpiresAt: null, message: inv.msg !== null && inv.msg !== standardFilled ? inv.msg : null } });
      if (!s.data) {
        setBusy(false);
        setDone({ visible, invited: 0, waiting: false, id: r.data.id });
        setError(`${name.trim()} is created, but the invitations were not sent: ${problemText(s.error, 'try again with Invite people.')}`);
        onCreated();
        return;
      }
      invited = s.data.invitations.length;
      waiting = s.data.invitations.some((i) => i.waits);
    }
    setBusy(false);
    setDone({ visible, invited, waiting, id: r.data.id });
    onCreated();
  });

  const steps = ['Group', 'Access', 'People'];
  const cur = done ? 3 : step;
  const stepList = (
    <ol className="steps">
      {steps.map((t, i) => {
        const past = i < cur;
        let cls = '';
        if (past) cls = 'done';
        else if (i === cur) cls = 'on';
        return <li key={t} className={cls}><span>{past ? '✓' : i + 1}</span>{t}</li>;
      })}
    </ol>
  );

  if (done) {
    return (
      <Dlg over="People" title="Group created" onClose={onClose}
        foot={<><button type="button" className="btn ghost" onClick={onClose}>Close</button>
          <Link className="btn primary" href={`${roomHref(ws, 'permissions')}?group=${done.id}`}>Open in Permissions</Link></>}>
        <div className="okbox"><i>✓</i><h3>{name.trim()} is created</h3>
          <p>{done.visible ? `It can see ${done.visible} of ${n} main folders.` : 'It cannot see anything yet.'}{' '}
            {!done.invited ? 'Nobody is invited yet.' : done.waiting
              ? `${done.invited} ${done.invited === 1 ? 'invitation waits' : 'invitations wait'} for the room to open, and ${done.invited === 1 ? 'goes' : 'go'} out when you open it.`
              : `${done.invited} ${done.invited === 1 ? 'invitation is' : 'invitations are'} on their way.`}</p></div>
        <ErrorLine text={error} />
        <ul className="facts"><li>Its column is now in Permissions, where you can fine-tune subfolders.</li><li>Logged in Activity, with the rights it started with.</li></ul>
      </Dlg>
    );
  }

  if (step === 0) {
    const parents = groups.filter((g) => g.side === 'bid' && !g.parentId && !g.revoked && !g.ended);
    return (
      <Dlg over="People" title="New group" onClose={onClose} focus="#ng-name"
        foot={<><button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!name.trim()} onClick={() => setStep(1)}>Next: access</button></>}>
        {stepList}
        <label className="fld"><span>Name</span>
          <input className="tin" id="ng-name" value={name} placeholder="For example: Bidder E" autoComplete="off" onChange={(e) => setName(e.target.value)} /></label>
        <div className="fld"><span>Side</span>
          <div className="seg2">
            <label><input type="radio" name="ng-side" value="bid" checked={side === 'bid'} onChange={() => setSide('bid')} />Bidder</label>
            <label><input type="radio" name="ng-side" value="sell" checked={side === 'sell'}
              onChange={() => {
                setSide('sell');
                setParent('');
                setStartFrom('none');
                setRights({ levels: Array(n).fill(0), up: Array(n).fill(false), pub: Array(n).fill(false) });
              }} />Seller team</label>
          </div>
          <p className="hint">{side === 'bid' ? 'A bidder group never sees other bidders, their people or their activity.' : 'Seller groups can be given the right to add files and to publish them, folder by folder.'}</p>
        </div>
        {side === 'bid' ? (
          <label className="fld"><span>Subgroup of</span>
            <select className="sel" id="ng-parent" value={parent} onChange={(e) => {
              const p = groups.find((g) => g.id === e.target.value);
              setParent(e.target.value);
              if (p?.until) setUntil(dayInput(p.until, roomTz));
            }}>
              <option value="">None, a separate bidder</option>
              {parents.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <p className="hint">For a bidder&apos;s financiers or advisers. A subgroup never gets more than its parent group, and loses access with it.</p>
          </label>
        ) : null}
        <div className="two">
          <label className="fld"><span>Organisation</span>
            <input className="tin" id="ng-org" value={org} placeholder="For example: Brivenhall Capital" onChange={(e) => setOrg(e.target.value)} /></label>
          <label className="fld"><span>Access until</span>
            <input className="tin" type="date" id="ng-until" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
        </div>
      </Dlg>
    );
  }

  if (step === 1) {
    const setEvery = (v: number) => { setRights({ ...rights, levels: capped(Array(n).fill(v)) }); setStartFrom(''); };
    return (
      <Dlg over="People" title="New group" onClose={onClose}
        foot={<><span className="grow cap">{visible ? `${visible} of ${n} folders visible` : 'Nothing visible yet'}</span>
          <button type="button" className="btn ghost" onClick={() => setStep(0)}>Back</button>
          <button type="button" className="btn primary" onClick={() => setStep(2)}>Next: people</button></>}>
        {stepList}
        <p className="hint" style={{ color: 'var(--fg)' }}>What may <b>{groupName}</b> see in each main folder? Subfolders follow their folder. You can fine-tune subfolders later in Permissions.</p>
        <div className="fld"><span>Start from</span>
          <div className="start">
            {[{ id: 'none', label: 'No access anywhere' }, ...copyable.map((g) => ({ id: g.id, label: `Same as ${g.name}` }))].map((o) => (
              <label key={o.id}><input type="radio" name="ng-start" value={o.id} checked={startFrom === o.id} onChange={() => {
                setStartFrom(o.id);
                if (o.id === 'none') setRights({ levels: Array(n).fill(0), up: Array(n).fill(false), pub: Array(n).fill(false) });
              }} />{o.label}</label>
            ))}
            {!byGroup ? <span className="cap">Loading the other groups…</span> : null}
          </div>
        </div>
        <div className="fld"><span>Set every folder at once</span>
          <div className="start" style={{ alignItems: 'center' }}>
            <select className="sel" id="ng-every" style={{ width: 'auto', minWidth: 200, height: 34, fontSize: 13 }} value=""
              onChange={(e) => { if (e.target.value !== '') setEvery(Number(e.target.value)); }} aria-label="Set every folder at once">
              <option value="">Choose a level…</option>
              {LV.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {side === 'sell' ? (
              <>
                <button type="button" className="pill" aria-pressed={rights.up.every(Boolean)} title="May add files in every folder"
                  onClick={() => setRights({ ...rights, up: Array(n).fill(!rights.up.every(Boolean)) })}>U</button><span className="cap">all</span>
                <button type="button" className="pill" aria-pressed={rights.pub.every(Boolean)} title="May publish in every folder"
                  onClick={() => setRights({ ...rights, pub: Array(n).fill(!rights.pub.every(Boolean)) })}>P</button><span className="cap">all</span>
              </>
            ) : null}
          </div>
          <p className="hint">Applies to all {n} folders{parent ? ', up to what the parent group has' : ''}. You can still change single folders below.</p>
        </div>
        {parentGroup ? (
          <div className="capbox"><b style={{ color: 'var(--warn)' }}>Capped by {parentGroup.name}.</b> A subgroup works for its parent group, so it can never see more than {parentGroup.name} in a folder. Levels above that are not offered.</div>
        ) : null}
        <div className="acc">
          {folders.map((f, i) => {
            const v = rights.levels[i]!;
            const max = cap ? cap[i]! : 60;
            return (
              <div className="ar" key={f.id}>
                <span className="ix">{f.ix}</span>
                <span>{f.name}{cap && max === 0 ? <> <span className="capt">Capped</span></> : null}</span>
                <select className={`sel${v ? '' : ' l0'}`} aria-label={`Level in ${f.ix} ${f.name}`} disabled={!!cap && max === 0} value={v}
                  onChange={(e) => { const levels = [...rights.levels]; levels[i] = Number(e.target.value); setRights({ ...rights, levels }); }}>
                  {LV.filter(([l]) => l <= max).map(([l, t]) => <option key={l} value={l}>{t}</option>)}
                </select>
                {side === 'sell' ? (
                  <span className="sw">
                    <button type="button" className="pill" aria-pressed={rights.up[i]} aria-label={`May add files as drafts in ${f.ix} ${f.name}`} title="May add files as drafts"
                      onClick={() => { const up = [...rights.up]; up[i] = !up[i]; setRights({ ...rights, up }); }}>U</button>
                    <button type="button" className="pill" aria-pressed={rights.pub[i]} aria-label={`May publish drafts in ${f.ix} ${f.name}`} title="May publish drafts"
                      onClick={() => { const pub = [...rights.pub]; pub[i] = !pub[i]; setRights({ ...rights, pub }); }}>P</button>
                  </span>
                ) : <span />}
              </div>
            );
          })}
        </div>
        {side === 'sell' ? <div className="legend"><span><span className="pill">U</span> may add files as drafts</span><span><span className="pill">P</span> may publish drafts</span></div> : null}
      </Dlg>
    );
  }

  let createLabel = `Create and invite ${people.length}`;
  if (!people.length) createLabel = 'Create group';
  else if (waits) createLabel = `Create, invite ${people.length} when the room opens`;

  return (
    <Dlg over="People" title="New group" onClose={onClose} busy={busy} focus={inv.tab === 'lead' && !subgroup ? '#iv-lead' : '#iv-mails'}
      foot={<><button type="button" className="btn ghost" onClick={() => setStep(1)} disabled={busy}>Back</button>
        <button type="button" className="btn secondary" onClick={() => create(false)} disabled={busy}>Create without inviting</button>
        <button type="button" className="btn primary" onClick={() => create(true)} disabled={busy}>
          {createLabel}</button></>}>
      {stepList}
      <InviteFields state={inv} onChange={setInv} groupName={groupName} leads={[]} standard={standardFilled}
        leadParagraph={leadParagraph.split('{group}').join(groupName)} settingsHref={roomHref(ws, 'settings')} noLeads={subgroup} />
      {waits ? <p className="hint" data-testid="invite-waits">The room is not open yet, so no email goes out now. The invitations are sent when you open the room in Settings.</p> : null}
      <ErrorLine text={error} />
    </Dlg>
  );
}
