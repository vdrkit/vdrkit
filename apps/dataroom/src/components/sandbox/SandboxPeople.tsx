// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState } from 'react';
import type { SandboxPerson } from '@/lib/sandbox';
import { useSendOnce } from '@/lib/send-once';

export function SandboxPeople({ people }: { people: SandboxPerson[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const once = useSendOnce();
  const [error, setError] = useState<string | null>(null);
  const groups: { label: string; people: SandboxPerson[] }[] = [];
  for (const p of people) {
    const g = groups.find((x) => x.label === p.groupLabel);
    if (g) g.people.push(p);
    else groups.push({ label: p.groupLabel, people: [p] });
  }

  const enter = once(async (p: SandboxPerson) => {
    setBusy(p.key);
    setError(null);
    try {
      const res = await fetch('/v1/sandbox/sign-in', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ person: p.key }),
      });
      const body = (await res.json().catch(() => ({}))) as { next?: string; detail?: string };
      if (res.status === 404) throw new Error('This person is not in the sandbox right now. Try another, or come back after the next reset.');
      if (!res.ok) throw new Error(body.detail ?? `The sandbox answered ${res.status}.`);
      const next = typeof body.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//') ? body.next : '/';
      window.location.assign(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Entering the sandbox did not work. Try again.');
      setBusy(null);
    }
  });

  return (
    <div className="sbx-people">
      {groups.map((g) => (
        <section key={g.label} className="sbx-group" aria-labelledby={`sbx-${g.people[0]!.key}`}>
          <h2 id={`sbx-${g.people[0]!.key}`}>{g.label}</h2>
          <ul>
            {g.people.map((p) => (
              <li key={p.key} className="sbx-person">
                <div className="sbx-who">
                  <b>{p.name}</b>
                  <span>{p.jobTitle}, {p.company}</span>
                  <span className="sbx-can">{p.can}</span>
                </div>
                <button type="button" className="btn secondary" disabled={busy !== null} onClick={() => { void enter(p); }}
                  aria-label={`Enter the sandbox as ${p.name}`}>
                  {busy === p.key ? 'Entering…' : `Enter as ${p.name.split(' ')[0]}`}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {error ? <p className="hint err" role="alert">{error}</p> : null}
    </div>
  );
}
