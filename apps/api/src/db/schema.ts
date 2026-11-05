import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const ownerId = () =>
  uuid()
    .notNull()
    .references(() => appUser.id, { onDelete: 'cascade' });

const num = (precision: number, scale: number) => numeric({ precision, scale, mode: 'number' });

/** The app is single-user, but every table carries `user_id` so a second profile needs no migration. */
export const appUser = pgTable('app_user', {
  id: uuid().primaryKey().defaultRandom(),
  ...timestamps,
});

export const profile = pgTable(
  'profile',
  {
    userId: uuid()
      .primaryKey()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    sex: text(),
    birthDate: date(),
    heightCm: num(5, 1),
    timezone: text().notNull().default('Europe/Rome'),
    activityFactor: num(3, 2).notNull().default(1.5),
    /** ISO weekdays, 1 = Monday. */
    trainingWeekdays: integer()
      .array()
      .notNull()
      .default(sql`'{1,3,5}'`),
    remindersEnabled: boolean().notNull().default(true),
    /** ISO weekdays with a morning weigh-in reminder. */
    weighInDays: integer()
      .array()
      .notNull()
      .default(sql`'{1,4}'`),
    /** Local time, HH:MM. */
    weighInTime: text().notNull().default('07:30'),
    checkinReminderTime: text().notNull().default('20:00'),
    ...timestamps,
  },
  (t) => [
    check('profile_sex_check', sql`${t.sex} in ('male', 'female')`),
    check('profile_activity_factor_check', sql`${t.activityFactor} between 1.2 and 2.0`),
    check('profile_training_weekdays_check', sql`${t.trainingWeekdays} <@ '{1,2,3,4,5,6,7}'`),
    check('profile_weigh_in_days_check', sql`${t.weighInDays} <@ '{1,2,3,4,5,6,7}'`),
    check('profile_weigh_in_time_check', sql`${t.weighInTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check(
      'profile_checkin_reminder_time_check',
      sql`${t.checkinReminderTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
  ],
);

/** One scale reading. Tanita CSV rows, Shortcut weigh-ins and manual entries all land here. */
export const bodyMeasurement = pgTable(
  'body_measurement',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    measuredAt: timestamp({ withTimezone: true }).notNull(),
    source: text().notNull(),
    weightKg: num(5, 2).notNull(),
    bmi: num(4, 1),
    bodyFatPct: num(4, 1),
    muscleMassKg: num(5, 2),
    muscleQuality: num(5, 1),
    boneMassKg: num(4, 2),
    visceralFat: num(4, 1),
    bmrKcal: integer(),
    metabolicAge: integer(),
    bodyWaterPct: num(4, 1),
    physiqueRating: integer(),
    /** Morning reading (05:00–10:30 local), per the weigh-in protocol. */
    protocolOk: boolean().notNull(),
    /** true = always treat as an outlier, false = never, null = let the trend decide. */
    outlierOverride: boolean(),
    raw: jsonb(),
    ...timestamps,
  },
  (t) => [
    unique('body_measurement_user_time_unique').on(t.userId, t.measuredAt),
    index('body_measurement_user_time_idx').on(t.userId, t.measuredAt),
    check(
      'body_measurement_source_check',
      sql`${t.source} in ('tanita_csv', 'manual', 'shortcut')`,
    ),
    check('body_measurement_weight_check', sql`${t.weightKg} between 20 and 300`),
  ],
);

/** Tape measurements, at most one set per day. */
export const girthMeasurement = pgTable(
  'girth_measurement',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    measuredOn: date().notNull(),
    waistCm: num(5, 1),
    chestCm: num(5, 1),
    bicepsCm: num(4, 1),
    quadCm: num(4, 1),
    notes: text(),
    ...timestamps,
  },
  (t) => [unique('girth_measurement_user_day_unique').on(t.userId, t.measuredOn)],
);

/** The weekly check-in. Its adherence answer is what gates review decisions. */
export const checkin = pgTable(
  'checkin',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    /** Monday of the ISO week, in the profile's timezone. */
    weekStart: date().notNull(),
    measurementId: uuid().references(() => bodyMeasurement.id, { onDelete: 'set null' }),
    girthId: uuid().references(() => girthMeasurement.id, { onDelete: 'set null' }),
    adherence: text(),
    trainingProgressed: text(),
    sleep: smallint(),
    energy: smallint(),
    hunger: smallint(),
    notes: text(),
    completedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('checkin_user_week_unique').on(t.userId, t.weekStart),
    check('checkin_adherence_check', sql`${t.adherence} in ('on_plan', 'mostly', 'off')`),
    check('checkin_training_check', sql`${t.trainingProgressed} in ('yes', 'no', 'deload')`),
    check('checkin_sleep_check', sql`${t.sleep} between 1 and 5`),
    check('checkin_energy_check', sql`${t.energy} between 1 and 5`),
    check('checkin_hunger_check', sql`${t.hunger} between 1 and 5`),
    check('checkin_week_start_monday_check', sql`extract(isodow from ${t.weekStart}) = 1`),
  ],
);

export const pushSubscription = pgTable('push_subscription', {
  id: uuid().primaryKey().defaultRandom(),
  userId: ownerId(),
  endpoint: text().notNull().unique(),
  p256dh: text().notNull(),
  auth: text().notNull(),
  deviceLabel: text(),
  lastSuccessAt: timestamp({ withTimezone: true }),
  failureCount: integer().notNull().default(0),
  ...timestamps,
});

/** One reminder of a kind per local day, retried after a failed delivery. */
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    kind: text().notNull(),
    localDate: date().notNull(),
    /** Last delivery attempt. */
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    attempts: integer().notNull().default(1),
    /** False after a failed push: the reminder is retried (with a pause) the same day. */
    delivered: boolean().notNull().default(false),
  },
  (t) => [unique('notification_log_once_per_day').on(t.userId, t.kind, t.localDate)],
);

// ---------- M2: phases, targets, reviews ----------

export const phase = pgTable(
  'phase',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    type: text().notNull(),
    startedOn: date().notNull(),
    endedOn: date(),
    /** Only one phase is active at a time (partial unique index below). */
    status: text().notNull().default('active'),
    rateBandLowKgPerWeek: num(4, 2),
    rateBandHighKgPerWeek: num(4, 2),
    targetWeightKg: num(5, 2),
    holdBandKg: num(3, 2).notNull().default(0.5),
    surplusPct: num(4, 3),
    deficitRatePctPerWeek: num(5, 4),
    reviewEveryDays: integer().notNull().default(21),
    intent: text(),
    postMortem: text(),
    ...timestamps,
  },
  (t) => [
    check(
      'phase_type_check',
      sql`${t.type} in ('cut', 'maintenance', 'surplus', 'maingain', 'recomp')`,
    ),
    check('phase_status_check', sql`${t.status} in ('active', 'closed')`),
    check('phase_review_days_check', sql`${t.reviewEveryDays} between 7 and 84`),
    uniqueIndex('phase_one_active')
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/** Append-only history of the maintenance estimate. Information and guardrail only. */
export const maintenanceEstimate = pgTable('maintenance_estimate', {
  id: uuid().primaryKey().defaultRandom(),
  userId: ownerId(),
  asOf: date().notNull(),
  kcal: integer().notNull(),
  method: text().notNull(),
  inputs: jsonb(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Versioned calorie and macro targets of a phase. The latest effective version applies. */
export const targets = pgTable(
  'targets',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    phaseId: uuid()
      .notNull()
      .references(() => phase.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    effectiveFrom: date().notNull(),
    trainingKcal: integer().notNull(),
    trainingProteinG: integer().notNull(),
    trainingFatG: integer().notNull(),
    trainingCarbsG: integer().notNull(),
    trainingFibreG: integer().notNull(),
    restKcal: integer().notNull(),
    restProteinG: integer().notNull(),
    restFatG: integer().notNull(),
    restCarbsG: integer().notNull(),
    restFibreG: integer().notNull(),
    /** Daily carb change vs the previous version; ≥ 40 g starts the water grace period. */
    carbChangeG: integer().notNull().default(0),
    reasoning: text(),
    createdBy: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('targets_phase_version_unique').on(t.phaseId, t.version),
    check('targets_created_by_check', sql`${t.createdBy} in ('engine', 'manual')`),
  ],
);

export const proposal = pgTable(
  'proposal',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    kind: text().notNull(),
    phaseId: uuid().references(() => phase.id, { onDelete: 'cascade' }),
    payload: jsonb().notNull(),
    reasoning: text().notNull(),
    status: text().notNull().default('pending'),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('proposal_kind_check', sql`${t.kind} in ('targets_change', 'diet_break')`),
    check(
      'proposal_status_check',
      sql`${t.status} in ('pending', 'approved', 'rejected', 'expired')`,
    ),
    uniqueIndex('proposal_one_pending_per_kind')
      .on(t.userId, t.kind)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/** Every review run, including holds, so the history explains itself. */
export const review = pgTable('review', {
  id: uuid().primaryKey().defaultRandom(),
  userId: ownerId(),
  phaseId: uuid()
    .notNull()
    .references(() => phase.id, { onDelete: 'cascade' }),
  ranOn: date().notNull(),
  outcome: text().notNull(),
  explanation: text().notNull(),
  inputs: jsonb().notNull(),
  proposalId: uuid().references(() => proposal.id, { onDelete: 'set null' }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ---------- M2: foods and the meal plan ----------

export const food = pgTable(
  'food',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    source: text().notNull().default('custom'),
    sourceRef: text(),
    barcode: text(),
    name: text().notNull(),
    brand: text(),
    /** Per 100 g (or 100 ml for liquids). */
    kcal: num(6, 1).notNull(),
    proteinG: num(5, 1).notNull(),
    carbsG: num(5, 1).notNull(),
    fatG: num(5, 1).notNull(),
    fibreG: num(5, 1),
    sugarG: num(5, 1),
    satFatG: num(5, 1),
    saltG: num(5, 2),
    basis: text().notNull().default('as_sold'),
    /** Named portions → grams, e.g. {"cup": 150, "pcs": 1.33}. */
    units: jsonb().$type<Record<string, number>>().notNull().default({}),
    notes: text(),
    archived: boolean().notNull().default(false),
    // Product data from Open Food Facts (spec §9), when the food came from a barcode.
    nutriscoreGrade: text(),
    /** Nutri-Score category with its own protein rule: general, cheese or red_meat. */
    nutriCategory: text().notNull().default('general'),
    novaGroup: integer(),
    additives: text().array(),
    ingredientsText: text(),
    offFetchedAt: timestamp({ withTimezone: true }),
    // Planning pool (spec §5.3): what the AI may use, and how.
    inPool: boolean().notNull().default(false),
    role: text().notNull().default('other'),
    preferredSlots: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    priority: text().notNull().default('medium'),
    /** PortionRule: {"kind":"flexible","stepG":5} or {"kind":"fixed_unit","unit":"cup"}. */
    portion: jsonb()
      .$type<{ kind: 'flexible'; stepG: number } | { kind: 'fixed_unit'; unit: string }>()
      .notNull()
      .default({ kind: 'flexible', stepG: 5 }),
    ...timestamps,
  },
  (t) => [
    check(
      'food_role_check',
      sql`${t.role} in ('main_protein', 'main_carb', 'fat', 'veg', 'fruit', 'dairy_protein', 'snack', 'other')`,
    ),
    check('food_priority_check', sql`${t.priority} in ('high', 'medium', 'low')`),
    check('food_source_check', sql`${t.source} in ('custom', 'off', 'opennutrition')`),
    check(
      'food_nutri_category_check',
      sql`${t.nutriCategory} in ('general', 'cheese', 'red_meat')`,
    ),
    check('food_basis_check', sql`${t.basis} in ('raw', 'dry', 'cooked', 'drained', 'as_sold')`),
    check(
      'food_macros_check',
      sql`${t.kcal} >= 0 and ${t.proteinG} >= 0 and ${t.carbsG} >= 0 and ${t.fatG} >= 0`,
    ),
    index('food_user_name_idx').on(t.userId, t.name),
    uniqueIndex('food_user_barcode_unique')
      .on(t.userId, t.barcode)
      .where(sql`${t.barcode} is not null`),
  ],
);

export const mealPlan = pgTable(
  'meal_plan',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    phaseId: uuid().references(() => phase.id, { onDelete: 'set null' }),
    name: text().notNull(),
    status: text().notNull().default('draft'),
    createdBy: text().notNull().default('manual'),
    /** The whole week as a document; see PlanDocument in packages/shared. */
    document: jsonb().notNull(),
    activatedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('meal_plan_status_check', sql`${t.status} in ('draft', 'active', 'archived')`),
    check('meal_plan_created_by_check', sql`${t.createdBy} in ('manual', 'ai')`),
    uniqueIndex('meal_plan_one_active')
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
  ],
);

// ---------- M3: rules and AI runs ----------

/** Planning rules (spec §5.4). `spec` is a RuleSpec from packages/shared/src/rules.ts. */
export const rule = pgTable('rule', {
  id: uuid().primaryKey().defaultRandom(),
  userId: ownerId(),
  kind: text().notNull(),
  spec: jsonb().notNull(),
  text: text().notNull(),
  active: boolean().notNull().default(true),
  position: integer().notNull().default(0),
  ...timestamps,
});

/** Every model call: what was sent, what came back, what the checks said, and the cost. */
export const aiRun = pgTable(
  'ai_run',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    kind: text().notNull(),
    status: text().notNull().default('queued'),
    model: text().notNull(),
    promptVersion: text().notNull(),
    input: jsonb().notNull(),
    /** Per attempt: raw output, validation errors, usage. */
    attempts: jsonb().notNull().default([]),
    result: jsonb(),
    error: text(),
    planId: uuid().references(() => mealPlan.id, { onDelete: 'set null' }),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    costUsd: num(8, 4).notNull().default(0),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ai_run_kind_check', sql`${t.kind} in ('generate_plan')`),
    check('ai_run_status_check', sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`),
    // One generation at a time per user, enforced by the database.
    uniqueIndex('ai_run_one_active')
      .on(t.userId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

// ---------- M4: food log ----------

/**
 * What was eaten beyond the plan (scans, searches, quick adds). Each entry keeps a snapshot
 * of the food's values, so editing or deleting a food never rewrites past intake.
 */
export const foodLog = pgTable(
  'food_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: ownerId(),
    /** Local calendar day in the profile's timezone. */
    loggedOn: date().notNull(),
    slot: text(),
    foodId: uuid().references(() => food.id, { onDelete: 'set null' }),
    name: text().notNull(),
    grams: num(6, 1).notNull(),
    kcal: num(7, 1).notNull(),
    proteinG: num(6, 1).notNull(),
    carbsG: num(6, 1).notNull(),
    fatG: num(6, 1).notNull(),
    fibreG: num(6, 1),
    via: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('food_log_user_day_idx').on(t.userId, t.loggedOn),
    check('food_log_via_check', sql`${t.via} in ('scan', 'search', 'quick_add')`),
    check('food_log_grams_check', sql`${t.grams} > 0 and ${t.grams} <= 5000`),
  ],
);
