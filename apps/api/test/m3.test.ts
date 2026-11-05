import type { AiRunDto, FoodDto, MealPlanDto, PoolInfo, RuleDto } from '@diet/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelCall, ModelResult, PlanModel } from '../src/ai/model.js';
import type { AiPlan } from '../src/ai/plan-prompt.js';
import { createApp } from '../src/app.js';
import { createTestDb, freshOwner } from './helpers.js';

const handle = createTestDb();
const { db, sql } = handle;
const clock = new Date('2026-11-05T11:00:00Z');

/** A model that answers from a script: one response per call, and records what it was sent. */
class FakeModel implements PlanModel {
  readonly name = 'claude-opus-5-5';
  calls: string[] = [];
  constructor(private readonly script: ((user: string) => AiPlan | null)[]) {}
  async call<T>(c: ModelCall<never>): Promise<ModelResult<T>> {
    this.calls.push(c.user);
    const next = this.script[this.calls.length - 1];
    const output = next ? next(c.user) : null;
    return {
      output: output as T | null,
      stopReason: output ? 'end_turn' : 'refusal',
      problem: output ? null : 'stopped with refusal',
      raw: JSON.stringify(output),
      served: [
        {
          model: this.name,
          usage: {
            inputTokens: 10_000,
            outputTokens: 5_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 2_000,
          },
        },
      ],
    };
  }
}

const send = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const pool = (
  role: PoolInfo['role'],
  portion: PoolInfo['portion'] = { kind: 'flexible', stepG: 5 },
): PoolInfo => ({
  inPool: true,
  role,
  preferredSlots: [],
  priority: 'high',
  portion,
});

let foods: Record<string, FoodDto>;
let refs: Record<string, string>;

async function setup(app: ReturnType<typeof createApp>) {
  await freshOwner(handle);
  const make = async (body: object) =>
    (await (await send(app, 'POST', '/foods', body)).json()) as FoodDto;
  foods = {
    oats: await make({
      name: 'Oats',
      kcal: 370,
      proteinG: 13,
      carbsG: 60,
      fatG: 7,
      pool: pool('main_carb'),
    }),
    rice: await make({
      name: 'Rice',
      kcal: 360,
      proteinG: 7,
      carbsG: 80,
      fatG: 1,
      pool: pool('main_carb'),
    }),
    chicken: await make({
      name: 'Chicken',
      kcal: 110,
      proteinG: 23,
      carbsG: 0,
      fatG: 2,
      pool: pool('main_protein'),
    }),
    salmon: await make({
      name: 'Salmon',
      kcal: 208,
      proteinG: 20,
      carbsG: 0,
      fatG: 13,
      pool: pool('main_protein'),
    }),
    oil: await make({
      name: 'Olive oil',
      kcal: 884,
      proteinG: 0,
      carbsG: 0,
      fatG: 100,
      pool: pool('fat', { kind: 'flexible', stepG: 1 }),
    }),
    tofu: await make({
      name: 'Tofu',
      kcal: 83,
      proteinG: 10,
      carbsG: 2,
      fatG: 4,
      pool: pool('main_protein'),
    }),
    // Same macros as chicken / salmon, so the week can vary its pairs without changing totals.
    turkey: await make({
      name: 'Turkey',
      kcal: 110,
      proteinG: 23,
      carbsG: 0,
      fatG: 2,
      pool: pool('main_protein'),
    }),
    trout: await make({
      name: 'Trout',
      kcal: 208,
      proteinG: 20,
      carbsG: 0,
      fatG: 13,
      pool: pool('main_protein'),
    }),
  };
  // The payload lists the pool by name and numbers it F01, F02, ...
  const sorted = Object.entries(foods).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  refs = Object.fromEntries(sorted.map(([key], i) => [key, `F${String(i + 1).padStart(2, '0')}`]));
}

/** One day: oats breakfast, chicken + rice lunch, salmon + rice dinner, oil. */
/** Lunch/dinner proteins per weekday: four distinct pairs, none on more than two days. */
const ROTATION: [string, string][] = [
  ['chicken', 'salmon'],
  ['chicken', 'salmon'],
  ['turkey', 'salmon'],
  ['turkey', 'salmon'],
  ['chicken', 'trout'],
  ['chicken', 'trout'],
  ['turkey', 'trout'],
];

function day(weekday: number, riceLunch = 150, lunchProtein?: string): AiPlan['days'][number] {
  const [lunchKey, dinnerKey] = ROTATION[weekday - 1]!;
  const protein = lunchProtein ?? refs[lunchKey]!;
  const fish = refs[dinnerKey]!;
  return {
    weekday,
    meals: [
      {
        slot: 'breakfast',
        notes: null,
        options: [{ label: 'A', items: [{ food: refs.oats!, grams: 80 }] }],
      },
      {
        slot: 'lunch',
        notes: null,
        options: [
          {
            label: 'A',
            items: [
              { food: protein, grams: 250 },
              { food: refs.rice!, grams: riceLunch },
            ],
          },
        ],
      },
      {
        slot: 'dinner',
        notes: null,
        options: [
          {
            label: 'A',
            items: [
              { food: fish, grams: 200 },
              { food: refs.rice!, grams: 120 },
              { food: refs.oil!, grams: 10 },
            ],
          },
        ],
      },
    ],
  };
}

const week = (d: (w: number) => AiPlan['days'][number] = (w) => day(w)): AiPlan => ({
  summary: 'A simple test week.',
  days: [1, 2, 3, 4, 5, 6, 7].map(d),
});

/** Targets equal to the test day's totals, so a plan made of that day passes exactly. */
async function startPhaseMatchingTheDay(app: ReturnType<typeof createApp>) {
  // oats 80: 296/10.4/48/5.6 · chicken 250: 275/57.5/0/5 · rice 270: 972/18.9/216/2.7 · salmon 200: 416/40/0/26 · oil 10: 88.4/0/0/10
  const t = { kcal: 2047, proteinG: 127, fatG: 49, carbsG: 264, fibreG: 26 };
  const res = await send(app, 'POST', '/phases', {
    type: 'maintenance',
    startedOn: '2026-11-01',
    maintenanceKcal: 2047,
    targets: { training: t, rest: t },
  });
  expect(res.status).toBe(201);
}

async function waitForRun(app: ReturnType<typeof createApp>, id: string): Promise<AiRunDto> {
  for (let i = 0; i < 100; i++) {
    const run = (await (await send(app, 'GET', `/ai-runs/${id}`)).json()) as AiRunDto;
    if (run.status === 'succeeded' || run.status === 'failed') return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('run did not finish');
}

afterAll(() => sql.end());

describe('plan generation', () => {
  let model: FakeModel;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    model = new FakeModel([]);
    app = createApp({ db, version: 'test', log: false, now: () => clock, planModel: model });
  });

  it('is off without a model, and needs a phase and a pool', async () => {
    const off = createApp({ db, version: 'test', log: false, now: () => clock });
    await setup(off);
    expect((await (await send(off, 'POST', '/plans/generate', {})).json()) as object).toMatchObject(
      { error: 'ai_disabled' },
    );
    expect((await (await send(app, 'POST', '/plans/generate', {})).json()) as object).toMatchObject(
      { error: 'no_targets' },
    );
  });

  it('turns a valid answer into a draft plan, with cost and a clean result', async () => {
    await setup(app);
    await startPhaseMatchingTheDay(app);
    model = new FakeModel([() => week()]);
    app = createApp({ db, version: 'test', log: false, now: () => clock, planModel: model });

    const started = await send(app, 'POST', '/plans/generate', { preferences: 'more fish' });
    expect(started.status).toBe(202);
    const run = await waitForRun(app, ((await started.json()) as AiRunDto).id);
    expect(run).toMatchObject({ status: 'succeeded', result: { repaired: false, errors: [] } });
    expect(run.costUsd).toBeGreaterThan(0);

    // The payload names foods by ref, carries the preferences, and the plan is a draft.
    expect(model.calls[0]).toContain(`"ref":"${refs.salmon}","name":"Salmon"`);
    expect(model.calls[0]).toContain('more fish');
    const plan = (await (await send(app, 'GET', `/plans/${run.planId}`)).json()) as MealPlanDto;
    expect(plan.status).toBe('draft');
    expect(plan.document.days[0]!.meals.map((m) => m.slot)).toEqual([
      'breakfast',
      'lunch',
      'dinner',
    ]);
    expect(plan.document.days[0]!.meals[1]!.options[0]!.items[0]).toMatchObject({
      foodId: foods.chicken!.id,
      grams: 250,
    });
  });

  it('fixes small portion misses with the solver, without another model call', async () => {
    await setup(app);
    await startPhaseMatchingTheDay(app);
    // Monday's lunch rice is 30 g too much: about +5% kcal, outside ±3%.
    model = new FakeModel([() => week((w) => day(w, w === 1 ? 180 : 150))]);
    app = createApp({ db, version: 'test', log: false, now: () => clock, planModel: model });
    const run = await waitForRun(
      app,
      ((await (await send(app, 'POST', '/plans/generate', {})).json()) as AiRunDto).id,
    );
    expect(run.status).toBe('succeeded');
    expect(model.calls).toHaveLength(1);
    expect(run.result!.solverChanges.length).toBeGreaterThan(0);
    expect(run.result!.solverChanges[0]).toMatch(/^Mon /);
  });

  it('repairs only the failing days, sending the errors back', async () => {
    await setup(app);
    await startPhaseMatchingTheDay(app);
    const rule = (await (
      await send(app, 'POST', '/rules', {
        spec: { kind: 'exclude_food', foodIds: [foods.tofu!.id] },
        text: 'No tofu.',
      })
    ).json()) as RuleDto;
    expect(rule.active).toBe(true);
    // Wednesday uses tofu (a rule error the solver can't fix); the repair swaps it for chicken.
    model = new FakeModel([
      () => week((w) => day(w, 150, w === 3 ? refs.tofu! : undefined)),
      () => ({ summary: 'Fixed Wednesday.', days: [day(3)] }),
    ]);
    app = createApp({ db, version: 'test', log: false, now: () => clock, planModel: model });
    const run = await waitForRun(
      app,
      ((await (await send(app, 'POST', '/plans/generate', {})).json()) as AiRunDto).id,
    );

    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]).toContain(`[never use ${refs.tofu}]`);
    expect(model.calls[1]).toContain('Return ONLY weekdays 3');
    expect(model.calls[1]).toMatch(/Wed.*Tofu/);
    expect(run).toMatchObject({
      status: 'succeeded',
      result: { repaired: true, summary: 'Fixed Wednesday.' },
    });
  });

  it('fails visibly when the repair still breaks the rules, and keeps no draft', async () => {
    await setup(app);
    await startPhaseMatchingTheDay(app);
    await send(app, 'POST', '/rules', {
      spec: { kind: 'exclude_food', foodIds: [foods.tofu!.id] },
      text: 'No tofu.',
    });
    const tofuWeek = () => week((w) => day(w, 150, refs.tofu!));
    model = new FakeModel([tofuWeek, tofuWeek]);
    app = createApp({ db, version: 'test', log: false, now: () => clock, planModel: model });
    const run = await waitForRun(
      app,
      ((await (await send(app, 'POST', '/plans/generate', {})).json()) as AiRunDto).id,
    );
    expect(run).toMatchObject({ status: 'failed', planId: null });
    expect(run.result!.errors.some((e) => e.includes('Tofu'))).toBe(true);
    const plans = (await (await send(app, 'GET', '/plans')).json()) as MealPlanDto[];
    expect(plans).toHaveLength(0);
  });

  it('reports a refusal or empty answer as a failed run', async () => {
    await setup(app);
    await startPhaseMatchingTheDay(app);
    model = new FakeModel([() => null]);
    app = createApp({ db, version: 'test', log: false, now: () => clock, planModel: model });
    const run = await waitForRun(
      app,
      ((await (await send(app, 'POST', '/plans/generate', {})).json()) as AiRunDto).id,
    );
    expect(run).toMatchObject({ status: 'failed' });
    expect(run.error).toContain('no usable plan');
  });

  it('keeps fixed slots from the active plan and does not send them to be regenerated', async () => {
    await setup(app);
    await startPhaseMatchingTheDay(app);
    // An active plan with the breakfast to keep.
    const created = (await (
      await send(app, 'POST', '/plans', { name: 'Current' })
    ).json()) as MealPlanDto;
    const breakfast = {
      slot: 'breakfast',
      options: [{ label: 'A', items: [{ foodId: foods.oats!.id, grams: 80 }] }],
    };
    await send(app, 'PUT', `/plans/${created.id}`, {
      document: { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, meals: [breakfast] })) },
    });
    await send(app, 'POST', `/plans/${created.id}/activate`);
    await send(app, 'POST', '/rules', {
      spec: { kind: 'fixed_slots', slots: ['breakfast'] },
      text: 'Keep breakfast.',
    });

    // The model wrongly returns a different breakfast too; it must be ignored.
    model = new FakeModel([
      () =>
        week((w) => ({
          ...day(w),
          meals: day(w).meals.map((m) =>
            m.slot === 'breakfast'
              ? { ...m, options: [{ label: 'A', items: [{ food: refs.rice!, grams: 60 }] }] }
              : m,
          ),
        })),
    ]);
    app = createApp({ db, version: 'test', log: false, now: () => clock, planModel: model });
    const run = await waitForRun(
      app,
      ((await (await send(app, 'POST', '/plans/generate', {})).json()) as AiRunDto).id,
    );
    expect(model.calls[0]).toContain(
      '"slots":["morning_snack","lunch","afternoon_snack","dinner"]',
    );
    expect(run.status).toBe('succeeded');
    const plan = (await (await send(app, 'GET', `/plans/${run.planId}`)).json()) as MealPlanDto;
    expect(plan.document.days[0]!.meals[0]!.options[0]!.items[0]).toMatchObject({
      foodId: foods.oats!.id,
      grams: 80,
    });
  });

  it('allows one generation at a time', async () => {
    await setup(app);
    await startPhaseMatchingTheDay(app);
    await db.execute(`select 1`);
    await sql`insert into ai_run (user_id, kind, status, model, prompt_version, input)
      select id, 'generate_plan', 'running', 'x', 'v', '{}' from app_user`;
    expect((await (await send(app, 'POST', '/plans/generate', {})).json()) as object).toMatchObject(
      { error: 'already_running' },
    );
  });
});

describe('rules API', () => {
  it('validates rules and refuses unknown foods', async () => {
    const app = createApp({ db, version: 'test', log: false, now: () => clock });
    await setup(app);
    const bad = await send(app, 'POST', '/rules', {
      spec: { kind: 'exclude_food', foodIds: ['00000000-0000-4000-8000-000000000000'] },
      text: 'x',
    });
    expect(await bad.json()).toMatchObject({ error: 'unknown_food' });
    expect(
      (
        await send(app, 'POST', '/rules', {
          spec: { kind: 'max_items_per_day', foodIds: [], max: 2 },
          text: 'x',
        })
      ).status,
    ).toBe(422);
    const ok = (await (
      await send(app, 'POST', '/rules', {
        spec: { kind: 'max_items_per_day', foodIds: [foods.oats!.id], max: 2 },
        text: 'Oats at most twice.',
      })
    ).json()) as RuleDto;
    const toggled = (await (
      await send(app, 'PUT', `/rules/${ok.id}`, { spec: ok.spec, text: ok.text, active: false })
    ).json()) as RuleDto;
    expect(toggled.active).toBe(false);
    expect((await send(app, 'DELETE', `/rules/${ok.id}`)).status).toBe(204);
  });

  it('stores pool info on foods and checks whole-unit portions', async () => {
    const app = createApp({ db, version: 'test', log: false, now: () => clock });
    await setup(app);
    const bad = await send(app, 'POST', '/foods', {
      name: 'Yogurt',
      kcal: 57,
      proteinG: 10,
      carbsG: 4,
      fatG: 0,
      pool: pool('dairy_protein', { kind: 'fixed_unit', unit: 'cup' }),
    });
    expect(await bad.json()).toMatchObject({ error: 'unknown_unit' });
    const ok = (await (
      await send(app, 'POST', '/foods', {
        name: 'Yogurt',
        kcal: 57,
        proteinG: 10,
        carbsG: 4,
        fatG: 0,
        units: { cup: 150 },
        pool: pool('dairy_protein', { kind: 'fixed_unit', unit: 'cup' }),
      })
    ).json()) as FoodDto;
    expect(ok.pool).toMatchObject({
      inPool: true,
      role: 'dairy_protein',
      portion: { kind: 'fixed_unit', unit: 'cup' },
    });
  });
});

describe('review fixes', () => {
  let app: ReturnType<typeof createApp>;
  const withModel = (m: PlanModel) =>
    createApp({ db, version: 'test', log: false, now: () => clock, planModel: m });

  it('keeps fixed meals exactly as checked, even after a food is edited', async () => {
    app = withModel(new FakeModel([]));
    await setup(app);
    await startPhaseMatchingTheDay(app);
    const created = (await (
      await send(app, 'POST', '/plans', { name: 'Current' })
    ).json()) as MealPlanDto;
    const breakfast = {
      slot: 'breakfast',
      options: [{ label: 'A', items: [{ foodId: foods.oats!.id, grams: 80 }] }],
    };
    await send(app, 'PUT', `/plans/${created.id}`, {
      document: { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, meals: [breakfast] })) },
    });
    await send(app, 'POST', `/plans/${created.id}/activate`);
    await send(app, 'POST', '/rules', {
      spec: { kind: 'fixed_slots', slots: ['breakfast'] },
      text: 'Keep breakfast.',
    });
    // Oats change after the active plan was saved: the fixed breakfast keeps its old values.
    await send(app, 'PATCH', `/foods/${foods.oats!.id}`, {
      kcal: 740,
      carbsG: 120,
      proteinG: 26,
      fatG: 14,
    });

    const model = new FakeModel([() => week()]);
    app = withModel(model);
    const run = await waitForRun(
      app,
      ((await (await send(app, 'POST', '/plans/generate', {})).json()) as AiRunDto).id,
    );
    expect(model.calls[0]).toContain('"totals":{"kcal":296');
    expect(run.status).toBe('succeeded');
    const plan = (await (await send(app, 'GET', `/plans/${run.planId}`)).json()) as MealPlanDto;
    expect(plan.document.days[0]!.meals[0]!.options[0]!.items[0]!.snapshot?.kcal).toBe(370);
  });

  it('does not offer foods taken out of the pool, and rejects them in generated meals', async () => {
    app = withModel(new FakeModel([]));
    await setup(app);
    await startPhaseMatchingTheDay(app);
    await send(app, 'PATCH', `/foods/${foods.tofu!.id}`, {
      pool: { ...pool('main_protein'), inPool: false },
    });
    // Codes follow the pool, which no longer has tofu.
    const remaining = Object.entries(foods)
      .filter(([key]) => key !== 'tofu')
      .sort(([, a], [, b]) => a.name.localeCompare(b.name));
    refs = Object.fromEntries(
      remaining.map(([key], i) => [key, `F${String(i + 1).padStart(2, '0')}`]),
    );
    const model = new FakeModel([
      // The model makes up the old ref of tofu: it no longer exists in the payload.
      () => week((w) => day(w, 150, w === 2 ? 'F99' : undefined)),
      () => ({ summary: 'Fixed.', days: [day(2)] }),
    ]);
    app = withModel(model);
    const run = await waitForRun(
      app,
      ((await (await send(app, 'POST', '/plans/generate', {})).json()) as AiRunDto).id,
    );
    expect(model.calls[0]).not.toContain('"name":"Tofu"');
    expect(model.calls[1]).toMatch(/Tue lunch: .*not in the planning pool|unknown food/);
    expect(run.status).toBe('succeeded');
  });

  it('records the cost of a completed call even when the repair call fails', async () => {
    app = withModel(new FakeModel([]));
    await setup(app);
    await startPhaseMatchingTheDay(app);
    const model = new FakeModel([() => week((w) => day(w, 150, w === 1 ? 'F99' : undefined))]);
    model.call = (async (c: ModelCall<never>) => {
      model.calls.push(c.user);
      if (model.calls.length === 2) throw new Error('connection reset');
      return FakeModel.prototype.call.call(
        Object.assign(
          new FakeModel([() => week((w) => day(w, 150, w === 1 ? 'F99' : undefined))]),
          {},
        ),
        c,
      );
    }) as PlanModel['call'];
    app = withModel(model);
    const run = await waitForRun(
      app,
      ((await (await send(app, 'POST', '/plans/generate', {})).json()) as AiRunDto).id,
    );
    expect(run).toMatchObject({ status: 'failed', error: 'connection reset' });
    expect(run.costUsd).toBeGreaterThan(0);
  });

  it('refuses to drop the unit a whole-unit food is planned in', async () => {
    app = withModel(new FakeModel([]));
    await setup(app);
    const yogurt = (await (
      await send(app, 'POST', '/foods', {
        name: 'Yogurt cup',
        kcal: 57,
        proteinG: 10,
        carbsG: 4,
        fatG: 0,
        units: { cup: 150 },
        pool: pool('dairy_protein', { kind: 'fixed_unit', unit: 'cup' }),
      })
    ).json()) as FoodDto;
    const res = await send(app, 'PATCH', `/foods/${yogurt.id}`, { units: {} });
    expect(await res.json()).toMatchObject({ error: 'unknown_unit' });
  });
});
