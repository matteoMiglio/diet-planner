import { describe, expect, it } from 'vitest';
import type { DayTargets } from './engine.js';
import type { PlanDocument, PlanItem, Slot } from './plan.js';
import type { RuleSpec } from './rules.js';
import { validatePlan } from './validate.js';
import type { PlanContext, PlanFood } from './validate.js';

const target: DayTargets = { kcal: 2200, proteinG: 165, fatG: 75, carbsG: 215, fibreG: 25 };

function fixture(): { doc: PlanDocument; ctx: PlanContext } {
  const foods = new Map<string, PlanFood>();
  const days = Array.from({ length: 7 }, (_, index) => {
    const id = `base-${index}`;
    foods.set(id, {
      id,
      name: `Base ${index}`,
      units: {},
      role: 'other',
      portion: { kind: 'flexible', stepG: 1 },
      per100: { kcal: 220, proteinG: 16.5, fatG: 7.5, carbsG: 21.5, fibreG: 2.5 },
    });
    return {
      weekday: index + 1,
      meals: [
        {
          slot: 'breakfast' as const,
          options: [{ label: 'Default', items: [{ foodId: id, grams: 1000 }] }],
        },
      ],
    };
  });
  for (const [id, name] of [
    ['rice', 'Dry rice'],
    ['wasa', 'Wasa'],
    ['chicken', 'Chicken'],
  ]) {
    if (!id || !name) continue;
    foods.set(id, {
      id,
      name,
      units: { slice: 20 },
      role: id === 'chicken' ? 'main_protein' : 'main_carb',
      portion: { kind: 'flexible', stepG: 5 },
      per100: { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0, fibreG: null },
    });
  }
  return {
    doc: { days },
    ctx: {
      foods,
      rules: [],
      targets: { training: { ...target, kcal: 2320, carbsG: 240 }, rest: { ...target } },
      trainingWeekdays: [],
    },
  };
}

function insert(
  doc: PlanDocument,
  slot: Slot,
  foodId = 'rice',
  grams = 50,
  alternative = false,
  index = 0,
): PlanItem {
  const day = doc.days[index]!;
  let meal = day.meals.find((m) => m.slot === slot);
  if (!meal) {
    meal = { slot, options: [{ label: 'Default', items: [] }] };
    day.meals.push(meal);
  }
  const item = { foodId, grams };
  if (alternative) meal.options.push({ label: 'Swap', items: [item] });
  else meal.options[0]!.items.push(item);
  return item;
}

function totals(doc: PlanDocument, index: number, values: DayTargets): void {
  const item = doc.days[index]!.meals[0]!.options[0]!.items[0]!;
  item.snapshot = {
    name: 'Saved base',
    kcal: values.kcal / 10,
    proteinG: values.proteinG / 10,
    fatG: values.fatG / 10,
    carbsG: values.carbsG / 10,
    fibreG: values.fibreG / 10,
  };
}

describe('validatePlan', () => {
  it('passes Lean Surplus vault totals, including Tue protein and Thu/Sat fat', () => {
    const { doc, ctx } = fixture();
    ctx.trainingWeekdays = [1, 3, 5];
    const vault = [
      [2327, 173, 247, 71],
      [2198, 164, 205, 78],
      [2320, 165, 240, 75],
      [2199, 182, 221, 66],
      [2320, 165, 240, 75],
      [2199, 184, 221, 67],
      [2206, 179, 213, 70],
    ];
    vault.forEach(([kcal, proteinG, carbsG, fatG], index) =>
      totals(doc, index, {
        kcal: kcal!,
        proteinG: proteinG!,
        carbsG: carbsG!,
        fatG: fatG!,
        fibreG: 25,
      }),
    );
    const result = validatePlan(doc, ctx);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.days.map((d) => d.dayType)).toEqual([
      'training',
      'rest',
      'training',
      'rest',
      'training',
      'rest',
      'rest',
    ]);
  });

  it.each<[RuleSpec, string]>([
    [{ kind: 'exclude_food', foodIds: ['rice'] }, 'Dry rice is excluded'],
    [
      { kind: 'max_items_per_day', foodIds: ['rice'], max: 0 },
      '1 units of Dry rice; use at most 0',
    ],
    [
      { kind: 'forbidden_on_day_type', foodIds: ['rice'], dayType: 'rest' },
      'Dry rice is forbidden on rest days',
    ],
    [{ kind: 'allowed_weekdays', foodIds: ['rice'], weekdays: [2, 3] }, 'only allowed on Tue, Wed'],
    [
      { kind: 'min_portion', foodIds: ['rice'], minG: 60, fallbackFoodIds: ['wasa'] },
      'Dry rice 50 g is below the 60 g minimum; use Wasa instead',
    ],
    [
      { kind: 'no_repeat_role_lunch_dinner', roles: ['main_protein'] },
      'Chicken repeats role main_protein',
    ],
    [
      { kind: 'fixed_portion', foodIds: ['rice'], slot: 'lunch', grams: 190 },
      'Dry rice 50 g must be exactly 190 g',
    ],
  ])('checks $kind and gives an actionable message', (rule, message) => {
    const { doc, ctx } = fixture();
    insert(doc, 'lunch');
    insert(doc, 'lunch', 'wasa', 50, true);
    insert(doc, 'lunch', 'chicken');
    insert(doc, 'dinner', 'chicken');
    ctx.rules = [rule];
    const errors = validatePlan(doc, ctx).errors;
    expect(
      errors.some(
        (e) => e.code === 'rule' && e.message.includes(message) && e.message.startsWith('Mon'),
      ),
    ).toBe(true);
  });

  it('checks all alternatives, but counts max items only in defaults', () => {
    const { doc, ctx } = fixture();
    insert(doc, 'lunch');
    insert(doc, 'lunch', 'rice', 50, true);
    ctx.rules = [{ kind: 'max_items_per_day', foodIds: ['rice'], max: 1 }];
    expect(validatePlan(doc, ctx).ok).toBe(true);
    ctx.rules = [{ kind: 'exclude_food', foodIds: ['rice'] }];
    expect(validatePlan(doc, ctx).errors.filter((e) => e.code === 'rule')).toHaveLength(2);
  });

  it('ignores fixed_slots and guidance; low fibre is only a warning', () => {
    const { doc, ctx } = fixture();
    ctx.rules = [{ kind: 'fixed_slots', slots: ['breakfast'] }, { kind: 'guidance' }];
    totals(doc, 0, { ...target, fibreG: 0 });
    const result = validatePlan(doc, ctx);
    expect(result.ok).toBe(true);
    expect(result.warnings[0]?.message).toContain('Mon: 0 g fibre is below target 25 g');
  });

  it('collects missing/duplicate/invalid weekdays, empty options and empty items', () => {
    const { doc, ctx } = fixture();
    doc.days.pop();
    doc.days[1]!.weekday = 1;
    doc.days[2]!.weekday = 8;
    doc.days[0]!.meals[0]!.options = [];
    doc.days[3]!.meals[0]!.options[0]!.items = [];
    const errors = validatePlan(doc, ctx).errors.filter((e) => e.code === 'shape');
    expect(errors.length).toBeGreaterThanOrEqual(7);
    expect(errors.some((e) => e.message.includes('at least one option'))).toBe(true);
    expect(errors.some((e) => e.message.includes('at least one item'))).toBe(true);
  });

  it('reports unknown foods, even with snapshots; uses snapshots for totals', () => {
    const { doc, ctx } = fixture();
    totals(doc, 0, target);
    ctx.foods.delete('base-0');
    const result = validatePlan(doc, ctx);
    expect(result.errors[0]?.code).toBe('unknown_food');
    expect(result.days[0]?.totals.kcal).toBe(2200);
    expect(result.days[0]?.macroErrors).toEqual([]);
  });

  it('checks flexible step tolerance and whole fixed units; rejects absent units', () => {
    const { doc, ctx } = fixture();
    const item = insert(doc, 'lunch', 'rice', 51);
    expect(validatePlan(doc, ctx).errors.some((e) => e.code === 'portion_step')).toBe(true);
    item.grams = 50 + 1e-7;
    expect(validatePlan(doc, ctx).ok).toBe(true);
    ctx.foods.get('rice')!.portion = { kind: 'fixed_unit', unit: 'slice' };
    expect(validatePlan(doc, ctx).errors.some((e) => e.code === 'fixed_unit')).toBe(true);
    item.grams = 60;
    expect(validatePlan(doc, ctx).ok).toBe(true);
    ctx.foods.get('rice')!.units = {};
    // A whole-unit food whose unit has no weight can't be checked: that's an error now.
    const result = validatePlan(doc, ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.find((e) => e.code === 'fixed_unit')?.message).toContain('unit slice');
  });

  it.each([
    ['kcal', 'kcal', 2134, -1],
    ['kcal', 'kcal', 2266, 1],
    ['proteinG', 'protein_low', 160, -1],
    ['proteinG', 'protein_high', 190, 1],
    ['fatG', 'fat', 65, -1],
    ['fatG', 'fat', 85, 1],
    ['carbsG', 'carbs', 197.8, -1],
    ['carbsG', 'carbs', 232.2, 1],
  ] as const)('enforces inclusive %s boundary %s at %s', (key, code, boundary, direction) => {
    const { doc, ctx } = fixture();
    for (const [offset, fails] of [
      [-0.001, false],
      [0, false],
      [0.001, true],
    ] as const) {
      totals(doc, 0, { ...target, [key]: boundary + offset * direction });
      const result = validatePlan(doc, ctx);
      expect(result.days[0]!.macroErrors.some((e) => e.code === code)).toBe(fails);
      expect(result.days[0]!.otherErrors).toEqual([]);
    }
  });

  it('detects triple protein pair repeats; two is allowed', () => {
    const { doc, ctx } = fixture();
    for (let index = 0; index < 2; index++) {
      insert(doc, 'lunch', 'chicken', 50, false, index);
      insert(doc, 'dinner', 'chicken', 50, false, index);
    }
    expect(validatePlan(doc, ctx).ok).toBe(true);
    insert(doc, 'lunch', 'chicken', 50, false, 2);
    insert(doc, 'dinner', 'chicken', 50, false, 2);
    const result = validatePlan(doc, ctx);
    expect(result.errors.filter((e) => e.code === 'variety')).toHaveLength(3);
    expect(result.days[0]!.otherErrors[0]?.code).toBe('variety');
  });

  it('uses a sorted variety key across swapped meals and reordered protein items', () => {
    const { doc, ctx } = fixture();
    const chicken = ctx.foods.get('chicken')!;
    ctx.foods.set('fish', { ...chicken, id: 'fish', name: 'Fish' });
    ctx.foods.set('beef', { ...chicken, id: 'beef', name: 'Beef' });
    for (let index = 0; index < 3; index++) {
      const lunch = index === 1 ? 'dinner' : 'lunch';
      const dinner = index === 1 ? 'lunch' : 'dinner';
      const ids = index === 2 ? ['fish', 'chicken'] : ['chicken', 'fish'];
      for (const id of ids) insert(doc, lunch, id, 50, false, index);
      insert(doc, dinner, 'beef', 50, false, index);
    }
    expect(validatePlan(doc, ctx).errors.filter((e) => e.code === 'variety')).toHaveLength(3);
  });

  it('collects at least five distinct problems without stopping', () => {
    const { doc, ctx } = fixture();
    insert(doc, 'lunch', 'missing');
    insert(doc, 'lunch', 'rice', 45);
    ctx.rules = [
      { kind: 'exclude_food', foodIds: ['rice'] },
      { kind: 'min_portion', foodIds: ['rice'], minG: 50, fallbackFoodIds: ['wasa'] },
    ];
    totals(doc, 0, { ...target, kcal: 2500, proteinG: 100, fatG: 100 });
    expect(validatePlan(doc, ctx).errors.length).toBeGreaterThanOrEqual(6);
  });
});

describe('locked slots', () => {
  it('skips portion-step checks for slots kept from the current plan', () => {
    const food: PlanFood = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Hazelnuts',
      per100: { kcal: 635, proteinG: 14.4, carbsG: 16.7, fatG: 58.6, fibreG: 9.5 },
      units: {},
      role: 'fat',
      portion: { kind: 'flexible', stepG: 5 },
    };
    const doc: PlanDocument = {
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        meals: [
          {
            slot: 'breakfast',
            options: [{ label: 'A', items: [{ foodId: food.id, grams: 13.3 }] }],
          },
        ],
      })),
    };
    const t = { kcal: 84, proteinG: 2, fatG: 8, carbsG: 2, fibreG: 1 };
    const ctx: PlanContext = {
      foods: new Map([[food.id, food]]),
      rules: [],
      targets: { training: t, rest: t },
      trainingWeekdays: [],
    };
    expect(validatePlan(doc, ctx).errors.some((e) => e.code === 'portion_step')).toBe(true);
    expect(
      validatePlan(doc, { ...ctx, lockedSlots: ['breakfast'] }).errors.some(
        (e) => e.code === 'portion_step',
      ),
    ).toBe(false);
  });
});

describe('rules interplay', () => {
  const food = (n: number, name: string, portion: PlanFood['portion']): PlanFood => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name,
    per100: { kcal: 100, proteinG: 10, carbsG: 10, fatG: 2, fibreG: 0 },
    units: {},
    role: 'snack',
    portion,
  });
  const a = food(1, 'Huel Protein', { kind: 'flexible', stepG: 5 });
  const b = food(2, 'Huel Bar', { kind: 'flexible', stepG: 5 });
  const chicken = food(3, 'Chicken', { kind: 'flexible', stepG: 25 });
  const t = { kcal: 100, proteinG: 10, fatG: 2, carbsG: 10, fibreG: 0 };
  const ctxWith = (rules: PlanContext['rules']): PlanContext => ({
    foods: new Map([a, b, chicken].map((f) => [f.id, f])),
    rules,
    targets: { training: t, rest: t },
    trainingWeekdays: [],
  });
  const week = (meals: PlanDocument['days'][number]['meals']): PlanDocument => ({
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, meals })),
  });
  const notSameDay = [{ kind: 'not_same_day' as const, foodIds: [a.id, b.id] }];

  it('treats options of one meal as alternatives for not_same_day', () => {
    const doc = week([
      {
        slot: 'afternoon_snack',
        options: [
          { label: 'S1', items: [{ foodId: a.id, grams: 100 }] },
          { label: 'S2', items: [{ foodId: b.id, grams: 100 }] },
        ],
      },
    ]);
    expect(validatePlan(doc, ctxWith(notSameDay)).errors.filter((e) => e.code === 'rule')).toEqual(
      [],
    );
  });

  it('flags not_same_day foods in different meals', () => {
    const doc = week([
      { slot: 'morning_snack', options: [{ label: 'A', items: [{ foodId: a.id, grams: 50 }] }] },
      { slot: 'afternoon_snack', options: [{ label: 'A', items: [{ foodId: b.id, grams: 50 }] }] },
    ]);
    expect(validatePlan(doc, ctxWith(notSameDay)).errors.some((e) => e.code === 'rule')).toBe(true);
  });

  it('lets a fixed_portion amount override the portion step', () => {
    const doc = week([
      { slot: 'dinner', options: [{ label: 'A', items: [{ foodId: chicken.id, grams: 190 }] }] },
    ]);
    const rules = [
      {
        kind: 'fixed_portion' as const,
        foodIds: [chicken.id],
        slot: 'dinner' as const,
        grams: 190,
      },
    ];
    expect(validatePlan(doc, ctxWith([])).errors.some((e) => e.code === 'portion_step')).toBe(true);
    expect(validatePlan(doc, ctxWith(rules)).errors.some((e) => e.code === 'portion_step')).toBe(
      false,
    );
  });
});

describe('review fixes', () => {
  const t = { kcal: 300, proteinG: 30, fatG: 6, carbsG: 30, fibreG: 0 };
  const yogurt: PlanFood = {
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Yogurt',
    per100: { kcal: 60, proteinG: 10, carbsG: 4, fatG: 0, fibreG: 0 },
    units: { cup: 150 },
    role: 'dairy_protein',
    portion: { kind: 'fixed_unit', unit: 'cup' },
  };
  const ctx = (patch: Partial<PlanContext> = {}): PlanContext => ({
    foods: new Map([[yogurt.id, yogurt]]),
    rules: [],
    targets: { training: t, rest: t },
    trainingWeekdays: [],
    ...patch,
  });
  const week = (grams: number, slot: 'breakfast' | 'lunch' = 'breakfast'): PlanDocument => ({
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      meals: [{ slot, options: [{ label: 'A', items: [{ foodId: yogurt.id, grams }] }] }],
    })),
  });

  it('counts whole units for at-most-N rules', () => {
    const rules = [{ kind: 'max_items_per_day' as const, foodIds: [yogurt.id], max: 2 }];
    expect(validatePlan(week(300), ctx({ rules })).errors.some((e) => e.code === 'rule')).toBe(
      false,
    );
    const three = validatePlan(week(450), ctx({ rules })).errors.find((e) => e.code === 'rule');
    expect(three?.message).toContain('3 units');
  });

  it('requires every slot it is told to expect', () => {
    const errors = validatePlan(week(150), ctx({ requiredSlots: ['breakfast', 'lunch'] })).errors;
    expect(errors.filter((e) => e.message.includes('lunch is missing'))).toHaveLength(7);
  });

  it('keeps generated meals to the pool, but allows other foods in locked slots', () => {
    const selectableFoodIds = new Set<string>();
    expect(
      validatePlan(week(150, 'lunch'), ctx({ selectableFoodIds })).errors.some((e) =>
        e.message.includes('not in the planning pool'),
      ),
    ).toBe(true);
    expect(
      validatePlan(week(150), ctx({ selectableFoodIds, lockedSlots: ['breakfast'] })).errors.some(
        (e) => e.message.includes('not in the planning pool'),
      ),
    ).toBe(false);
  });

  it('enforces a daily calorie floor', () => {
    const errors = validatePlan(week(450), ctx({ kcalFloorPerDay: 2000 })).errors;
    expect(errors.some((e) => e.message.includes('daily floor'))).toBe(true);
  });
});
