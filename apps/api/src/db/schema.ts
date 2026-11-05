import { sql } from 'drizzle-orm';
import { check, date, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

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
    heightCm: numeric({ precision: 5, scale: 1, mode: 'number' }),
    timezone: text().notNull().default('Europe/Rome'),
    activityFactor: numeric({ precision: 3, scale: 2, mode: 'number' }).notNull().default(1.5),
    /** ISO weekdays, 1 = Monday. */
    trainingWeekdays: integer()
      .array()
      .notNull()
      .default(sql`'{1,3,5}'`),
    ...timestamps,
  },
  (t) => [
    check('profile_sex_check', sql`${t.sex} in ('male', 'female')`),
    check('profile_activity_factor_check', sql`${t.activityFactor} between 1.2 and 2.0`),
    check('profile_training_weekdays_check', sql`${t.trainingWeekdays} <@ '{1,2,3,4,5,6,7}'`),
  ],
);
