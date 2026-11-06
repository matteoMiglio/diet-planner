import type { TrendDto } from '@diet/shared';
import { daysAgo, kgPerWeek } from '../format';

/** What the trend says, and when it can't say anything yet, exactly what would fix that. */
export function TrendSummary({ trend }: { trend: TrendDto }) {
  const rate =
    trend.slopeKgPerWeek !== null ? (
      <span className="text-2xl font-bold tracking-tight">{kgPerWeek(trend.slopeKgPerWeek)}</span>
    ) : (
      <span className="text-2xl font-bold tracking-tight text-muted-foreground">—</span>
    );

  if (trend.decidable && trend.ci80) {
    return (
      <div>
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Weight trend
        </p>
        <p className="mt-1">{rate}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Likely between {kgPerWeek(trend.ci80[0])} and {kgPerWeek(trend.ci80[1])} (80%), from{' '}
          {trend.n} weigh-ins over {Math.round(trend.spanDays)} days.
        </p>
      </div>
    );
  }

  const fixes: string[] = [];
  if (trend.reasons.includes('too_few_readings')) {
    fixes.push(
      `${trend.readingsNeeded} more weigh-in${trend.readingsNeeded === 1 ? '' : 's'} in the last 6 weeks`,
    );
  }
  if (trend.reasons.includes('span_too_short')) fixes.push('readings spread over at least 3 weeks');
  if (trend.reasons.includes('latest_too_old') && trend.latestAgeDays !== null) {
    fixes.push(`a fresh weigh-in (the latest was ${daysAgo(trend.latestAgeDays)})`);
  }
  if (trend.reasons.includes('latest_too_old') && trend.latestAgeDays === null) {
    fixes.push('a first weigh-in');
  }

  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Weight trend · not reliable yet
      </p>
      <p className="mt-1">{rate}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {trend.slopeKgPerWeek !== null ? 'A rough estimate only. ' : ''}
        To trust it, the trend needs {joinList(fixes)}.
      </p>
    </div>
  );
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? 'more data';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
