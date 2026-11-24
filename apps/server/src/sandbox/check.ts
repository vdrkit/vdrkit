// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from '@vdrkit/core';
import { refuseUnsafeSandboxEnv, sandboxFlag, SANDBOX_TENANT_ID, type Env } from './config.js';

export interface SandboxState {
  markerTenant: string | null;
  seedVersion: number | null;
  siteTenant: string | null;
  tenants: number;
  otherTenants: number;
  outsidePeople: number;
  outsideLogins: number;
}

export async function sandboxState(db: Database, dbRole?: 'vdrkit_app'): Promise<SandboxState> {
  const raw = await db.transaction(async (tx) => {
    if (dbRole) await tx.query(`set local role ${dbRole}`);
    return (await tx.query<{ s: Record<string, unknown> | string }>(`select sandbox_state() as s`)).rows[0]!.s;
  });
  const s = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  const n = (v: unknown) => Number(v ?? 0);
  return {
    markerTenant: (s.marker_tenant as string | null) ?? null,
    seedVersion: s.seed_version == null ? null : Number(s.seed_version),
    siteTenant: (s.site_tenant as string | null) ?? null,
    tenants: n(s.tenants), otherTenants: n(s.other_tenants), outsidePeople: n(s.outside_people), outsideLogins: n(s.outside_logins),
  };
}

export const isEmpty = (s: SandboxState) => s.tenants === 0 && s.outsideLogins === 0 && s.siteTenant === null && s.markerTenant === null;

// null means it is a sandbox
export function notASandbox(s: SandboxState): string | null {
  if (!s.markerTenant) return 'it carries no sandbox marker (only sandbox-init and sandbox-reset write one)';
  if (s.markerTenant !== SANDBOX_TENANT_ID) return 'its sandbox marker names another tenant than the demo tenant';
  if (s.siteTenant !== s.markerTenant) return 'its site was set up for another organisation (first-run setup)';
  if (s.otherTenants > 0) return `it holds ${s.otherTenants} tenant${s.otherTenants === 1 ? '' : 's'} besides the demo tenant`;
  if (s.outsidePeople > 0) return `${s.outsidePeople} ${s.outsidePeople === 1 ? 'person has' : 'people have'} a real email address, not one at an example domain`;
  if (s.outsideLogins > 0) return `${s.outsideLogins} login${s.outsideLogins === 1 ? ' has' : 's have'} a real email address, not one at an example domain`;
  return null;
}

export class SandboxRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxRefused';
  }
}

export async function checkSandboxStart(db: Database, role: string, opts: { env?: Env; dbRole?: 'vdrkit_app'; warn?: (msg: string) => void } = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  const on = sandboxFlag(env);
  if (on) refuseUnsafeSandboxEnv(env);
  const state = await sandboxState(db, opts.dbRole);
  if (!on) {
    if (state.markerTenant) {
      (opts.warn ?? console.error)(`This database is marked as the VDRkit sandbox, but VDRKIT_SANDBOX is not set, so the ${role} runs as a normal installation. `
        + 'A sandbox database holds only invented data and is wiped every day: never use it for real work.');
    }
    return false;
  }
  const why = notASandbox(state);
  if (why) {
    throw new SandboxRefused(`VDRKIT_SANDBOX=1, but this database is not a sandbox: ${why}. The ${role} does not start. `
      + 'The sandbox must never point at a real database. On an empty database, run "sandbox-init" first (docs/sandbox.md).');
  }
  return true;
}
