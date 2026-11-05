import { describe, expect, it } from 'vitest';
import {
  adaptiveMaintenance,
  katchMcArdle,
  mifflinStJeor,
  phaseTargets,
  reviewDecision,
} from './engine.js';
import type { DayTargets, PhaseType, ReviewInput, Targets } from './engine.js';
import type { TrendResult } from './trend.js';

function day(kcal: number): DayTargets {
  const carbsG = Math.round((kcal - 4 * 160 - 9 * 70) / 4);
  return { kcal, proteinG: 160, fatG: 70, carbsG, fibreG: Math.round(Math.max(20, carbsG * 0.1)) };
}

function input(type: PhaseType = 'surplus'): ReviewInput {
  return {
    phase: { type, weeksInPhase: 4, targetWeightKg: 80 },
    targets: { training: day(2300), rest: day(2200) },
    maintenanceKcal: 2400,
    bodyweightKg: 80,
    trainingDaysPerWeek: 3,
    trend: {
      decidable: true,
      reasons: [],
      slopeKgPerWeek: 0.15,
      ci80: [0.12, 0.18],
      interceptKg: 80,
      readingsNeeded: 0,
    },
    inGracePeriod: false,
    checkins: ['2026-11-02', '2026-10-26'].map((weekStart) => ({
      weekStart,
      adherence: 'on_plan',
      trainingProgressed: 'yes',
      sleep: 4,
      energy: 4,
    })),
    waistChangeCm: 0,
  };
}

function trend(i: ReviewInput, ci: [number, number]): void {
  i.trend.ci80 = ci;
  i.trend.slopeKgPerWeek = (ci[0] + ci[1]) / 2;
}

function lowRecovery(i: ReviewInput): void {
  // Each check-in can satisfy a different part of the recovery condition.
  i.checkins = i.checkins.map((c, index) => ({
    ...c,
    sleep: index === 0 ? 2 : 4,
    energy: index === 1 ? 2 : 4,
  }));
}

function expectChange(i: ReviewInput, rule: string, training: number, rest: number) {
  const before = structuredClone(i);
  const result = reviewDecision(i);
  expect(i).toEqual(before);
  expect(result.action).toBe('change');
  if (result.action !== 'change') throw new Error(`Expected ${rule} to change targets`);
  expect(result.rule).toBe(rule);
  expect(result.deltaKcal).toEqual({ training, rest });
  for (const key of ['training', 'rest'] as const) {
    expect(result.targets[key].proteinG).toBe(i.targets[key].proteinG);
    expect(result.targets[key].fatG).toBe(i.targets[key].fatG);
    expect(result.targets[key].kcal).toBe(i.targets[key].kcal + result.deltaKcal[key]);
    expect(result.targets[key].carbsG).toBe(
      Math.max(0, Math.round(i.targets[key].carbsG + result.deltaKcal[key] / 4)),
    );
    expect(result.targets[key].fibreG).toBe(
      Math.round(Math.max(20, result.targets[key].carbsG * 0.1)),
    );
  }
  return result;
}

const average = (targets: Targets, t: number) =>
  (targets.training.kcal * t + targets.rest.kcal * (7 - t)) / 7;

describe('maintenance estimates', () => {
  it('computes known male and female Mifflin and Katch values', () => {
    expect(mifflinStJeor({ sex: 'male', weightKg: 80, heightCm: 180, ageYears: 30 })).toBe(1780);
    expect(mifflinStJeor({ sex: 'female', weightKg: 80, heightCm: 180, ageYears: 30 })).toBe(1614);
    expect(katchMcArdle({ weightKg: 80, bodyFatPct: 20 })).toBeCloseTo(1752.4);
  });

  it('pulls a 2100 seed toward flat 2040 intake and rounds to 5 kcal', () => {
    expect(
      adaptiveMaintenance({ previousKcal: 2100, meanIntakeKcal: 2040, slopeKgPerWeek: 0 }),
    ).toEqual({ kcal: 2075, observedTdee: 2040, clamped: false });
  });

  it('uses different energy densities for gain and loss, including overrides', () => {
    const seed = { previousKcal: 2100, meanIntakeKcal: 2100 };
    expect(adaptiveMaintenance({ ...seed, slopeKgPerWeek: 0.14 }).observedTdee).toBeCloseTo(1990);
    expect(adaptiveMaintenance({ ...seed, slopeKgPerWeek: -0.14 }).observedTdee).toBeCloseTo(2254);
    expect(
      adaptiveMaintenance({ ...seed, slopeKgPerWeek: 0.14, energyDensityGain: 7000 }).observedTdee,
    ).toBeCloseTo(1960);
    expect(
      adaptiveMaintenance({ ...seed, slopeKgPerWeek: -0.14, energyDensityLoss: 7000 }).observedTdee,
    ).toBeCloseTo(2240);
  });

  it.each([
    [-2, 2250],
    [2, 1950],
  ])('clamps slope %s to a 150 kcal step', (slopeKgPerWeek, kcal) => {
    expect(
      adaptiveMaintenance({ previousKcal: 2100, meanIntakeKcal: 2100, slopeKgPerWeek }),
    ).toMatchObject({ kcal, clamped: true });
  });

  it('supports a custom step limit', () => {
    expect(
      adaptiveMaintenance({
        previousKcal: 2100,
        meanIntakeKcal: 3000,
        slopeKgPerWeek: 0,
        maxStepKcal: 50,
      }),
    ).toMatchObject({ kcal: 2150, clamped: true });
  });
});

describe('phase targets', () => {
  const base = { maintenanceKcal: 2040, bodyweightKg: 87, trainingDaysPerWeek: 3 };

  it('matches the 2040 kcal / 87 kg / 10% surplus acceptance case', () => {
    const result = phaseTargets({ ...base, phase: 'surplus' });
    expect(Math.abs(result.averageKcal - 2244)).toBeLessThanOrEqual(5);
    expect(Math.abs(result.targets.training.kcal - 2313)).toBeLessThanOrEqual(5);
    expect(Math.abs(result.targets.rest.kcal - 2193)).toBeLessThanOrEqual(5);
    expect(result.targets.training.proteinG).toBe(165);
    expect(result.targets.training.fatG).toBe(74);
    expect(result.targets.rest.proteinG).toBe(165);
    expect(result.targets.rest.fatG).toBe(74);
    expect(result.floorBinds).toBe(false);
    expect(result.achievableRatePctPerWeek).toBeNull();
  });

  it('reports the achievable cut rate after the daily floor binds', () => {
    const result = phaseTargets({ ...base, phase: 'cut', deficitRatePctPerWeek: 0.005 });
    expect(result.floorBinds).toBe(true);
    expect(result.targets.training.kcal).toBe(2000);
    expect(result.targets.rest.kcal).toBe(2000);
    expect(result.averageKcal).toBe(2000);
    expect(result.achievableRatePctPerWeek).toBeCloseTo((40 * 7) / (87 * 7700));
    expect(result.notes.join(' ')).toContain('floor');
  });

  it('keeps a custom floor even when it is not a multiple of five', () => {
    const result = phaseTargets({ ...base, phase: 'cut', kcalFloorPerDay: 2002 });
    expect(result.targets.training.kcal).toBe(2005);
    expect(result.targets.rest.kcal).toBe(2005);
  });

  it('reports the cut rate with or without the floor, including a single raised day', () => {
    const result = phaseTargets({ ...base, phase: 'cut', maintenanceKcal: 2600 });
    expect(result.floorBinds).toBe(false);
    expect(result.achievableRatePctPerWeek).toBeCloseTo(0.005, 4);
    const partial = phaseTargets({ ...base, phase: 'cut', maintenanceKcal: 2500 });
    expect(partial.floorBinds).toBe(true);
    expect(partial.targets.training.kcal).toBeGreaterThan(2000);
    expect(partial.targets.rest.kcal).toBe(2000);
  });

  it('uses the fixed recomp split even with a custom cycle', () => {
    const result = phaseTargets({ ...base, phase: 'recomp', carbCycleKcal: 300 });
    expect(result.targets.training.kcal).toBe(2190);
    expect(result.targets.rest.kcal).toBe(1890);
    expect(result.targets.training.proteinG).toBe(183);
    expect(result.averageKcal).toBeCloseTo((2190 * 3 + 1890 * 4) / 7);
  });

  it.each(['cut', 'surplus', 'maintenance', 'maingain', 'recomp'] as const)(
    'rounds macros and reconciles calories in %s',
    (phase) => {
      const result = phaseTargets({ ...base, phase });
      for (const d of Object.values(result.targets)) {
        expect(d.kcal % 5).toBe(0);
        expect(Number.isInteger(d.proteinG)).toBe(true);
        expect(Number.isInteger(d.fatG)).toBe(true);
        expect(Number.isInteger(d.carbsG)).toBe(true);
        expect(Number.isInteger(d.fibreG)).toBe(true);
        expect(Math.abs(4 * d.proteinG + 9 * d.fatG + 4 * d.carbsG - d.kcal)).toBeLessThanOrEqual(
          10,
        );
      }
    },
  );

  it.each([0, 3, 7])('preserves the maintenance average for %s training days', (t) => {
    const result = phaseTargets({ ...base, phase: 'maintenance', trainingDaysPerWeek: t });
    expect(Math.abs(result.averageKcal - 2040)).toBeLessThanOrEqual(2.5);
    expect(result.averageKcal).toBe(average(result.targets, t));
  });

  it.each([1500, 4000])('clamps surplus fat to 20-30%% at maintenance %s', (maintenanceKcal) => {
    const result = phaseTargets({ ...base, phase: 'surplus', bodyweightKg: 60, maintenanceKcal });
    const fraction = (result.targets.training.fatG * 9) / result.averageKcal;
    expect(fraction).toBeGreaterThanOrEqual(0.2);
    expect(fraction).toBeLessThanOrEqual(0.3);
    expect(result.targets.training.fatG).toBeGreaterThanOrEqual(60 * 0.7);
  });

  it('never emits negative carbs and flags targets that protein and fat alone exceed', () => {
    const result = phaseTargets({ ...base, phase: 'maintenance', maintenanceKcal: 500 });
    expect(result.feasible).toBe(false);
    expect(result.targets.training.carbsG).toBe(0);
    expect(result.targets.rest.carbsG).toBe(0);
    expect(result.targets.rest.fibreG).toBe(20);
    expect(result.notes.join(' ')).toContain('exceed the calories');
  });

  it('is feasible for a normal setup', () => {
    expect(phaseTargets({ ...base, phase: 'surplus', maintenanceKcal: 2040 }).feasible).toBe(true);
  });

  it('caps the surplus at 10% and says so', () => {
    const capped = phaseTargets({
      ...base,
      phase: 'surplus',
      maintenanceKcal: 2000,
      surplusPct: 0.25,
    });
    expect(capped.averageKcal).toBeLessThanOrEqual(2205);
    expect(capped.notes.join(' ')).toContain('capped at 10%');
  });
});

describe('review gates', () => {
  it('prioritizes the undecidable trend gate over all other gates', () => {
    const i = input();
    i.trend.decidable = false;
    i.trend.reasons = ['too_few_readings'];
    i.trend.readingsNeeded = 2;
    i.checkins = [];
    i.inGracePeriod = true;
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'trend_not_decidable' });
    expect(reviewDecision(i).explanation).toContain('2');
  });

  it.each([
    { checkins: [] },
    { checkins: [input().checkins[0]!] },
    { checkins: [{ ...input().checkins[0]!, adherence: 'off' as const }, input().checkins[1]!] },
    { checkins: [input().checkins[0]!, { ...input().checkins[1]!, adherence: null }] },
  ])('requires two adherent recent check-ins: $checkins', ({ checkins }) => {
    const i = input();
    i.checkins = checkins;
    i.inGracePeriod = true;
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'adherence_gate' });
  });

  it('accepts mostly adherence and then checks the grace period', () => {
    const i = input();
    i.checkins = i.checkins.map((c) => ({ ...c, adherence: 'mostly' }));
    i.inGracePeriod = true;
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'grace_period' });
  });

  it('consumes the structural trend result and holds if CI or slope is absent', () => {
    const result: TrendResult = {
      ...input().trend,
      reasons: [],
      seKgPerWeek: 0.1,
      n: 5,
      spanDays: 28,
      latestAgeDays: 1,
      windowStart: new Date('2026-10-01'),
      outlierIds: [],
      excludedIds: [],
    };
    const i = input();
    i.trend = result;
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
    i.trend = { ...result, ci80: null };
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'trend_not_decidable' });
    i.trend = { ...result, slopeKgPerWeek: null };
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'trend_not_decidable' });
  });
});

describe('review decision table', () => {
  it('surplus: removes rest-day carbs for an entirely fast CI', () => {
    const i = input();
    trend(i, [0.26, 0.36]);
    expectChange(i, 'surplus_too_fast', 0, -100);
  });

  it('surplus: waist increase alone can trigger the rest-day reduction', () => {
    const i = input();
    i.waistChangeCm = 1.01;
    expectChange(i, 'surplus_too_fast', 0, -100);
  });

  it('surplus: adds all-day carbs when slow, progressing, and well below the literal threshold', () => {
    const i = input();
    trend(i, [-0.02, 0.08]);
    expectChange(i, 'surplus_too_slow', 150, 150);
  });

  it('surplus: adds to all days while the current average is more than 150 under the ceiling', () => {
    const i = input();
    i.maintenanceKcal = 2300;
    trend(i, [0, 0.05]);
    // Current average 2242.86; ceiling 2530; 2242.86 < 2380, so a full step.
    expectChange(i, 'surplus_too_slow', 150, 150);
  });

  it('surplus: adds to training days only within 150 of the ceiling', () => {
    const i = input();
    i.maintenanceKcal = 2100;
    trend(i, [0, 0.05]);
    // Current average 2242.86 > 2310 − 150, so a half step.
    expectChange(i, 'surplus_too_slow', 150, 0);
  });

  it('moves a change to the other day type when one never occurs', () => {
    const i = input('cut');
    i.trainingDaysPerWeek = 7;
    trend(i, [-0.4, -0.3]);
    const result = reviewDecision(i);
    expect(result).toMatchObject({ action: 'change', deltaKcal: { training: -100, rest: 0 } });
  });

  it('surplus: respects a custom band lower edge', () => {
    const i = input();
    i.phase.rateBandKgPerWeek = [0.2, 0.3];
    expectChange(i, 'surplus_too_slow', 150, 150);
  });

  it('surplus: holds for missing training stimulus', () => {
    const i = input();
    trend(i, [0, 0.05]);
    i.checkins = i.checkins.map((c) => ({ ...c, trainingProgressed: 'no' }));
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'training_not_progressed' });
  });

  it('surplus: holds for low recovery', () => {
    const i = input();
    lowRecovery(i);
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'sleep_first' });
  });

  it('cut: removes rest-day carbs for slow loss, including flat weight', () => {
    const i = input('cut');
    trend(i, [-0.1, 0.1]);
    expectChange(i, 'cut_too_slow', 0, -100);
  });

  it('cut: adds training-day carbs for fast loss', () => {
    const i = input('cut');
    trend(i, [-1.1, -0.9]);
    expectChange(i, 'cut_too_fast', 150, 0);
  });

  it('cut: thresholds scale with bodyweight', () => {
    const i = input('cut');
    i.bodyweightKg = 100;
    trend(i, [-0.49, -0.45]);
    expectChange(i, 'cut_too_slow', 0, -100);
  });

  it('cut: adds training-day carbs for low recovery', () => {
    const i = input('cut');
    trend(i, [-0.7, -0.5]);
    lowRecovery(i);
    expectChange(i, 'cut_low_recovery', 100, 0);
  });

  it('cut: proposes a two-week maintenance break after 12 weeks', () => {
    const i = input('cut');
    trend(i, [-0.7, -0.5]);
    i.phase.weeksInPhase = 12;
    expect(reviewDecision(i)).toMatchObject({ action: 'propose_diet_break' });
    expect(reviewDecision(i).explanation).toContain('2 weeks');
  });

  it('uses table order for overlapping cut conditions', () => {
    const i = input('cut');
    trend(i, [-0.1, 0.1]);
    lowRecovery(i);
    i.phase.weeksInPhase = 12;
    expectChange(i, 'cut_too_slow', 0, -100);
  });

  it.each(['maintenance', 'maingain'] as const)(
    '%s: applies all three maintenance rules',
    (phase) => {
      const up = input(phase);
      up.trend.interceptKg = 81;
      up.recentSlopeKgPerWeek = 0.51;
      expectChange(up, 'maintenance_drift_up', -100, -100);
      const down = input(phase);
      down.trend.interceptKg = 79;
      down.recentSlopeKgPerWeek = -0.31;
      expectChange(down, 'maintenance_drift_down', 100, 0);
      const stable = input(phase);
      lowRecovery(stable);
      expectChange(stable, 'maintenance_low_recovery', 100, 0);
    },
  );

  it('maintenance: requires directional band exit and recent drift', () => {
    const i = input('maintenance');
    i.trend.interceptKg = 81;
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
    i.recentSlopeKgPerWeek = -0.4;
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
    i.recentSlopeKgPerWeek = 0.5;
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
    i.phase.holdBandKg = 2;
    i.recentSlopeKgPerWeek = 0.6;
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
  });

  it('maintenance: holds if no target weight is supplied, even with low recovery', () => {
    const i = input('maintenance');
    i.phase.targetWeightKg = null;
    lowRecovery(i);
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
  });

  it.each(['surplus', 'cut', 'maintenance', 'maingain', 'recomp'] as const)(
    '%s: holds otherwise',
    (phase) => {
      const i = input(phase);
      if (phase === 'cut') trend(i, [-0.7, -0.5]);
      expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
    },
  );

  it.each([
    [0.24, 0.3],
    [0.05, 0.15],
    [0.25, 0.3],
  ] as [number, number][])(
    'surplus: holds when CI %j straddles or touches a threshold',
    (lower, upper) => {
      const i = input();
      trend(i, [lower, upper]);
      expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
    },
  );

  it.each([
    [-0.5, -0.3],
    [-0.9, -0.7],
    [-0.9, -0.8],
  ] as [number, number][])('cut: holds for straddling or touching CI %j', (lower, upper) => {
    const i = input('cut');
    trend(i, [lower, upper]);
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
  });

  it('does not count null recovery scores or one low check-in as two low check-ins', () => {
    const i = input();
    i.checkins = i.checkins.map((c, index) => ({
      ...c,
      sleep: index === 0 ? 1 : null,
      energy: null,
    }));
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
  });
});

describe('too-slow rules use the best estimate, guarded by the range', () => {
  it('surplus: flat weight with twice-weekly noise (CI ±0.13) proposes more food', () => {
    const i = input();
    trend(i, [-0.13, 0.13]);
    expect(reviewDecision(i)).toMatchObject({ action: 'change', rule: 'surplus_too_slow' });
  });

  it('surplus: holds when the range reaches the top of the band', () => {
    const i = input();
    trend(i, [-0.15, 0.25]);
    expect(reviewDecision(i)).toMatchObject({ action: 'hold', reason: 'on_target' });
  });

  it('cut: slow loss whose range stays clear of too fast proposes less food', () => {
    const i = input('cut');
    trend(i, [-0.4, -0.3]);
    expect(reviewDecision(i)).toMatchObject({ action: 'change', rule: 'cut_too_slow' });
  });
});

describe('slow surplus without progressing training', () => {
  it.each([
    ['deload', 'deload week'],
    ['no', 'stimulus'],
    [null, 'answer'],
  ] as const)('holds when training is %s and says why', (progressed, wording) => {
    const i = input();
    trend(i, [-0.05, 0.05]);
    i.checkins = i.checkins.map((c) => ({ ...c, trainingProgressed: progressed }));
    const result = reviewDecision(i);
    expect(result).toMatchObject({ action: 'hold', reason: 'training_not_progressed' });
    expect(result.explanation).toContain(wording);
  });

  it('explains a not-decidable trend in words, not codes', () => {
    const i = input();
    i.trend = { ...i.trend, decidable: false, reasons: ['too_few_readings'], readingsNeeded: 1 };
    const result = reviewDecision(i);
    expect(result.explanation).toContain('1 more weigh-in');
    expect(result.explanation).not.toContain('too_few_readings');
  });
});

describe('review guardrails', () => {
  it.each([0, 1, 3, 7])('caps surplus using the actual %s training days', (t) => {
    const i = input();
    i.trainingDaysPerWeek = t;
    i.maintenanceKcal = 2040;
    i.targets = { training: day(2240), rest: day(2240) };
    trend(i, [-0.02, 0.05]);
    const result = reviewDecision(i);
    if (t === 0 || t === 7) {
      // One day type only, already at the ceiling: nothing left to add.
      expect(result).toMatchObject({ action: 'hold', reason: 'at_limit' });
      return;
    }
    expect(result.action).toBe('change');
    if (result.action !== 'change') throw new Error('Expected a capped proposal');
    expect(average(result.targets, t)).toBeLessThanOrEqual(i.maintenanceKcal * 1.1);
    expect(result.capped).toBe(t !== 0);
    expect(result.deltaKcal.rest).toBe(0);
    if (t > 0) expect(result.explanation).toContain('capped');
  });

  it('caps cut reductions at the default and custom daily floors', () => {
    const i = input('cut');
    i.targets.rest = day(2050);
    trend(i, [-0.1, 0.1]);
    expect(expectChange(i, 'cut_too_slow', 0, -50).capped).toBe(true);
    i.kcalFloorPerDay = 2023;
    expect(expectChange(i, 'cut_too_slow', 0, -25).capped).toBe(true);
  });

  it('does not remove more carbs than available', () => {
    const i = input();
    trend(i, [0.3, 0.4]);
    i.targets.rest = { kcal: 1290, proteinG: 160, fatG: 70, carbsG: 5, fibreG: 20 };
    const result = expectChange(i, 'surplus_too_fast', 0, -20);
    expect(result.targets.rest.carbsG).toBe(0);
    expect(result.capped).toBe(true);
  });

  it('leaves caller inputs unchanged and gives deterministic results', () => {
    const i = input();
    trend(i, [0, 0.05]);
    expect(reviewDecision(i)).toEqual(reviewDecision(i));
  });

  it.each([-1, 8, 2.5])('rejects invalid training-day count %s', (t) => {
    expect(() =>
      phaseTargets({
        phase: 'maintenance',
        maintenanceKcal: 2000,
        bodyweightKg: 80,
        trainingDaysPerWeek: t,
      }),
    ).toThrow(RangeError);
    const i = input();
    i.trainingDaysPerWeek = t;
    expect(() => reviewDecision(i)).toThrow(RangeError);
  });
});
