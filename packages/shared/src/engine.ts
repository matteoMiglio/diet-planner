import type { TrendResult } from './trend.js';

export type PhaseType = 'cut' | 'maintenance' | 'surplus' | 'maingain' | 'recomp';

export interface DayTargets {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  fibreG: number;
}

export interface Targets {
  training: DayTargets;
  rest: DayTargets;
}

/** A larger surplus buys speed at a poor exchange rate (spec §6.3); it is also the review ceiling. */
export const MAX_SURPLUS_PCT = 0.1;

const roundKcal = (value: number): number => Math.round(value / 5) * 5;
const fibre = (carbsG: number): number => Math.round(Math.max(20, carbsG * 0.1));
const weeklyAverage = (targets: Targets, trainingDays: number): number =>
  (targets.training.kcal * trainingDays + targets.rest.kcal * (7 - trainingDays)) / 7;

function checkTrainingDays(days: number): void {
  if (!Number.isInteger(days) || days < 0 || days > 7) {
    throw new RangeError('trainingDaysPerWeek must be an integer from 0 to 7.');
  }
}

export function mifflinStJeor(i: {
  sex: 'male' | 'female';
  weightKg: number;
  heightCm: number;
  ageYears: number;
}): number {
  return 10 * i.weightKg + 6.25 * i.heightCm - 5 * i.ageYears + (i.sex === 'male' ? 5 : -161);
}

export function katchMcArdle(i: { weightKg: number; bodyFatPct: number }): number {
  return 370 + 21.6 * i.weightKg * (1 - i.bodyFatPct / 100);
}

export interface AdaptiveInput {
  previousKcal: number;
  meanIntakeKcal: number;
  slopeKgPerWeek: number;
  energyDensityLoss?: number;
  energyDensityGain?: number;
  maxStepKcal?: number;
}

export function adaptiveMaintenance(i: AdaptiveInput): {
  kcal: number;
  observedTdee: number;
  clamped: boolean;
} {
  const density =
    i.slopeKgPerWeek < 0 ? (i.energyDensityLoss ?? 7700) : (i.energyDensityGain ?? 5500);
  const observedTdee = i.meanIntakeKcal - (i.slopeKgPerWeek * density) / 7;
  const estimate = 0.6 * i.previousKcal + 0.4 * observedTdee;
  const step = Math.max(0, i.maxStepKcal ?? 150);
  const bounded = Math.max(i.previousKcal - step, Math.min(i.previousKcal + step, estimate));
  return { kcal: roundKcal(bounded), observedTdee, clamped: bounded !== estimate };
}

export interface PhaseTargetsInput {
  phase: PhaseType;
  maintenanceKcal: number;
  bodyweightKg: number;
  trainingDaysPerWeek: number;
  surplusPct?: number;
  deficitRatePctPerWeek?: number;
  carbCycleKcal?: number;
  kcalFloorPerDay?: number;
}

export interface PhaseTargetsResult {
  targets: Targets;
  /** False when protein and fat alone exceed a day's calories: the targets can't be met. */
  feasible: boolean;
  averageKcal: number;
  floorBinds: boolean;
  achievableRatePctPerWeek: number | null;
  notes: string[];
}

export function phaseTargets(i: PhaseTargetsInput): PhaseTargetsResult {
  checkTrainingDays(i.trainingDaysPerWeek);
  const notes: string[] = [];
  let average = i.maintenanceKcal;
  if (i.phase === 'surplus') {
    const requested = i.surplusPct ?? 0.1;
    const pct = Math.min(Math.max(requested, 0), MAX_SURPLUS_PCT);
    if (pct !== requested)
      notes.push(`Surplus capped at ${MAX_SURPLUS_PCT * 100}% of maintenance.`);
    average *= 1 + pct;
  }
  if (i.phase === 'cut') {
    average -= ((i.deficitRatePctPerWeek ?? 0.005) * i.bodyweightKg * 7700) / 7;
  }
  const delta = i.carbCycleKcal ?? 120;
  let training = average + (delta * (7 - i.trainingDaysPerWeek)) / 7;
  let rest = average - (delta * i.trainingDaysPerWeek) / 7;
  if (i.phase === 'recomp') {
    training = i.maintenanceKcal + 150;
    rest = i.maintenanceKcal - 150;
  }
  const floor = i.kcalFloorPerDay ?? 2000;
  const floorBinds = i.phase === 'cut' && (training < floor || rest < floor);
  if (i.phase === 'cut') {
    // Round the floor upwards so non-multiples of five remain a hard minimum.
    const roundedFloor = Math.ceil(floor / 5) * 5;
    training = Math.max(roundedFloor, roundKcal(training));
    rest = Math.max(roundedFloor, roundKcal(rest));
  } else {
    training = roundKcal(training);
    rest = roundKcal(rest);
  }
  const averageKcal = (training * i.trainingDaysPerWeek + rest * (7 - i.trainingDaysPerWeek)) / 7;
  const proteinPerKg: Record<PhaseType, number> = {
    cut: 2,
    surplus: 1.9,
    maintenance: 1.8,
    maingain: 1.8,
    recomp: 2.1,
  };
  const proteinG = Math.round(i.bodyweightKg * proteinPerKg[i.phase]);
  const minFatG = Math.ceil(i.bodyweightKg * 0.7);
  let fatG = Math.max(minFatG, Math.round(i.bodyweightKg * 0.85));
  if (i.phase === 'surplus') {
    const lower = Math.max(minFatG, Math.ceil((averageKcal * 0.2) / 9));
    const upper = Math.floor((averageKcal * 0.3) / 9);
    fatG = Math.max(lower, Math.min(upper, fatG));
    if (lower > upper) notes.push('The 0.7 g/kg fat minimum exceeds 30% of average calories.');
  }
  let feasible = true;
  const day = (kcal: number): DayTargets => {
    const remaining = (kcal - 4 * proteinG - 9 * fatG) / 4;
    if (remaining < 0) {
      feasible = false;
      notes.push(
        `At ${kcal} kcal, protein and fat alone exceed the calories: check maintenance and bodyweight.`,
      );
    }
    const carbsG = Math.max(0, Math.round(remaining));
    return { kcal, proteinG, fatG, carbsG, fibreG: fibre(carbsG) };
  };
  const achievableRatePctPerWeek =
    i.phase === 'cut' ? ((i.maintenanceKcal - averageKcal) * 7) / (i.bodyweightKg * 7700) : null;
  if (floorBinds) {
    notes.push(
      `The ${floor} kcal floor limits the cut to ${((achievableRatePctPerWeek ?? 0) * 100).toFixed(2)}% of bodyweight per week.`,
    );
  }
  const result = { training: day(training), rest: day(rest) };
  return {
    targets: result,
    feasible,
    averageKcal,
    floorBinds,
    achievableRatePctPerWeek,
    notes,
  };
}

export interface ReviewCheckin {
  weekStart: string;
  adherence: 'on_plan' | 'mostly' | 'off' | null;
  trainingProgressed: 'yes' | 'no' | 'deload' | null;
  sleep: number | null;
  energy: number | null;
}

export interface ReviewInput {
  phase: {
    type: PhaseType;
    rateBandKgPerWeek?: [number, number] | null;
    targetWeightKg?: number | null;
    holdBandKg?: number;
    weeksInPhase: number;
  };
  targets: Targets;
  maintenanceKcal: number;
  bodyweightKg: number;
  trainingDaysPerWeek: number;
  trend: Pick<
    TrendResult,
    'decidable' | 'slopeKgPerWeek' | 'ci80' | 'interceptKg' | 'readingsNeeded'
  > & {
    reasons: string[];
  };
  recentSlopeKgPerWeek?: number | null;
  inGracePeriod: boolean;
  checkins: ReviewCheckin[];
  waistChangeCm: number | null;
  kcalFloorPerDay?: number;
}

export type HoldReason =
  | 'trend_not_decidable'
  | 'adherence_gate'
  | 'grace_period'
  | 'on_target'
  | 'training_not_progressed'
  | 'sleep_first'
  | 'at_limit';

export type ReviewOutcome =
  | { action: 'hold'; reason: HoldReason; explanation: string }
  | {
      action: 'change';
      rule: string;
      explanation: string;
      targets: Targets;
      deltaKcal: { training: number; rest: number };
      capped: boolean;
    }
  | { action: 'propose_diet_break'; explanation: string };

function hold(reason: HoldReason, explanation: string): ReviewOutcome {
  return { action: 'hold', reason, explanation };
}

/** Apply a proposal without mutating the supplied targets. All changed calories are carbs. */
function change(
  i: ReviewInput,
  rule: string,
  explanation: string,
  trainingDelta: number,
  restDelta: number,
): ReviewOutcome {
  // A change on a day type that never occurs would do nothing: move it to the other type.
  if (i.trainingDaysPerWeek === 0 && trainingDelta !== 0) {
    restDelta = restDelta || trainingDelta;
    trainingDelta = 0;
  }
  if (i.trainingDaysPerWeek === 7 && restDelta !== 0) {
    trainingDelta = trainingDelta || restDelta;
    restDelta = 0;
  }
  let capped = false;
  const floor = i.phase.type === 'cut' ? (i.kcalFloorPerDay ?? 2000) : -Infinity;
  // Removing more energy than the existing carbs supply would violate carbs-only semantics.
  const boundDay = (day: DayTargets, delta: number): number => {
    const minimum = Math.max(floor, day.kcal - 4 * day.carbsG);
    const bounded = Math.max(delta, Math.ceil((minimum - day.kcal) / 5) * 5);
    if (bounded !== delta) capped = true;
    return bounded;
  };
  trainingDelta = boundDay(i.targets.training, trainingDelta);
  restDelta = boundDay(i.targets.rest, restDelta);
  if (i.phase.type === 'surplus') {
    const currentAverage = weeklyAverage(i.targets, i.trainingDaysPerWeek);
    const proposedAverage =
      currentAverage +
      (trainingDelta * i.trainingDaysPerWeek + restDelta * (7 - i.trainingDaysPerWeek)) / 7;
    const limit = i.maintenanceKcal * (1 + MAX_SURPLUS_PCT);
    if (proposedAverage > limit) {
      capped = true;
      const increase = proposedAverage - currentAverage;
      if (increase > 0 && currentAverage <= limit) {
        const scale = Math.max(0, (limit - currentAverage) / increase);
        trainingDelta = Math.floor((trainingDelta * scale) / 5) * 5;
        restDelta = Math.floor((restDelta * scale) / 5) * 5;
      } else {
        // Also repair an already over-limit input; both day types share the reduction.
        const reduction = Math.ceil((proposedAverage - limit) / 5) * 5;
        trainingDelta -= reduction;
        restDelta -= reduction;
      }
    }
  }
  let carbsLimited = false;
  const apply = (day: DayTargets, delta: number): DayTargets => {
    const rawCarbs = day.carbsG + delta / 4;
    if (rawCarbs < 0) carbsLimited = true;
    const carbsG = Math.max(0, Math.round(rawCarbs));
    return { ...day, kcal: day.kcal + delta, carbsG, fibreG: fibre(carbsG) };
  };
  const targets = {
    training: apply(i.targets.training, trainingDelta),
    rest: apply(i.targets.rest, restDelta),
  };
  const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n)} kcal`;
  const parts = [
    trainingDelta !== 0 && `${signed(trainingDelta)} on training days`,
    restDelta !== 0 && `${signed(restDelta)} on rest days`,
  ].filter(Boolean);
  if (parts.length === 0) {
    return hold(
      'at_limit',
      `${explanation} No change: the calorie or carb limits leave no room to adjust.`,
    );
  }
  const actual = `Carbs: ${parts.join(' and ')}${capped ? ' (capped by the calorie or carb limit)' : ''}${carbsLimited ? ', with carbs limited to 0 g' : ''}.`;
  return {
    action: 'change',
    rule,
    explanation: `${explanation} ${actual}`,
    targets,
    deltaKcal: { training: trainingDelta, rest: restDelta },
    capped,
  };
}

export function reviewDecision(i: ReviewInput): ReviewOutcome {
  checkTrainingDays(i.trainingDaysPerWeek);
  const ci = i.trend.ci80;
  const slope = i.trend.slopeKgPerWeek;
  if (!i.trend.decidable || ci === null || slope === null) {
    const needs = i.trend.reasons.map((r) =>
      r === 'too_few_readings'
        ? `${i.trend.readingsNeeded} more weigh-in${i.trend.readingsNeeded === 1 ? '' : 's'}`
        : r === 'span_too_short'
          ? 'readings spread over at least 3 weeks'
          : r === 'latest_too_old'
            ? 'a weigh-in from the last 10 days'
            : r,
    );
    return hold(
      'trend_not_decidable',
      `No change: the weight trend isn't reliable yet. It needs ${needs.join(' and ') || 'more data'}.`,
    );
  }
  const latest = i.checkins[0];
  const previous = i.checkins[1];
  const adherent = (checkin: ReviewCheckin | undefined): boolean =>
    checkin?.adherence === 'on_plan' || checkin?.adherence === 'mostly';
  if (!adherent(latest) || !adherent(previous)) {
    return hold(
      'adherence_gate',
      'Need 2 recent check-ins with on-plan or mostly on-plan adherence.',
    );
  }
  if (i.inGracePeriod)
    return hold('grace_period', 'Wait until the water grace period ends before changing calories.');
  const low = (checkin: ReviewCheckin | undefined): boolean =>
    checkin !== undefined &&
    ((checkin.sleep !== null && checkin.sleep <= 2) ||
      (checkin.energy !== null && checkin.energy <= 2));
  const lowRecovery = low(latest) && low(previous);
  const trace = `Weight changes ${slope.toFixed(2)} kg/week (likely ${ci[0].toFixed(2)} to ${ci[1].toFixed(2)})`;
  switch (i.phase.type) {
    case 'surplus': {
      const lower = i.phase.rateBandKgPerWeek?.[0] ?? 0.1;
      const upper = i.phase.rateBandKgPerWeek?.[1] ?? 0.2;
      // "Too slow" needs the best estimate under the band and the plausible range clear of its
      // top. Requiring the whole range under the floor would almost never fire at 2 weigh-ins
      // a week (±0.13 kg/wk), and undershooting a surplus wastes the block.
      const tooSlow = slope < lower && ci[1] < upper;
      if (ci[0] > 0.25 || (i.waistChangeCm !== null && i.waistChangeCm > 1)) {
        return change(
          i,
          'surplus_too_fast',
          `${trace}; above 0.25 kg/week or waist increased ${i.waistChangeCm ?? 0} cm.`,
          0,
          -100,
        );
      }
      if (tooSlow && latest?.trainingProgressed === 'yes') {
        // Within 150 kcal of the ceiling, a half step (training days only) is the safer move.
        const trainingOnly =
          weeklyAverage(i.targets, i.trainingDaysPerWeek) >
          i.maintenanceKcal * (1 + MAX_SURPLUS_PCT) - 150;
        return change(
          i,
          'surplus_too_slow',
          `${trace}; below the ${lower.toFixed(2)} kg/week lower limit.`,
          150,
          trainingOnly ? 0 : 150,
        );
      }
      if (tooSlow) {
        const why =
          latest?.trainingProgressed === 'deload'
            ? 'it was a deload week, so wait for a normal training week before adding food'
            : latest?.trainingProgressed === 'no'
              ? 'training numbers did not go up, so fix the stimulus first; more food would only add fat'
              : 'answer "did your training numbers go up?" in the check-in first';
        return hold('training_not_progressed', `${trace}; below the lower limit, but ${why}.`);
      }
      if (lowRecovery)
        return hold(
          'sleep_first',
          'Sleep or energy was 2 or less in both check-ins; improve sleep and recovery first.',
        );
      break;
    }
    case 'cut': {
      // Same shape as the surplus: best estimate losing too slowly, range clear of too fast.
      if (slope > -0.005 * i.bodyweightKg && ci[0] > -0.01 * i.bodyweightKg) {
        return change(
          i,
          'cut_too_slow',
          `${trace}; losing less than ${(0.005 * i.bodyweightKg).toFixed(2)} kg/week.`,
          0,
          -100,
        );
      }
      if (ci[1] < -0.01 * i.bodyweightKg) {
        return change(
          i,
          'cut_too_fast',
          `${trace}; losing more than ${(0.01 * i.bodyweightKg).toFixed(2)} kg/week.`,
          150,
          0,
        );
      }
      if (lowRecovery)
        return change(
          i,
          'cut_low_recovery',
          'Sleep or energy was 2 or less in both check-ins.',
          100,
          0,
        );
      if (i.phase.weeksInPhase >= 12) {
        return {
          action: 'propose_diet_break',
          explanation: `After ${i.phase.weeksInPhase} weeks of cutting, consider 2 weeks at maintenance (${i.maintenanceKcal} kcal/day).`,
        };
      }
      break;
    }
    case 'maintenance':
    case 'maingain': {
      const target = i.phase.targetWeightKg;
      if (target === undefined || target === null) break;
      const band = i.phase.holdBandKg ?? 0.5;
      const projected = i.trend.interceptKg;
      const drift = i.recentSlopeKgPerWeek;
      if (projected === null) break;
      if (projected > target + band && drift !== null && drift !== undefined && drift > 0.5) {
        return change(
          i,
          'maintenance_drift_up',
          `Projected weight ${projected.toFixed(2)} kg is above ${(target + band).toFixed(2)} kg, with 14-day drift ${drift.toFixed(2)} kg/week.`,
          -100,
          -100,
        );
      }
      if (projected < target - band && drift !== null && drift !== undefined && drift < -0.3) {
        return change(
          i,
          'maintenance_drift_down',
          `Projected weight ${projected.toFixed(2)} kg is below ${(target - band).toFixed(2)} kg, with 14-day drift ${drift.toFixed(2)} kg/week.`,
          100,
          0,
        );
      }
      if (lowRecovery && Math.abs(projected - target) <= band) {
        return change(
          i,
          'maintenance_low_recovery',
          `Weight is inside ${(target - band).toFixed(1)}–${(target + band).toFixed(1)} kg, but recovery was low in both check-ins.`,
          100,
          0,
        );
      }
      break;
    }
    case 'recomp':
      break;
  }
  return hold('on_target', `${trace}; no adjustment threshold was crossed.`);
}
