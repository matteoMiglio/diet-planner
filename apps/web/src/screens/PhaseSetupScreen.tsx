import type {
  CreatePhaseRequest,
  DayTargetsDto,
  PhaseTypeValue,
  PlanOverviewDto,
  ProgressDto,
} from '@diet/shared';
import { phaseTargets } from '@diet/shared';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../api';
import { ScreenHeader } from '../components/ScreenHeader';
import {
  Button,
  Card,
  ErrorNote,
  NumberField,
  type Option,
  parseDecimal,
  SectionTitle,
  Segmented,
} from '../components/ui';
import { useQuery } from '../useQuery';
import { PHASE_LABEL } from './PlanScreen';

const TYPES: Option<PhaseTypeValue>[] = [
  { value: 'surplus', label: 'Surplus' },
  { value: 'maintenance', label: 'Maintain' },
  { value: 'cut', label: 'Cut' },
  { value: 'recomp', label: 'Recomp' },
];

const HELP: Record<PhaseTypeValue, string> = {
  surplus: 'Small surplus to build strength and muscle. Gain 0.10–0.20 kg a week.',
  maintenance: 'Hold weight in a band around a target.',
  maingain: 'Eat at maintenance and push the training.',
  cut: 'Lose fat at about 0.5% of bodyweight a week, never under 2000 kcal a day.',
  recomp: 'Small surplus on training days, small deficit on rest days.',
};

export function PhaseSetupScreen() {
  const overview = useQuery<PlanOverviewDto>('/plan');
  const progress = useQuery<ProgressDto>('/progress');
  if (overview.status === 'loading' || progress.status === 'loading') {
    return <p className="text-sm text-muted">Loading…</p>;
  }
  const weight =
    progress.data?.trend.interceptKg ?? progress.data?.measurements.at(-1)?.weightKg ?? null;
  return <PhaseForm overview={overview.data ?? null} currentWeight={weight} />;
}

const today = () => new Date().toLocaleDateString('en-CA');

function PhaseForm({
  overview,
  currentWeight,
}: {
  overview: PlanOverviewDto | null;
  currentWeight: number | null;
}) {
  const navigate = useNavigate();
  const [type, setType] = useState<PhaseTypeValue>(overview?.phase?.type ?? 'surplus');
  const [startedOn, setStartedOn] = useState(today());
  const [maintenance, setMaintenance] = useState(String(overview?.maintenance?.kcal ?? ''));
  const [bodyweight, setBodyweight] = useState(currentWeight ? currentWeight.toFixed(1) : '');
  const [surplusPct, setSurplusPct] = useState('10');
  const [deficitPct, setDeficitPct] = useState('0.5');
  const [targetWeight, setTargetWeight] = useState(currentWeight ? currentWeight.toFixed(1) : '');
  const [reviewDays, setReviewDays] = useState('21');
  const [intent, setIntent] = useState('');
  const [byHand, setByHand] = useState(false);
  const [manual, setManual] = useState<Record<
    'training' | 'rest',
    Record<keyof DayTargetsDto, string>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const trainingDays = overview?.trainingWeekdays.length ?? 3;
  const m = parseDecimal(maintenance);
  const bw = parseDecimal(bodyweight);
  const preview = useMemo(() => {
    if (!m || !bw || m < 1000 || bw < 20) return null;
    return phaseTargets({
      phase: type,
      maintenanceKcal: m,
      bodyweightKg: bw,
      trainingDaysPerWeek: trainingDays,
      surplusPct: (parseDecimal(surplusPct) ?? 10) / 100,
      deficitRatePctPerWeek: (parseDecimal(deficitPct) ?? 0.5) / 100,
    });
  }, [type, m, bw, trainingDays, surplusPct, deficitPct]);

  function startByHand() {
    const base = preview?.targets ?? null;
    const asText = (d: DayTargetsDto | undefined) => ({
      kcal: String(d?.kcal ?? ''),
      proteinG: String(d?.proteinG ?? ''),
      carbsG: String(d?.carbsG ?? ''),
      fatG: String(d?.fatG ?? ''),
      fibreG: String(d?.fibreG ?? ''),
    });
    setManual({ training: asText(base?.training), rest: asText(base?.rest) });
    setByHand(true);
  }

  async function save() {
    setError(null);
    if (!m || m < 1000) return setError('Enter your maintenance in kcal (e.g. 2040).');
    const body: CreatePhaseRequest = {
      type,
      startedOn,
      maintenanceKcal: Math.round(m),
      reviewEveryDays: Math.round(parseDecimal(reviewDays) ?? 21),
      intent: intent.trim() || null,
    };
    if (bw) body.bodyweightKg = bw;
    if (type === 'surplus') body.surplusPct = (parseDecimal(surplusPct) ?? 10) / 100;
    if (type === 'cut') body.deficitRatePctPerWeek = (parseDecimal(deficitPct) ?? 0.5) / 100;
    if (type === 'maintenance' || type === 'maingain')
      body.targetWeightKg = parseDecimal(targetWeight) ?? null;
    if (byHand && manual) {
      const toDay = (d: Record<keyof DayTargetsDto, string>) => {
        const out = {} as DayTargetsDto;
        for (const k of Object.keys(d) as (keyof DayTargetsDto)[]) {
          const v = parseDecimal(d[k]);
          if (v == null) throw new Error(`Fill in every target (${k}).`);
          out[k] = Math.round(v);
        }
        return out;
      };
      try {
        body.targets = { training: toDay(manual.training), rest: toDay(manual.rest) };
      } catch (err) {
        return setError((err as Error).message);
      }
    }
    setSaving(true);
    try {
      await api.post('/phases', body);
      navigate('/plan', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <>
      <ScreenHeader title={overview?.phase ? 'New phase' : 'Start a phase'}>
        {overview?.phase
          ? `Replaces the current ${PHASE_LABEL[overview.phase.type].toLowerCase()} phase from the start date.`
          : 'Direction, starting targets and how often to review.'}
      </ScreenHeader>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Card className="space-y-3">
          <Segmented label="Phase" options={TYPES} value={type} onChange={(v) => v && setType(v)} />
          <p className="text-sm text-muted">{HELP[type]}</p>
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm">Starts on</span>
            <input
              type="date"
              value={startedOn}
              onChange={(e) => setStartedOn(e.target.value)}
              className="rounded-xl border border-border bg-bg px-3 py-2 text-base"
            />
          </label>
          <NumberField
            label="Maintenance"
            unit="kcal"
            value={maintenance}
            onChange={setMaintenance}
          />
          <p className="-mt-2 text-xs text-muted">
            Use the maintenance you've observed (the weight held steady at this intake), not a
            formula.
          </p>
          <NumberField label="Bodyweight" unit="kg" value={bodyweight} onChange={setBodyweight} />
          {type === 'surplus' && (
            <NumberField label="Surplus" unit="%" value={surplusPct} onChange={setSurplusPct} />
          )}
          {type === 'cut' && (
            <NumberField
              label="Loss per week"
              unit="%"
              value={deficitPct}
              onChange={setDeficitPct}
            />
          )}
          {(type === 'maintenance' || type === 'maingain') && (
            <NumberField
              label="Hold weight"
              unit="kg"
              value={targetWeight}
              onChange={setTargetWeight}
            />
          )}
          <NumberField
            label="Review every"
            unit="days"
            value={reviewDays}
            onChange={setReviewDays}
          />
          <label className="block">
            <span className="text-sm">Why this phase (optional)</span>
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-xl border border-border bg-bg px-3 py-2 text-base"
            />
          </label>
        </Card>

        <Card className="space-y-3">
          <div className="flex items-baseline justify-between">
            <SectionTitle>Starting targets</SectionTitle>
            {!byHand && (
              <button
                type="button"
                onClick={startByHand}
                className="text-sm font-medium text-accent"
              >
                Set by hand
              </button>
            )}
          </div>
          {!byHand && !preview && (
            <p className="text-sm text-muted">Enter maintenance and bodyweight to see them.</p>
          )}
          {!byHand && preview && (
            <>
              <PreviewTable training={preview.targets.training} rest={preview.targets.rest} />
              <p className="text-xs text-muted">
                {trainingDays} training days a week, averaging {Math.round(preview.averageKcal)}{' '}
                kcal. {preview.notes.join(' ')}
              </p>
              {preview.floorBinds && (
                <p className="text-sm text-warn">
                  The 2000 kcal floor limits this cut to about{' '}
                  {((preview.achievableRatePctPerWeek ?? 0) * 100).toFixed(2)}% a week. More
                  activity is the lever.
                </p>
              )}
            </>
          )}
          {byHand && manual && <ManualTargets value={manual} onChange={setManual} />}
        </Card>

        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" disabled={saving} className="w-full">
          {saving ? 'Starting…' : overview?.phase ? 'Start the new phase' : 'Start the phase'}
        </Button>
      </form>
    </>
  );
}

const ROWS: [string, keyof DayTargetsDto, string][] = [
  ['Energy', 'kcal', 'kcal'],
  ['Protein', 'proteinG', 'g'],
  ['Carbs', 'carbsG', 'g'],
  ['Fat', 'fatG', 'g'],
  ['Fibre', 'fibreG', 'g'],
];

function PreviewTable({ training, rest }: { training: DayTargetsDto; rest: DayTargetsDto }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted">
          <th className="text-left font-medium" />
          <th className="text-right font-medium">Training</th>
          <th className="text-right font-medium">Rest</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(([label, key, unit]) => (
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

function ManualTargets({
  value,
  onChange,
}: {
  value: Record<'training' | 'rest', Record<keyof DayTargetsDto, string>>;
  onChange: (v: Record<'training' | 'rest', Record<keyof DayTargetsDto, string>>) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted">
          <th className="text-left font-medium" />
          <th className="text-right font-medium">Training</th>
          <th className="text-right font-medium">Rest</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(([label, key, unit]) => (
          <tr key={key}>
            <td className="py-1">
              {label} <span className="text-xs text-muted">({unit})</span>
            </td>
            {(['training', 'rest'] as const).map((day) => (
              <td key={day} className="py-1 text-right">
                <input
                  aria-label={`${label} on ${day} days`}
                  inputMode="decimal"
                  value={value[day][key]}
                  onChange={(e) =>
                    onChange({ ...value, [day]: { ...value[day], [key]: e.target.value } })
                  }
                  className="w-20 rounded-lg border border-border bg-bg px-2 py-1.5 text-right text-base"
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
