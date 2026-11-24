// SPDX-License-Identifier: AGPL-3.0-only
export type Mode = 'immediate' | 'bundled' | 'digest' | 'off';
export const MODES: readonly Mode[] = ['immediate', 'bundled', 'digest', 'off'];

export type Frequency = Exclude<Mode, 'off'>;
export const FREQUENCIES: readonly Frequency[] = ['immediate', 'bundled', 'digest'];

export interface PolicySetting {
  enabled?: boolean;
  mode?: Mode;
  /** "HH:MM", recipient's zone */
  digestTimes?: string[];
  allowedModes?: Mode[];
}

export interface PolicyCascade {
  workspace: PolicySetting & { mode: Mode };
  group?: PolicySetting;
  user?: PolicySetting;
}

export interface ResolvedPolicy {
  mode: Mode;
  enabled: boolean;
  frequency: Frequency;
  digestTimes: string[];
  mandatory: boolean;
  locked: boolean;
  from: 'workspace' | 'group' | 'user' | 'mandatory';
  allowedModes: Mode[];
}

export interface ResolveOptions {
  mandatoryExempt?: boolean;
}

export const DEFAULT_DIGEST = ['08:00'];

export function resolvePolicy(c: PolicyCascade, mandatory = false, opts: ResolveOptions = {}): ResolvedPolicy {
  let enabled = c.workspace.enabled ?? c.workspace.mode !== 'off';
  let frequency: Frequency = c.workspace.mode === 'off' ? 'immediate' : c.workspace.mode;
  let from: ResolvedPolicy['from'] = 'workspace';
  let digestTimes = c.workspace.digestTimes ?? DEFAULT_DIGEST;
  const bound = mandatory && !opts.mandatoryExempt;
  const exemptOff = mandatory && !!opts.mandatoryExempt;
  const limit = (modes: Iterable<Mode>) => {
    const s = new Set<Mode>(modes);
    if (exemptOff) s.add('off');
    return s;
  };
  let allowed = limit(c.workspace.allowedModes ?? MODES);

  const apply = (s: PolicySetting, level: 'group' | 'user') => {
    const wantsOff = s.enabled === false || s.mode === 'off';
    if (wantsOff) {
      if (allowed.has('off') && !bound) { enabled = false; from = level; }
    } else if (s.enabled === true && !enabled) {
      enabled = true; from = level;
    }
    if (s.mode && s.mode !== 'off' && allowed.has(s.mode)) { frequency = s.mode; from = level; }
  };

  if (c.group) {
    apply(c.group, 'group');
    if (c.group.digestTimes) digestTimes = c.group.digestTimes;
    if (c.group.allowedModes) allowed = limit(c.group.allowedModes.filter((m) => allowed.has(m)));
  }
  if (c.user) {
    apply(c.user, 'user');
    if (c.user.digestTimes && c.user.digestTimes.every(isClock)) digestTimes = c.user.digestTimes;
  }
  if (bound && !enabled) { enabled = true; from = 'mandatory'; }
  const allowedModes = MODES.filter((m) => allowed.has(m) && !(m === 'off' && bound));
  return { mode: enabled ? frequency : 'off', enabled, frequency, digestTimes, mandatory, locked: bound, from, allowedModes };
}

export function isClock(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export interface BundleWindow {
  quietMinutes: number;
  maxMinutes: number;
}
export const DEFAULT_BUNDLE: BundleWindow = { quietMinutes: 10, maxMinutes: 60 };

export function dueAt(
  mode: Mode,
  firstAt: Date,
  lastAt: Date,
  opts: { timeZone: string; digestTimes?: string[]; bundle?: BundleWindow },
): Date | null {
  switch (mode) {
    case 'off':
      return null;
    case 'immediate':
      return lastAt;
    case 'bundled': {
      const b = opts.bundle ?? DEFAULT_BUNDLE;
      return new Date(Math.min(lastAt.getTime() + b.quietMinutes * 60_000, firstAt.getTime() + b.maxMinutes * 60_000));
    }
    case 'digest':
      return nextDigest(firstAt, opts.digestTimes ?? DEFAULT_DIGEST, opts.timeZone);
  }
}

export function nextDigest(after: Date, times: string[], timeZone: string): Date {
  const clocks = [...new Set(times.filter(isClock))].sort();
  if (clocks.length === 0) throw new Error('No valid digest times');
  const local = partsIn(after, timeZone);
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const day = addDays(local.year, local.month, local.day, dayOffset);
    for (const c of clocks) {
      const [hh, mm] = c.split(':').map(Number) as [number, number];
      const t = zonedToUtc(day.year, day.month, day.day, hh, mm, timeZone);
      if (t.getTime() > after.getTime()) return t;
    }
  }
  throw new Error('No digest time found within two days');
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function partsIn(d: Date, timeZone: string): LocalParts {
  const p = Object.fromEntries(fmt(timeZone).formatToParts(d).map((x) => [x.type, x.value]));
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, second: +p.second! };
}

function addDays(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

// DST: Temporal "compatible"
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const p = partsIn(new Date(t), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  const before = want - offsetAt(want - 86_400_000);
  const after = want - offsetAt(want + 86_400_000);
  const candidates = [before, after]
    .filter((t) => {
      const p = partsIn(new Date(t), timeZone);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === want;
    })
    .sort((a, b) => a - b);
  if (candidates[0] !== undefined) return new Date(candidates[0]);
  return new Date(Math.max(before, after));
}

export function formatWhen(d: Date, timeZone: string, now: Date = new Date()): string {
  const p = partsIn(d, timeZone);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(d);
  const month = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'short' }).format(d);
  const zone = zoneAbbreviation(d, timeZone);
  const year = p.year !== partsIn(now, timeZone).year ? ` ${p.year}` : '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${weekday} ${p.day} ${month}${year}, ${pad(p.hour)}:${pad(p.minute)} ${zone}`;
}

// ICU gives "GMT+2" for these
const KNOWN_ABBR: Record<string, [string, string]> = {
  'Africa/Johannesburg': ['SAST', 'SAST'],
  'Europe/London': ['GMT', 'BST'],
  'Europe/Amsterdam': ['CET', 'CEST'],
  'Europe/Berlin': ['CET', 'CEST'],
  'Europe/Paris': ['CET', 'CEST'],
  'America/New_York': ['EST', 'EDT'],
  'Asia/Dubai': ['GST', 'GST'],
  'Asia/Singapore': ['SGT', 'SGT'],
  UTC: ['UTC', 'UTC'],
};

export function zoneAbbreviation(d: Date, timeZone: string): string {
  const known = KNOWN_ABBR[timeZone];
  if (known) {
    const jan = utcOffsetMinutes(new Date(Date.UTC(partsIn(d, timeZone).year, 0, 15)), timeZone);
    return utcOffsetMinutes(d, timeZone) === jan ? known[0] : known[1];
  }
  const name = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName');
  return name?.value ?? timeZone;
}

export function utcOffsetMinutes(d: Date, timeZone: string): number {
  const p = partsIn(d, timeZone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}
