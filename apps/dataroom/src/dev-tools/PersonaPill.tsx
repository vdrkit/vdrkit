// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { Persona } from './personas';
import './persona-pill.css';

export function PersonaPill({ personas, current, cookie, signedIn }: {
  personas: Persona[]; current: string; cookie: string;
  signedIn?: { name: string; email: string } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (signedIn) {
    return (
      <div className="proto" role="group" aria-label="Prototype only: you are signed in" data-real="">
        <span>Prototype · signed in as</span>
        <div className="seg">
          <b title="You are really signed in, so View as is off. Sign out to use View as again.">{signedIn.name}</b>
        </div>
      </div>
    );
  }
  return (
    <div className="proto" role="group" aria-label="Prototype only: switch persona" data-pending={pending || undefined}>
      <span>Prototype · view as</span>
      <div className="seg">
        <select
          aria-label="View the room as"
          title="Reloads this page as the person you choose"
          value={current}
          onChange={(e) => {
            document.cookie = `${cookie}=${encodeURIComponent(e.target.value)}; path=/; samesite=lax; max-age=31536000`;
            start(() => router.refresh());
          }}
        >
          {personas.map((p) => (
            <option key={p.key} value={p.key}>{`${p.label} · ${p.name}`}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
