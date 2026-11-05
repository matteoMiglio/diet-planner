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
