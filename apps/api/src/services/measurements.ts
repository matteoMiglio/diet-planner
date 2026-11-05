import type { TanitaRow } from '@diet/shared';
import { and, asc, between, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bodyMeasurement } from '../db/schema.js';
import { isProtocolTime, localToInstant } from '../lib/time.js';

/** Two readings this close together are the same weigh-in (e.g. a Shortcut entry, then the CSV). */
export const SAME_WEIGH_IN_MS = 10 * 60 * 1000;

type Measurement = typeof bodyMeasurement.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type ImportRowStatus = 'new' | 'merge' | 'duplicate';

export interface ImportRowResult {
  line: number;
  measuredAt: string;
  weightKg: number;
  status: ImportRowStatus;
}

export interface ImportResult {
  created: number;
  merged: number;
  duplicates: number;
  rows: ImportRowResult[];
}

const minuteOf = (d: Date) => Math.floor(d.getTime() / 60_000);

/**
 * Serialises measurement writes for one user, so two requests can't both decide a weigh-in is
 * new, or update a row another request has just replaced. Released at commit.
 */
async function lockMeasurements(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`measurements:${userId}`}))`);
}

function nearest(existing: Measurement[], at: Date): Measurement | undefined {
  let best: Measurement | undefined;
  let bestGap = Infinity;
  for (const m of existing) {
    const gap = Math.abs(m.measuredAt.getTime() - at.getTime());
    if (gap <= SAME_WEIGH_IN_MS && gap < bestGap) {
      best = m;
      bestGap = gap;
    }
  }
  return best;
}

function compositionFields(row: TanitaRow) {
  return {
    weightKg: row.weightKg,
    bmi: row.bmi,
    bodyFatPct: row.bodyFatPct,
    muscleMassKg: row.muscleMassKg,
    muscleQuality: row.muscleQuality,
    boneMassKg: row.boneMassKg,
    visceralFat: row.visceralFat,
    bmrKcal: row.bmrKcal,
    metabolicAge: row.metabolicAge,
    bodyWaterPct: row.bodyWaterPct,
    physiqueRating: row.physiqueRating,
    raw: row.raw,
  };
}

/**
 * Imports parsed Tanita rows. Idempotent: a row in the same minute as an existing CSV reading
 * is a duplicate (two real readings minutes apart both stay); a row within 10 minutes of a
 * Shortcut or manual weigh-in replaces it with the full composition reading. With `dryRun`,
 * nothing is written and the result is a preview.
 */
export async function importTanitaRows(
  db: Db,
  userId: string,
  timeZone: string,
  rows: TanitaRow[],
  { dryRun }: { dryRun: boolean },
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, merged: 0, duplicates: 0, rows: [] };
  if (rows.length === 0) return result;

  const run = async (tx: Tx) => {
    if (!dryRun) await lockMeasurements(tx, userId);
    const instants = rows.map((r) => localToInstant(r.localDateTime, timeZone));
    const times = instants.map((d) => d.getTime());
    const existing = await tx
      .select()
      .from(bodyMeasurement)
      .where(
        and(
          eq(bodyMeasurement.userId, userId),
          between(
            bodyMeasurement.measuredAt,
            new Date(Math.min(...times) - SAME_WEIGH_IN_MS),
            new Date(Math.max(...times) + SAME_WEIGH_IN_MS),
          ),
        ),
      );

    for (const [i, row] of rows.entries()) {
      const measuredAt = instants[i]!;
      const sameReading = existing.find(
        (m) => m.source === 'tanita_csv' && minuteOf(m.measuredAt) === minuteOf(measuredAt),
      );
      const match = sameReading
        ? undefined
        : nearest(
            existing.filter((m) => m.source !== 'tanita_csv'),
            measuredAt,
          );
      let status: ImportRowStatus;

      if (sameReading) {
        status = 'duplicate';
        result.duplicates++;
      } else if (match) {
        status = 'merge';
        result.merged++;
        if (!dryRun) {
          await tx
            .update(bodyMeasurement)
            .set({
              ...compositionFields(row),
              measuredAt,
              source: 'tanita_csv',
              protocolOk: isProtocolTime(measuredAt, timeZone),
            })
            .where(eq(bodyMeasurement.id, match.id));
        }
        match.source = 'tanita_csv';
        match.measuredAt = measuredAt;
      } else {
        status = 'new';
        result.created++;
        const values = {
          userId,
          measuredAt,
          source: 'tanita_csv' as const,
          protocolOk: isProtocolTime(measuredAt, timeZone),
          ...compositionFields(row),
        };
        if (!dryRun) {
          const [inserted] = await tx.insert(bodyMeasurement).values(values).returning();
          if (inserted) existing.push(inserted);
        } else {
          // Rows later in the same file must see this one, as they would after a real insert.
          existing.push({
            ...values,
            id: `preview-${i}`,
            outlierOverride: null,
            createdAt: measuredAt,
            updatedAt: measuredAt,
          });
        }
      }
      result.rows.push({
        line: row.line,
        measuredAt: measuredAt.toISOString(),
        weightKg: row.weightKg,
        status,
      });
    }
  };

  if (dryRun) await run(db as unknown as Tx);
  else await db.transaction(run);
  return result;
}

export interface AddWeightResult {
  measurement: Measurement;
  status: 'created' | 'updated' | 'kept_scale_reading';
}

/**
 * Records a weight from the Shortcut or the app. Within 10 minutes of an existing reading it
 * updates that entry instead of adding a second one; a full Tanita reading is never
 * overwritten by a typed number.
 */
export async function addWeight(
  db: Db,
  userId: string,
  timeZone: string,
  input: { weightKg: number; measuredAt: Date; source: 'manual' | 'shortcut' },
): Promise<AddWeightResult> {
  return db.transaction(async (tx) => {
    await lockMeasurements(tx, userId);
    const nearby = await tx
      .select()
      .from(bodyMeasurement)
      .where(
        and(
          eq(bodyMeasurement.userId, userId),
          between(
            bodyMeasurement.measuredAt,
            new Date(input.measuredAt.getTime() - SAME_WEIGH_IN_MS),
            new Date(input.measuredAt.getTime() + SAME_WEIGH_IN_MS),
          ),
        ),
      );
    const match = nearest(nearby, input.measuredAt);

    if (match?.source === 'tanita_csv') return { measurement: match, status: 'kept_scale_reading' };
    if (match) {
      const [updated] = await tx
        .update(bodyMeasurement)
        .set({ weightKg: input.weightKg, source: input.source })
        .where(eq(bodyMeasurement.id, match.id))
        .returning();
      return { measurement: updated!, status: 'updated' };
    }
    const [created] = await tx
      .insert(bodyMeasurement)
      .values({
        userId,
        measuredAt: input.measuredAt,
        source: input.source,
        weightKg: input.weightKg,
        protocolOk: isProtocolTime(input.measuredAt, timeZone),
      })
      .returning();
    return { measurement: created!, status: 'created' };
  });
}

export async function listMeasurements(db: Db, userId: string, since?: Date) {
  return db
    .select()
    .from(bodyMeasurement)
    .where(
      since
        ? and(eq(bodyMeasurement.userId, userId), gte(bodyMeasurement.measuredAt, since))
        : eq(bodyMeasurement.userId, userId),
    )
    .orderBy(asc(bodyMeasurement.measuredAt));
}
