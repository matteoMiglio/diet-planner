/**
 * The meal plan as one document: seven days, each with meals in slots, each meal with one
 * or more options (the first is the default), each option a list of foods in grams.
 *
 * Items carry a snapshot of the food's per-100 g values taken when the plan was saved, so a
 * later change to a food never rewrites a plan's history.
 */
import { z } from 'zod';

export const SLOTS = [
  'breakfast',
  'morning_snack',
  'lunch',
  'afternoon_snack',
  'dinner',
  'evening_snack',
] as const;
export type Slot = (typeof SLOTS)[number];

export const SLOT_LABEL: Record<Slot, string> = {
  breakfast: 'Breakfast',
  morning_snack: 'Morning snack',
  lunch: 'Lunch',
  afternoon_snack: 'Afternoon snack',
  dinner: 'Dinner',
  evening_snack: 'Evening snack',
};

export const Per100 = z.object({
  kcal: z.number().min(0).max(1000),
  proteinG: z.number().min(0).max(100),
  carbsG: z.number().min(0).max(100),
  fatG: z.number().min(0).max(100),
  fibreG: z.number().min(0).max(100).nullable(),
});
export type Per100 = z.infer<typeof Per100>;

export const PlanItem = z.object({
  foodId: z.uuid(),
  grams: z.number().positive().max(3000),
  /** How the amount is shown, e.g. 1 cup or 10 pcs; grams stay the source of truth. */
  display: z
    .object({ unit: z.string().min(1).max(30), qty: z.number().positive() })
    .nullable()
    .optional(),
  /** Filled in by the server on save. */
  snapshot: Per100.extend({ name: z.string() }).optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

export const PlanOption = z.object({
  label: z.string().trim().min(1).max(24),
  items: z.array(PlanItem).min(1).max(20),
});
export type PlanOption = z.infer<typeof PlanOption>;

export const PlanMeal = z.object({
  slot: z.enum(SLOTS),
  /** options[0] is the default; the others are swaps. */
  options: z.array(PlanOption).min(1).max(6),
  notes: z.string().max(500).nullable().optional(),
});
export type PlanMeal = z.infer<typeof PlanMeal>;

export const PlanDay = z.object({
  weekday: z.number().int().min(1).max(7),
  meals: z.array(PlanMeal).max(SLOTS.length),
});
export type PlanDay = z.infer<typeof PlanDay>;

export const PlanDocument = z
  .object({ days: z.array(PlanDay).length(7) })
  .superRefine((doc, ctx) => {
    const weekdays = doc.days.map((d) => d.weekday);
    if (new Set(weekdays).size !== 7) {
      ctx.addIssue({
        code: 'custom',
        message: 'Each weekday must appear exactly once.',
        path: ['days'],
      });
    }
    doc.days.forEach((day, i) => {
      const slots = day.meals.map((m) => m.slot);
      if (new Set(slots).size !== slots.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'A slot appears twice.',
          path: ['days', i, 'meals'],
        });
      }
    });
  });
export type PlanDocument = z.infer<typeof PlanDocument>;

export interface Macros {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
}

export const ZERO: Macros = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0 };

export function add(a: Macros, b: Macros): Macros {
  return {
    kcal: a.kcal + b.kcal,
    proteinG: a.proteinG + b.proteinG,
    carbsG: a.carbsG + b.carbsG,
    fatG: a.fatG + b.fatG,
    fibreG: a.fibreG + b.fibreG,
  };
}

export function itemMacros(per100: Per100, grams: number): Macros {
  const f = grams / 100;
  return {
    kcal: per100.kcal * f,
    proteinG: per100.proteinG * f,
    carbsG: per100.carbsG * f,
    fatG: per100.fatG * f,
    fibreG: (per100.fibreG ?? 0) * f,
  };
}

/** Totals of an option; items without a snapshot (not yet saved) need `lookup`. */
export function optionMacros(
  option: PlanOption,
  lookup?: (foodId: string) => Per100 | undefined,
): Macros {
  return option.items.reduce((sum, item) => {
    const per100 = item.snapshot ?? lookup?.(item.foodId);
    return per100 ? add(sum, itemMacros(per100, item.grams)) : sum;
  }, ZERO);
}

/** Day totals using each meal's default (first) option. */
export function dayMacros(day: PlanDay, lookup?: (foodId: string) => Per100 | undefined): Macros {
  return day.meals.reduce((sum, meal) => {
    const first = meal.options[0];
    return first ? add(sum, optionMacros(first, lookup)) : sum;
  }, ZERO);
}

export function emptyPlan(): PlanDocument {
  return { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, meals: [] })) };
}

export function roundMacros(m: Macros): Macros {
  return {
    kcal: Math.round(m.kcal),
    proteinG: Math.round(m.proteinG),
    carbsG: Math.round(m.carbsG),
    fatG: Math.round(m.fatG),
    fibreG: Math.round(m.fibreG),
  };
}
