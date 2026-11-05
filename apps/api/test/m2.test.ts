import type {
  FoodDto,
  MealPlanDto,
  PlanDocument,
  PlanOverviewDto,
  ReviewDto,
  TargetsDto,
  TodayDto,
} from '@diet/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bodyMeasurement, checkin, maintenanceEstimate } from '../src/db/schema.js';
import { localToInstant } from '../src/lib/time.js';
import { runReminders } from '../src/services/push.js';
import { createTestDb, freshOwner } from './helpers.js';

const handle = createTestDb();
const { db, sql } = handle;
let clock = new Date('2026-11-05T11:00:00Z'); // Thursday
const app = createApp({ db, version: 'test', log: false, now: () => clock });

const send = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const json = async <T>(res: Response | Promise<Response>) =>
  (await res) && ((await (await res).json()) as T);

let userId: string;
beforeEach(async () => {
  userId = await freshOwner(handle);
  clock = new Date('2026-11-05T11:00:00Z');
});
afterAll(() => sql.end());

async function startSurplus(startedOn = '2026-08-24') {
  const res = await send('POST', '/phases', {
    type: 'surplus',
    startedOn,
    maintenanceKcal: 2040,
    bodyweightKg: 87,
    surplusPct: 0.1,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { targets: TargetsDto };
}

/** Morning weigh-ins every 3–4 days for six weeks, flat at `kg`. */
async function flatWeighIns(kg: number, untilLocalDate = '2026-11-05') {
  const end = new Date(`${untilLocalDate}T00:00:00Z`).getTime();
  for (let d = 42; d >= 0; d -= 3.5) {
    const day = new Date(end - Math.round(d) * 86_400_000).toISOString().slice(0, 10);
    await db.insert(bodyMeasurement).values({
      userId,
      measuredAt: localToInstant(`${day}T07:30`, 'Europe/Rome'),
      source: 'manual',
      weightKg: kg,
      protocolOk: true,
    });
  }
}

async function goodCheckins() {
  for (const weekStart of ['2026-10-26', '2026-11-02']) {
    await db.insert(checkin).values({
      userId,
      weekStart,
      adherence: 'on_plan',
      trainingProgressed: 'yes',
      sleep: 4,
      energy: 4,
      completedAt: clock,
    });
  }
}

describe('phases and targets', () => {
  it('builds the current Lean Surplus targets from maintenance 2040 at 87 kg', async () => {
    const { targets } = await startSurplus();
    expect(targets.training.kcal).toBeGreaterThanOrEqual(2305);
    expect(targets.training.kcal).toBeLessThanOrEqual(2320);
    expect(targets.rest.kcal).toBeGreaterThanOrEqual(2185);
    expect(targets.rest.kcal).toBeLessThanOrEqual(2200);
    expect(targets.training).toMatchObject({ proteinG: 165, fatG: 74 });

    const overview = await json<PlanOverviewDto>(send('GET', '/plan'));
    expect(overview.phase).toMatchObject({ type: 'surplus', rateBandKgPerWeek: [0.1, 0.2] });
    expect(overview.maintenance).toMatchObject({ kcal: 2040, method: 'phase_start' });
    expect(overview.nextReviewOn).toBe('2026-09-14');
  });

  it('accepts targets entered by hand', async () => {
    const day = (kcal: number, carbsG: number) => ({
      kcal,
      proteinG: 165,
      fatG: 75,
      carbsG,
      fibreG: 25,
    });
    const res = await send('POST', '/phases', {
      type: 'surplus',
      startedOn: '2026-08-24',
      maintenanceKcal: 2040,
      targets: { training: day(2320, 240), rest: day(2200, 215) },
    });
    const body = (await res.json()) as { targets: TargetsDto };
    expect(body.targets).toMatchObject({
      createdBy: 'manual',
      training: { kcal: 2320 },
      rest: { kcal: 2200 },
    });
  });

  it('closes the current phase when a new one starts, and refuses to start before it', async () => {
    await startSurplus('2026-08-24');
    expect(
      (
        await send('POST', '/phases', {
          type: 'cut',
          startedOn: '2026-08-01',
          maintenanceKcal: 2040,
          bodyweightKg: 87,
        })
      ).status,
    ).toBe(422);
    const res = await send('POST', '/phases', {
      type: 'maintenance',
      startedOn: '2026-11-01',
      maintenanceKcal: 2100,
      bodyweightKg: 87,
      targetWeightKg: 87,
    });
    expect(res.status).toBe(201);
    const overview = await json<PlanOverviewDto>(send('GET', '/plan'));
    expect(overview.phase).toMatchObject({ type: 'maintenance', targetWeightKg: 87 });
  });
});

describe('reviews', () => {
  it('holds and says what is missing when the trend is not decidable', async () => {
    await startSurplus();
    await db.insert(bodyMeasurement).values({
      userId,
      measuredAt: new Date('2026-11-02T07:00:00Z'),
      source: 'tanita_csv',
      weightKg: 86.75,
      protocolOk: true,
    });
    const review = await json<ReviewDto>(send('POST', '/reviews'));
    expect(review).toMatchObject({ outcome: 'hold', proposalId: null });
    expect(review.explanation).toContain('more weigh-in');
    const overview = await json<PlanOverviewDto>(send('GET', '/plan'));
    expect(overview.lastReview?.id).toBe(review.id);
    expect(overview.nextReviewOn).toBe('2026-11-26');
  });

  it('holds on the adherence gate without two good check-ins', async () => {
    await startSurplus();
    await flatWeighIns(87);
    const review = await json<ReviewDto>(send('POST', '/reviews'));
    expect(review.outcome).toBe('hold');
    expect(review.explanation).toContain('check-ins');
  });

  it('proposes more food when weight is flat, then applies it on approval', async () => {
    const { targets: before } = await startSurplus();
    await flatWeighIns(87);
    await goodCheckins();

    const review = await json<ReviewDto>(send('POST', '/reviews'));
    expect(review.outcome).toBe('change');

    // Flat weight at ~2244 kcal raises the maintenance estimate, which makes room under the ceiling.
    const estimates = await db
      .select()
      .from(maintenanceEstimate)
      .where(eq(maintenanceEstimate.method, 'adaptive'));
    expect(estimates[0]?.kcal).toBeGreaterThan(2040);

    const overview = await json<PlanOverviewDto>(send('GET', '/plan'));
    const proposal = overview.pendingProposal!;
    expect(proposal).toMatchObject({ kind: 'targets_change', status: 'pending' });
    expect(proposal.deltaKcal!.training).toBeGreaterThan(0);
    expect(overview.targets?.version).toBe(1); // nothing changes until approved

    const decided = await json<{ targets: TargetsDto }>(
      send('POST', `/proposals/${proposal.id}/approve`),
    );
    expect(decided.targets.version).toBe(2);
    expect(decided.targets.training.kcal).toBe(before.training.kcal + proposal.deltaKcal!.training);
    expect(decided.targets.training.proteinG).toBe(before.training.proteinG);
    expect((await send('POST', `/proposals/${proposal.id}/approve`)).status).toBe(409);
  });

  it('rejects a proposal without changing targets', async () => {
    await startSurplus();
    await flatWeighIns(87);
    await goodCheckins();
    await send('POST', '/reviews');
    const { pendingProposal } = await json<PlanOverviewDto>(send('GET', '/plan'));
    await send('POST', `/proposals/${pendingProposal!.id}/reject`);
    const overview = await json<PlanOverviewDto>(send('GET', '/plan'));
    expect(overview.pendingProposal).toBeNull();
    expect(overview.targets?.version).toBe(1);
  });

  it('needs a phase', async () => {
    expect((await send('POST', '/reviews')).status).toBe(409);
  });
});

describe('foods', () => {
  const chicken = {
    name: 'Chicken breast',
    kcal: 110,
    proteinG: 23,
    carbsG: 0,
    fatG: 1.5,
    fibreG: 0,
    basis: 'raw',
  };

  it('creates, searches and edits foods, keeping fields not sent', async () => {
    const created = await json<FoodDto>(
      send('POST', '/foods', { ...chicken, units: { slice: 190 } }),
    );
    expect(created).toMatchObject({ name: 'Chicken breast', units: { slice: 190 } });
    expect(await json<FoodDto[]>(send('GET', '/foods?q=chick'))).toHaveLength(1);
    expect(await json<FoodDto[]>(send('GET', '/foods?q=rice'))).toHaveLength(0);

    const edited = await json<FoodDto>(
      send('PATCH', `/foods/${created.id}`, { notes: 'Frozen slices' }),
    );
    expect(edited).toMatchObject({ kcal: 110, proteinG: 23, notes: 'Frozen slices' });
    const archived = await json<FoodDto>(send('PATCH', `/foods/${created.id}`, { archived: true }));
    expect(archived.archived).toBe(true);
    expect(await json<FoodDto[]>(send('GET', '/foods'))).toHaveLength(0);
  });

  it('catches label typos where energy does not match the macros', async () => {
    const res = await send('POST', '/foods', { ...chicken, kcal: 23, proteinG: 110 });
    expect(res.status).toBe(422);
    const swapped = await send('POST', '/foods', { ...chicken, kcal: 400 });
    expect(await swapped.json()).toMatchObject({ error: 'energy_mismatch' });
  });
});

describe('meal plans and today', () => {
  async function seedFoods() {
    const make = (body: object) => json<FoodDto>(send('POST', '/foods', body));
    const oats = await make({
      name: 'Oats',
      kcal: 372,
      proteinG: 13.5,
      carbsG: 58.7,
      fatG: 7,
      fibreG: 10,
      basis: 'dry',
    });
    const yogurt = await make({
      name: 'Greek yogurt 0%',
      kcal: 57,
      proteinG: 10,
      carbsG: 4,
      fatG: 0,
      units: { cup: 150 },
    });
    return { oats, yogurt };
  }

  function weekWith(breakfast: PlanDocument['days'][number]['meals'][number]): PlanDocument {
    return { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, meals: [breakfast] })) };
  }

  it('saves a plan with snapshots, activates it, and shows today', async () => {
    await startSurplus();
    const { oats, yogurt } = await seedFoods();
    const plan = await json<MealPlanDto>(send('POST', '/plans', { name: 'Lean Surplus' }));
    expect(plan.document.days).toHaveLength(7);

    const doc = weekWith({
      slot: 'breakfast',
      options: [
        {
          label: 'A',
          items: [
            { foodId: oats.id, grams: 40 },
            { foodId: yogurt.id, grams: 150, display: { unit: 'cup', qty: 1 } },
          ],
        },
      ],
    });
    const saved = await json<MealPlanDto>(send('PUT', `/plans/${plan.id}`, { document: doc }));
    expect(saved.document.days[0]!.meals[0]!.options[0]!.items[0]!.snapshot).toMatchObject({
      name: 'Oats',
      kcal: 372,
    });

    // Editing the food later must not rewrite the saved plan.
    await send('PATCH', `/foods/${oats.id}`, { kcal: 380, carbsG: 60 });
    const reread = await json<MealPlanDto>(send('GET', `/plans/${plan.id}`));
    expect(reread.document.days[0]!.meals[0]!.options[0]!.items[0]!.snapshot?.kcal).toBe(372);

    expect((await send('POST', `/plans/${plan.id}/activate`)).status).toBe(200);
    const today = await json<TodayDto>(send('GET', '/today'));
    expect(today).toMatchObject({ date: '2026-11-05', weekday: 4, dayType: 'rest' });
    expect(today.targets?.kcal).toBeGreaterThan(2100);
    expect(today.plan?.day.meals[0]!.slot).toBe('breakfast');
  });

  it('rejects plans that reference unknown foods or repeat a slot', async () => {
    const plan = await json<MealPlanDto>(send('POST', '/plans', { name: 'P' }));
    const unknown = weekWith({
      slot: 'lunch',
      options: [
        { label: 'A', items: [{ foodId: '00000000-0000-4000-8000-000000000000', grams: 100 }] },
      ],
    });
    expect(
      await (await send('PUT', `/plans/${plan.id}`, { document: unknown })).json(),
    ).toMatchObject({
      error: 'unknown_food',
    });
    const { oats } = await seedFoods();
    const meal = {
      slot: 'lunch' as const,
      options: [{ label: 'A', items: [{ foodId: oats.id, grams: 50 }] }],
    };
    const doubled: PlanDocument = {
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, meals: [meal, meal] })),
    };
    expect((await send('PUT', `/plans/${plan.id}`, { document: doubled })).status).toBe(422);
  });

  it('archives the previous plan on activation and refuses empty plans', async () => {
    const { oats } = await seedFoods();
    const doc = weekWith({
      slot: 'lunch',
      options: [{ label: 'A', items: [{ foodId: oats.id, grams: 80 }] }],
    });
    const first = await json<MealPlanDto>(send('POST', '/plans', { name: 'First' }));
    expect((await send('POST', `/plans/${first.id}/activate`)).status).toBe(422);
    await send('PUT', `/plans/${first.id}`, { document: doc });
    await send('POST', `/plans/${first.id}/activate`);
    const second = await json<MealPlanDto>(
      send('POST', '/plans', { name: 'Second', copyFrom: first.id }),
    );
    expect(second.document.days[0]!.meals).toHaveLength(1);
    await send('POST', `/plans/${second.id}/activate`);
    const plans = await json<MealPlanDto[]>(send('GET', '/plans'));
    expect(plans.find((p) => p.id === first.id)?.status).toBe('archived');
    expect(plans.find((p) => p.id === second.id)?.status).toBe('active');
    expect((await send('PUT', `/plans/${first.id}`, { name: 'x' })).status).toBe(409);
  });
});

describe('review fixes', () => {
  it('expires a pending proposal when targets are set by hand, and rejects stale approvals', async () => {
    await startSurplus();
    await flatWeighIns(87);
    await goodCheckins();
    await send('POST', '/reviews');
    const before = await json<PlanOverviewDto>(send('GET', '/plan'));
    expect(before.pendingProposal).not.toBeNull();

    const day = (kcal: number) => ({ kcal, proteinG: 170, fatG: 75, carbsG: 230, fibreG: 25 });
    await send('POST', '/targets', {
      targets: { training: day(2320), rest: day(2200) },
      reasoning: 'By hand',
    });
    const after = await json<PlanOverviewDto>(send('GET', '/plan'));
    expect(after.pendingProposal).toBeNull();
    const res = await send('POST', `/proposals/${before.pendingProposal!.id}/approve`);
    expect(res.status).toBe(409);
  });

  it('expires a proposal whose base targets were replaced in another way', async () => {
    await startSurplus();
    await flatWeighIns(87);
    await goodCheckins();
    await send('POST', '/reviews');
    const { pendingProposal } = await json<PlanOverviewDto>(send('GET', '/plan'));
    await sql`update proposal set payload = jsonb_set(payload, '{baseTargetsId}', '"00000000-0000-4000-8000-000000000000"')`;
    const res = await send('POST', `/proposals/${pendingProposal!.id}/approve`);
    expect(await res.json()).toMatchObject({ error: 'stale_proposal' });
    const [row] = await sql`select status from proposal where id = ${pendingProposal!.id}`;
    expect(row?.status).toBe('expired');
    expect((await json<PlanOverviewDto>(send('GET', '/plan'))).targets?.version).toBe(1);
  });

  it('refuses a phase that starts in the future, or whose targets cannot be met', async () => {
    const future = await send('POST', '/phases', {
      type: 'surplus',
      startedOn: '2026-11-09',
      maintenanceKcal: 2040,
      bodyweightKg: 87,
    });
    expect(await future.json()).toMatchObject({ error: 'future_start' });
    const infeasible = await send('POST', '/phases', {
      type: 'maintenance',
      startedOn: '2026-11-01',
      maintenanceKcal: 1000,
      bodyweightKg: 150,
    });
    expect(await infeasible.json()).toMatchObject({ error: 'infeasible_targets' });
  });

  it('starts the water grace period when a new phase cuts carbs a lot', async () => {
    await startSurplus('2026-08-24');
    const res = await send('POST', '/phases', {
      type: 'cut',
      startedOn: '2026-11-01',
      maintenanceKcal: 2300,
      bodyweightKg: 87,
    });
    const { targets } = (await res.json()) as { targets: TargetsDto };
    expect(targets.carbChangeG).toBeLessThanOrEqual(-40);
    await flatWeighIns(87);
    await goodCheckins();
    const review = await json<ReviewDto>(send('POST', '/reviews'));
    expect(review.outcome).toBe('hold');
  });

  it('ignores check-ins older than three weeks', async () => {
    await startSurplus();
    await flatWeighIns(87);
    for (const weekStart of ['2026-08-31', '2026-09-07']) {
      await db
        .insert(checkin)
        .values({ userId, weekStart, adherence: 'on_plan', trainingProgressed: 'yes' });
    }
    const review = await json<ReviewDto>(send('POST', '/reviews'));
    expect(review.outcome).toBe('hold');
    expect(review.explanation).toContain('check-ins');
  });

  it('keeps saved snapshots when the rest of the plan is edited after a food changes', async () => {
    const oats = await json<FoodDto>(
      send('POST', '/foods', { name: 'Oats', kcal: 372, proteinG: 13.5, carbsG: 58.7, fatG: 7 }),
    );
    const plan = await json<MealPlanDto>(send('POST', '/plans', { name: 'P' }));
    const meal = (slot: 'breakfast' | 'dinner') => ({
      slot,
      options: [{ label: 'A', items: [{ foodId: oats.id, grams: 40 }] }],
    });
    const first = await json<MealPlanDto>(
      send('PUT', `/plans/${plan.id}`, {
        document: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, meals: [meal('breakfast')] })),
        },
      }),
    );
    await send('PATCH', `/foods/${oats.id}`, { kcal: 380, carbsG: 60 });
    // Send back what the server gave us, plus a new dinner on Monday.
    const doc = structuredClone(first.document);
    doc.days[0]!.meals.push(meal('dinner'));
    const second = await json<MealPlanDto>(send('PUT', `/plans/${plan.id}`, { document: doc }));
    const monday = second.document.days[0]!;
    expect(monday.meals[0]!.options[0]!.items[0]!.snapshot?.kcal).toBe(372);
    expect(monday.meals[1]!.options[0]!.items[0]!.snapshot?.kcal).toBe(380);

    // A snapshot the server never issued is replaced.
    doc.days[1]!.meals[0]!.options[0]!.items[0]!.snapshot = {
      name: 'Oats',
      kcal: 1,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      fibreG: null,
    };
    const third = await json<MealPlanDto>(send('PUT', `/plans/${plan.id}`, { document: doc }));
    expect(third.document.days[1]!.meals[0]!.options[0]!.items[0]!.snapshot?.kcal).toBe(380);
  });

  it('runs a due review at midday even without push configured', async () => {
    await startSurplus('2026-10-01');
    await db.insert(bodyMeasurement).values({
      userId,
      measuredAt: new Date('2026-11-02T07:00:00Z'),
      source: 'manual',
      weightKg: 86.8,
      protocolOk: true,
    });
    const at = (local: string) => localToInstant(local, 'Europe/Rome');
    expect(await runReminders(db, null, at('2026-11-05T11:30'))).toEqual([]);
    expect(await runReminders(db, null, at('2026-11-05T12:01'))).toEqual(['review']);
    expect(await runReminders(db, null, at('2026-11-05T12:30'))).toEqual([]);
    const overview = await json<PlanOverviewDto>(send('GET', '/plan'));
    expect(overview.lastReview?.ranOn).toBe('2026-11-05');
  });
});
