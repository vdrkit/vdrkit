// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { mailsIn } from './model';

export interface InviteState {
  mails: string;
  lead: string;
  tab: 'member' | 'lead';
  /** null until edited: room's standard text */
  msg: string | null;
}

export const NO_SUBGROUP_LEADS = 'Only main groups have leads. People in a subgroup are members.';

export function InviteFields({ state, onChange, groupName, leads, standard, leadParagraph, settingsHref, noLeads = false }: {
  state: InviteState;
  onChange: (s: InviteState) => void;
  groupName: string;
  leads: string[] | null;
  standard: string;
  leadParagraph: string;
  settingsHref: string;
  noLeads?: boolean;
}) {
  const nm = mailsIn(state.mails).length;
  const nl = mailsIn(state.lead).length;
  const tab = (k: 'member' | 'lead', label: string, n: number) => (
    <button type="button" role="tab" aria-selected={state.tab === k} aria-controls="iv-pane" onClick={() => onChange({ ...state, tab: k })}>
      {label} <span className="tc">{n || ''}</span>
    </button>
  );
  const message = (
    <label className="fld">
      <span>Invitation message</span>
      <textarea className="tin" id="iv-msg" style={{ height: 180 }} value={state.msg ?? standard} onChange={(e) => onChange({ ...state, msg: e.target.value })} />
      <p className="hint">
        The room&apos;s standard invitation, filled in for this group. Edit it here for this invitation only, or{' '}
        <Link href={settingsHref} className="linkbtn" style={{ fontSize: 12.5 }}>change the standard in Settings</Link>. The sign-in button is added below the message.
      </p>
    </label>
  );
  const facts = (
    <ul className="facts">
      <li>Each person gets this email with a personal sign-in link. They accept the NDA before they see anything.</li>
      <li>Each invitation is logged in Activity.</li>
    </ul>
  );
  if (noLeads) {
    return (
      <>
        <label className="fld">
          <span>Email addresses of team members</span>
          <textarea className="tin" id="iv-mails" placeholder="One per line, or separated by commas" value={state.mails}
            onChange={(e) => onChange({ ...state, mails: e.target.value })} />
          <p className="hint">Team members see what {groupName} sees. {NO_SUBGROUP_LEADS}</p>
        </label>
        {message}
        {facts}
      </>
    );
  }
  return (
    <>
      <div className="fld">
        <span>Who to invite</span>
        <div className="itabs" role="tablist" aria-label="Who to invite">{tab('member', 'Team members', nm)}{tab('lead', 'Leads', nl)}</div>
        <div className="ipane" id="iv-pane" role="tabpanel">
          {state.tab === 'member' ? (
            <label className="fld">
              <span>Email addresses of team members</span>
              <textarea className="tin" id="iv-mails" placeholder="One per line, or separated by commas" value={state.mails}
                onChange={(e) => onChange({ ...state, mails: e.target.value })} />
              <p className="hint">Team members see what {groupName} sees. They cannot ask for anyone else to be added.</p>
            </label>
          ) : (
            <label className="fld">
              <span>Email addresses of leads</span>
              <textarea className="tin" id="iv-lead" placeholder="For example the buyer's deal lead and its lead adviser" value={state.lead}
                onChange={(e) => onChange({ ...state, lead: e.target.value })} />
              <p className="hint">
                Leads see what {groupName} sees, and may also request to add colleagues and advisers. A group can have several leads.{' '}
                {leads && leads.length ? `${leads.length === 1 ? 'Current lead' : 'Current leads'}: ${leads.join(', ')}.` : `${groupName} has no lead yet.`}
              </p>
            </label>
          )}
        </div>
      </div>
      {message}
      {state.tab === 'lead' ? (
        <div className="auto"><b>Added for leads, below your message</b><span>{leadParagraph || 'Nothing. The room has no paragraph for leads.'}</span></div>
      ) : (
        <p className="hint" style={{ marginTop: -8 }}>Leads get the same message, with one paragraph added about their role. Open the Leads tab to read it.</p>
      )}
      {facts}
    </>
  );
}

// in both boxes = lead; subgroups have members only
export function peopleToInvite(s: InviteState, noLeads = false): { email: string; role: 'member' | 'lead' }[] {
  if (noLeads) {
    const everyone = new Set([...mailsIn(s.mails), ...mailsIn(s.lead)]);
    return [...everyone].map((email) => ({ email, role: 'member' as const }));
  }
  const leads = mailsIn(s.lead);
  const members = mailsIn(s.mails).filter((m) => !leads.includes(m));
  return [
    ...members.map((email) => ({ email, role: 'member' as const })),
    ...leads.map((email) => ({ email, role: 'lead' as const })),
  ];
}
