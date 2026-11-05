/**
 * A realistic, generic planning setup for `pnpm eval:plan`: a Mediterranean-style pool with
 * values per 100 g from the OpenNutrition dataset, rules typical of a real plan, and lean
 * surplus targets. Nothing here is personal data.
 */
import type { Slot } from '@diet/shared';
import type { ContextData, PoolFood } from '../src/services/generate.js';

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

type Def = [
  name: string,
  kcal: number,
  p: number,
  c: number,
  f: number,
  fibre: number | null,
  role: PoolFood['role'],
  slots: Slot[],
  priority: PoolFood['priority'],
  portion: PoolFood['portion'],
  units?: Record<string, number>,
];

const step = (g: number) => ({ kind: 'flexible' as const, stepG: g });
const unit = (u: string) => ({ kind: 'fixed_unit' as const, unit: u });
const B: Slot = 'breakfast';
const MS: Slot = 'morning_snack';
const L: Slot = 'lunch';
const AS: Slot = 'afternoon_snack';
const D: Slot = 'dinner';

const defs: Def[] = [
  ['Oats', 371, 13.2, 68.2, 6.9, 10.4, 'main_carb', [B], 'high', step(5)],
  ['Soy milk', 35, 3.1, 1.6, 1.8, 0.4, 'other', [B], 'high', step(10)],
  ['Blueberries', 56, 0.6, 13.4, 0.2, 2.8, 'fruit', [B], 'high', step(5)],
  [
    'Greek yogurt 0% (150 g cup)',
    61,
    10.3,
    3.6,
    0.4,
    0,
    'dairy_protein',
    [B, MS],
    'high',
    unit('cup'),
    { cup: 150 },
  ],
  ['Almonds', 601, 21.6, 20, 51, 11.3, 'fat', [B, MS], 'high', step(5)],
  [
    'Cottage cheese (150 g tub)',
    100,
    11.3,
    3.8,
    4.3,
    0,
    'dairy_protein',
    [MS, AS],
    'high',
    unit('tub'),
    { tub: 150 },
  ],
  [
    'Whey protein (30 g scoop)',
    380,
    75,
    8,
    5,
    0,
    'snack',
    [AS],
    'medium',
    unit('scoop'),
    { scoop: 30 },
  ],
  ['Banana', 89, 1.1, 22.8, 0.3, 2.6, 'fruit', [B, AS], 'medium', unit('banana'), { banana: 120 }],
  ['Chicken breast', 120, 22.5, 0, 2.6, 0, 'main_protein', [L, D], 'high', step(25)],
  ['Turkey breast', 113, 23.5, 0, 1.7, 0, 'main_protein', [L, D], 'high', step(25)],
  ['Salmon', 208, 20.3, 0, 13.4, 0, 'main_protein', [D], 'medium', step(25)],
  ['Cod', 82, 17.8, 0, 0.7, 0, 'main_protein', [L, D], 'medium', step(10)],
  ['Lean beef', 137, 21.4, 0, 5, 0, 'main_protein', [L, D], 'medium', step(25)],
  ['Eggs', 143, 12.6, 1.1, 9.5, 0, 'main_protein', [B, L], 'high', unit('egg'), { egg: 50 }],
  [
    'Canned chickpeas (drained)',
    137,
    6.8,
    21.4,
    2.7,
    6,
    'main_protein',
    [L, D],
    'medium',
    step(20),
  ],
  ['Lentils, canned (drained)', 116, 9, 20, 0.4, 5.8, 'main_protein', [L], 'medium', step(20)],
  ['Rice (dry)', 365, 7.1, 80, 0.7, 1.3, 'main_carb', [L, D], 'high', step(5)],
  ['Pasta (dry)', 367, 13.5, 71.7, 2.2, 4.2, 'main_carb', [L, D], 'high', step(5)],
  ['Whole-wheat pasta (dry)', 352, 13.9, 73.4, 2.9, 9.2, 'main_carb', [L, D], 'medium', step(5)],
  ['Potatoes', 77, 2, 17.4, 0.1, 1.7, 'main_carb', [L, D], 'medium', step(25)],
  ['Spelt (dry)', 338, 14.6, 70.2, 2.4, 10.7, 'main_carb', [L, D], 'medium', step(5)],
  [
    'Whole wheat bread',
    257,
    11.4,
    44.9,
    3.3,
    6.2,
    'main_carb',
    [L],
    'medium',
    unit('slice'),
    { slice: 40 },
  ],
  [
    'Rye crispbread',
    366,
    7.9,
    82.2,
    1.3,
    16.5,
    'main_carb',
    [L, AS],
    'medium',
    unit('slice'),
    { slice: 12 },
  ],
  ['Olive oil', 884, 0, 0, 100, 0, 'fat', [L, D], 'high', step(1)],
  ['Parmesan', 392, 35.8, 3.2, 25.4, 0, 'fat', [L, D], 'medium', step(5)],
  ['Hummus', 220, 7.5, 15, 17, 5.5, 'fat', [L, D, AS], 'medium', step(5)],
  ['Mixed vegetables', 36, 1.4, 7.1, 0.3, 3.8, 'veg', [L, D], 'high', step(50)],
  ['Spinach', 23.5, 2.8, 3.5, 0.5, 2.1, 'veg', [L, D], 'high', step(50)],
];

export const pool: PoolFood[] = defs
  .map(([name, kcal, p, c, f, fibre, role, slots, priority, portion, units]) => ({
    id: id(),
    name,
    kcal,
    proteinG: p,
    carbsG: c,
    fatG: f,
    fibreG: fibre,
    units: units ?? {},
    role,
    preferredSlots: slots,
    priority,
    portion,
    notes: null,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const byName = (name: string) => {
  const found = pool.find((f) => f.name === name);
  if (!found) throw new Error(`fixture food missing: ${name}`);
  return found.id;
};

export function fixture(preferences: string | null = null): ContextData {
  return {
    targets: {
      training: { kcal: 2320, proteinG: 165, fatG: 75, carbsG: 240, fibreG: 24 },
      rest: { kcal: 2200, proteinG: 165, fatG: 75, carbsG: 215, fibreG: 22 },
    },
    trainingWeekdays: [1, 3, 5],
    phaseType: 'surplus',
    pool,
    extra: [],
    rules: [
      {
        spec: {
          kind: 'max_items_per_day',
          foodIds: [byName('Greek yogurt 0% (150 g cup)')],
          max: 2,
        },
        text: 'Greek yogurt at most twice a day.',
      },
      {
        spec: { kind: 'forbidden_on_day_type', foodIds: [byName('Potatoes')], dayType: 'training' },
        text: 'No potatoes on training days: not enough time to cook them.',
      },
      {
        spec: {
          kind: 'min_portion',
          foodIds: [byName('Rice (dry)'), byName('Pasta (dry)'), byName('Whole-wheat pasta (dry)')],
          minG: 50,
          fallbackFoodIds: [byName('Rye crispbread')],
        },
        text: 'Below 50 g of rice or pasta, use crispbread instead.',
      },
      {
        spec: { kind: 'allowed_weekdays', foodIds: [byName('Eggs')], weekdays: [1, 2, 3, 4, 5] },
        text: 'Eggs on weekdays only.',
      },
      {
        spec: { kind: 'no_repeat_role_lunch_dinner', roles: ['main_protein', 'main_carb'] },
        text: "Lunch and dinner don't repeat the main protein or the main carb.",
      },
      {
        spec: { kind: 'guidance' },
        text: 'Front-load protein at breakfast (about 40–50 g). Keep breakfast similar every day.',
      },
      { spec: { kind: 'guidance' }, text: 'Two servings of vegetables and two of fruit a day.' },
    ],
    current: null,
    preferences,
    phaseId: null,
  };
}
