import type { DayTargets, Targets } from './engine.js';
import { dayMacros, SLOTS } from './plan.js';
import type { Macros, Per100, PlanDocument } from './plan.js';
import type { PortionRule, Role, RuleSpec } from './rules.js';

export interface PlanFood {
  id: string;
  name: string;
  per100: Per100;
  units: Record<string, number>;
  role: Role;
  portion: PortionRule;
}

export interface PlanContext {
  foods: Map<string, PlanFood>;
  rules: RuleSpec[];
  targets: Targets;
  trainingWeekdays: number[];
  /**
   * Slots kept from the current plan (a fixed_slots rule). Their portions are not checked
   * against portion steps, since they weren't generated, but their macros and rules count.
   */
  lockedSlots?: string[];
  /** Slots every day must have (generated + fixed). Missing ones are errors. */
  requiredSlots?: string[];
  /**
   * Foods generated meals may use. Foods outside it (archived, out of the pool) may still
   * appear in locked slots. Omitted: every food in `foods` is allowed.
   */
  selectableFoodIds?: Set<string>;
  /** A hard per-day calorie floor (cuts: 2000 kcal), on top of the target tolerance. */
  kcalFloorPerDay?: number;
}

export type PlanErrorCode =
  | 'shape'
  | 'unknown_food'
  | 'portion_step'
  | 'fixed_unit'
  | 'rule'
  | 'kcal'
  | 'protein_low'
  | 'protein_high'
  | 'fat'
  | 'carbs'
  | 'variety';

export interface PlanError {
  weekday: number | null;
  slot: string | null;
  code: PlanErrorCode;
  message: string;
}

export interface DayCheck {
  weekday: number;
  dayType: 'training' | 'rest';
  totals: Macros;
  target: DayTargets;
  macroErrors: PlanError[];
  otherErrors: PlanError[];
}

export interface ValidationResult {
  ok: boolean;
  errors: PlanError[];
  warnings: PlanError[];
  days: DayCheck[];
}

export const TOLERANCES = {
  kcalPct: 0.03,
  proteinBelowG: 5,
  proteinAboveG: 25,
  fatG: 10,
  carbsPct: 0.08,
};

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const label = (weekday: number): string => weekdays[weekday - 1] ?? `Weekday ${weekday}`;
const number = (value: number): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: 3 });

export function validatePlan(doc: PlanDocument, ctx: PlanContext): ValidationResult {
  const errors: PlanError[] = [];
  const warnings: PlanError[] = [];
  const days: DayCheck[] = [];
  const names = (ids: string[]): string =>
    ids.map((id) => ctx.foods.get(id)?.name ?? id).join(', ');
  const globalShape = (message: string): void => {
    errors.push({ weekday: null, slot: null, code: 'shape', message });
  };
  if (doc.days.length !== 7) globalShape(`Plan has ${doc.days.length} days; provide exactly 7.`);
  for (let weekday = 1; weekday <= 7; weekday++) {
    const count = doc.days.filter((day) => day.weekday === weekday).length;
    if (count !== 1)
      globalShape(`${label(weekday)} appears ${count} times; provide it exactly once.`);
  }

  const pairs = new Map<string, DayCheck[]>();
  for (const day of doc.days) {
    const dayType = ctx.trainingWeekdays.includes(day.weekday) ? 'training' : 'rest';
    const target = ctx.targets[dayType];
    const check: DayCheck = {
      weekday: day.weekday,
      dayType,
      totals: dayMacros(day, (id) => ctx.foods.get(id)?.per100),
      target,
      macroErrors: [],
      otherErrors: [],
    };
    days.push(check);
    const add = (code: PlanErrorCode, slot: string | null, message: string): void => {
      const error = { weekday: day.weekday, slot, code, message };
      check.otherErrors.push(error);
      errors.push(error);
    };
    if (!Number.isInteger(day.weekday) || day.weekday < 1 || day.weekday > 7) {
      add('shape', null, `${label(day.weekday)}: use an ISO weekday from 1 to 7.`);
    }
    const entries = day.meals.flatMap((meal) =>
      meal.options.flatMap((option, optionIndex) =>
        option.items.map((item) => ({ item, slot: meal.slot, optionIndex })),
      ),
    );
    const defaults = entries.filter((entry) => entry.optionIndex === 0);
    const seenSlots = new Set<string>();
    for (const meal of day.meals) {
      const prefix = `${label(day.weekday)} ${meal.slot}`;
      if (!SLOTS.includes(meal.slot) || seenSlots.has(meal.slot)) {
        add('shape', meal.slot, `${prefix}: use a valid slot exactly once per day.`);
      }
      seenSlots.add(meal.slot);
      if (meal.options.length === 0) {
        add('shape', meal.slot, `${prefix}: provide at least one option.`);
      }
      meal.options.forEach((option, index) => {
        if (option.items.length === 0) {
          add('shape', meal.slot, `${prefix} option ${index + 1}: provide at least one item.`);
        }
      });
    }
    for (const slot of ctx.requiredSlots ?? []) {
      if (!day.meals.some((m) => m.slot === slot)) {
        add(
          'shape',
          slot,
          `${label(day.weekday)}: the ${slot.replace('_', ' ')} is missing; add it.`,
        );
      }
    }
    for (const { item, slot } of entries) {
      const food = ctx.foods.get(item.foodId);
      const prefix = `${label(day.weekday)} ${slot}: ${food?.name ?? item.foodId}`;
      if (!Number.isFinite(item.grams) || item.grams <= 0 || item.grams > 3000) {
        add('shape', slot, `${prefix} has ${item.grams} g; use a positive amount up to 3,000 g.`);
      }
      if (!food) {
        add('unknown_food', slot, `${prefix}: unknown food; select a food from the active pool.`);
        continue;
      }
      if (ctx.lockedSlots?.includes(slot)) continue;
      if (ctx.selectableFoodIds && !ctx.selectableFoodIds.has(item.foodId)) {
        add('unknown_food', slot, `${prefix} is not in the planning pool; use a pool food.`);
        continue;
      }
      // A fixed_portion rule sets the amount itself (e.g. the 190 g chicken slice).
      if (
        ctx.rules.some(
          (r) => r.kind === 'fixed_portion' && r.slot === slot && r.foodIds.includes(item.foodId),
        )
      ) {
        continue;
      }
      const portion = food.portion;
      const step = portion.kind === 'flexible' ? portion.stepG : food.units[portion.unit];
      if (step === undefined || !Number.isFinite(step) || step <= 0) {
        errors.push({
          weekday: day.weekday,
          slot,
          code: 'fixed_unit',
          message: `${prefix}: unit ${portion.kind === 'fixed_unit' ? portion.unit : 'step'} has no valid gram weight; add it to check whole units.`,
        });
      } else if (Math.abs(item.grams - Math.round(item.grams / step) * step) > 1e-6) {
        add(
          portion.kind === 'flexible' ? 'portion_step' : 'fixed_unit',
          slot,
          `${prefix} ${number(item.grams)} g must be a whole multiple of ${number(step)} g${portion.kind === 'fixed_unit' ? ` per ${portion.unit}` : ' steps'}.`,
        );
      }
    }

    for (const rule of ctx.rules) {
      if (rule.kind === 'fixed_slots' || rule.kind === 'guidance') continue;
      if (rule.kind === 'no_repeat_role_lunch_dinner') {
        for (const role of rule.roles) {
          const lunch = new Set(
            defaults
              .filter((e) => e.slot === 'lunch' && ctx.foods.get(e.item.foodId)?.role === role)
              .map((e) => e.item.foodId),
          );
          const repeated = new Set(
            defaults
              .filter((e) => e.slot === 'dinner' && lunch.has(e.item.foodId))
              .map((e) => e.item.foodId),
          );
          for (const id of repeated)
            add(
              'rule',
              'dinner',
              `${label(day.weekday)} lunch/dinner: ${names([id])} repeats role ${role}; choose a different food at dinner.`,
            );
        }
        continue;
      }
      const matching = entries.filter((e) => rule.foodIds.includes(e.item.foodId));
      if (rule.kind === 'max_items_per_day') {
        // Counts units: a whole-unit food counts its units (450 g of a 150 g cup is 3),
        // any other food counts once per item.
        const count = matching
          .filter((e) => e.optionIndex === 0)
          .reduce((sum, e) => {
            const food = ctx.foods.get(e.item.foodId);
            const unitG =
              food?.portion.kind === 'fixed_unit' ? food.units[food.portion.unit] : undefined;
            return sum + (unitG ? Math.round(e.item.grams / unitG) : 1);
          }, 0);
        if (count > rule.max)
          add(
            'rule',
            null,
            `${label(day.weekday)} default meals: ${count} units of ${names(rule.foodIds)}; use at most ${rule.max}.`,
          );
      } else if (rule.kind === 'not_same_day') {
        // Options of one meal are alternatives: two listed foods only clash when they could
        // both be eaten, i.e. they sit in different meals or in the same option.
        const clash = matching.some((a) =>
          matching.some(
            (b) =>
              a.item.foodId !== b.item.foodId &&
              (a.slot !== b.slot || a.optionIndex === b.optionIndex),
          ),
        );
        if (clash) {
          const distinct = [...new Set(matching.map((e) => e.item.foodId))];
          add(
            'rule',
            null,
            `${label(day.weekday)}: ${names(distinct)} could both be eaten on the same day; use only one of them per day (alternatives in the same meal are fine).`,
          );
        }
      } else {
        for (const { item, slot } of matching) {
          const prefix = `${label(day.weekday)} ${slot}: ${names([item.foodId])}`;
          switch (rule.kind) {
            case 'exclude_food':
              add('rule', slot, `${prefix} is excluded; replace it with an allowed food.`);
              break;
            case 'forbidden_on_day_type':
              if (dayType === rule.dayType)
                add('rule', slot, `${prefix} is forbidden on ${dayType} days; replace it.`);
              break;
            case 'allowed_weekdays':
              if (!rule.weekdays.includes(day.weekday))
                add(
                  'rule',
                  slot,
                  `${prefix} is only allowed on ${rule.weekdays.map(label).join(', ')}; replace it on ${label(day.weekday)}.`,
                );
              break;
            case 'min_portion':
              if (item.grams < rule.minG)
                add(
                  'rule',
                  slot,
                  `${prefix} ${number(item.grams)} g is below the ${number(rule.minG)} g minimum; ${rule.fallbackFoodIds.length ? `use ${names(rule.fallbackFoodIds)} instead` : 'increase the portion'}.`,
                );
              break;
            case 'fixed_portion':
              if (slot === rule.slot && item.grams !== rule.grams)
                add(
                  'rule',
                  slot,
                  `${prefix} ${number(item.grams)} g must be exactly ${number(rule.grams)} g.`,
                );
              break;
          }
        }
      }
    }

    const macro = (code: PlanErrorCode, message: string): void => {
      const error = {
        weekday: day.weekday,
        slot: null,
        code,
        message: `${label(day.weekday)}: ${message}`,
      };
      check.macroErrors.push(error);
      errors.push(error);
    };
    const range = (
      key: 'kcal' | 'fatG' | 'carbsG',
      tolerance: number,
      code: PlanErrorCode,
      unit: string,
      description: string,
    ): void => {
      const value = check.totals[key];
      const low = target[key] - tolerance;
      const high = target[key] + tolerance;
      if (value < low - 1e-9 || value > high + 1e-9)
        macro(
          code,
          `${number(value)} ${unit} vs target ${number(target[key])} (${description}: ${number(low)}–${number(high)}); adjust portions.`,
        );
    };
    range('kcal', target.kcal * TOLERANCES.kcalPct, 'kcal', 'kcal', '±3%');
    if (ctx.kcalFloorPerDay !== undefined && check.totals.kcal < ctx.kcalFloorPerDay - 1e-9) {
      macro(
        'kcal',
        `${number(check.totals.kcal)} kcal is below the ${number(ctx.kcalFloorPerDay)} kcal daily floor; add food.`,
      );
    }
    range('fatG', TOLERANCES.fatG, 'fat', 'g fat', '±10 g');
    range('carbsG', target.carbsG * TOLERANCES.carbsPct, 'carbs', 'g carbs', '±8%');
    for (const [code, bound, fails, instruction] of [
      [
        'protein_low',
        target.proteinG - TOLERANCES.proteinBelowG,
        check.totals.proteinG < target.proteinG - TOLERANCES.proteinBelowG - 1e-9,
        'increase',
      ],
      [
        'protein_high',
        target.proteinG + TOLERANCES.proteinAboveG,
        check.totals.proteinG > target.proteinG + TOLERANCES.proteinAboveG + 1e-9,
        'reduce',
      ],
    ] as const) {
      if (fails)
        macro(
          code,
          `${number(check.totals.proteinG)} g protein vs target ${number(target.proteinG)} (${code === 'protein_low' ? 'minimum' : 'maximum'} ${number(bound)} g); ${instruction} protein portions.`,
        );
    }
    if (check.totals.fibreG < target.fibreG)
      warnings.push({
        weekday: day.weekday,
        slot: null,
        code: 'rule',
        message: `${label(day.weekday)}: ${number(check.totals.fibreG)} g fibre is below target ${number(target.fibreG)} g; add fibre-rich foods.`,
      });

    const proteinIds = (slot: string): string[] =>
      [
        ...new Set(
          defaults
            .filter((e) => e.slot === slot && ctx.foods.get(e.item.foodId)?.role === 'main_protein')
            .map((e) => e.item.foodId),
        ),
      ].sort();
    const lunch = proteinIds('lunch');
    const dinner = proteinIds('dinner');
    if (lunch.length || dinner.length) {
      // Canonicalise both food order and meal order: swapping lunch/dinner is the same pair.
      const key = JSON.stringify(
        [lunch, dinner].sort((a, b) => {
          const left = JSON.stringify(a);
          const right = JSON.stringify(b);
          return left < right ? -1 : left > right ? 1 : 0;
        }),
      );
      const group = pairs.get(key) ?? [];
      group.push(check);
      pairs.set(key, group);
    }
  }
  for (const [key, group] of pairs) {
    if (group.length <= 2) continue;
    const [lunch, dinner] = JSON.parse(key) as [string[], string[]];
    for (const check of group) {
      const error: PlanError = {
        weekday: check.weekday,
        slot: null,
        code: 'variety',
        message: `${label(check.weekday)} lunch/dinner: ${names(lunch) || '(no main protein)'} / ${names(dinner) || '(no main protein)'} repeats on ${group.length} days; use this pair at most 2 days.`,
      };
      check.otherErrors.push(error);
      errors.push(error);
    }
  }
  return { ok: errors.length === 0, errors, warnings, days };
}
