import type { CheckinDto, CurrentCheckinDto, GirthDto, SaveCheckinRequest } from '@diet/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bodyMeasurement, checkin, girthMeasurement } from '../db/schema.js';
import { HttpError } from '../lib/http.js';
import type { Profile } from '../lib/owner.js';
import { addDays, isoWeekStart, localParts, localToInstant } from '../lib/time.js';
import { addWeight } from './measurements.js';

type Girth = typeof girthMeasurement.$inferSelect;
type Checkin = typeof checkin.$inferSelect;

export function toGirthDto(g: Girth): GirthDto {
  return {
    measuredOn: g.measuredOn,
    waistCm: g.waistCm,
    chestCm: g.chestCm,
    bicepsCm: g.bicepsCm,
    quadCm: g.quadCm,
  };
}

async function toCheckinDto(db: Db, c: Checkin): Promise<CheckinDto> {
  const [measurement] = c.measurementId
    ? await db.select().from(bodyMeasurement).where(eq(bodyMeasurement.id, c.measurementId))
    : [];
  const [girth] = c.girthId
    ? await db.select().from(girthMeasurement).where(eq(girthMeasurement.id, c.girthId))
    : [];
  return {
    weekStart: c.weekStart,
    adherence: c.adherence as CheckinDto['adherence'],
    trainingProgressed: c.trainingProgressed as CheckinDto['trainingProgressed'],
    sleep: c.sleep,
    energy: c.energy,
    hunger: c.hunger,
    notes: c.notes,
    completedAt: c.completedAt?.toISOString() ?? null,
    weightKg: measurement?.weightKg ?? null,
    girth: girth ? toGirthDto(girth) : null,
  };
}

/** A check-in counts as complete once the two answers that gate decisions are in. */
function isComplete(c: Pick<Checkin, 'adherence' | 'trainingProgressed'>): boolean {
  return c.adherence != null && c.trainingProgressed != null;
}

export async function currentCheckin(
  db: Db,
  owner: Profile,
  now: Date,
): Promise<CurrentCheckinDto> {
  const today = localParts(now, owner.timezone).date;
  const weekStart = isoWeekStart(today);
  const [row] = await db
    .select()
    .from(checkin)
    .where(and(eq(checkin.userId, owner.userId), eq(checkin.weekStart, weekStart)));
  const [latest] = await db
    .select({ measuredAt: bodyMeasurement.measuredAt, weightKg: bodyMeasurement.weightKg })
    .from(bodyMeasurement)
    .where(
      and(
        eq(bodyMeasurement.userId, owner.userId),
        gte(bodyMeasurement.measuredAt, localToInstant(`${weekStart}T00:00`, owner.timezone)),
      ),
    )
    .orderBy(desc(bodyMeasurement.measuredAt))
    .limit(1);

  return {
    weekStart,
    today,
    checkin: row ? await toCheckinDto(db, row) : null,
    latestWeightThisWeek: latest
      ? { measuredAt: latest.measuredAt.toISOString(), weightKg: latest.weightKg }
      : null,
    due: !row || !isComplete(row),
  };
}

/**
 * Saves (creates or updates) the check-in of a week. A weight creates or updates a reading
 * now. Only fields present in the request change.
 */
export async function saveCheckin(
  db: Db,
  owner: Profile,
  weekStart: string,
  input: SaveCheckinRequest,
  now: Date,
): Promise<CheckinDto> {
  const today = localParts(now, owner.timezone).date;
  if (isoWeekStart(weekStart) !== weekStart) {
    throw new HttpError(422, 'not_a_monday', `${weekStart} is not a Monday.`);
  }
  // A check-in can be filled in late, but not for a week that hasn't started.
  if (weekStart > today || weekStart < addDays(isoWeekStart(today), -7 * 52)) {
    throw new HttpError(422, 'week_out_of_range', `${weekStart} is outside the editable range.`);
  }

  let measurementId: string | undefined;
  if (input.weightKg != null) {
    const { measurement } = await addWeight(db, owner.userId, owner.timezone, {
      weightKg: input.weightKg,
      measuredAt: now,
      source: 'manual',
    });
    measurementId = measurement.id;
  }

  const girthFields = {
    ...(input.waistCm !== undefined && { waistCm: input.waistCm }),
    ...(input.chestCm !== undefined && { chestCm: input.chestCm }),
    ...(input.bicepsCm !== undefined && { bicepsCm: input.bicepsCm }),
    ...(input.quadCm !== undefined && { quadCm: input.quadCm }),
  };
  const answers = {
    ...(input.adherence !== undefined && { adherence: input.adherence }),
    ...(input.trainingProgressed !== undefined && { trainingProgressed: input.trainingProgressed }),
    ...(input.sleep !== undefined && { sleep: input.sleep }),
    ...(input.energy !== undefined && { energy: input.energy }),
    ...(input.hunger !== undefined && { hunger: input.hunger }),
    ...(input.notes !== undefined && { notes: input.notes }),
    ...(measurementId && { measurementId }),
  };

  // One transaction, serialised per week, so concurrent saves can't interleave and the
  // completion timestamp always matches the answers it was computed from.
  const saved = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`checkin:${owner.userId}:${weekStart}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(checkin)
      .where(and(eq(checkin.userId, owner.userId), eq(checkin.weekStart, weekStart)));

    // Tape measurements belong to the check-in: editing them later in the week updates the
    // same row (omitted fields kept); the first ones of the week are stored for today.
    let girthId = existing?.girthId ?? undefined;
    if (Object.keys(girthFields).length > 0) {
      if (girthId) {
        await tx.update(girthMeasurement).set(girthFields).where(eq(girthMeasurement.id, girthId));
      } else {
        const [g] = await tx
          .insert(girthMeasurement)
          .values({ userId: owner.userId, measuredOn: today, ...girthFields })
          .onConflictDoUpdate({
            target: [girthMeasurement.userId, girthMeasurement.measuredOn],
            set: girthFields,
          })
          .returning({ id: girthMeasurement.id });
        girthId = g?.id;
      }
    }

    const merged = { ...existing, ...answers };
    const complete = isComplete({
      adherence: merged.adherence ?? null,
      trainingProgressed: merged.trainingProgressed ?? null,
    });
    // completedAt records when it first became complete, and clears if an answer is removed.
    const completedAt = complete ? (existing?.completedAt ?? now) : null;
    const values = { ...answers, ...(girthId && { girthId }), completedAt };

    const [row] = existing
      ? await tx.update(checkin).set(values).where(eq(checkin.id, existing.id)).returning()
      : await tx
          .insert(checkin)
          .values({ userId: owner.userId, weekStart, ...values })
          .returning();
    if (!row) throw new Error('Check-in was not saved');
    return row;
  });
  return toCheckinDto(db, saved);
}

export async function listGirths(db: Db, userId: string): Promise<GirthDto[]> {
  const rows = await db
    .select()
    .from(girthMeasurement)
    .where(eq(girthMeasurement.userId, userId))
    .orderBy(girthMeasurement.measuredOn);
  return rows.map(toGirthDto);
}
