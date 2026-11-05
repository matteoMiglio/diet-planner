import { describe, expect, it } from 'vitest';
import { weightTrend } from './trend.js';
import type { WeightReading } from './trend.js';

const DAY_MS = 86_400_000;
const now = new Date('2026-11-05T12:00:00Z');
const atDay = (day: number) => new Date(now.getTime() + day * DAY_MS);

function reading(day: number, weightKg = 80 + (0.15 * day) / 7): WeightReading {
  return { id: `day-${day}`, measuredAt: atDay(day), weightKg, protocolOk: true };
}

// Two readings per week for six weeks, with the latest reading at now.
const smoothSeries = () => Array.from({ length: 12 }, (_, i) => reading(-38.5 + i * 3.5));

describe('weightTrend', () => {
  it('recovers an exact slope from two readings per week for six weeks', () => {
    const readings = Array.from({ length: 12 }, (_, i) => reading(-38.5 + i * 3.5));
    const result = weightTrend(readings, { now });
    expect(result.slopeKgPerWeek).toBeCloseTo(0.15, 9);
    expect(result.interceptKg).toBeCloseTo(80, 9);
    expect(result.decidable).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.n).toBe(12);
  });

  it('uses the sigma floor for the SE and a nonzero 80% confidence interval', () => {
    const readings = smoothSeries();
    const meanDay = -19.25;
    const spread = readings.reduce((sum, r) => {
      const day = (r.measuredAt.getTime() - now.getTime()) / DAY_MS;
      return sum + (day - meanDay) ** 2;
    }, 0);
    const expectedSE = (7 * 0.6) / Math.sqrt(spread);
    const result = weightTrend(readings, { now });
    expect(result.seKgPerWeek).toBeCloseTo(expectedSE, 12);
    expect(result.ci80?.[0]).toBeCloseTo(0.15 - 1.2816 * expectedSE, 12);
    expect(result.ci80?.[1]).toBeCloseTo(0.15 + 1.2816 * expectedSE, 12);
    expect(expectedSE).toBeGreaterThan(0);
  });

  it('has a CI half-width of about 0.13 kg/week over six weeks', () => {
    const result = weightTrend(smoothSeries(), { now });
    // half-width = 1.2816 * 7 * sigma / sqrt(sum((day - meanDay)^2))
    // For n=12, spacing=3.5 days: sum = spacing^2 * n * (n^2 - 1) / 12.
    const halfWidth = ((result.ci80?.[1] ?? 0) - (result.ci80?.[0] ?? 0)) / 2;
    expect(Math.abs(halfWidth - 0.13)).toBeLessThan(0.01);
  });

  it('removes an automatic outlier and refits the original slope', () => {
    const readings = smoothSeries();
    const outlier = readings[3]!;
    outlier.weightKg -= 2;
    const result = weightTrend(readings, { now });
    expect(result.outlierIds).toEqual([outlier.id]);
    expect(result.n).toBe(11);
    expect(result.slopeKgPerWeek).toBeCloseTo(0.15, 9);
  });

  it('keeps an outlier explicitly overridden false', () => {
    const readings = smoothSeries();
    const outlier = readings[3]!;
    outlier.weightKg -= 2;
    outlier.outlierOverride = false;
    const result = weightTrend(readings, { now });
    expect(result.outlierIds).toEqual([]);
    expect(result.n).toBe(12);
    expect(Math.abs((result.slopeKgPerWeek ?? 0) - 0.15)).toBeGreaterThan(0.01);
  });

  it('removes a normal reading overridden true before fitting', () => {
    const readings = smoothSeries();
    readings[0]!.outlierOverride = true;
    const result = weightTrend(readings, { now });
    expect(result.outlierIds).toEqual([readings[0]!.id]);
    expect(result.n).toBe(11);
    expect(result.slopeKgPerWeek).toBeCloseTo(0.15, 9);
  });

  it('treats null overrides as automatic detection', () => {
    const readings = smoothSeries();
    readings[3]!.weightKg -= 2;
    readings[3]!.outlierOverride = null;
    expect(weightTrend(readings, { now }).outlierIds).toEqual([readings[3]!.id]);
  });

  it('assigns off-protocol readings half weight', () => {
    const readings = [reading(-28, 80), reading(-14, 80), reading(0, 82)];
    const full = weightTrend(readings, { now });
    const half = weightTrend(
      readings.map((r) => ({ ...r, protocolOk: r.measuredAt.getTime() !== now.getTime() })),
      { now },
    );
    expect(full.slopeKgPerWeek).toBeCloseTo(0.5, 12);
    expect(half.slopeKgPerWeek).toBeCloseTo(3 / 7, 12);
    expect(half.slopeKgPerWeek).toBeLessThan(full.slopeKgPerWeek!);
  });

  it('excludes pre-grace readings, retaining the exact grace boundary', () => {
    const result = weightTrend([reading(-42), reading(-28), reading(-14), reading(0)], {
      now,
      graceUntil: atDay(-28),
    });
    expect(result.excludedIds).toEqual(['day--42']);
    expect(result.n).toBe(3);
    expect(result.spanDays).toBe(28);
    expect(result.windowStart).toEqual(atDay(-42));
  });

  it('reports too few readings', () => {
    const result = weightTrend([reading(-28), reading(-14), reading(0)], { now });
    expect(result.decidable).toBe(false);
    expect(result.reasons).toEqual(['too_few_readings']);
    expect(result.readingsNeeded).toBe(1);
  });

  it('reports a span shorter than 21 days', () => {
    const result = weightTrend(
      [-10, -7, -3, 0].map((day) => reading(day)),
      { now },
    );
    expect(result.reasons).toEqual(['span_too_short']);
    expect(result.decidable).toBe(false);
  });

  it('reports a latest reading 15 days old', () => {
    const result = weightTrend(
      [-42, -33, -24, -15].map((day) => reading(day)),
      { now },
    );
    expect(result.reasons).toEqual(['latest_too_old']);
    expect(result.latestAgeDays).toBe(15);
    expect(result.decidable).toBe(false);
  });

  it('extends the window when the initial window has fewer than four readings', () => {
    const result = weightTrend(
      [-56, -40, -20, 0].map((day) => reading(day)),
      { now },
    );
    expect(result.windowStart).toEqual(atDay(-56));
    expect(result.n).toBe(4);
    expect(result.decidable).toBe(true);
  });

  it('does not extend the window after outlier removal', () => {
    const readings = [-50, -40, -25, -10, 0].map((day) => reading(day));
    readings[1]!.outlierOverride = true;
    const result = weightTrend(readings, { now });
    expect(result.windowStart).toEqual(atDay(-42));
    expect(result.n).toBe(3);
  });

  it('handles sparse readings across the extended window', () => {
    const result = weightTrend(
      [-50, -31, -12].map((day) => reading(day)),
      { now },
    );
    expect(result.decidable).toBe(false);
    expect(result.reasons).toEqual(['too_few_readings', 'latest_too_old']);
    expect(result.readingsNeeded).toBe(1);
    expect(result.n).toBe(3);
  });

  it('handles empty input and lists every failing readiness condition in order', () => {
    const result = weightTrend([], { now });
    expect(result.decidable).toBe(false);
    expect(result.reasons).toEqual(['too_few_readings', 'span_too_short', 'latest_too_old']);
    expect(result.slopeKgPerWeek).toBeNull();
    expect(result.seKgPerWeek).toBeNull();
    expect(result.ci80).toBeNull();
    expect(result.interceptKg).toBeNull();
    expect(result.latestAgeDays).toBeNull();
    expect(result.n).toBe(0);
    expect(result.spanDays).toBe(0);
  });

  it('handles one reading and zero time spread without NaN', () => {
    const single = weightTrend([reading(0, 81)], { now });
    expect(single.slopeKgPerWeek).toBeNull();
    expect(single.interceptKg).toBe(81);
    const repeated = weightTrend([reading(0, 80), reading(0, 82)], { now });
    expect(repeated.slopeKgPerWeek).toBeNull();
    expect(repeated.seKgPerWeek).toBeNull();
    expect(repeated.ci80).toBeNull();
    expect(repeated.interceptKg).toBe(81);
    expect(repeated.spanDays).toBe(0);
  });

  it('uses the noise floor with only two readings', () => {
    const result = weightTrend([reading(-28), reading(0)], { now });
    expect(result.slopeKgPerWeek).toBeCloseTo(0.15, 9);
    expect(result.seKgPerWeek).toBeCloseTo((7 * 0.6) / Math.sqrt(392), 12);
  });

  it('honors custom options and inclusive window, age, and span boundaries', () => {
    const readings = [-70, -35, -14, -7, 1].map((day) => reading(day));
    const result = weightTrend(readings, {
      now,
      windowDays: 35,
      extendedWindowDays: 70,
      minReadings: 3,
      minSpanDays: 28,
      maxLatestAgeDays: 7,
      sigmaKg: 1,
      madThreshold: 4,
      graceUntil: null,
    });
    expect(result.windowStart).toEqual(atDay(-35));
    expect(result.n).toBe(3);
    expect(result.spanDays).toBe(28);
    expect(result.latestAgeDays).toBe(7);
    expect(result.decidable).toBe(true);
    expect(result.readingsNeeded).toBe(0);
  });

  it('ignores invalid dates and non-finite weights', () => {
    const result = weightTrend(
      [{ ...reading(0), measuredAt: new Date(NaN) }, reading(-1, NaN), reading(-2, Infinity)],
      { now },
    );
    expect(result.n).toBe(0);
    expect(result.slopeKgPerWeek).toBeNull();
  });
});
