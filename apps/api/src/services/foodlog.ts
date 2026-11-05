/**
 * The food log (extras beyond the plan) and the context a scanned product is scored in:
 * today's budget left, the current meal, and the rules it would break.
 */
import type {
  FoodLogDayDto,
  FoodLogEntryDto,
  LogFoodRequest,
  PlanDocument,
  Role,
  RuleSpec,
  ScanContextDto,
  Slot,
} from '@diet/shared';
import { countedUnits, dayMacros } from '@diet/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { food, foodLog } from '../db/schema.js';
import { HttpError } from '../lib/http.js';
import type { Profile } from '../lib/owner.js';
import { localParts } from '../lib/time.js';
import { activePhase, currentTargets, toTargetsDto } from './phases.js';
import { activePlan } from './plans.js';
import { listRules } from './rules.js';

type Entry = typeof foodLog.$inferSelect;
const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function toEntryDto(e: Entry): FoodLogEntryDto {
  return {
    id: e.id,
    loggedOn: e.loggedOn,
    slot: e.slot,
    foodId: e.foodId,
    name: e.name,
    grams: e.grams,
    kcal: e.kcal,
    proteinG: e.proteinG,
    carbsG: e.carbsG,
    fatG: e.fatG,
    via: e.via as FoodLogEntryDto['via'],
    createdAt: e.createdAt.toISOString(),
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export async function logFood(db: Db, owner: Profile, input: LogFoodRequest, now: Date) {
  const [f] = await db
    .select()
    .from(food)
    .where(and(eq(food.id, input.foodId), eq(food.userId, owner.userId)));
  if (!f) throw new HttpError(404, 'not_found', 'No such food.');
  const k = input.grams / 100;
  const [row] = await db
    .insert(foodLog)
    .values({
      userId: owner.userId,
      loggedOn: input.date ?? localParts(now, owner.timezone).date,
      slot: input.slot ?? currentSlot(now, owner.timezone),
      foodId: f.id,
      name: f.brand ? `${f.name} (${f.brand})` : f.name,
      grams: input.grams,
      kcal: round1(f.kcal * k),
      proteinG: round1(f.proteinG * k),
      carbsG: round1(f.carbsG * k),
      fatG: round1(f.fatG * k),
      fibreG: f.fibreG === null ? null : round1(f.fibreG * k),
      via: input.via,
    })
    .returning();
  return toEntryDto(row!);
}

export async function logDay(db: Db, userId: string, date: string): Promise<FoodLogDayDto> {
  const rows = await db
    .select()
    .from(foodLog)
    .where(and(eq(foodLog.userId, userId), eq(foodLog.loggedOn, date)))
    .orderBy(asc(foodLog.createdAt));
  const totals = rows.reduce(
    (t, r) => ({
      kcal: t.kcal + r.kcal,
      proteinG: t.proteinG + r.proteinG,
      carbsG: t.carbsG + r.carbsG,
      fatG: t.fatG + r.fatG,
    }),
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );
  return {
    date,
    entries: rows.map(toEntryDto),
    totals: {
      kcal: Math.round(totals.kcal),
      proteinG: Math.round(totals.proteinG),
      carbsG: Math.round(totals.carbsG),
      fatG: Math.round(totals.fatG),
    },
  };
}

export async function deleteEntry(db: Db, userId: string, id: string) {
  const deleted = await db
    .delete(foodLog)
    .where(and(eq(foodLog.id, id), eq(foodLog.userId, userId)))
    .returning({ id: foodLog.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'No such entry.');
}

/** The meal you're most likely deciding about, from the local time of day. */
export function currentSlot(now: Date, timeZone: string): Slot {
  const m = localParts(now, timeZone).minutes;
  if (m < 10 * 60 + 30) return 'breakfast';
  if (m < 12 * 60) return 'morning_snack';
  if (m < 15 * 60) return 'lunch';
  if (m < 18 * 60 + 30) return 'afternoon_snack';
  if (m < 22 * 60) return 'dinner';
  return 'evening_snack';
}

/** Rules a food would break if eaten today, given the plan and what's logged. */
function conflictsFor(
  foodId: string,
  foodName: string,
  rules: { spec: RuleSpec; text: string }[],
  today: {
    isoWeekday: number;
    dayType: 'training' | 'rest';
    eatenIds: string[];
    eatenUnits: Map<string, number>;
  },
): string[] {
  const out: string[] = [];
  for (const { spec, text } of rules) {
    if (!('foodIds' in spec) || !spec.foodIds.includes(foodId)) continue;
    switch (spec.kind) {
      case 'exclude_food':
        out.push(`You've ruled out ${foodName}. (${text})`);
        break;
      case 'forbidden_on_day_type':
        if (spec.dayType === today.dayType) out.push(`Not on ${spec.dayType} days. (${text})`);
        break;
      case 'allowed_weekdays':
        if (!spec.weekdays.includes(today.isoWeekday)) {
          out.push(`Not on ${WEEKDAY[today.isoWeekday - 1]}s. (${text})`);
        }
        break;
      case 'not_same_day': {
        const other = spec.foodIds.find((id) => id !== foodId && today.eatenIds.includes(id));
        if (other) out.push(`Clashes with something already planned or eaten today. (${text})`);
        break;
      }
      case 'max_items_per_day': {
        const used = spec.foodIds.reduce((sum, id) => sum + (today.eatenUnits.get(id) ?? 0), 0);
        if (used >= spec.max)
          out.push(`Today already has ${used} of the ${spec.max} allowed. (${text})`);
        break;
      }
    }
  }
  return out;
}

export async function scanContext(
  db: Db,
  owner: Profile,
  foodRow: { id: string; name: string } | null,
  now: Date,
): Promise<ScanContextDto> {
  const local = localParts(now, owner.timezone);
  const dayType = owner.trainingWeekdays.includes(local.isoWeekday) ? 'training' : 'rest';
  const slot = currentSlot(now, owner.timezone);
  const p = await activePhase(db, owner.userId);
  const t = p ? await currentTargets(db, p.id, local.date) : null;
  const plan = await activePlan(db, owner.userId);
  const day = (plan?.document as PlanDocument | undefined)?.days.find(
    (d) => d.weekday === local.isoWeekday,
  );
  const logged = await logDay(db, owner.userId, local.date);

  const planned = day ? dayMacros(day) : { kcal: 0, fatG: 0 };
  const target = t ? toTargetsDto(t)[dayType] : null;
  const remaining = target
    ? {
        kcal: Math.round(target.kcal - planned.kcal - logged.totals.kcal),
        fatG: Math.round(target.fatG - planned.fatG - logged.totals.fatG),
      }
    : null;

  const pool = await db
    .select({ role: food.role, preferredSlots: food.preferredSlots })
    .from(food)
    .where(and(eq(food.userId, owner.userId), eq(food.inPool, true), eq(food.archived, false)));
  const slotRoles = [
    ...new Set(pool.filter((f) => f.preferredSlots.includes(slot)).map((f) => f.role as Role)),
  ];

  let conflicts: string[] = [];
  if (foodRow) {
    // What today already holds: the plan's default options plus logged extras, counted in
    // units as the plan validator does (two 150 g cups in one item are two).
    const eaten = [
      ...(day?.meals ?? []).flatMap((m) => m.options[0]?.items ?? []),
      ...logged.entries.flatMap((e) => (e.foodId ? [{ foodId: e.foodId, grams: e.grams }] : [])),
    ];
    const ids = [...new Set(eaten.map((e) => e.foodId))];
    const unitInfo = new Map(
      ids.length
        ? (
            await db
              .select({ id: food.id, portion: food.portion, units: food.units })
              .from(food)
              .where(and(eq(food.userId, owner.userId), inArray(food.id, ids)))
          ).map((f) => [f.id, f] as const)
        : [],
    );
    const eatenUnits = new Map<string, number>();
    for (const e of eaten) {
      const n = countedUnits(unitInfo.get(e.foodId), e.grams);
      eatenUnits.set(e.foodId, (eatenUnits.get(e.foodId) ?? 0) + n);
    }
    const rules = await listRules(db, owner.userId, { activeOnly: true });
    conflicts = conflictsFor(foodRow.id, foodRow.name, rules, {
      isoWeekday: local.isoWeekday,
      dayType,
      eatenIds: [...eatenUnits.keys()],
      eatenUnits,
    });
  }

  return {
    phase: (p?.type as ScanContextDto['phase']) ?? null,
    remaining,
    slot,
    slotRoles,
    conflicts,
  };
}
