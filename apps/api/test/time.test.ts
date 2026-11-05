import { describe, expect, it } from 'vitest';
import {
  addDays,
  isoWeekStart,
  isProtocolTime,
  isValidTimeZone,
  localParts,
  localToInstant,
} from '../src/lib/time.js';

describe('time helpers', () => {
  it('converts local wall-clock time to an instant across DST', () => {
    expect(localToInstant('2026-01-12T07:41:10', 'Europe/Rome').toISOString()).toBe(
      '2026-01-12T06:41:10.000Z',
    );
    expect(localToInstant('2026-07-12T07:41', 'Europe/Rome').toISOString()).toBe(
      '2026-07-12T05:41:00.000Z',
    );
  });

  it('reads local parts of an instant', () => {
    expect(localParts(new Date('2026-11-01T23:30:00Z'), 'Europe/Rome')).toEqual({
      date: '2026-11-02',
      time: '00:30',
      isoWeekday: 1,
      minutes: 30,
    });
  });

  it('finds the Monday of the ISO week', () => {
    expect(isoWeekStart('2026-11-05')).toBe('2026-11-02');
    expect(isoWeekStart('2026-11-02')).toBe('2026-11-02');
    expect(isoWeekStart('2026-11-08')).toBe('2026-11-02');
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });

  it('applies the morning protocol window in local time', () => {
    expect(
      isProtocolTime(localToInstant('2026-03-08T10:21:04', 'Europe/Rome'), 'Europe/Rome'),
    ).toBe(true);
    expect(
      isProtocolTime(localToInstant('2026-03-08T10:31:00', 'Europe/Rome'), 'Europe/Rome'),
    ).toBe(false);
    expect(
      isProtocolTime(localToInstant('2025-03-04T18:01:58', 'Europe/Rome'), 'Europe/Rome'),
    ).toBe(false);
  });

  it('validates timezone names', () => {
    expect(isValidTimeZone('Europe/Rome')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
