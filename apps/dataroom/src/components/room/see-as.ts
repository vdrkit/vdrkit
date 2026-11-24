// SPDX-License-Identifier: AGPL-3.0-only
// The team rides in the room part (/rooms/{room}~{team}/documents), so every link built from it keeps the mode.
// Access is enforced by the API: room admins only, the team's rights, nothing written.

export const SEE_AS_MARK = '~';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoomPart(ws: string): { room: string; team: string | null } {
  let part = ws;
  try { part = decodeURIComponent(ws); } catch { /* malformed escape: the API refuses it */ }
  const at = part.indexOf(SEE_AS_MARK);
  if (at < 0) return { room: part, team: null };
  return { room: part.slice(0, at), team: part.slice(at + 1) };
}

export function seeAsRoomPart(room: string, team: string): string {
  return `${parseRoomPart(room).room}${SEE_AS_MARK}${team}`;
}

export function splitApiPath(path: string): { path: string; team: string } | null {
  const m = /^(.*\/v1\/workspaces\/)([^/?#]+)(.*)$/.exec(path);
  if (!m) return null;
  const { room, team } = parseRoomPart(m[2]!);
  if (team === null || !UUID.test(team)) return null;
  return { path: `${m[1]}${room}${m[3]}`, team };
}

export function withoutSeeAs(pathAndQuery: string, ws: string): string {
  const { room } = parseRoomPart(ws);
  return pathAndQuery.replace(`/rooms/${ws}`, `/rooms/${room}`).replace(`/rooms/${encodeURIComponent(ws)}`, `/rooms/${room}`);
}
