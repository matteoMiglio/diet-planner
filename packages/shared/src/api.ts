/**
 * Request schemas and response types shared by the API and the web app.
 * Dates travel as ISO strings (instants) or `YYYY-MM-DD` (local calendar dates).
 */
import { z } from 'zod';
import type { PlanDay, PlanDocument, Slot } from './plan.js';
import { PoolInfo } from './rules.js';
import type { Role } from './rules.js';
import { canonicalBarcode } from './gtin.js';
import type { NutriCategory } from './scores.js';

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
  ai: { configured: boolean; model: string | null };
}

export const GeneratePlanRequest = z.object({
  /** Free text the model reads as tastes/constraints, e.g. "more fish, no lentils this week". */
  preferences: z.string().trim().max(500).nullable().optional(),
});

export interface AiRunDto {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  model: string;
  createdAt: string;
  finishedAt: string | null;
  costUsd: number;
  error: string | null;
  planId: string | null;
  result: {
    summary: string;
    repaired: boolean;
    solverChanges: string[];
    errors: string[];
    warnings: string[];
  } | null;
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

// ---------- M2: phases, targets, reviews ----------

export const PhaseTypeSchema = z.enum(['cut', 'maintenance', 'surplus', 'maingain', 'recomp']);
export type PhaseTypeValue = z.infer<typeof PhaseTypeSchema>;

const DayTargetsSchema = z.object({
  kcal: z.number().int().min(800).max(6000),
  proteinG: z.number().int().min(0).max(500),
  fatG: z.number().int().min(0).max(400),
  carbsG: z.number().int().min(0).max(1000),
  fibreG: z.number().int().min(0).max(150),
});
export const TargetsSchema = z.object({ training: DayTargetsSchema, rest: DayTargetsSchema });

export interface DayTargetsDto {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  fibreG: number;
}

export interface TargetsDto {
  id: string;
  version: number;
  effectiveFrom: string;
  training: DayTargetsDto;
  rest: DayTargetsDto;
  carbChangeG: number;
  reasoning: string | null;
  createdBy: 'engine' | 'manual';
}

export interface PhaseDto {
  id: string;
  type: PhaseTypeValue;
  startedOn: string;
  endedOn: string | null;
  status: 'active' | 'closed';
  rateBandKgPerWeek: [number, number] | null;
  targetWeightKg: number | null;
  holdBandKg: number;
  surplusPct: number | null;
  deficitRatePctPerWeek: number | null;
  reviewEveryDays: number;
  intent: string | null;
}

export const CreatePhaseRequest = z.object({
  type: PhaseTypeSchema,
  startedOn: localDate,
  maintenanceKcal: z.number().int().min(1000).max(6000),
  /** Defaults to the trend's current weight. */
  bodyweightKg: WeightKg.optional(),
  surplusPct: z.number().min(0).max(0.1).optional(),
  deficitRatePctPerWeek: z.number().min(0).max(0.015).optional(),
  rateBandKgPerWeek: z.tuple([z.number(), z.number()]).nullable().optional(),
  targetWeightKg: WeightKg.nullable().optional(),
  reviewEveryDays: z.number().int().min(7).max(84).optional(),
  intent: z.string().max(2000).nullable().optional(),
  /** Overrides the engine's targets. */
  targets: TargetsSchema.optional(),
});
export type CreatePhaseRequest = z.infer<typeof CreatePhaseRequest>;

export const UpdateTargetsRequest = z.object({
  targets: TargetsSchema,
  reasoning: z.string().min(1).max(2000),
  effectiveFrom: localDate.optional(),
});

export interface ProposalDto {
  id: string;
  kind: 'targets_change' | 'diet_break';
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reasoning: string;
  createdAt: string;
  /** For targets_change: the proposed targets and the change per day type. */
  targets: { training: DayTargetsDto; rest: DayTargetsDto } | null;
  deltaKcal: { training: number; rest: number } | null;
}

export interface ReviewDto {
  id: string;
  ranOn: string;
  outcome: 'hold' | 'change' | 'propose_diet_break';
  explanation: string;
  proposalId: string | null;
}

export interface PlanOverviewDto {
  phase: PhaseDto | null;
  targets: TargetsDto | null;
  maintenance: { kcal: number; asOf: string; method: string } | null;
  nextReviewOn: string | null;
  lastReview: ReviewDto | null;
  pendingProposal: ProposalDto | null;
  activePlan: MealPlanDto | null;
  trainingWeekdays: number[];
}

// ---------- M2: foods and plans ----------

const per100 = z.number().min(0).max(100);
export const FoodInput = z.object({
  name: z.string().trim().min(1).max(120),
  brand: z.string().trim().max(120).nullable().optional(),
  kcal: z.number().min(0).max(1000),
  proteinG: per100,
  carbsG: per100,
  fatG: per100,
  fibreG: per100.nullable().optional(),
  basis: z.enum(['raw', 'dry', 'cooked', 'drained', 'as_sold']).optional(),
  units: z.record(z.string().trim().min(1).max(30), z.number().positive().max(3000)).optional(),
  notes: z.string().max(1000).nullable().optional(),
  archived: z.boolean().optional(),
  pool: PoolInfo.optional(),
  /** Set when a scanned product is saved from its label. */
  barcode: z
    .string()
    .transform((v, ctx) => {
      const code = canonicalBarcode(v);
      if (code === null) {
        ctx.addIssue({ code: 'custom', message: "Isn't a valid EAN/UPC barcode." });
        return z.NEVER;
      }
      return code;
    })
    .nullable()
    .optional(),
  sugarG: per100.nullable().optional(),
  satFatG: per100.nullable().optional(),
  saltG: per100.nullable().optional(),
});
export type FoodInput = z.infer<typeof FoodInput>;
export const FoodPatch = FoodInput.partial();
export type FoodPatch = z.infer<typeof FoodPatch>;

export interface FoodDto {
  id: string;
  name: string;
  brand: string | null;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number | null;
  basis: 'raw' | 'dry' | 'cooked' | 'drained' | 'as_sold';
  units: Record<string, number>;
  notes: string | null;
  archived: boolean;
  pool: PoolInfo;
  sugarG: number | null;
  satFatG: number | null;
  saltG: number | null;
  /** Packaged-product data, when the food came from a barcode. */
  product: {
    barcode: string;
    source: 'off' | 'custom' | 'opennutrition';
    nutriscoreGrade: string | null;
    /** Nutri-Score category with its own protein rule, from Open Food Facts categories. */
    category: NutriCategory;
    novaGroup: number | null;
    additives: string[] | null;
    ingredientsText: string | null;
  } | null;
}

export interface MealPlanDto {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'archived';
  phaseId: string | null;
  document: PlanDocument;
  activatedAt: string | null;
  updatedAt: string;
}

export interface TodayDto {
  date: string;
  weekday: number;
  dayType: 'training' | 'rest';
  targets: DayTargetsDto | null;
  plan: { id: string; name: string; day: PlanDay } | null;
}

// ---------- M4: scanning and the food log ----------

export interface ScanContextDto {
  phase: 'cut' | 'maintenance' | 'surplus' | 'maingain' | 'recomp' | null;
  /** Today's budget left: target − planned meals − extras logged. Null without targets. */
  remaining: { kcal: number; fatG: number } | null;
  slot: Slot;
  slotRoles: Role[];
  /** Rules this food would break today, in words. */
  conflicts: string[];
}

export type BarcodeLookupDto =
  | { status: 'found'; source: 'local' | 'open_food_facts'; food: FoodDto; context: ScanContextDto }
  | { status: 'not_found' | 'incomplete'; reason: string | null };

export const LogFoodRequest = z.object({
  foodId: z.uuid(),
  grams: z.number().positive().max(5000),
  slot: z
    .enum(['breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner', 'evening_snack'])
    .nullable()
    .optional(),
  via: z.enum(['scan', 'search', 'quick_add']),
  /** Defaults to today in the profile's timezone. */
  date: localDate.optional(),
});
export type LogFoodRequest = z.infer<typeof LogFoodRequest>;

export interface FoodLogEntryDto {
  id: string;
  loggedOn: string;
  slot: string | null;
  foodId: string | null;
  name: string;
  grams: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  via: 'scan' | 'search' | 'quick_add';
  createdAt: string;
}

export interface FoodLogDayDto {
  date: string;
  entries: FoodLogEntryDto[];
  totals: { kcal: number; proteinG: number; carbsG: number; fatG: number };
}

/** What Claude read off a nutrition label photo; reviewed by the person before saving. */
export interface LabelReadingDto {
  name: string | null;
  brand: string | null;
  servingG: number | null;
  per100: {
    kcal: number | null;
    proteinG: number | null;
    carbsG: number | null;
    sugarG: number | null;
    fatG: number | null;
    satFatG: number | null;
    fibreG: number | null;
    saltG: number | null;
  };
  /** Anything the reader was unsure about, in plain words. */
  notes: string[];
  costUsd: number;
}
