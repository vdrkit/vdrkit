// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './db.js';

export interface RoomSignInSettings {
  requireTwoFactor: boolean;
  allowTrustedBrowser: boolean;
  trustedBrowserDays: number;
  idleSignOutMinutes: number;
}

export interface SignInPolicy extends RoomSignInSettings {
  rooms: number;
}

export const IDLE_SIGN_OUT_MINUTES = [30, 60, 120, 240, 480, 1440] as const;
export const TRUSTED_BROWSER_DAYS = { min: 1, max: 90 } as const;

export const DEFAULT_SIGN_IN_SETTINGS: RoomSignInSettings = Object.freeze({
  requireTwoFactor: true,
  allowTrustedBrowser: true,
  trustedBrowserDays: 30,
  idleSignOutMinutes: 240,
});

// trusted-browser rule only from rooms requiring 2FA; no rooms means defaults (2FA on)
export function strictestSignInPolicy(rooms: readonly RoomSignInSettings[]): SignInPolicy {
  if (rooms.length === 0) return { ...DEFAULT_SIGN_IN_SETTINGS, rooms: 0 };
  const strict = rooms.filter((r) => r.requireTwoFactor);
  const trustRooms = strict.length ? strict : rooms;
  return {
    requireTwoFactor: strict.length > 0,
    allowTrustedBrowser: trustRooms.every((r) => r.allowTrustedBrowser),
    trustedBrowserDays: Math.min(...trustRooms.map((r) => r.trustedBrowserDays)),
    idleSignOutMinutes: Math.min(...rooms.map((r) => r.idleSignOutMinutes)),
    rooms: rooms.length,
  };
}

export async function roomSignInSettings(tx: SqlClient, personIds: readonly string[], at: Date): Promise<RoomSignInSettings[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.query<{
    require_two_factor: boolean; allow_trusted_browser: boolean; trusted_browser_days: number; idle_sign_out_minutes: number;
  }>(
    `select distinct w.id, w.require_two_factor, w.allow_trusted_browser, w.trusted_browser_days, w.idle_sign_out_minutes
       from membership m join groups g on g.id = m.group_id join workspace w on w.id = g.workspace_id
      where m.person_id = any($1::uuid[]) and m.status = 'active' and m.superseded_at = 'infinity'
        and m.valid_from <= $2 and $2 < m.valid_to and g.valid_from <= $2 and $2 < g.valid_to
        and w.state <> 'deleted'`,
    [personIds, at.toISOString()],
  );
  return rows.map((r) => ({
    requireTwoFactor: r.require_two_factor,
    allowTrustedBrowser: r.allow_trusted_browser,
    trustedBrowserDays: Number(r.trusted_browser_days),
    idleSignOutMinutes: Number(r.idle_sign_out_minutes),
  }));
}

export async function signInPolicy(tx: SqlClient, personId: string, at: Date): Promise<SignInPolicy> {
  return strictestSignInPolicy(await roomSignInSettings(tx, [personId], at));
}
