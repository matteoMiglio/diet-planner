import type { CheckinDto, CurrentCheckinDto, SaveCheckinRequest } from '@diet/shared';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
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
import { clockTime, shortDate } from '../format';
import { useQuery } from '../useQuery';

type Adherence = NonNullable<CheckinDto['adherence']>;
type Training = NonNullable<CheckinDto['trainingProgressed']>;

const ADHERENCE: Option<Adherence>[] = [
  { value: 'on_plan', label: 'On plan' },
  { value: 'mostly', label: 'Mostly' },
  { value: 'off', label: 'Off' },
];
const TRAINING: Option<Training>[] = [
  { value: 'yes', label: 'Progressed' },
  { value: 'no', label: 'Flat' },
  { value: 'deload', label: 'Deload' },
];
const SCALE: Option<number>[] = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }));

const asText = (v: number | null | undefined) => (v == null ? '' : String(v));

export function CheckinScreen() {
  const query = useQuery<CurrentCheckinDto>('/checkins/current');

  return (
    <>
      <ScreenHeader title="Check-in">
        {query.data ? `Week of ${shortDate(query.data.weekStart)}` : 'This week'}
      </ScreenHeader>
      {query.status === 'loading' && <p className="text-sm text-muted">Loading…</p>}
      {query.status === 'error' && <ErrorNote>{query.error.message}</ErrorNote>}
      {query.data && <CheckinForm current={query.data} />}
    </>
  );
}

function CheckinForm({ current }: { current: CurrentCheckinDto }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const saved = current.checkin;
  const prefillWeight = saved?.weightKg ?? current.latestWeightThisWeek?.weightKg ?? null;

  const [weight, setWeight] = useState(asText(prefillWeight));
  // Typing in the field (even the same number) means "I weighed myself now": log a reading.
  const [weightTyped, setWeightTyped] = useState(false);
  const [waist, setWaist] = useState(asText(saved?.girth?.waistCm));
  const [chest, setChest] = useState(asText(saved?.girth?.chestCm));
  const [biceps, setBiceps] = useState(asText(saved?.girth?.bicepsCm));
  const [quad, setQuad] = useState(asText(saved?.girth?.quadCm));
  const [moreGirths, setMoreGirths] = useState(
    saved?.girth?.chestCm != null || saved?.girth?.bicepsCm != null || saved?.girth?.quadCm != null,
  );
  const [adherence, setAdherence] = useState<Adherence | null>(saved?.adherence ?? null);
  const [training, setTraining] = useState<Training | null>(saved?.trainingProgressed ?? null);
  const [sleep, setSleep] = useState<number | null>(saved?.sleep ?? null);
  const [energy, setEnergy] = useState<number | null>(saved?.energy ?? null);
  const [hunger, setHunger] = useState<number | null>(saved?.hunger ?? null);
  const [notes, setNotes] = useState(saved?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const body: SaveCheckinRequest = {
      adherence,
      trainingProgressed: training,
      sleep,
      energy,
      hunger,
      notes: notes.trim() || null,
    };

    // Only send a weight that was typed here: a value prefilled from this week's scale
    // reading must not turn into a second, manual reading.
    const w = parseDecimal(weight);
    if (w === undefined || (w !== null && (w < 20 || w > 300))) {
      return setError('Weight must be a number between 20 and 300 kg.');
    }
    if (weightTyped && w !== null) body.weightKg = w;

    const girths = { waistCm: waist, chestCm: chest, bicepsCm: biceps, quadCm: quad } as const;
    const savedGirth = saved?.girth;
    for (const [key, text] of Object.entries(girths) as [keyof typeof girths, string][]) {
      const v = parseDecimal(text);
      if (v === undefined || (v !== null && (v < 10 || v > 250))) {
        return setError('Measurements must be numbers between 10 and 250 cm.');
      }
      if (text !== asText(savedGirth?.[key])) body[key] = v;
    }

    setSaving(true);
    try {
      await api.put<CheckinDto>(`/checkins/${current.weekStart}`, body);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setSaving(false);
    }
  }

  const incomplete = adherence === null || training === null;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Card className="space-y-3">
        <SectionTitle>Body</SectionTitle>
        <NumberField
          label="Weight"
          unit="kg"
          value={weight}
          onChange={(v) => {
            setWeight(v);
            setWeightTyped(true);
          }}
          autoFocus={params.get('focus') === 'weight'}
        />
        {current.latestWeightThisWeek && !weightTyped && (
          <p className="text-xs text-muted">
            From the scale reading on {shortDate(current.latestWeightThisWeek.measuredAt)} at{' '}
            {clockTime(current.latestWeightThisWeek.measuredAt)}. Type today’s weight to log a new
            reading.
          </p>
        )}
        <NumberField label="Waist at the navel" unit="cm" value={waist} onChange={setWaist} />
        {moreGirths ? (
          <>
            <NumberField label="Chest" unit="cm" value={chest} onChange={setChest} />
            <NumberField label="Biceps" unit="cm" value={biceps} onChange={setBiceps} />
            <NumberField label="Quad" unit="cm" value={quad} onChange={setQuad} />
          </>
        ) : (
          <button
            type="button"
            onClick={() => setMoreGirths(true)}
            className="flex items-center gap-1 text-sm font-medium text-accent"
          >
            <ChevronDown size={16} aria-hidden /> Chest, biceps, quad
          </button>
        )}
      </Card>

      <Card className="space-y-4">
        <div>
          <SectionTitle>How closely did you follow the plan?</SectionTitle>
          <Segmented
            label="Adherence"
            options={ADHERENCE}
            value={adherence}
            onChange={setAdherence}
          />
        </div>
        <div>
          <SectionTitle>Did your training numbers go up?</SectionTitle>
          <Segmented label="Training" options={TRAINING} value={training} onChange={setTraining} />
        </div>
      </Card>

      <Card className="space-y-4">
        <SectionTitle>How did the week feel? (1 = bad, 5 = great)</SectionTitle>
        <Rating label="Sleep" value={sleep} onChange={setSleep} />
        <Rating label="Energy" value={energy} onChange={setEnergy} />
        <Rating
          label="Hunger (1 = starving, 5 = never hungry)"
          value={hunger}
          onChange={setHunger}
        />
        <label className="block">
          <span className="text-sm">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={2000}
            className="mt-1 w-full rounded-xl border border-border bg-bg px-3 py-2 text-base outline-none focus:border-accent"
          />
        </label>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving} className="flex-1">
          <Check size={18} aria-hidden /> {saving ? 'Saving…' : 'Save check-in'}
        </Button>
        <Link to="/" className="px-3 text-sm text-muted">
          Cancel
        </Link>
      </div>
      {incomplete && (
        <p className="text-xs text-muted">
          You can save part of it now. The check-in counts once plan and training are answered.
        </p>
      )}
    </form>
  );
}

function Rating({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-sm">{label}</p>
      <Segmented label={label} options={SCALE} value={value} onChange={onChange} />
    </div>
  );
}
