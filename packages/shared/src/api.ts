/**
 * Request schemas and response types shared by the API and the web app.
 * Dates travel as ISO strings (instants) or `YYYY-MM-DD` (local calendar dates).
 */
import { z } from 'zod';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
const score = z.number().int().min(1).max(5);
const isoWeekday = z.number().int().min(1).max(7);

export const WeightKg = z.number().min(20).max(300);

// ---------- Measurements ----------

export interface MeasurementDto {
  id: string;
  measuredAt: string;
  source: 'tanita_csv' | 'manual' | 'shortcut';
  weightKg: number;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  visceralFat: number | null;
  bodyWaterPct: number | null;
  protocolOk: boolean;
  outlierOverride: boolean | null;
}

export const AddWeightRequest = z.object({
  weightKg: WeightKg,
  /** Defaults to now. */
  measuredAt: z.iso.datetime({ offset: true }).optional(),
});
export type AddWeightRequest = z.infer<typeof AddWeightRequest>;

export const UpdateMeasurementRequest = z.object({
  outlierOverride: z.boolean().nullable(),
});

export interface ImportPreviewDto {
  dryRun: boolean;
  created: number;
  merged: number;
  duplicates: number;
  rows: {
    line: number;
    measuredAt: string;
    weightKg: number;
    status: 'new' | 'merge' | 'duplicate';
  }[];
  errors: { line: number; message: string }[];
}

// ---------- Trend ----------

export interface TrendDto {
  decidable: boolean;
  reasons: ('too_few_readings' | 'span_too_short' | 'latest_too_old')[];
  slopeKgPerWeek: number | null;
  ci80: [number, number] | null;
  interceptKg: number | null;
  n: number;
  spanDays: number;
  latestAgeDays: number | null;
  windowStart: string;
  outlierIds: string[];
  readingsNeeded: number;
}

export interface ProgressDto {
  measurements: MeasurementDto[];
  girths: GirthDto[];
  trend: TrendDto;
}

// ---------- Girths and check-ins ----------

export interface GirthDto {
  measuredOn: string;
  waistCm: number | null;
  chestCm: number | null;
  bicepsCm: number | null;
  quadCm: number | null;
}

const girthCm = z.number().min(10).max(250);

export const Adherence = z.enum(['on_plan', 'mostly', 'off']);
export const TrainingProgressed = z.enum(['yes', 'no', 'deload']);

export const SaveCheckinRequest = z.object({
  weightKg: WeightKg.nullable().optional(),
  waistCm: girthCm.nullable().optional(),
  chestCm: girthCm.nullable().optional(),
  bicepsCm: girthCm.nullable().optional(),
  quadCm: girthCm.nullable().optional(),
  adherence: Adherence.nullable().optional(),
  trainingProgressed: TrainingProgressed.nullable().optional(),
  sleep: score.nullable().optional(),
  energy: score.nullable().optional(),
  hunger: score.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type SaveCheckinRequest = z.infer<typeof SaveCheckinRequest>;

export interface CheckinDto {
  weekStart: string;
  adherence: z.infer<typeof Adherence> | null;
  trainingProgressed: z.infer<typeof TrainingProgressed> | null;
  sleep: number | null;
  energy: number | null;
  hunger: number | null;
  notes: string | null;
  completedAt: string | null;
  weightKg: number | null;
  girth: GirthDto | null;
}

export interface CurrentCheckinDto {
  weekStart: string;
  today: string;
  checkin: CheckinDto | null;
  /** The latest reading this week, to prefill the weight. */
  latestWeightThisWeek: { measuredAt: string; weightKg: number } | null;
  /** Shown on Today until the check-in is complete. */
  due: boolean;
}

// ---------- Profile and settings ----------

export interface ProfileDto {
  timezone: string;
  trainingWeekdays: number[];
  remindersEnabled: boolean;
  weighInDays: number[];
  weighInTime: string;
  checkinReminderTime: string;
}

export const UpdateProfileRequest = z
  .object({
    timezone: z.string().min(1).max(64),
    trainingWeekdays: z.array(isoWeekday).max(7),
    remindersEnabled: z.boolean(),
    weighInDays: z.array(isoWeekday).max(7),
    weighInTime: hhmm,
    checkinReminderTime: hhmm,
  })
  .partial();

export interface SettingsDto {
  profile: ProfileDto;
  ingest: { configured: boolean };
  push: { publicKey: string | null; subscriptions: number };
}

// ---------- Push ----------

/**
 * Push endpoints the server may POST to: the browsers' push services only. Anything else
 * would let a forged subscription make the server call arbitrary (internal) URLs.
 */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function isPushServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      PUSH_SERVICE_HOSTS.some((re) => re.test(url.hostname))
    );
  } catch {
    return false;
  }
}

const pushEndpoint = z
  .url()
  .max(2048)
  .refine(isPushServiceUrl, 'Not a known browser push service URL');

export const PushSubscribeRequest = z.object({
  endpoint: pushEndpoint,
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
  deviceLabel: z.string().max(100).optional(),
});

export const PushUnsubscribeRequest = z.object({ endpoint: z.url().max(2048) });

export { localDate };
