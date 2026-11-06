import type {
  CurrentCheckinDto,
  FoodLogDayDto,
  PlanMeal,
  ProgressDto,
  TodayDto,
} from '@diet/shared';
import { add, optionMacros, SLOT_LABEL, ZERO } from '@diet/shared';
import { ChevronRight, ClipboardCheck, Utensils, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Input } from '@/ui/input';
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
        <TodayMeals />
        <ExtrasCard />
      </div>
    </>
  );
}

function CheckinBanner({ started }: { started: boolean }) {
  return (
    <Link
      to="/checkin"
      className="flex items-center gap-3 rounded-2xl bg-primary-soft p-4 text-text transition hover:opacity-90"
    >
      <span className="rounded-full bg-surface p-2 text-primary">
        <ClipboardCheck size={20} aria-hidden />
      </span>
      <span className="flex-1">
        <span className="block font-semibold">
          {started ? 'Finish the weekly check-in' : 'Weekly check-in due'}
        </span>
        <span className="block text-sm text-muted-foreground">
          Weight, waist, and four quick answers.
        </span>
      </span>
      <ChevronRight size={20} className="text-muted-foreground" aria-hidden />
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
              <p className="text-sm text-muted-foreground">
                {shortDate(latest.measuredAt)}, {clockTime(latest.measuredAt)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No weigh-ins yet.</p>
          )}
        </div>
        {trend && (
          <Link to="/progress" className="text-right">
            <span className="block text-xs text-muted-foreground">Trend</span>
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
        <Input
          id="quick-weight"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="Weight in kg"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 h-11"
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

function TodayMeals() {
  const today = useQuery<TodayDto>('/today');
  // Which option is picked per slot, for today only; the default is the first.
  const [picked, setPicked] = useState<Record<string, number>>({});

  if (today.status === 'error') return <ErrorNote>{today.error.message}</ErrorNote>;
  if (!today.data) return null;
  const { plan, targets, dayType } = today.data;

  if (!plan || plan.day.meals.length === 0) {
    return (
      <EmptyState icon={Utensils} title={plan ? 'Nothing planned today' : 'No plan yet'}>
        {plan
          ? 'Today has no meals in the plan. '
          : 'Your meals for the day show up here once a plan is active. '}
        <Link to="/plan" className="font-semibold text-primary">
          Go to Plan
        </Link>
      </EmptyState>
    );
  }

  const choice = (meal: PlanMeal) => Math.min(picked[meal.slot] ?? 0, meal.options.length - 1);
  const totals = plan.day.meals.reduce(
    (sum, meal) => add(sum, optionMacros(meal.options[choice(meal)]!)),
    ZERO,
  );

  return (
    <section aria-labelledby="meals-heading" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2
          id="meals-heading"
          className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {dayType === 'training' ? 'Training day' : 'Rest day'}
        </h2>
        <span className="text-sm">
          <span className="font-semibold">{Math.round(totals.kcal)}</span>
          {targets && <span className="text-muted-foreground"> / {targets.kcal} kcal</span>}
          <span className="text-muted-foreground">
            {' '}
            · P {Math.round(totals.proteinG)}
            {targets && `/${targets.proteinG}`}
          </span>
        </span>
      </div>
      {plan.day.meals.map((meal) => {
        const index = choice(meal);
        const option = meal.options[index]!;
        const m = optionMacros(option);
        return (
          <Card key={meal.slot} className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="font-semibold">{SLOT_LABEL[meal.slot]}</h3>
              <span className="text-xs text-muted-foreground">
                {Math.round(m.kcal)} kcal · P {Math.round(m.proteinG)}
              </span>
            </div>
            {meal.options.length > 1 && (
              <div
                className="flex gap-1"
                role="radiogroup"
                aria-label={`${SLOT_LABEL[meal.slot]} option`}
              >
                {meal.options.map((o, i) => (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={i === index}
                    onClick={() => setPicked({ ...picked, [meal.slot]: i })}
                    className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                      i === index ? 'bg-primary text-bg' : 'bg-surface-2 text-muted-foreground'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            <ul className="space-y-1 text-sm">
              {option.items.map((item, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>{item.snapshot?.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {item.display
                      ? `${item.display.qty} ${item.display.unit}`
                      : `${Math.round(item.grams)} g`}
                  </span>
                </li>
              ))}
            </ul>
            {meal.notes && <p className="text-xs text-muted-foreground">{meal.notes}</p>}
          </Card>
        );
      })}
    </section>
  );
}

/** What was eaten beyond the plan today (from Scan). */
function ExtrasCard() {
  const log = useQuery<FoodLogDayDto>('/food-log');
  const [error, setError] = useState<string | null>(null);
  if (!log.data || log.data.entries.length === 0) return null;

  async function remove(id: string) {
    setError(null);
    try {
      await api.delete(`/food-log/${id}`);
      await log.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-baseline justify-between">
        <SectionTitle>Also eaten</SectionTitle>
        <span className="text-sm text-muted-foreground">
          {log.data.totals.kcal} kcal · P {log.data.totals.proteinG}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {log.data.entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="block truncate">{e.name}</span>
              <span className="block text-xs text-muted-foreground">
                {Math.round(e.grams)} g · {Math.round(e.kcal)} kcal · P {Math.round(e.proteinG)}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void remove(e.id)}
              aria-label={`Remove ${e.name}`}
              className="rounded-full p-1.5 text-muted-foreground hover:bg-surface-2"
            >
              <X size={16} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Card>
  );
}
