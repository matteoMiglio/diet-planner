import { TZDate } from '@date-fns/tz';

/** Calendar date `YYYY-MM-DD`. */
export type LocalDate = string;

export interface LocalParts {
  date: LocalDate;
  /** `HH:MM`, 24-hour. */
  time: string;
  /** ISO weekday, 1 = Monday. */
  isoWeekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock date, time and weekday of an instant in a timezone. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    isoWeekday: WEEKDAYS[parts.weekday ?? ''] ?? NaN,
    minutes: hour * 60 + minute,
  };
}

/**
 * The instant a local wall-clock time (`YYYY-MM-DDTHH:MM[:SS]`) refers to in a timezone.
 * Times inside a DST gap move forward, as clocks do.
 */
export function localToInstant(localDateTime: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localDateTime);
  if (!m) throw new Error(`Not a local date-time: ${localDateTime}`);
  const [, y, mo, d, h, mi, s] = m;
  const tz = new TZDate(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
    timeZone,
  );
  return new Date(tz.getTime());
}

/** Monday of the ISO week containing a local date. */
export function isoWeekStart(date: LocalDate): LocalDate {
  const d = new Date(`${date}T00:00:00Z`);
  const isoWeekday = ((d.getUTCDay() + 6) % 7) + 1;
  d.setUTCDate(d.getUTCDate() - (isoWeekday - 1));
  return d.toISOString().slice(0, 10);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The weigh-in protocol is morning, fasted: 05:00–10:30 local time. */
export function isProtocolTime(instant: Date, timeZone: string): boolean {
  const { minutes } = localParts(instant, timeZone);
  return minutes >= 5 * 60 && minutes <= 10 * 60 + 30;
}
