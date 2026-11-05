import { isPushServiceUrl } from '@diet/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import webpush from 'web-push';
import type { Db } from '../db/client.js';
import { bodyMeasurement, checkin, notificationLog, pushSubscription } from '../db/schema.js';
import type { Profile } from '../lib/owner.js';
import { loadOwner } from '../lib/owner.js';
import { isoWeekStart, localParts, localToInstant } from '../lib/time.js';

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

export type ReminderKind = 'weigh_in' | 'checkin';

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

const MESSAGES: Record<ReminderKind, PushMessage> = {
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

/** After a failed delivery, wait this long before trying again; give up after MAX_ATTEMPTS. */
const RETRY_AFTER_MIN = 15;
const MAX_ATTEMPTS = 4;

/**
 * Sends due reminders at most once per kind per local day. The log row is claimed before
 * sending, so a restart or a second instance can't double-send; a delivery that reached no
 * device releases the day for a retry after a pause instead of losing the reminder.
 */
export async function runReminders(db: Db, pusher: Pusher, now: Date): Promise<ReminderKind[]> {
  const owner = await loadOwner(db);
  const sent: ReminderKind[] = [];
  for (const kind of await dueReminders(db, owner, now)) {
    const localDate = localParts(now, owner.timezone).date;
    const retryBefore = new Date(now.getTime() - RETRY_AFTER_MIN * 60_000);
    const [claim] = await db
      .insert(notificationLog)
      .values({ userId: owner.userId, kind, localDate, sentAt: now })
      .onConflictDoUpdate({
        target: [notificationLog.userId, notificationLog.kind, notificationLog.localDate],
        set: { attempts: sql`${notificationLog.attempts} + 1`, sentAt: now },
        setWhere: sql`${notificationLog.delivered} = false
          and ${notificationLog.sentAt} < ${retryBefore.toISOString()}::timestamptz
          and ${notificationLog.attempts} < ${MAX_ATTEMPTS}`,
      })
      .returning({ id: notificationLog.id });
    if (!claim) continue;

    const result = await pusher.send(db, owner.userId, MESSAGES[kind]);
    // No devices at all is not a failure worth retrying.
    const delivered = result.sent > 0 || result.failed === 0;
    if (delivered) {
      await db
        .update(notificationLog)
        .set({ delivered: true })
        .where(eq(notificationLog.id, claim.id));
      sent.push(kind);
    }
  }
  return sent;
}

/** Checks reminders every minute. Returns a stop function. */
export function startReminderLoop(db: Db, pusher: Pusher, intervalMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sent = await runReminders(db, pusher, new Date());
      if (sent.length > 0) console.log(`reminders sent: ${sent.join(', ')}`);
    } catch (err) {
      console.error('reminder check failed', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
