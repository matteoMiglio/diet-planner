import type { DayTargets } from './engine.js';
import { dayMacros } from './plan.js';
import type { Macros, PlanDocument, PlanItem } from './plan.js';
import { TOLERANCES, validatePlan } from './validate.js';
import type { PlanContext, PlanFood } from './validate.js';

export interface SolverChange {
  weekday: number;
  slot: string;
  foodId: string;
  foodName: string;
  fromG: number;
  toG: number;
}

export interface SolveResult {
  doc: PlanDocument;
  changes: SolverChange[];
  fixedDays: number[];
  unfixedDays: number[];
}

interface Variable {
  item: PlanItem;
  food: PlanFood;
  slot: string;
  original: number;
  step: number;
  min: number;
  max: number;
}

function penalty(totals: Macros, target: DayTargets, variables: Variable[]): number {
  const beyond = (value: number, centre: number, tolerance: number): number =>
    Math.max(0, Math.abs(value - centre) - tolerance);
  const violation =
    Math.max(0, target.proteinG - TOLERANCES.proteinBelowG - totals.proteinG) +
    Math.max(0, totals.proteinG - target.proteinG - TOLERANCES.proteinAboveG) +
    beyond(totals.fatG, target.fatG, TOLERANCES.fatG) +
    beyond(totals.kcal, target.kcal, target.kcal * TOLERANCES.kcalPct) +
    beyond(totals.carbsG, target.carbsG, target.carbsG * TOLERANCES.carbsPct);
  const deviation =
    ((totals.kcal - target.kcal) / Math.max(1, target.kcal)) ** 2 +
    ((totals.carbsG - target.carbsG) / Math.max(1, target.carbsG)) ** 2;
  return (
    1e6 * violation + deviation + 1e-8 * variables.filter((v) => v.item.grams !== v.original).length
  );
}

const priority = (food: PlanFood): number => {
  if (food.role === 'main_carb') return 0;
  if (food.role === 'main_protein' || food.role === 'dairy_protein') return 1;
  return food.role === 'fat' ? 3 : 2;
};

/** Greedy, bounded integer-step search; commit only days that fully pass validation. */
export function solvePortions(
  doc: PlanDocument,
  ctx: PlanContext,
  opts?: { lockedSlots?: string[]; maxRelChange?: number; maxIterations?: number },
): SolveResult {
  const result: SolveResult = {
    doc: structuredClone(doc),
    changes: [],
    fixedDays: [],
    unfixedDays: [],
  };
  const initial = validatePlan(doc, ctx);
  const maxRelChange = Math.max(0, opts?.maxRelChange ?? 0.3);
  const maxIterations = Math.max(0, Math.floor(opts?.maxIterations ?? 400));
  const locked = new Set(opts?.lockedSlots ?? []);
  const globalErrors = initial.errors.some((error) => error.weekday === null);
  for (const [index, check] of initial.days.entries()) {
    if (!check.macroErrors.length && !check.otherErrors.length) continue;
    const day = result.doc.days[index];
    if (!day) continue;
    if (globalErrors || check.otherErrors.length || !check.macroErrors.length) {
      result.unfixedDays.push(day.weekday);
      continue;
    }
    const originalDay = structuredClone(day);
    const variables: Variable[] = [];
    for (const meal of day.meals) {
      if (locked.has(meal.slot)) continue;
      for (const item of meal.options[0]?.items ?? []) {
        const food = ctx.foods.get(item.foodId);
        if (!food || food.portion.kind !== 'flexible') continue;
        if (
          ctx.rules.some(
            (rule) =>
              rule.kind === 'fixed_portion' &&
              rule.slot === meal.slot &&
              rule.foodIds.includes(item.foodId),
          )
        )
          continue;
        const minimum = ctx.rules.reduce(
          (min, rule) =>
            rule.kind === 'min_portion' && rule.foodIds.includes(item.foodId)
              ? Math.max(min, rule.minG)
              : min,
          0,
        );
        const step = food.portion.stepG;
        variables.push({
          item,
          food,
          slot: meal.slot,
          original: item.grams,
          step,
          min: Math.max(
            step,
            Math.ceil((Math.max(minimum, item.grams * (1 - maxRelChange)) - 1e-9) / step) * step,
          ),
          max: Math.floor((Math.min(3000, item.grams * (1 + maxRelChange)) + 1e-9) / step) * step,
        });
      }
    }
    variables.sort((a, b) => priority(a.food) - priority(b.food));
    const score = (): number =>
      penalty(
        dayMacros(day, (id) => ctx.foods.get(id)?.per100),
        check.target,
        variables,
      );
    let current = score();
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let best = current;
      let move: { variable: Variable; grams: number } | undefined;
      for (const variable of variables) {
        const from = variable.item.grams;
        for (const direction of [-1, 1]) {
          const grams = Math.round(from / variable.step + direction) * variable.step;
          if (grams < variable.min - 1e-9 || grams > variable.max + 1e-9) continue;
          variable.item.grams = grams;
          const candidate = score();
          variable.item.grams = from;
          if (candidate < best - 1e-12) {
            best = candidate;
            move = { variable, grams };
          }
        }
      }
      if (!move) break;
      move.variable.item.grams = move.grams;
      current = best;
    }
    const verified = validatePlan(result.doc, ctx);
    const dayErrors = verified.days[index];
    const newRuleErrors = verified.errors.some(
      (error) =>
        error.code === 'rule' &&
        !initial.errors.some(
          (old) =>
            old.code === 'rule' &&
            old.weekday === error.weekday &&
            old.slot === error.slot &&
            old.message === error.message,
        ),
    );
    if (
      !dayErrors ||
      dayErrors.macroErrors.length ||
      dayErrors.otherErrors.length ||
      newRuleErrors
    ) {
      result.doc.days[index] = originalDay;
      result.unfixedDays.push(day.weekday);
      continue;
    }
    result.fixedDays.push(day.weekday);
    for (const variable of variables) {
      if (variable.item.grams === variable.original) continue;
      result.changes.push({
        weekday: day.weekday,
        slot: variable.slot,
        foodId: variable.food.id,
        foodName: variable.food.name,
        fromG: variable.original,
        toG: variable.item.grams,
      });
    }
  }
  return result;
}
