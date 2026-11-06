import type {
  DayTargetsDto,
  MealPlanDto,
  PhaseDto,
  PlanOverviewDto,
  ProposalDto,
  ReviewDto,
  TargetsDto,
} from '@diet/shared';
import { dayMacros } from '@diet/shared';
import { Apple, CalendarDays, Check, ListChecks, Pencil, Play, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api';
import { EmptyState } from '../components/EmptyState';
import { GenerateCard } from '../components/GenerateCard';
import { ScreenHeader } from '../components/ScreenHeader';
import { Button, Card, ErrorNote, SectionTitle, Disclosure, Loading } from '../components/ui';
import { shortDate } from '../format';
import { useQuery } from '../useQuery';

export const PHASE_LABEL: Record<PhaseDto['type'], string> = {
  surplus: 'Lean surplus',
  maintenance: 'Maintenance',
  cut: 'Cut',
  maingain: 'Maingain',
  recomp: 'Recomp',
};
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function PlanScreen() {
  const overview = useQuery<PlanOverviewDto>('/plan');

  return (
    <>
      <div className="flex items-start justify-between">
        <ScreenHeader title="Plan">Phase, targets, reviews and the week.</ScreenHeader>
        <div className="mt-1 flex gap-3">
          <Link to="/foods" className="flex items-center gap-1 text-sm font-medium text-primary">
            <Apple size={16} aria-hidden /> Foods
          </Link>
          <Link to="/rules" className="flex items-center gap-1 text-sm font-medium text-primary">
            <ListChecks size={16} aria-hidden /> Rules
          </Link>
        </div>
      </div>
      {overview.status === 'loading' && <Loading />}
      {overview.status === 'error' && <ErrorNote>{overview.error.message}</ErrorNote>}
      {overview.data && !overview.data.phase && (
        <EmptyState icon={CalendarDays} title="No phase yet">
          A phase sets the direction (surplus, maintenance or cut) and the targets that go with it.{' '}
          <Link to="/plan/phase" className="font-semibold text-primary">
            Start a phase
          </Link>
        </EmptyState>
      )}
      {overview.data?.phase && <Overview data={overview.data} reload={overview.reload} />}
    </>
  );
}

function Overview({ data, reload }: { data: PlanOverviewDto; reload: () => Promise<void> }) {
  const phase = data.phase!;
  return (
    <div className="space-y-4">
      {data.pendingProposal && (
        <ProposalCard proposal={data.pendingProposal} current={data.targets} onDecided={reload} />
      )}

      <Card>
        <div className="flex items-start justify-between">
          <div>
            <SectionTitle>Phase</SectionTitle>
            <p className="text-xl font-bold tracking-tight">{PHASE_LABEL[phase.type]}</p>
            <p className="text-sm text-muted-foreground">
              Since {shortDate(phase.startedOn, true)}
              {phase.rateBandKgPerWeek &&
                ` · aiming for ${phase.rateBandKgPerWeek[0].toFixed(2)}–${phase.rateBandKgPerWeek[1].toFixed(2)} kg/wk`}
              {phase.targetWeightKg !== null &&
                ` · holding ${phase.targetWeightKg} ± ${phase.holdBandKg} kg`}
            </p>
          </div>
          <Link to="/plan/phase" className="text-sm font-medium text-primary">
            Change
          </Link>
        </div>
        {phase.intent && <p className="mt-2 text-sm">{phase.intent}</p>}
      </Card>

      {data.targets && <TargetsCard targets={data.targets} maintenance={data.maintenance} />}

      <ReviewCard data={data} onRan={reload} />

      {data.targets && <GenerateCard />}

      <WeekCard
        plan={data.activePlan}
        targets={data.targets}
        trainingWeekdays={data.trainingWeekdays}
      />
    </div>
  );
}

function TargetsTable({ training, rest }: { training: DayTargetsDto; rest: DayTargetsDto }) {
  const rows: [string, keyof DayTargetsDto, string][] = [
    ['Energy', 'kcal', 'kcal'],
    ['Protein', 'proteinG', 'g'],
    ['Carbs', 'carbsG', 'g'],
    ['Fat', 'fatG', 'g'],
    ['Fibre', 'fibreG', 'g'],
  ];
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted-foreground">
          <th className="py-1 text-left font-medium" />
          <th className="py-1 text-right font-medium">Training</th>
          <th className="py-1 text-right font-medium">Rest</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, key, unit]) => (
          <tr key={key} className="border-t border-border">
            <td className="py-1.5">{label}</td>
            <td className="py-1.5 text-right font-medium">
              {training[key]} {unit}
            </td>
            <td className="py-1.5 text-right font-medium">
              {rest[key]} {unit}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TargetsCard({
  targets,
  maintenance,
}: {
  targets: TargetsDto;
  maintenance: PlanOverviewDto['maintenance'];
}) {
  return (
    <Card className="space-y-2">
      <div className="flex items-baseline justify-between">
        <SectionTitle>Targets</SectionTitle>
        <span className="text-xs text-muted-foreground">
          v{targets.version} · from {shortDate(targets.effectiveFrom)}
        </span>
      </div>
      <TargetsTable training={targets.training} rest={targets.rest} />
      {targets.reasoning && <p className="text-xs text-muted-foreground">{targets.reasoning}</p>}
      {maintenance && (
        <p className="text-xs text-muted-foreground">
          Maintenance estimate: {maintenance.kcal} kcal ({shortDate(maintenance.asOf, true)}). For
          reference only: targets move through reviews.
        </p>
      )}
    </Card>
  );
}

const OUTCOME_LABEL: Record<ReviewDto['outcome'], string> = {
  hold: 'No change',
  change: 'Change proposed',
  propose_diet_break: 'Diet break proposed',
};

function ReviewCard({ data, onRan }: { data: PlanOverviewDto; onRan: () => Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      await api.post('/reviews');
      await onRan();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-baseline justify-between">
        <SectionTitle>Review</SectionTitle>
        {data.nextReviewOn && (
          <span className="text-xs text-muted-foreground">
            Next: {shortDate(data.nextReviewOn, true)}
          </span>
        )}
      </div>
      {data.lastReview ? (
        <div>
          <p className="text-sm font-semibold">
            {OUTCOME_LABEL[data.lastReview.outcome]}{' '}
            <span className="font-normal text-muted-foreground">
              · {shortDate(data.lastReview.ranOn)}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">{data.lastReview.explanation}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No review yet. It runs by itself on the date above; you can also run it now. It only
          proposes a change when the trend and two check-ins back it up.
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button variant="secondary" disabled={running} onClick={() => void run()}>
        <Play size={16} aria-hidden /> {running ? 'Reviewing…' : 'Run review now'}
      </Button>
    </Card>
  );
}

function ProposalCard({
  proposal,
  current,
  onDecided,
}: {
  proposal: ProposalDto;
  current: TargetsDto | null;
  onDecided: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/proposals/${proposal.id}/${decision}`);
      await onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  const delta = (n: number) => (n === 0 ? 'no change' : `${n > 0 ? '+' : '−'}${Math.abs(n)} kcal`);

  return (
    <section
      aria-labelledby="proposal-heading"
      className="rounded-2xl border-2 border-primary bg-surface p-4"
    >
      <h2
        id="proposal-heading"
        className="text-xs font-semibold tracking-wide text-primary uppercase"
      >
        {proposal.kind === 'diet_break' ? 'Proposal: diet break' : 'Proposal: new targets'}
      </h2>
      <p className="mt-1 text-sm">{proposal.reasoning}</p>
      {proposal.deltaKcal && (
        <p className="mt-2 text-sm font-medium">
          Training days: {delta(proposal.deltaKcal.training)} · Rest days:{' '}
          {delta(proposal.deltaKcal.rest)}
        </p>
      )}
      {proposal.targets && current && (
        <Disclosure
          className="mt-2"
          summaryClassName="text-sm text-muted-foreground"
          summary="New targets"
        >
          <div className="mt-2">
            <TargetsTable training={proposal.targets.training} rest={proposal.targets.rest} />
          </div>
        </Disclosure>
      )}
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button disabled={busy} onClick={() => void decide('approve')} className="flex-1">
          <Check size={16} aria-hidden /> {proposal.kind === 'diet_break' ? 'Noted' : 'Apply'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void decide('reject')}>
          <X size={16} aria-hidden /> Decline
        </Button>
      </div>
    </section>
  );
}

function WeekCard({
  plan,
  targets,
  trainingWeekdays,
}: {
  plan: MealPlanDto | null;
  targets: TargetsDto | null;
  trainingWeekdays: number[];
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      const created = await api.post<MealPlanDto>('/plans', { name: 'My plan' });
      navigate(`/plan/edit/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (!plan) {
    return (
      <Card className="space-y-2">
        <SectionTitle>The week</SectionTitle>
        <p className="text-sm text-muted-foreground">
          No active meal plan. Add your foods first (Foods, top right), then build the week; totals
          check against the targets as you go.
        </p>
        <Drafts />
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button onClick={() => void create()}>Create a new plan</Button>
      </Card>
    );
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-baseline justify-between">
        <SectionTitle>{plan.name}</SectionTitle>
        <Link
          to={`/plan/edit/${plan.id}`}
          className="flex items-center gap-1 text-sm font-medium text-primary"
        >
          <Pencil size={14} aria-hidden /> Edit
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {plan.document.days.map((day) => {
          const training = trainingWeekdays.includes(day.weekday);
          const target = targets ? (training ? targets.training : targets.rest) : null;
          const totals = dayMacros(day);
          const off = target ? Math.round(totals.kcal - target.kcal) : null;
          return (
            <li key={day.weekday} className="flex items-center justify-between py-2">
              <span className="text-sm">
                <span className="inline-block w-9 font-semibold">{WEEKDAY[day.weekday - 1]}</span>
                <span className="text-xs text-muted-foreground">
                  {training ? 'Training' : 'Rest'}
                </span>
              </span>
              <span className="text-right text-sm">
                {day.meals.length === 0 ? (
                  <span className="text-muted-foreground">empty</span>
                ) : (
                  <>
                    <span className="font-medium">{Math.round(totals.kcal)} kcal</span>
                    <span className="text-muted-foreground">
                      {' '}
                      · P {Math.round(totals.proteinG)}
                    </span>
                    {off !== null && Math.abs(off) > 50 && (
                      <span
                        className={`block text-xs ${Math.abs(off) > 150 ? 'text-warn' : 'text-muted-foreground'}`}
                      >
                        {off > 0 ? '+' : '−'}
                        {Math.abs(off)} vs target
                      </span>
                    )}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Drafts() {
  const plans = useQuery<MealPlanDto[]>('/plans');
  const drafts = plans.data?.filter((p) => p.status === 'draft') ?? [];
  if (drafts.length === 0) return null;
  return (
    <ul className="divide-y divide-border rounded-xl bg-surface-2">
      {drafts.map((d) => (
        <li key={d.id}>
          <Link
            to={`/plan/edit/${d.id}`}
            className="flex items-center justify-between px-3 py-2.5 text-sm"
          >
            <span>
              <span className="font-medium">{d.name}</span>
              <span className="text-muted-foreground">
                {' '}
                · draft, edited {shortDate(d.updatedAt)}
              </span>
            </span>
            <span className="text-primary">Continue</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
