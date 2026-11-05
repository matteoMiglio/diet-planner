export interface WeightReading {
  id: string;
  measuredAt: Date;
  weightKg: number;
  protocolOk: boolean;
  outlierOverride?: boolean | null;
}

export interface TrendOptions {
  now: Date;
  windowDays?: number;
  extendedWindowDays?: number;
  minReadings?: number;
  minSpanDays?: number;
  maxLatestAgeDays?: number;
  sigmaKg?: number;
  graceUntil?: Date | null;
  madThreshold?: number;
}

export type TrendReason = 'too_few_readings' | 'span_too_short' | 'latest_too_old';

export interface TrendResult {
  decidable: boolean;
  reasons: TrendReason[];
  slopeKgPerWeek: number | null;
  seKgPerWeek: number | null;
  ci80: [number, number] | null;
  interceptKg: number | null;
  n: number;
  spanDays: number;
  latestAgeDays: number | null;
  windowStart: Date;
  outlierIds: string[];
  excludedIds: string[];
  readingsNeeded: number;
}

const DAY_MS = 86_400_000;

interface Point {
  reading: WeightReading;
  x: number;
  y: number;
  w: number;
}

function nonnegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 0 ? (upper + (sorted[middle - 1] ?? upper)) / 2 : upper;
}

function fit(points: Point[]) {
  let weight = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (const point of points) {
    weight += point.w;
    weightedX += point.w * point.x;
    weightedY += point.w * point.y;
  }
  const meanX = weight > 0 ? weightedX / weight : 0;
  const meanY = weight > 0 ? weightedY / weight : 0;
  let spread = 0;
  let covariance = 0;
  for (const point of points) {
    spread += point.w * (point.x - meanX) ** 2;
    covariance += point.w * (point.x - meanX) * (point.y - meanY);
  }
  const slope = spread > 0 ? covariance / spread : 0;
  const intercept = meanY - slope * meanX;
  const residuals = points.map((point) => point.y - (intercept + slope * point.x));
  let squaredError = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const residual = residuals[i];
    if (point !== undefined && residual !== undefined) {
      squaredError += point.w * residual ** 2;
    }
  }
  return { slope, intercept, spread, residuals, squaredError };
}

/** Estimate a scale-weight trend using only the supplied reference time. */
export function weightTrend(readings: WeightReading[], options: TrendOptions): TrendResult {
  const now = options.now.getTime();
  const windowDays = nonnegative(options.windowDays, 42);
  const extendedWindowDays = nonnegative(options.extendedWindowDays, 56);
  const minReadings = Math.ceil(nonnegative(options.minReadings, 4));
  const minSpanDays = nonnegative(options.minSpanDays, 21);
  const maxLatestAgeDays = nonnegative(options.maxLatestAgeDays, 10);
  const sigmaKg = nonnegative(options.sigmaKg, 0.6);
  const madThreshold = nonnegative(options.madThreshold, 3);
  const graceUntil = options.graceUntil?.getTime() ?? -Infinity;
  const valid = readings.filter(
    (reading) => Number.isFinite(reading.measuredAt.getTime()) && Number.isFinite(reading.weightKg),
  );
  const inWindow = (days: number) =>
    valid.filter((reading) => {
      const time = reading.measuredAt.getTime();
      return time >= now - days * DAY_MS && time <= now;
    });
  let usedWindowDays = windowDays;
  let selected = inWindow(windowDays);
  // Window selection precedes both grace exclusions and outlier removal.
  if (selected.length < minReadings) {
    usedWindowDays = extendedWindowDays;
    selected = inWindow(extendedWindowDays);
  }

  const excludedIds: string[] = [];
  const outlierIds: string[] = [];
  let points: Point[] = [];
  for (const reading of selected) {
    if (reading.measuredAt.getTime() < graceUntil) {
      excludedIds.push(reading.id);
    } else if (reading.outlierOverride === true) {
      outlierIds.push(reading.id);
    } else {
      points.push({
        reading,
        x: (reading.measuredAt.getTime() - now) / DAY_MS,
        y: reading.weightKg,
        w: reading.protocolOk ? 1 : 0.5,
      });
    }
  }

  let fitted = fit(points);
  if (points.length >= 4) {
    const center = median(fitted.residuals);
    const mad = median(fitted.residuals.map((residual) => Math.abs(residual - center)));
    const cutoff = madThreshold * Math.max(mad * 1.4826, sigmaKg * 0.5);
    points = points.filter((point, index) => {
      const residual = fitted.residuals[index];
      if (
        point.reading.outlierOverride !== false &&
        residual !== undefined &&
        Math.abs(residual - center) > cutoff
      ) {
        outlierIds.push(point.reading.id);
        return false;
      }
      return true;
    });
    fitted = fit(points);
  }

  const n = points.length;
  const firstX = n > 0 ? Math.min(...points.map((point) => point.x)) : 0;
  const lastX = n > 0 ? Math.max(...points.map((point) => point.x)) : 0;
  const spanDays = lastX - firstX;
  const latestAgeDays = n > 0 ? -lastX : null;
  const reasons: TrendReason[] = [];
  if (n < minReadings) reasons.push('too_few_readings');
  if (spanDays < minSpanDays) reasons.push('span_too_short');
  if (latestAgeDays === null || latestAgeDays > maxLatestAgeDays) reasons.push('latest_too_old');

  const identifiable = n >= 2 && fitted.spread > 0;
  const slopeKgPerWeek = identifiable ? finiteOrNull(fitted.slope * 7) : null;
  // With two points there are no residual degrees of freedom; use the noise floor.
  const s2 = n > 2 ? fitted.squaredError / (n - 2) : 0;
  const variance = Math.max(s2, sigmaKg ** 2);
  const seKgPerWeek = identifiable ? finiteOrNull(Math.sqrt(variance / fitted.spread) * 7) : null;
  const halfWidth = seKgPerWeek === null ? null : 1.2816 * seKgPerWeek;
  const lower =
    slopeKgPerWeek !== null && halfWidth !== null ? finiteOrNull(slopeKgPerWeek - halfWidth) : null;
  const upper =
    slopeKgPerWeek !== null && halfWidth !== null ? finiteOrNull(slopeKgPerWeek + halfWidth) : null;

  return {
    decidable: reasons.length === 0,
    reasons,
    slopeKgPerWeek,
    seKgPerWeek,
    ci80: lower !== null && upper !== null ? [lower, upper] : null,
    interceptKg: n > 0 ? finiteOrNull(fitted.intercept) : null,
    n,
    spanDays,
    latestAgeDays,
    windowStart: new Date(now - usedWindowDays * DAY_MS),
    outlierIds,
    excludedIds,
    readingsNeeded: Math.max(0, minReadings - n),
  };
}
