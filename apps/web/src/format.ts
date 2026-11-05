const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export const kg = (v: number, digits = 1) => `${v.toFixed(digits)} kg`;

/** Signed rate, e.g. "+0.12 kg/wk". */
export const kgPerWeek = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} kg/wk`;

export function shortDate(iso: string, withYear = false): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return (withYear ? dayMonthYear : dayMonth).format(d);
}

export const clockTime = (iso: string) => time.format(new Date(iso));

export function daysAgo(days: number): string {
  const d = Math.round(days);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}
