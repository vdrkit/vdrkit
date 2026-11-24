// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { dueAt, formatWhen, nextDigest, resolvePolicy, zonedToUtc, type Mode } from '../src/notify-schedule.js';

const utc = (s: string) => new Date(s);

describe('resolvePolicy', () => {
  it('uses the most specific allowed setting', () => {
    expect(resolvePolicy({ workspace: { mode: 'bundled' }, group: { mode: 'digest' }, user: { mode: 'immediate' } }))
      .toMatchObject({ mode: 'immediate', from: 'user' });
  });

  it('ignores a user mode the room does not allow', () => {
    const p = resolvePolicy({
      workspace: { mode: 'bundled', allowedModes: ['immediate', 'bundled', 'digest'] },
      user: { mode: 'off' },
    });
    expect(p).toMatchObject({ mode: 'bundled', from: 'workspace' });
  });

  it('applies group limits on top of workspace limits', () => {
    const p = resolvePolicy({
      workspace: { mode: 'bundled', allowedModes: ['immediate', 'bundled', 'digest'] },
      group: { mode: 'digest', allowedModes: ['digest', 'off'] },
      user: { mode: 'off' },
    });
    expect(p).toMatchObject({ mode: 'digest', from: 'group' });
  });

  it('should not allow mandatory categories to be off', () => {
    expect(resolvePolicy({ workspace: { mode: 'digest' }, user: { mode: 'off' } }, true)).toMatchObject({ mode: 'digest', mandatory: true });
    expect(resolvePolicy({ workspace: { mode: 'off' } }, true)).toMatchObject({ mode: 'immediate', from: 'mandatory' });
  });

  it('falls back to default digest times', () => {
    expect(resolvePolicy({ workspace: { mode: 'digest' }, user: { digestTimes: ['8am'] } }).digestTimes).toEqual(['08:00']);
  });
});

describe('resolvePolicy enabled and frequency', () => {
  it('keeps the frequency while switched off', () => {
    expect(resolvePolicy({ workspace: { mode: 'digest' }, user: { enabled: false } }))
      .toMatchObject({ mode: 'off', enabled: false, frequency: 'digest', from: 'user' });
    expect(resolvePolicy({ workspace: { mode: 'bundled', enabled: false }, user: { enabled: true, mode: 'immediate' } }))
      .toMatchObject({ mode: 'immediate', enabled: true, from: 'user' });
  });

  it('locks mandatory events on', () => {
    expect(resolvePolicy({ workspace: { mode: 'bundled' }, user: { enabled: false, mode: 'digest' } }, true))
      .toMatchObject({ mode: 'digest', enabled: true, locked: true, frequency: 'digest' });
  });

  it('exempts room admins from mandatory events', () => {
    expect(resolvePolicy({ workspace: { mode: 'bundled' }, user: { enabled: false } }, true, { mandatoryExempt: true }))
      .toMatchObject({ mode: 'off', enabled: false, locked: false, mandatory: true });
  });

  it('lets admins pick off even when the room disallows it', () => {
    const ws = { mode: 'immediate' as const, allowedModes: ['immediate', 'bundled'] as Mode[] };
    const admin = resolvePolicy({ workspace: ws, group: { allowedModes: ['immediate'] }, user: { enabled: false } }, true, { mandatoryExempt: true });
    expect(admin).toMatchObject({ mode: 'off', enabled: false, locked: false });
    expect(admin.allowedModes).toEqual(['immediate', 'off']);
    expect(resolvePolicy({ workspace: ws, user: { enabled: false } }, true)).toMatchObject({ mode: 'immediate', locked: true });
    expect(resolvePolicy({ workspace: ws, user: { enabled: false } }, false, { mandatoryExempt: true })).toMatchObject({ mode: 'immediate', enabled: true });
  });
});

describe('dueAt', () => {
  const tz = { timeZone: 'Africa/Johannesburg' };
  it('sends a bundle 10 minutes after the last upload', () => {
    expect(dueAt('bundled', utc('2026-11-12T08:00:00Z'), utc('2026-11-12T08:25:00Z'), tz)).toEqual(utc('2026-11-12T08:35:00Z'));
  });
  it('caps the bundle wait at 60 minutes', () => {
    expect(dueAt('bundled', utc('2026-11-12T08:00:00Z'), utc('2026-11-12T08:58:00Z'), tz)).toEqual(utc('2026-11-12T09:00:00Z'));
  });
  it('handles immediate and off', () => {
    expect(dueAt('immediate', utc('2026-11-12T08:00:00Z'), utc('2026-11-12T08:00:00Z'), tz)).toEqual(utc('2026-11-12T08:00:00Z'));
    expect(dueAt('off', utc('2026-11-12T08:00:00Z'), utc('2026-11-12T08:00:00Z'), tz)).toBeNull();
  });
});

describe('nextDigest', () => {
  it('uses the recipient time zone', () => {
    expect(nextDigest(utc('2026-11-12T14:30:00Z'), ['08:00', '17:00'], 'Europe/London')).toEqual(utc('2026-11-12T17:00:00Z'));
    expect(nextDigest(utc('2026-11-12T17:30:00Z'), ['08:00', '17:00'], 'Europe/London')).toEqual(utc('2026-11-13T08:00:00Z'));
  });

  it('converts Johannesburg times to UTC', () => {
    expect(nextDigest(utc('2026-11-12T20:00:00Z'), ['08:00', '17:00'], 'Africa/Johannesburg')).toEqual(utc('2026-11-13T06:00:00Z'));
  });

  it('handles British Summer Time', () => {
    expect(nextDigest(utc('2026-03-28T18:00:00Z'), ['08:00'], 'Europe/London')).toEqual(utc('2026-03-29T07:00:00Z'));
    expect(nextDigest(utc('2026-10-24T18:00:00Z'), ['08:00'], 'Europe/London')).toEqual(utc('2026-10-25T08:00:00Z'));
  });

  it('shifts a skipped time forward', () => {
    // like Temporal's "compatible" disambiguation
    expect(zonedToUtc(2026, 3, 29, 1, 30, 'Europe/London')).toEqual(utc('2026-03-29T01:30:00Z'));
  });

  it('picks the earlier time when clocks go back', () => {
    expect(zonedToUtc(2026, 10, 25, 1, 30, 'Europe/London')).toEqual(utc('2026-10-25T00:30:00Z'));
  });
});

describe('formatWhen', () => {
  const now = utc('2026-11-12T08:00:00Z');
  it('formats in the viewer time zone', () => {
    const deadline = utc('2026-11-27T15:00:00Z');
    expect(formatWhen(deadline, 'Europe/London', now)).toBe('Fri 27 Nov, 15:00 GMT');
    expect(formatWhen(deadline, 'Africa/Johannesburg', now)).toBe('Fri 27 Nov, 17:00 SAST');
    expect(formatWhen(deadline, 'Europe/Amsterdam', now)).toBe('Fri 27 Nov, 16:00 CET');
  });
  it('adds the year for other years', () => {
    expect(formatWhen(utc('2027-06-01T09:00:00Z'), 'Europe/London', now)).toBe('Tue 1 Jun 2027, 10:00 BST');
  });
});
