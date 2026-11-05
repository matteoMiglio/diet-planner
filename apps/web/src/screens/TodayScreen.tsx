import type { CurrentCheckinDto, ProgressDto } from '@diet/shared';
import { ChevronRight, ClipboardCheck, Utensils } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api';
import { EmptyState } from '../components/EmptyState';
import { ScreenHeader } from '../components/ScreenHeader';
import { Button, Card, ErrorNote, parseDecimal, SectionTitle } from '../components/ui';
import { clockTime, kg, kgPerWeek, shortDate } from '../format';
import { useQuery } from '../useQuery';

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export function TodayScreen() {
  const checkin = useQuery<CurrentCheckinDto>('/checkins/current');
  const progress = useQuery<ProgressDto>('/progress');

  return (
    <>
      <ScreenHeader title="Today">{dateFormat.format(new Date())}</ScreenHeader>
      <div className="space-y-4">
        {checkin.data?.due && <CheckinBanner started={checkin.data.checkin !== null} />}
        <WeightCard
          progress={progress.data}
          error={progress.error?.message}
          onLogged={() => Promise.all([progress.reload(), checkin.reload()]).then(() => undefined)}
        />
        <EmptyState icon={Utensils} title="No plan yet">
          Your meals for the day will show up here once a plan is active.
        </EmptyState>
      </div>
    </>
  );
}

function CheckinBanner({ started }: { started: boolean }) {
  return (
    <Link
      to="/checkin"
      className="flex items-center gap-3 rounded-2xl bg-accent-soft p-4 text-text transition hover:opacity-90"
    >
      <span className="rounded-full bg-surface p-2 text-accent">
        <ClipboardCheck size={20} aria-hidden />
      </span>
      <span className="flex-1">
        <span className="block font-semibold">
          {started ? 'Finish the weekly check-in' : 'Weekly check-in due'}
        </span>
        <span className="block text-sm text-muted">Weight, waist, and four quick answers.</span>
      </span>
      <ChevronRight size={20} className="text-muted" aria-hidden />
    </Link>
  );
}

function WeightCard({
  progress,
  error,
  onLogged,
}: {
  progress: ProgressDto | undefined;
  error: string | undefined;
  onLogged: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = progress?.measurements.at(-1);
  const trend = progress?.trend;

  async function log() {
    const w = parseDecimal(value);
    if (w == null || w < 20 || w > 300) return setSaveError('Type your weight in kg, e.g. 86,4.');
    setSaving(true);
    setSaveError(null);
    try {
      await api.post('/measurements', { weightKg: w });
      setValue('');
      await onLogged();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <SectionTitle>Weight</SectionTitle>
          {latest ? (
            <>
              <p className="text-2xl font-bold tracking-tight">{kg(latest.weightKg, 2)}</p>
              <p className="text-sm text-muted">
                {shortDate(latest.measuredAt)}, {clockTime(latest.measuredAt)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">No weigh-ins yet.</p>
          )}
        </div>
        {trend && (
          <Link to="/progress" className="text-right">
            <span className="block text-xs text-muted">Trend</span>
            <span className="block text-sm font-semibold">
              {trend.decidable && trend.slopeKgPerWeek !== null
                ? kgPerWeek(trend.slopeKgPerWeek)
                : trend.readingsNeeded > 0
                  ? `needs ${trend.readingsNeeded} more`
                  : 'not reliable yet'}
            </span>
          </Link>
        )}
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void log();
        }}
      >
        <label className="sr-only" htmlFor="quick-weight">
          Weight in kg
        </label>
        <input
          id="quick-weight"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="Weight in kg"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-h-11 flex-1 rounded-xl border border-border bg-bg px-3 text-base outline-none focus:border-accent"
        />
        <Button type="submit" disabled={saving || value.trim() === ''}>
          {saving ? 'Saving…' : 'Log'}
        </Button>
      </form>
      {(saveError || error) && (
        <div className="mt-2">
          <ErrorNote>{saveError ?? error}</ErrorNote>
        </div>
      )}
    </Card>
  );
}
