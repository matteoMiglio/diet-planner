import type { MeasurementDto, TrendDto } from '@diet/shared';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { kg, shortDate } from '../format';

const DAY = 86_400_000;

interface Point {
  t: number;
  weight: number;
}

/** Weigh-ins as dots (hollow when off-protocol, red when an outlier) plus the fitted trend line. */
export function WeightChart({
  measurements,
  trend,
  sinceMs,
  nowMs,
}: {
  measurements: MeasurementDto[];
  trend: TrendDto;
  sinceMs: number;
  nowMs: number;
}) {
  const outliers = new Set(trend.outlierIds);
  const visible = measurements.filter((m) => new Date(m.measuredAt).getTime() >= sinceMs);
  const toPoint = (m: MeasurementDto): Point => ({
    t: new Date(m.measuredAt).getTime(),
    weight: m.weightKg,
  });

  const protocol = visible.filter((m) => m.protocolOk && !outliers.has(m.id)).map(toPoint);
  const offProtocol = visible.filter((m) => !m.protocolOk && !outliers.has(m.id)).map(toPoint);
  const flagged = visible.filter((m) => outliers.has(m.id)).map(toPoint);

  const trendLine: Point[] = [];
  if (trend.slopeKgPerWeek !== null && trend.interceptKg !== null) {
    const start = Math.max(new Date(trend.windowStart).getTime(), sinceMs);
    for (const t of [start, nowMs]) {
      trendLine.push({
        t,
        weight: trend.interceptKg + (trend.slopeKgPerWeek / 7) * ((t - nowMs) / DAY),
      });
    }
  }

  const weights = [...visible.map((m) => m.weightKg), ...trendLine.map((p) => p.weight)];
  if (weights.length === 0) return null;
  const lo = Math.floor(Math.min(...weights) - 0.5);
  const hi = Math.ceil(Math.max(...weights) + 0.5);

  return (
    <div className="h-60 w-full" role="img" aria-label="Weight over time with trend line">
      <ResponsiveContainer>
        <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[sinceMs, nowMs]}
            tickFormatter={(t: number) => shortDate(new Date(t).toISOString())}
            tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            stroke="var(--border)"
            minTickGap={24}
          />
          <YAxis
            dataKey="weight"
            type="number"
            domain={[lo, hi]}
            tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            stroke="var(--border)"
            allowDecimals={false}
          />
          <Tooltip
            cursor={false}
            contentStyle={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              color: 'var(--text)',
            }}
            labelFormatter={(t) => shortDate(new Date(Number(t)).toISOString(), true)}
            formatter={(v) => [kg(Number(v), 2), 'Weight']}
          />
          <Line
            data={trendLine}
            dataKey="weight"
            stroke="var(--primary)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="Trend"
          />
          <Scatter
            data={protocol}
            fill="var(--primary)"
            name="Morning weigh-in"
            isAnimationActive={false}
          />
          <Scatter
            data={offProtocol}
            fill="var(--surface)"
            stroke="var(--primary)"
            name="Off-protocol weigh-in"
            isAnimationActive={false}
          />
          <Scatter
            data={flagged}
            fill="var(--danger)"
            name="Outlier"
            shape="cross"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A small single-series line chart, for waist and composition trends. */
export function MiniLine({
  data,
  label,
  unit,
}: {
  data: { t: number; value: number }[];
  label: string;
  unit: string;
}) {
  if (data.length === 0) return null;
  const values = data.map((d) => d.value);
  const pad = Math.max(0.5, (Math.max(...values) - Math.min(...values)) * 0.15);
  return (
    <div className="h-32 w-full" role="img" aria-label={`${label} over time`}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t: number) => shortDate(new Date(t).toISOString())}
            tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            stroke="var(--border)"
            minTickGap={24}
          />
          <YAxis
            type="number"
            domain={[Math.floor(Math.min(...values) - pad), Math.ceil(Math.max(...values) + pad)]}
            tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            stroke="var(--border)"
            allowDecimals={false}
          />
          <Tooltip
            cursor={false}
            contentStyle={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              color: 'var(--text)',
            }}
            labelFormatter={(t) => shortDate(new Date(Number(t)).toISOString(), true)}
            formatter={(v) => [`${Number(v).toFixed(1)} ${unit}`, label]}
          />
          <Line
            dataKey="value"
            stroke="var(--primary)"
            strokeWidth={2}
            dot={{ r: 2.5, fill: 'var(--primary)' }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
