import { describe, expect, it } from 'vitest';
import type { PlanDocument, PlanItem } from './plan.js';
import { solvePortions } from './solver.js';
import { validatePlan } from './validate.js';
import type { PlanContext, PlanFood } from './validate.js';

function fixture(): { doc: PlanDocument; ctx: PlanContext; rice: PlanItem } {
  const base: PlanFood = {
    id: 'base',
    name: 'Fixed base',
    role: 'other',
    units: { pack: 1000 },
    portion: { kind: 'fixed_unit', unit: 'pack' },
    per100: { kcal: 180, proteinG: 16.5, fatG: 7.5, carbsG: 13.5, fibreG: 2.5 },
  };
  const riceFood: PlanFood = {
    id: 'rice',
    name: 'Dry rice',
    role: 'main_carb',
    units: { pack: 1 },
    portion: { kind: 'flexible', stepG: 1 },
    per100: { kcal: 400, proteinG: 0, fatG: 0, carbsG: 80, fibreG: 0 },
  };
  const doc: PlanDocument = {
    days: Array.from({ length: 7 }, (_, index) => ({
      weekday: index + 1,
      meals: [
        {
          slot: 'breakfast',
          options: [{ label: 'Default', items: [{ foodId: 'base', grams: 1000 }] }],
        },
        {
          slot: 'lunch',
          options: [
            { label: 'Default', items: [{ foodId: 'rice', grams: index === 0 ? 122 : 100 }] },
          ],
        },
      ],
    })),
  };
  const target = { kcal: 2200, proteinG: 165, fatG: 75, carbsG: 215, fibreG: 25 };
  return {
    doc,
    ctx: {
      foods: new Map([
        ['base', base],
        ['rice', riceFood],
      ]),
      rules: [],
      targets: { training: { ...target }, rest: { ...target } },
      trainingWeekdays: [],
    },
    rice: doc.days[0]!.meals[1]!.options[0]!.items[0]!,
  };
}

function solvedRice(doc: PlanDocument): PlanItem {
  return doc.days[0]!.meals[1]!.options[0]!.items[0]!;
}

describe('solvePortions', () => {
  it('fixes a day 4% over kcal by reducing rice, then passes validation', () => {
    const { doc, ctx } = fixture();
    expect(validatePlan(doc, ctx).days[0]!.totals.kcal).toBe(2288);
    const result = solvePortions(doc, ctx);
    expect(validatePlan(result.doc, ctx).errors).toEqual([]);
    expect(result.fixedDays).toEqual([1]);
    expect(result.unfixedDays).toEqual([]);
    expect(result.changes).toEqual([
      { weekday: 1, slot: 'lunch', foodId: 'rice', foodName: 'Dry rice', fromG: 122, toG: 100 },
    ]);
  });

  it('leaves a day with rule errors untouched and reports it', () => {
    const { doc, ctx } = fixture();
    ctx.rules = [{ kind: 'exclude_food', foodIds: ['rice'] }];
    const result = solvePortions(doc, ctx);
    expect(result.doc).toEqual(doc);
    expect(result.unfixedDays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.changes).toEqual([]);
  });

  it('never changes locked slots or non-default alternatives', () => {
    const { doc, ctx } = fixture();
    doc.days[0]!.meals[1]!.options.push({ label: 'Swap', items: [{ foodId: 'rice', grams: 150 }] });
    const locked = solvePortions(doc, ctx, { lockedSlots: ['lunch'] });
    expect(locked.doc).toEqual(doc);
    expect(locked.unfixedDays).toEqual([1]);
    const result = solvePortions(doc, ctx);
    expect(result.fixedDays).toEqual([1]);
    expect(result.doc.days[0]!.meals[1]!.options[1]).toEqual(doc.days[0]!.meals[1]!.options[1]);
  });

  it('never changes fixed_unit items or fixed_portion items', () => {
    const { doc, ctx } = fixture();
    ctx.foods.get('rice')!.portion = { kind: 'fixed_unit', unit: 'pack' };
    const fixedUnit = solvePortions(doc, ctx);
    expect(fixedUnit.doc).toEqual(doc);
    expect(fixedUnit.unfixedDays).toEqual([1]);
    ctx.foods.get('rice')!.portion = { kind: 'flexible', stepG: 1 };
    ctx.rules = [{ kind: 'fixed_portion', foodIds: ['rice'], slot: 'lunch', grams: 122 }];
    const fixedPortion = solvePortions(doc, ctx);
    expect(fixedPortion.doc).toEqual(doc);
    expect(fixedPortion.unfixedDays).toContain(1);
  });

  it('respects the original ±30% bound and rolls back an impossible day', () => {
    const { doc, ctx, rice } = fixture();
    rice.grams = 200;
    const result = solvePortions(doc, ctx);
    expect(result.doc).toEqual(doc);
    expect(result.unfixedDays).toEqual([1]);
    expect(result.changes).toEqual([]);
    const possible = solvePortions(doc, ctx, { maxRelChange: 0.6 });
    expect(possible.fixedDays).toEqual([1]);
    expect(solvedRice(possible.doc).grams).toBe(100);
  });

  it('keeps successful moves within supplied relative bounds', () => {
    const { doc, ctx, rice } = fixture();
    const result = solvePortions(doc, ctx, { maxRelChange: 0.1 });
    expect(result.fixedDays).toEqual([1]);
    const grams = solvedRice(result.doc).grams;
    expect(grams).toBeGreaterThanOrEqual(rice.grams * 0.9);
    expect(grams).toBeLessThanOrEqual(rice.grams * 1.1);
    expect(Number.isInteger(grams)).toBe(true);
  });

  it('respects min_portion floors and restores a day when the floor prevents repair', () => {
    const { doc, ctx } = fixture();
    // Only the failing day uses this id, so the other days remain valid.
    const food = ctx.foods.get('rice')!;
    ctx.foods.set('special-rice', { ...food, id: 'special-rice' });
    solvedRice(doc).foodId = 'special-rice';
    ctx.rules = [
      { kind: 'min_portion', foodIds: ['special-rice'], minG: 110, fallbackFoodIds: [] },
    ];
    const result = solvePortions(doc, ctx);
    expect(result.fixedDays).toEqual([1]);
    expect(solvedRice(result.doc).grams).toBe(110);
    expect(validatePlan(result.doc, ctx).ok).toBe(true);
    ctx.rules = [
      { kind: 'min_portion', foodIds: ['special-rice'], minG: 120, fallbackFoodIds: [] },
    ];
    const impossible = solvePortions(doc, ctx);
    expect(impossible.doc).toEqual(doc);
    expect(impossible.unfixedDays).toEqual([1]);
  });

  it('honours iteration limits and keeps already valid days unchanged', () => {
    const { doc, ctx } = fixture();
    const zero = solvePortions(doc, ctx, { maxIterations: 0 });
    expect(zero.doc).toEqual(doc);
    expect(zero.unfixedDays).toEqual([1]);
    const result = solvePortions(doc, ctx);
    expect(result.doc.days.slice(1)).toEqual(doc.days.slice(1));
  });

  it('uses snapshots during search', () => {
    const { doc, ctx, rice } = fixture();
    rice.snapshot = { ...ctx.foods.get('rice')!.per100, name: 'Saved rice' };
    ctx.foods.get('rice')!.per100 = { kcal: 100, proteinG: 0, fatG: 0, carbsG: 20, fibreG: 0 };
    const result = solvePortions(doc, ctx);
    expect(result.fixedDays).toContain(1);
    expect(solvedRice(result.doc).grams).toBe(100);
  });

  it('is deterministic and mutates neither input nor context', () => {
    const { doc, ctx } = fixture();
    const before = structuredClone({ doc, ctx });
    const first = solvePortions(doc, ctx);
    expect(solvePortions(doc, ctx)).toEqual(first);
    expect({ doc, ctx }).toEqual(before);
    expect(first.doc).not.toBe(doc);
  });
});
