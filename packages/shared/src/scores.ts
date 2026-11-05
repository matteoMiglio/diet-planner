import type { DayTargets, PhaseType } from './engine.js';
import type { Per100, Slot } from './plan.js';
import type { Role } from './rules.js';

export interface NutriInput {
  kcal: number;
  sugarsG: number | null;
  satFatG: number | null;
  saltG: number | null;
  fibreG: number | null;
  proteinG: number;
  fruitVegPct?: number | null;
  /**
   * The 2023 algorithm's food-specific exceptions: cheese always counts protein; red meat
   * counts at most 2 protein points. Default: a general food.
   */
  category?: NutriCategory;
}

export type NutriCategory = 'general' | 'cheese' | 'red_meat';

export interface NutriResult {
  points: number;
  grade: 'a' | 'b' | 'c' | 'd' | 'e';
  /** False when sugars, saturated fat or salt were missing and treated as zero. */
  complete: boolean;
}

// Santé publique France, 2022 solid-food update (2023 algorithm), general foods.
// Tables 1–2, reproduced in the French implementing order:
// https://www.legifrance.gouv.fr/loda/id/JORFTEXT000051329233/2025-04-01
// Each threshold must be strictly exceeded to earn its point.
const ENERGY_KJ_THRESHOLDS = [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350];
const SUGARS_G_THRESHOLDS = [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51];
const SAT_FAT_G_THRESHOLDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SALT_G_THRESHOLDS = [
  0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4,
];
const FIBRE_G_THRESHOLDS = [3, 4.1, 5.2, 6.3, 7.4];
const PROTEIN_G_THRESHOLDS = [2.4, 4.8, 7.2, 9.6, 12, 14, 17];
const FRUIT_VEG_PCT_THRESHOLDS = [40, 60, 80, 80, 80];

function thresholdPoints(value: number, thresholds: readonly number[]): number {
  return thresholds.filter((threshold) => value > threshold).length;
}

function proteinPoints(n: NutriInput, negative = negativePoints(n)): number {
  const points = thresholdPoints(n.proteinG, PROTEIN_G_THRESHOLDS);
  if (n.category === 'red_meat') return Math.min(points, 2);
  if (n.category === 'cheese') return points;
  return negative < 11 ? points : 0;
}

function negativePoints(n: NutriInput): number {
  return (
    thresholdPoints(n.kcal * 4.184, ENERGY_KJ_THRESHOLDS) +
    thresholdPoints(n.sugarsG ?? 0, SUGARS_G_THRESHOLDS) +
    thresholdPoints(n.satFatG ?? 0, SAT_FAT_G_THRESHOLDS) +
    thresholdPoints(n.saltG ?? 0, SALT_G_THRESHOLDS)
  );
}

export function nutriScore(n: NutriInput): NutriResult {
  const negative = negativePoints(n);
  const positive =
    thresholdPoints(n.fibreG ?? 0, FIBRE_G_THRESHOLDS) +
    thresholdPoints(n.fruitVegPct ?? 0, FRUIT_VEG_PCT_THRESHOLDS) +
    proteinPoints(n, negative);
  const points = negative - positive;
  const grade =
    points <= 0 ? 'a' : points <= 2 ? 'b' : points <= 10 ? 'c' : points <= 18 ? 'd' : 'e';
  return {
    points,
    grade,
    complete: n.sugarsG !== null && n.satFatG !== null && n.saltG !== null,
  };
}

export interface QualityInput {
  nutriscoreGrade: string | null;
  computed: NutriResult | null;
  novaGroup: number | null;
  additives: string[] | null;
}

export interface ScorePart {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  detail: string;
}

export interface QualityScore {
  score: number | null;
  band: 'good' | 'ok' | 'poor' | 'avoid' | null;
  partial: boolean;
  parts: ScorePart[];
}

const GRADE_VALUES = { a: 100, b: 75, c: 50, d: 25, e: 0 } as const;
const NOVA_VALUES: Readonly<Record<number, number>> = { 1: 100, 2: 75, 3: 50, 4: 15 };

function isGrade(grade: string | null): grade is NutriResult['grade'] {
  return grade === 'a' || grade === 'b' || grade === 'c' || grade === 'd' || grade === 'e';
}

/** Keep nominal weights in the parts; only the aggregate renormalises missing values. */
function weightedScore(parts: ScorePart[]): number | null {
  let total = 0;
  let weight = 0;
  for (const part of parts) {
    if (part.value !== null) {
      total += part.value * part.weight;
      weight += part.weight;
    }
  }
  return weight === 0 ? null : Math.round(total / weight);
}

export function qualityScore(q: QualityInput): QualityScore {
  const off = isGrade(q.nutriscoreGrade);
  // A computed grade missing sugars, saturated fat or salt would read optimistically (they
  // count as zero), so it isn't used: the nutrition part is then unavailable.
  const computedUsable = q.computed?.complete ? q.computed.grade : null;
  const grade = isGrade(q.nutriscoreGrade) ? q.nutriscoreGrade : computedUsable;
  const nova = q.novaGroup === null ? null : (NOVA_VALUES[q.novaGroup] ?? null);
  const parts: ScorePart[] = [
    {
      key: 'nutrition',
      label: 'Nutritional quality',
      weight: 60,
      value: grade === null ? null : GRADE_VALUES[grade],
      detail:
        grade === null
          ? q.computed && !q.computed.complete
            ? 'Not enough data: sugars, saturated fat or salt are missing.'
            : 'Nutri-Score unavailable.'
          : `${off ? 'Open Food Facts' : 'Computed'} Nutri-Score: ${grade.toUpperCase()}.`,
    },
    {
      key: 'processing',
      label: 'Processing',
      weight: 25,
      value: nova,
      detail: nova === null ? 'NOVA unavailable.' : `NOVA group ${q.novaGroup}.`,
    },
    {
      key: 'additives',
      label: 'Additives',
      weight: 15,
      value: q.additives === null ? null : Math.max(0, 100 - 15 * q.additives.length),
      detail: q.additives === null ? 'Additives unknown.' : `${q.additives.length} additives.`,
    },
  ];
  const score = weightedScore(parts);
  const partial = parts.filter((part) => part.value !== null).length < 2;
  const band =
    partial || score === null
      ? null
      : score >= 75
        ? 'good'
        : score >= 50
          ? 'ok'
          : score >= 25
            ? 'poor'
            : 'avoid';
  return { score, band, partial, parts };
}

export interface FitInput {
  per100: Pick<Per100, 'kcal' | 'proteinG' | 'carbsG' | 'fatG'>;
  portionG: number;
  role: Role | null;
  phase: PhaseType | null;
  remaining: Pick<DayTargets, 'kcal' | 'fatG'> | null;
  slot: Slot | null;
  slotRoles: Role[];
  ruleConflicts: string[];
}

export interface FitScore {
  score: number;
  parts: ScorePart[];
  reasons: string[];
}

const CUT_WEIGHTS = [40, 30, 0, 15, 15] as const;
const MAINTENANCE_WEIGHTS = [30, 30, 10, 15, 15] as const;
const SURPLUS_WEIGHTS = [20, 15, 35, 15, 15] as const;
const clamp100 = (value: number): number => Math.max(0, Math.min(100, value));

/** Full credit through the limit, then linear decay to zero at twice the limit. */
function budgetFit(amount: number, remaining: number): number {
  if (amount <= remaining) return 100;
  if (remaining <= 0) return 0;
  return clamp100((2 - amount / remaining) * 100);
}

export function fitScore(f: FitInput): FitScore {
  const weights =
    f.phase === 'cut' ? CUT_WEIGHTS : f.phase === 'surplus' ? SURPLUS_WEIGHTS : MAINTENANCE_WEIGHTS;
  const kcal = (f.per100.kcal * f.portionG) / 100;
  const fat = (f.per100.fatG * f.portionG) / 100;
  const density = f.per100.kcal > 0 ? (f.per100.proteinG / f.per100.kcal) * 100 : 0;
  const fits =
    f.remaining === null
      ? null
      : Math.min(budgetFit(kcal, f.remaining.kcal), budgetFit(fat, f.remaining.fatG));
  // Equal credit for portion coverage and kcal/100 g (saturated at 400).
  const gap =
    f.remaining === null
      ? null
      : f.remaining.kcal > 0
        ? (clamp100((kcal / f.remaining.kcal) * 100) + clamp100(f.per100.kcal / 4)) / 2
        : 0;
  const slotFit =
    f.role === null || f.slotRoles.length === 0 ? 50 : f.slotRoles.includes(f.role) ? 100 : 20;
  const conflicts = f.ruleConflicts.length > 0;
  const parts: ScorePart[] = [
    {
      key: 'protein_density',
      label: 'Protein density',
      weight: weights[0],
      value: clamp100(density * 10),
      detail: `${Math.round(density)} g protein per 100 kcal.`,
    },
    {
      key: 'fits_today',
      label: 'Fits today',
      weight: weights[1],
      value: fits,
      detail:
        f.remaining === null
          ? "Today's budget is unknown."
          : `${Math.round(kcal)} kcal and ${Math.round(fat)} g fat against ${Math.round(f.remaining.kcal)} kcal and ${Math.round(f.remaining.fatG)} g fat left.`,
    },
    {
      key: 'closes_gap',
      label: 'Closes gap',
      weight: weights[2],
      value: gap,
      detail:
        f.remaining === null
          ? "Today's calorie gap is unknown."
          : `${Math.round(kcal)} kcal per portion; ${Math.round(f.per100.kcal)} kcal per 100 g.`,
    },
    {
      key: 'slot_fit',
      label: 'Slot fit',
      weight: weights[3],
      value: slotFit,
      detail:
        slotFit === 50
          ? 'No role preference available.'
          : slotFit === 100
            ? `Matches roles for ${f.slot ?? 'the next meal'}.`
            : `Does not match roles for ${f.slot ?? 'the next meal'}.`,
    },
    {
      key: 'no_conflicts',
      label: 'No rule conflicts',
      weight: weights[4],
      value: conflicts ? 0 : 100,
      detail: conflicts ? f.ruleConflicts.join('; ') : 'No rule conflicts.',
    },
  ];
  const reasons: string[] = [];
  if (conflicts) reasons.push(`Clashes with your rules: ${f.ruleConflicts.join('; ')}.`);
  if (f.remaining !== null) {
    if (kcal > f.remaining.kcal) {
      reasons.push(`Would go ${Math.round(kcal - f.remaining.kcal)} kcal over today's budget.`);
    }
    if (fat > f.remaining.fatG) {
      reasons.push(`Would go ${Math.round(fat - f.remaining.fatG)} g fat over today's budget.`);
    }
    if (fits === 100) {
      reasons.push(
        `Fits today's budget (${Math.round(kcal)} of ${Math.round(f.remaining.kcal)} kcal left).`,
      );
    }
  }
  if (density >= 10) reasons.push(`High protein: ${Math.round(density)} g per 100 kcal.`);
  if (gap !== null && gap >= 50 && weights[2] > 0) reasons.push("Helps close today's calorie gap.");
  if (slotFit === 20) reasons.push('Does not match the roles for this meal.');
  return { score: weightedScore(parts) ?? 0, parts, reasons: reasons.slice(0, 4) };
}
