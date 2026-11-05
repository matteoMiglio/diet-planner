import type { FoodDto, FoodInput, FoodPatch, MealPlanDto } from '@diet/shared';
import { PlanDocument, SLOTS } from '@diet/shared';
import { and, asc, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { food, mealPlan } from '../db/schema.js';
import { HttpError } from '../lib/http.js';

type Food = typeof food.$inferSelect;
type MealPlan = typeof mealPlan.$inferSelect;

export function toFoodDto(f: Food): FoodDto {
  return {
    id: f.id,
    name: f.name,
    brand: f.brand,
    kcal: f.kcal,
    proteinG: f.proteinG,
    carbsG: f.carbsG,
    fatG: f.fatG,
    fibreG: f.fibreG,
    basis: f.basis as FoodDto['basis'],
    units: f.units,
    notes: f.notes,
    archived: f.archived,
    sugarG: f.sugarG,
    satFatG: f.satFatG,
    saltG: f.saltG,
    product: f.barcode
      ? {
          barcode: f.barcode,
          source: f.source as NonNullable<FoodDto['product']>['source'],
          nutriscoreGrade: f.nutriscoreGrade,
          category: f.nutriCategory as NonNullable<FoodDto['product']>['category'],
          novaGroup: f.novaGroup,
          additives: f.additives,
          ingredientsText: f.ingredientsText,
        }
      : null,
    pool: {
      inPool: f.inPool,
      role: f.role as FoodDto['pool']['role'],
      preferredSlots: f.preferredSlots as FoodDto['pool']['preferredSlots'],
      priority: f.priority as FoodDto['pool']['priority'],
      portion: f.portion,
    },
  };
}

/** Flattens the API's nested `pool` into the food table's columns. */
function poolColumns(pool: FoodInput['pool']) {
  return pool
    ? {
        inPool: pool.inPool,
        role: pool.role,
        preferredSlots: pool.preferredSlots,
        priority: pool.priority,
        portion: pool.portion,
      }
    : {};
}

/** A fixed-unit portion must name one of the food's own units. */
function checkPortionUnit(units: Record<string, number>, pool: FoodInput['pool']) {
  if (pool?.portion.kind === 'fixed_unit' && !(pool.portion.unit in units)) {
    throw new HttpError(
      422,
      'unknown_unit',
      `Portion unit "${pool.portion.unit}" isn't one of this food's portions.`,
    );
  }
}

export function toPlanDto(p: MealPlan): MealPlanDto {
  return {
    id: p.id,
    name: p.name,
    status: p.status as MealPlanDto['status'],
    phaseId: p.phaseId,
    document: p.document as PlanDocument,
    activatedAt: p.activatedAt?.toISOString() ?? null,
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ---------- Foods ----------

export async function listFoods(
  db: Db,
  userId: string,
  { q, includeArchived }: { q?: string | undefined; includeArchived?: boolean },
) {
  const conditions = [eq(food.userId, userId)];
  if (!includeArchived) conditions.push(eq(food.archived, false));
  if (q) conditions.push(ilike(food.name, `%${q.replace(/[%_\\]/g, '\\$&')}%`));
  const rows = await db
    .select()
    .from(food)
    .where(and(...conditions))
    .orderBy(asc(food.name))
    .limit(200);
  return rows.map(toFoodDto);
}

function checkEnergy(input: Pick<FoodInput, 'kcal' | 'proteinG' | 'carbsG' | 'fatG'>) {
  // Catches typos such as kcal and protein swapped: label energy is within ~20% of 4/4/9.
  const fromMacros = input.proteinG * 4 + input.carbsG * 4 + input.fatG * 9;
  if (input.proteinG + input.carbsG + input.fatG > 100) {
    throw new HttpError(
      422,
      'macros_over_100',
      'Protein, carbs and fat add up to more than 100 g per 100 g.',
    );
  }
  if (fromMacros > 40 && Math.abs(input.kcal - fromMacros) / fromMacros > 0.25) {
    throw new HttpError(
      422,
      'energy_mismatch',
      `Energy ${input.kcal} kcal doesn't match the macros (${Math.round(fromMacros)} kcal). Check the label.`,
    );
  }
}

/** Barcodes arrive canonical (FoodInput normalises them), so equal codes compare equal. */
async function checkBarcodeFree(db: Db, userId: string, barcode: string) {
  const [taken] = await db
    .select({ id: food.id })
    .from(food)
    .where(and(eq(food.userId, userId), eq(food.barcode, barcode)));
  if (taken) throw new HttpError(409, 'barcode_taken', 'A food with this barcode already exists.');
}

export async function createFood(db: Db, userId: string, input: FoodInput) {
  checkEnergy(input);
  checkPortionUnit(input.units ?? {}, input.pool);
  if (input.barcode) await checkBarcodeFree(db, userId, input.barcode);
  const [row] = await db
    .insert(food)
    .values({
      userId,
      name: input.name,
      brand: input.brand ?? null,
      kcal: input.kcal,
      proteinG: input.proteinG,
      carbsG: input.carbsG,
      fatG: input.fatG,
      fibreG: input.fibreG ?? null,
      basis: input.basis ?? 'as_sold',
      units: input.units ?? {},
      notes: input.notes ?? null,
      barcode: input.barcode ?? null,
      sugarG: input.sugarG ?? null,
      satFatG: input.satFatG ?? null,
      saltG: input.saltG ?? null,
      ...poolColumns(input.pool),
    })
    .returning();
  return toFoodDto(row!);
}

export async function updateFood(db: Db, userId: string, id: string, input: FoodPatch) {
  const [existing] = await db
    .select()
    .from(food)
    .where(and(eq(food.id, id), eq(food.userId, userId)));
  if (!existing) throw new HttpError(404, 'not_found', 'No such food.');
  // Only the fields sent change; an omitted field must not count as "cleared".
  const patch = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as FoodPatch;
  checkEnergy({ ...existing, ...patch } as FoodInput);
  // Check the food as it will be after the update: new units against the existing pool rule too.
  checkPortionUnit(patch.units ?? existing.units, patch.pool ?? toFoodDto(existing).pool);
  if (patch.barcode && patch.barcode !== existing.barcode)
    await checkBarcodeFree(db, userId, patch.barcode);
  const { pool, ...columns } = patch;
  const [row] = await db
    .update(food)
    .set({ ...columns, ...poolColumns(pool) })
    .where(eq(food.id, id))
    .returning();
  return toFoodDto(row!);
}

// ---------- Plans ----------

/** Key-order-independent form of a snapshot: JSONB and the schema order keys differently. */
function canonical(snapshot: object): string {
  return JSON.stringify(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Validates a plan document and fills in item snapshots. An item that still carries a
 * snapshot the server stored before (in `previous`) keeps it, so saving one meal never
 * re-prices the rest of the week after a food was edited; new items get the food's current
 * values. Snapshots the server never issued are ignored. Unknown foods are an error.
 */
async function withSnapshots(
  db: Db,
  userId: string,
  raw: unknown,
  previous: PlanDocument | null,
): Promise<PlanDocument> {
  const parsed = PlanDocument.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, 'invalid_plan', 'The plan is invalid.', parsed.error.issues);
  }
  const doc = parsed.data;
  const ids = [
    ...new Set(
      doc.days.flatMap((d) =>
        d.meals.flatMap((m) => m.options.flatMap((o) => o.items.map((i) => i.foodId))),
      ),
    ),
  ];
  const foods = ids.length
    ? await db
        .select()
        .from(food)
        .where(and(eq(food.userId, userId), inArray(food.id, ids)))
    : [];
  const byId = new Map(foods.map((f) => [f.id, f]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new HttpError(
      422,
      'unknown_food',
      `The plan uses ${missing.length} food(s) that don't exist.`,
      missing,
    );
  }
  const issued = new Set<string>();
  for (const day of previous?.days ?? []) {
    for (const meal of day.meals) {
      for (const option of meal.options) {
        for (const item of option.items) {
          if (item.snapshot) issued.add(`${item.foodId}|${canonical(item.snapshot)}`);
        }
      }
    }
  }
  for (const day of doc.days) {
    day.meals.sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
    for (const meal of day.meals) {
      for (const option of meal.options) {
        for (const item of option.items) {
          if (item.snapshot && issued.has(`${item.foodId}|${canonical(item.snapshot)}`)) continue;
          const f = byId.get(item.foodId)!;
          item.snapshot = {
            name: f.brand ? `${f.name} (${f.brand})` : f.name,
            kcal: f.kcal,
            proteinG: f.proteinG,
            carbsG: f.carbsG,
            fatG: f.fatG,
            fibreG: f.fibreG,
          };
        }
      }
    }
  }
  doc.days.sort((a, b) => a.weekday - b.weekday);
  return doc;
}

export async function listPlans(db: Db, userId: string) {
  const rows = await db
    .select()
    .from(mealPlan)
    .where(eq(mealPlan.userId, userId))
    .orderBy(desc(mealPlan.updatedAt));
  return rows.map(toPlanDto);
}

export async function getPlan(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(mealPlan)
    .where(and(eq(mealPlan.id, id), eq(mealPlan.userId, userId)));
  if (!row) throw new HttpError(404, 'not_found', 'No such plan.');
  return row;
}

export async function activePlan(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(mealPlan)
    .where(and(eq(mealPlan.userId, userId), eq(mealPlan.status, 'active')));
  return row ?? null;
}

export async function createPlan(
  db: Db,
  userId: string,
  input: { name: string; document: unknown; phaseId: string | null; copiedFrom?: PlanDocument },
) {
  const document = await withSnapshots(db, userId, input.document, input.copiedFrom ?? null);
  const [row] = await db
    .insert(mealPlan)
    .values({ userId, name: input.name, document, phaseId: input.phaseId })
    .returning();
  return toPlanDto(row!);
}

export async function savePlan(
  db: Db,
  userId: string,
  id: string,
  input: { name?: string | undefined; document?: unknown },
) {
  const existing = await getPlan(db, userId, id);
  if (existing.status === 'archived') {
    throw new HttpError(409, 'archived', 'Archived plans are read-only; copy it to a new plan.');
  }
  const document =
    input.document !== undefined
      ? await withSnapshots(db, userId, input.document, existing.document as PlanDocument)
      : undefined;
  const [row] = await db
    .update(mealPlan)
    .set({ ...(input.name && { name: input.name }), ...(document && { document }) })
    .where(eq(mealPlan.id, id))
    .returning();
  return toPlanDto(row!);
}

/** Makes a plan the active one; the previously active plan is archived. */
export async function activatePlan(db: Db, userId: string, id: string, now: Date) {
  return db.transaction(async (tx) => {
    // One activation at a time per user: two drafts activated at once must not both win.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plans:${userId}`}))`);
    const [target] = await tx
      .select()
      .from(mealPlan)
      .where(and(eq(mealPlan.id, id), eq(mealPlan.userId, userId)));
    if (!target) throw new HttpError(404, 'not_found', 'No such plan.');
    if (target.status === 'active') return toPlanDto(target);
    if (target.status === 'archived')
      throw new HttpError(409, 'archived', 'Archived plans cannot be activated.');
    const doc = target.document as PlanDocument;
    if (doc.days.every((d) => d.meals.length === 0)) {
      throw new HttpError(422, 'empty_plan', 'Add at least one meal before activating the plan.');
    }
    await tx
      .update(mealPlan)
      .set({ status: 'archived' })
      .where(and(eq(mealPlan.userId, userId), eq(mealPlan.status, 'active'), ne(mealPlan.id, id)));
    const [row] = await tx
      .update(mealPlan)
      .set({ status: 'active', activatedAt: now })
      .where(eq(mealPlan.id, id))
      .returning();
    return toPlanDto(row!);
  });
}
