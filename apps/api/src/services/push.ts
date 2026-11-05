import { isPushServiceUrl } from '@diet/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import webpush from 'web-push';
import type { Db } from '../db/client.js';
import { bodyMeasurement, checkin, notificationLog, pushSubscription } from '../db/schema.js';
import type { Profile } from '../lib/owner.js';
import { loadOwner } from '../lib/owner.js';
import { isoWeekStart, localParts, localToInstant } from '../lib/time.js';
import { latestReviewOn, reviewDue, runReview } from './phases.js';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` contact, required by push services. */
  subject: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Path to open when the notification is tapped. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
}

/** Push services reject subscriptions after this many consecutive failures; so do we. */
const MAX_FAILURES = 5;

export interface Pusher {
  readonly publicKey: string;
  send(db: Db, userId: string, message: PushMessage): Promise<{ sent: number; failed: number }>;
}

export function createPusher(config: VapidConfig): Pusher {
  const options = {
    vapidDetails: config,
    TTL: 6 * 60 * 60,
    urgency: 'normal' as const,
  };

  return {
    publicKey: config.publicKey,
    async send(db, userId, message) {
      const subs = await db
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.userId, userId));
      let sent = 0;
      let failed = 0;
      await Promise.all(
        subs.map(async (sub) => {
          // Defence in depth: never POST to a non-push-service URL, even if one got stored.
          if (!isPushServiceUrl(sub.endpoint)) {
            await db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
            failed++;
            return;
          }
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              JSON.stringify(message),
              options,
            );
            sent++;
            await db
              .update(pushSubscription)
              .set({ lastSuccessAt: new Date(), failureCount: 0 })
              .where(eq(pushSubscription.id, sub.id));
          } catch (err) {
            failed++;
            const status = (err as { statusCode?: number }).statusCode;
            // 404/410: the browser dropped the subscription; it will never work again.
            if (status === 404 || status === 410 || sub.failureCount + 1 >= MAX_FAILURES) {
              await db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
            } else {
              await db
                .update(pushSubscription)
                .set({ failureCount: sub.failureCount + 1 })
                .where(eq(pushSubscription.id, sub.id));
            }
            console.error(`push to ${new URL(sub.endpoint).host} failed (${status ?? 'network'})`);
          }
        }),
      );
      return { sent, failed };
    },
  };
}

export type ReminderKind = 'weigh_in' | 'checkin' | 'review';

/** How long after its scheduled time a reminder is still worth sending (e.g. after a restart). */
const SEND_WINDOW_MIN = 3 * 60;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Which reminders are due right now. Pure apart from the two "already done?" lookups, so the
 * scheduling rules are testable with a fixed clock.
 */
export async function dueReminders(db: Db, owner: Profile, now: Date): Promise<ReminderKind[]> {
  if (!owner.remindersEnabled) return [];
  const local = localParts(now, owner.timezone);
  const due: ReminderKind[] = [];
  const inWindow = (hhmm: string) => {
    const delta = local.minutes - minutesOf(hhmm);
    return delta >= 0 && delta <= SEND_WINDOW_MIN;
  };

  if (owner.weighInDays.includes(local.isoWeekday) && inWindow(owner.weighInTime)) {
    const startOfDay = localToInstant(`${local.date}T00:00`, owner.timezone);
    const [weighed] = await db
      .select({ id: bodyMeasurement.id })
      .from(bodyMeasurement)
      .where(
        and(eq(bodyMeasurement.userId, owner.userId), gte(bodyMeasurement.measuredAt, startOfDay)),
      )
      .limit(1);
    if (!weighed) due.push('weigh_in');
  }

  if (local.isoWeekday === 1 && inWindow(owner.checkinReminderTime)) {
    const [row] = await db
      .select({ adherence: checkin.adherence, training: checkin.trainingProgressed })
      .from(checkin)
      .where(
        and(eq(checkin.userId, owner.userId), eq(checkin.weekStart, isoWeekStart(local.date))),
      );
    if (!row?.adherence || !row.training) due.push('checkin');
  }
  return due;
}

const MESSAGES: Record<Exclude<ReminderKind, 'review'>, PushMessage> = {
  weigh_in: {
    title: 'Weigh-in',
    body: 'Step on the Tanita, then share the CSV — or tap to log just the weight.',
    url: '/checkin?focus=weight',
    tag: 'weigh-in',
  },
  checkin: {
    title: 'Weekly check-in',
    body: 'Four quick answers: adherence, training, waist, how you feel.',
    url: '/checkin',
    tag: 'checkin',
  },
};

/** After a failed attempt, wait this long before trying again; give up after MAX_ATTEMPTS. */
const RETRY_AFTER_MIN = 15;
const MAX_ATTEMPTS = 4;

/**
 * Claims today's slot for a job (a reminder, a review run, a review notification). Returns
 * the log row id when this caller should do the job now: the first time today, or again
 * after a failed attempt once the retry pause has passed. A restart or a second instance
 * can't do the same job twice.
 */
async function claim(db: Db, userId: string, kind: string, localDate: string, now: Date) {
  const retryBefore = new Date(now.getTime() - RETRY_AFTER_MIN * 60_000);
  const [row] = await db
    .insert(notificationLog)
    .values({ userId, kind, localDate, sentAt: now })
    .onConflictDoUpdate({
      target: [notificationLog.userId, notificationLog.kind, notificationLog.localDate],
      set: { attempts: sql`${notificationLog.attempts} + 1`, sentAt: now },
      setWhere: sql`${notificationLog.delivered} = false
        and ${notificationLog.sentAt} < ${retryBefore.toISOString()}::timestamptz
        and ${notificationLog.attempts} < ${MAX_ATTEMPTS}`,
    })
    .returning({ id: notificationLog.id });
  return row?.id ?? null;
}

async function markDone(db: Db, id: string) {
  await db.update(notificationLog).set({ delivered: true }).where(eq(notificationLog.id, id));
}

/** Sends a push; true when it reached a device, or there was no device to reach. */
async function deliver(db: Db, pusher: Pusher, userId: string, message: PushMessage) {
  const result = await pusher.send(db, userId, message);
  return result.sent > 0 || result.failed === 0;
}

/**
 * Sends due reminders (at most once per kind per local day, retried after a failed
 * delivery) and runs a due review. Without a pusher, only reviews run.
 */
export async function runReminders(
  db: Db,
  pusher: Pusher | null,
  now: Date,
): Promise<ReminderKind[]> {
  const owner = await loadOwner(db);
  const localDate = localParts(now, owner.timezone).date;
  const sent: ReminderKind[] = [];
  if (pusher) {
    for (const kind of await dueReminders(db, owner, now)) {
      const id = await claim(db, owner.userId, kind, localDate, now);
      if (!id) continue;
      if (
        await deliver(db, pusher, owner.userId, MESSAGES[kind as Exclude<ReminderKind, 'review'>])
      ) {
        await markDone(db, id);
        sent.push(kind);
      }
    }
  }
  if (await runScheduledReview(db, pusher, owner, localDate, now)) sent.push('review');
  return sent;
}

/** Scheduled reviews run at midday, after the morning weigh-in has had time to arrive. */
const REVIEW_TIME_MIN = 12 * 60;

/**
 * Runs a due review at or after midday on its due date, then pushes its outcome. Running and
 * notifying are claimed separately: a failed run is retried later in the day, and a failed
 * notification is resent from the stored result even though the review itself won't run again.
 */
async function runScheduledReview(
  db: Db,
  pusher: Pusher | null,
  owner: Profile,
  localDate: string,
  now: Date,
): Promise<boolean> {
  if (localParts(now, owner.timezone).minutes < REVIEW_TIME_MIN) return false;

  let ran = false;
  if (await reviewDue(db, owner, now)) {
    const id = await claim(db, owner.userId, 'review_run', localDate, now);
    if (id) {
      await runReview(db, owner, now); // throws on failure: the claim stays open for a retry
      await markDone(db, id);
      ran = true;
    }
  }

  // Notify only about today's scheduled run, not a review run by hand from the app.
  const [scheduled] = await db
    .select({ id: notificationLog.id })
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.userId, owner.userId),
        eq(notificationLog.kind, 'review_run'),
        eq(notificationLog.localDate, localDate),
        eq(notificationLog.delivered, true),
      ),
    );
  if (scheduled && pusher && owner.remindersEnabled) {
    const latest = await latestReviewOn(db, owner.userId, localDate);
    if (latest) {
      const id = await claim(db, owner.userId, 'review', localDate, now);
      if (id) {
        const ok = await deliver(db, pusher, owner.userId, {
          title: latest.outcome === 'hold' ? 'Review: no change' : 'Review: proposal ready',
          body: latest.explanation,
          url: '/plan',
          tag: 'review',
        });
        if (ok) await markDone(db, id);
      }
    }
  }
  return ran;
}

/** Checks reminders and reviews every minute. Returns a stop function. */
export function startReminderLoop(db: Db, pusher: Pusher | null, intervalMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await runReminders(db, pusher, new Date());
      if (done.length > 0) console.log(`scheduled: ${done.join(', ')}`);
    } catch (err) {
      console.error('reminder/review check failed', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
