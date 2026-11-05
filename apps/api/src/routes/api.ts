import {
  AddWeightRequest,
  type ImportPreviewDto,
  localDate,
  type MeasurementDto,
  parseTanitaCsv,
  type ProfileDto,
  type ProgressDto,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  SaveCheckinRequest,
  type SettingsDto,
  UpdateMeasurementRequest,
  UpdateProfileRequest,
  WeightKg,
  weightTrend,
} from '@diet/shared';
import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { bodyMeasurement, profile, pushSubscription } from '../db/schema.js';
import { bearerAuth, HttpError, parseJson, rateLimit, sameOriginWrites } from '../lib/http.js';
import { loadOwner, type Profile } from '../lib/owner.js';
import { isValidTimeZone } from '../lib/time.js';
import { currentCheckin, listGirths, saveCheckin } from '../services/checkins.js';
import { addWeight, importTanitaRows, listMeasurements } from '../services/measurements.js';
import type { Pusher } from '../services/push.js';

export interface ApiDeps {
  db: Db;
  ingestToken?: string | undefined;
  pusher?: Pusher | null;
  now?: () => Date;
}

type Measurement = typeof bodyMeasurement.$inferSelect;

const MAX_CSV_BYTES = 1024 * 1024;
const csvLimit = bodyLimit({
  maxSize: MAX_CSV_BYTES,
  onError: () => {
    throw new HttpError(413, 'too_large', 'The file is larger than 1 MB.');
  },
});

function toMeasurementDto(m: Measurement): MeasurementDto {
  return {
    id: m.id,
    measuredAt: m.measuredAt.toISOString(),
    source: m.source as MeasurementDto['source'],
    weightKg: m.weightKg,
    bodyFatPct: m.bodyFatPct,
    muscleMassKg: m.muscleMassKg,
    visceralFat: m.visceralFat,
    bodyWaterPct: m.bodyWaterPct,
    protocolOk: m.protocolOk,
    outlierOverride: m.outlierOverride,
  };
}

function toProfileDto(p: Profile): ProfileDto {
  return {
    timezone: p.timezone,
    trainingWeekdays: p.trainingWeekdays,
    remindersEnabled: p.remindersEnabled,
    weighInDays: p.weighInDays,
    weighInTime: p.weighInTime,
    checkinReminderTime: p.checkinReminderTime,
  };
}

/** Reads a CSV upload sent either as a raw body or as the `file` field of a form. */
async function readCsv(c: {
  req: {
    header(n: string): string | undefined;
    text(): Promise<string>;
    parseBody(): Promise<Record<string, unknown>>;
  };
}): Promise<string> {
  const type = c.req.header('Content-Type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File))
      throw new HttpError(422, 'no_file', 'Send the CSV as the "file" field.');
    return file.text();
  }
  return c.req.text();
}

async function runImport(
  db: Db,
  owner: Profile,
  csv: string,
  dryRun: boolean,
): Promise<ImportPreviewDto> {
  const parsed = parseTanitaCsv(csv);
  if (parsed.rows.length === 0 && parsed.errors.length > 0) {
    throw new HttpError(422, 'unreadable_csv', parsed.errors[0]!.message, parsed.errors);
  }
  const result = await importTanitaRows(db, owner.userId, owner.timezone, parsed.rows, { dryRun });
  return { dryRun, ...result, errors: parsed.errors };
}

export function createApi({ db, ingestToken, pusher = null, now = () => new Date() }: ApiDeps) {
  const api = new Hono();
  // Browser routes only; /ingest authenticates with its bearer token instead.
  const sameOrigin = sameOriginWrites();
  api.use('*', async (c, next) =>
    c.req.path.startsWith('/api/ingest/') ? next() : sameOrigin(c, next),
  );

  // ---------- Measurements and progress ----------

  api.get('/progress', async (c) => {
    const owner = await loadOwner(db);
    const measurements = await listMeasurements(db, owner.userId);
    const trend = weightTrend(
      measurements.map((m) => ({
        id: m.id,
        measuredAt: m.measuredAt,
        weightKg: m.weightKg,
        protocolOk: m.protocolOk,
        outlierOverride: m.outlierOverride,
      })),
      { now: now() },
    );
    const body: ProgressDto = {
      measurements: measurements.map(toMeasurementDto),
      girths: await listGirths(db, owner.userId),
      trend: {
        decidable: trend.decidable,
        reasons: trend.reasons,
        slopeKgPerWeek: trend.slopeKgPerWeek,
        ci80: trend.ci80,
        interceptKg: trend.interceptKg,
        n: trend.n,
        spanDays: trend.spanDays,
        latestAgeDays: trend.latestAgeDays,
        windowStart: trend.windowStart.toISOString(),
        outlierIds: trend.outlierIds,
        readingsNeeded: trend.readingsNeeded,
      },
    };
    return c.json(body);
  });

  api.post('/measurements', async (c) => {
    const owner = await loadOwner(db);
    const input = await parseJson(c, AddWeightRequest);
    const result = await addWeight(db, owner.userId, owner.timezone, {
      weightKg: input.weightKg,
      measuredAt: input.measuredAt ? new Date(input.measuredAt) : now(),
      source: 'manual',
    });
    return c.json(
      { status: result.status, measurement: toMeasurementDto(result.measurement) },
      201,
    );
  });

  api.patch('/measurements/:id', async (c) => {
    const owner = await loadOwner(db);
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) throw new HttpError(404, 'not_found', 'No such measurement.');
    const input = await parseJson(c, UpdateMeasurementRequest);
    const [updated] = await db
      .update(bodyMeasurement)
      .set({ outlierOverride: input.outlierOverride })
      .where(and(eq(bodyMeasurement.id, id.data), eq(bodyMeasurement.userId, owner.userId)))
      .returning();
    if (!updated) throw new HttpError(404, 'not_found', 'No such measurement.');
    return c.json(toMeasurementDto(updated));
  });

  api.delete('/measurements/:id', async (c) => {
    const owner = await loadOwner(db);
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) throw new HttpError(404, 'not_found', 'No such measurement.');
    const deleted = await db
      .delete(bodyMeasurement)
      .where(and(eq(bodyMeasurement.id, id.data), eq(bodyMeasurement.userId, owner.userId)))
      .returning({ id: bodyMeasurement.id });
    if (deleted.length === 0) throw new HttpError(404, 'not_found', 'No such measurement.');
    return c.body(null, 204);
  });

  /** Upload from the app: `?dryRun=1` previews, without it the import is written. */
  api.post('/measurements/import', csvLimit, async (c) => {
    const owner = await loadOwner(db);
    const dryRun = c.req.query('dryRun') === '1';
    return c.json(await runImport(db, owner, await readCsv(c), dryRun));
  });

  // ---------- Check-ins ----------

  api.get('/checkins/current', async (c) => {
    return c.json(await currentCheckin(db, await loadOwner(db), now()));
  });

  api.put('/checkins/:weekStart', async (c) => {
    const weekStart = localDate.safeParse(c.req.param('weekStart'));
    if (!weekStart.success) throw new HttpError(404, 'not_found', 'Expected /checkins/YYYY-MM-DD.');
    const input = await parseJson(c, SaveCheckinRequest);
    return c.json(await saveCheckin(db, await loadOwner(db), weekStart.data, input, now()));
  });

  // ---------- Settings ----------

  api.get('/settings', async (c) => {
    const owner = await loadOwner(db);
    const [subs] = await db
      .select({ n: count() })
      .from(pushSubscription)
      .where(eq(pushSubscription.userId, owner.userId));
    const body: SettingsDto = {
      profile: toProfileDto(owner),
      ingest: { configured: Boolean(ingestToken) },
      push: { publicKey: pusher?.publicKey ?? null, subscriptions: subs?.n ?? 0 },
    };
    return c.json(body);
  });

  api.patch('/profile', async (c) => {
    const owner = await loadOwner(db);
    const input = await parseJson(c, UpdateProfileRequest);
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new HttpError(422, 'invalid_timezone', `Unknown timezone "${input.timezone}".`);
    }
    const sorted = (days?: number[]) => (days ? [...new Set(days)].sort() : undefined);
    const [updated] = await db
      .update(profile)
      .set({
        ...input,
        ...(input.trainingWeekdays && { trainingWeekdays: sorted(input.trainingWeekdays) }),
        ...(input.weighInDays && { weighInDays: sorted(input.weighInDays) }),
      })
      .where(eq(profile.userId, owner.userId))
      .returning();
    return c.json(toProfileDto(updated!));
  });

  // ---------- Push ----------

  api.post('/push/subscriptions', async (c) => {
    if (!pusher) throw new HttpError(503, 'push_disabled', 'Push is not configured on the server.');
    const owner = await loadOwner(db);
    const input = await parseJson(c, PushSubscribeRequest);
    await db
      .insert(pushSubscription)
      .values({
        userId: owner.userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        deviceLabel: input.deviceLabel ?? null,
      })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: { p256dh: input.keys.p256dh, auth: input.keys.auth, failureCount: 0 },
      });
    return c.body(null, 204);
  });

  api.delete('/push/subscriptions', async (c) => {
    const owner = await loadOwner(db);
    const input = await parseJson(c, PushUnsubscribeRequest);
    await db
      .delete(pushSubscription)
      .where(
        and(
          eq(pushSubscription.userId, owner.userId),
          eq(pushSubscription.endpoint, input.endpoint),
        ),
      );
    return c.body(null, 204);
  });

  api.post('/push/test', async (c) => {
    if (!pusher) throw new HttpError(503, 'push_disabled', 'Push is not configured on the server.');
    const owner = await loadOwner(db);
    const result = await pusher.send(db, owner.userId, {
      title: 'Notifications work',
      body: 'Weigh-in and check-in reminders will arrive like this.',
      url: '/settings',
      tag: 'test',
    });
    return c.json(result);
  });

  // ---------- Ingest (iOS Shortcuts, bearer token) ----------

  const ingest = new Hono();
  ingest.use(
    rateLimit(30, 60_000),
    bearerAuth(() => ingestToken),
  );

  ingest.post('/tanita', csvLimit, async (c) => {
    const owner = await loadOwner(db);
    const result = await runImport(db, owner, await readCsv(c), false);
    const parts = [`${result.created} new`];
    if (result.merged) parts.push(`${result.merged} merged`);
    if (result.duplicates) parts.push(`${result.duplicates} already imported`);
    if (result.errors.length) parts.push(`${result.errors.length} skipped`);
    return c.json({ ...result, message: `Tanita import: ${parts.join(', ')}.` });
  });

  /** Accepts `{"weightKg": 86.4}` or a bare number, with a decimal comma or point. */
  ingest.post('/weight', async (c) => {
    const owner = await loadOwner(db);
    const text = (await c.req.text()).trim();
    let value: unknown = text;
    try {
      const json: unknown = JSON.parse(text);
      value =
        typeof json === 'object' && json !== null && 'weightKg' in json ? json.weightKg : json;
    } catch {
      // Not JSON: treat the body as a bare number.
    }
    const weight = WeightKg.safeParse(Number(String(value).replace(',', '.')));
    if (!weight.success)
      throw new HttpError(422, 'invalid_weight', 'Send a weight between 20 and 300 kg.');
    const result = await addWeight(db, owner.userId, owner.timezone, {
      weightKg: weight.data,
      measuredAt: now(),
      source: 'shortcut',
    });
    const message =
      result.status === 'kept_scale_reading'
        ? 'The scale reading from a few minutes ago is already in; kept that one.'
        : `Logged ${weight.data.toFixed(2)} kg.`;
    return c.json({
      status: result.status,
      message,
      measurement: toMeasurementDto(result.measurement),
    });
  });

  api.route('/ingest', ingest);

  return api;
}
