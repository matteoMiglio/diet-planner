import type { MeasurementDto, ProgressDto } from '@diet/shared';
import { ChartLine, FileUp, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { EmptyState } from '../components/EmptyState';
import { ImportSheet } from '../components/ImportSheet';
import { ScreenHeader } from '../components/ScreenHeader';
import { TrendSummary } from '../components/TrendSummary';
import {
  Button,
  Card,
  ErrorNote,
  type Option,
  SectionTitle,
  Segmented,
  Loading,
} from '../components/ui';
import { MiniLine, WeightChart } from '../components/WeightChart';
import { clockTime, kg, shortDate } from '../format';
import { useQuery } from '../useQuery';

type Range = '3m' | '6m' | '1y' | 'all';
const RANGES: Option<Range>[] = [
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
];
const RANGE_DAYS: Record<Exclude<Range, 'all'>, number> = { '3m': 91, '6m': 182, '1y': 365 };

export function ProgressScreen() {
  const query = useQuery<ProgressDto>('/progress');
  const [importing, setImporting] = useState(false);

  return (
    <>
      <div className="flex items-start justify-between">
        <ScreenHeader title="Progress">Weight trend, waist and body composition.</ScreenHeader>
        <Button variant="ghost" onClick={() => setImporting(true)} className="-mr-2">
          <FileUp size={18} aria-hidden /> Import
        </Button>
      </div>

      {query.status === 'loading' && <Loading />}
      {query.status === 'error' && <ErrorNote>{query.error.message}</ErrorNote>}
      {query.data && query.data.measurements.length === 0 && (
        <EmptyState icon={ChartLine} title="No measurements yet">
          Import your My Tanita CSV, or log a weight from Today.
        </EmptyState>
      )}
      {query.data && query.data.measurements.length > 0 && (
        <ProgressBody data={query.data} reload={query.reload} />
      )}

      {importing && (
        <ImportSheet onClose={() => setImporting(false)} onImported={() => void query.reload()} />
      )}
    </>
  );
}

function ProgressBody({ data, reload }: { data: ProgressDto; reload: () => Promise<void> }) {
  const [range, setRange] = useState<Range>('6m');
  // Fixed per render of this data, so the chart and the trend line agree on "now".
  const [nowMs] = useState(() => Date.now());
  const first = new Date(data.measurements[0]!.measuredAt).getTime();
  const sinceMs = range === 'all' ? first : Math.max(first, nowMs - RANGE_DAYS[range] * 86_400_000);
  const inRange = (iso: string) => new Date(iso).getTime() >= sinceMs;

  const waist = data.girths
    .filter((g) => g.waistCm !== null && inRange(g.measuredOn))
    .map((g) => ({ t: new Date(`${g.measuredOn}T12:00:00`).getTime(), value: g.waistCm! }));
  const series = (pick: (m: MeasurementDto) => number | null) =>
    data.measurements
      .filter((m) => inRange(m.measuredAt) && pick(m) !== null)
      .map((m) => ({ t: new Date(m.measuredAt).getTime(), value: pick(m)! }));
  const bodyFat = series((m) => m.bodyFatPct);
  const muscle = series((m) => m.muscleMassKg);

  return (
    <div className="space-y-4">
      <Card>
        <TrendSummary trend={data.trend} />
      </Card>

      <Card className="space-y-3">
        <Segmented
          label="Range"
          options={RANGES}
          value={range}
          onChange={(r) => r && setRange(r)}
        />
        <WeightChart
          measurements={data.measurements}
          trend={data.trend}
          sinceMs={sinceMs}
          nowMs={nowMs}
        />
        <p className="text-xs text-muted-foreground">
          Filled dots: morning weigh-ins. Hollow: later in the day, counted at half weight. Red
          crosses: left out as outliers.
        </p>
      </Card>

      <Card>
        <SectionTitle>Waist</SectionTitle>
        {waist.length > 0 ? (
          <MiniLine data={waist} label="Waist" unit="cm" />
        ) : (
          <p className="text-sm text-muted-foreground">
            No waist measurements yet. Add one in the weekly check-in: it's the honest read on fat
            gain that the scale's body-fat number can't give.
          </p>
        )}
      </Card>

      {(bodyFat.length > 0 || muscle.length > 0) && (
        <Card className="space-y-3">
          <div>
            <SectionTitle>Body fat and muscle</SectionTitle>
            <p className="-mt-1 text-xs text-muted-foreground">
              Bioimpedance estimates: read the direction, not the number.
            </p>
          </div>
          {bodyFat.length > 0 && <MiniLine data={bodyFat} label="Body fat" unit="%" />}
          {muscle.length > 0 && <MiniLine data={muscle} label="Muscle mass" unit="kg" />}
        </Card>
      )}

      <Readings
        measurements={data.measurements}
        outlierIds={data.trend.outlierIds}
        reload={reload}
      />
    </div>
  );
}

const SOURCE_LABEL: Record<MeasurementDto['source'], string> = {
  tanita_csv: 'Tanita',
  shortcut: 'Shortcut',
  manual: 'Manual',
};

function Readings({
  measurements,
  outlierIds,
  reload,
}: {
  measurements: MeasurementDto[];
  outlierIds: string[];
  reload: () => Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outliers = new Set(outlierIds);
  const newestFirst = [...measurements].reverse();
  const shown = showAll ? newestFirst : newestFirst.slice(0, 10);

  async function act(run: () => Promise<unknown>, done?: string) {
    setError(null);
    try {
      await run();
      if (done) toast.success(done);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <Card>
      <SectionTitle>Readings</SectionTitle>
      {error && <ErrorNote>{error}</ErrorNote>}
      <ul className="divide-y divide-border">
        {shown.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {shortDate(m.measuredAt, true)}{' '}
                <span className="font-normal text-muted-foreground">{clockTime(m.measuredAt)}</span>
              </p>
              <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span>{SOURCE_LABEL[m.source]}</span>
                {!m.protocolOk && <span>· off-protocol</span>}
                {outliers.has(m.id) && (
                  <span className="text-danger">
                    · outlier{m.outlierOverride === true ? ' (manual)' : ''}
                  </span>
                )}
                {m.outlierOverride === false && <span>· always kept</span>}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-sm font-semibold">{kg(m.weightKg, 2)}</span>
              <ReadingMenu
                measurement={m}
                isOutlier={outliers.has(m.id)}
                onOverride={(value) =>
                  act(() => api.patch(`/measurements/${m.id}`, { outlierOverride: value }))
                }
                onDelete={() => act(() => api.delete(`/measurements/${m.id}`), 'Reading deleted')}
              />
            </div>
          </li>
        ))}
      </ul>
      {newestFirst.length > 10 && (
        <Button variant="ghost" className="mt-1 w-full" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${newestFirst.length}`}
        </Button>
      )}
    </Card>
  );
}

function ReadingMenu({
  measurement,
  isOutlier,
  onOverride,
  onDelete,
}: {
  measurement: MeasurementDto;
  isOutlier: boolean;
  onOverride: (value: boolean | null) => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const choices: { label: string; run: () => void }[] = [];
  if (measurement.outlierOverride !== null) {
    choices.push({ label: 'Let the trend decide', run: () => onOverride(null) });
  }
  if (measurement.outlierOverride !== true && !isOutlier) {
    choices.push({ label: 'Mark as outlier', run: () => onOverride(true) });
  }
  if (measurement.outlierOverride !== false && isOutlier) {
    choices.push({ label: 'Keep in the trend', run: () => onOverride(false) });
  }
  choices.push({
    label: 'Delete reading',
    run: () => setConfirmDelete(true),
  });

  return (
    <>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete the ${kg(measurement.weightKg, 2)} reading?`}
        description="It's removed from your weight trend. This can't be undone."
        confirmLabel="Delete reading"
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
      {/* Not modal: a dialog opened from a modal menu can leave the page unclickable. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label="Reading options"
          className="rounded-full p-2 text-muted-foreground hover:bg-surface-2"
        >
          <MoreHorizontal size={18} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {choices.map((c) => (
            <DropdownMenuItem
              key={c.label}
              variant={c.label.startsWith('Delete') ? 'destructive' : 'default'}
              onSelect={c.run}
            >
              {c.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
