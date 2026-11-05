import { readFileSync } from 'node:fs';
import type {
  CheckinDto,
  CurrentCheckinDto,
  ImportPreviewDto,
  ProgressDto,
  SettingsDto,
} from '@diet/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bodyMeasurement, notificationLog, profile, pushSubscription } from '../src/db/schema.js';
import { localToInstant } from '../src/lib/time.js';
import { dueReminders, type Pusher, runReminders } from '../src/services/push.js';
import { loadOwner } from '../src/lib/owner.js';
import { createTestDb, freshOwner } from './helpers.js';

const handle = createTestDb();
const { db, sql } = handle;
const TOKEN = 'x'.repeat(40);
const csv = readFileSync(
  new URL('../../../packages/shared/test/fixtures/tanita-rd953-synthetic.csv', import.meta.url),
  'utf8',
);

/** A clock the tests can move. */
let clock = new Date('2026-02-10T08:00:00Z');
const sentMessages: { title: string }[] = [];
const fakePusher: Pusher = {
  publicKey: 'test-public-key',
  async send(_db, _userId, message) {
    sentMessages.push(message);
    return { sent: 1, failed: 0 };
  },
};

const app = createApp({
  db,
  version: 'test',
  log: false,
  ingestToken: TOKEN,
  pusher: fakePusher,
  now: () => clock,
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const auth = { Authorization: `Bearer ${TOKEN}` };

let userId: string;
beforeEach(async () => {
  userId = await freshOwner(handle);
  clock = new Date('2026-02-10T08:00:00Z');
  sentMessages.length = 0;
});
afterAll(() => sql.end());

describe('Tanita import', () => {
  it('previews without writing, then imports, then recognises duplicates', async () => {
    const preview = await app.request('/api/measurements/import?dryRun=1', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: csv,
    });
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as ImportPreviewDto;
    expect(p).toMatchObject({ dryRun: true, created: 3, merged: 0, duplicates: 0 });
    expect(await db.select().from(bodyMeasurement)).toHaveLength(0);

    const first = (await (
      await app.request('/api/measurements/import', { method: 'POST', body: csv })
    ).json()) as ImportPreviewDto;
    expect(first.created).toBe(3);

    const again = (await (
      await app.request('/api/measurements/import', { method: 'POST', body: csv })
    ).json()) as ImportPreviewDto;
    expect(again).toMatchObject({ created: 0, duplicates: 3 });
    expect(await db.select().from(bodyMeasurement)).toHaveLength(3);
  });

  it('stores readings as instants in the profile timezone and flags off-protocol times', async () => {
    await app.request('/api/measurements/import', { method: 'POST', body: csv });
    const rows = await db.select().from(bodyMeasurement).orderBy(bodyMeasurement.measuredAt);
    expect(rows.map((r) => [r.measuredAt.toISOString(), r.protocolOk])).toEqual([
      ['2026-01-12T06:41:10.000Z', true],
      ['2026-01-26T18:05:33.000Z', false],
      ['2026-02-09T07:02:51.000Z', true],
    ]);
    expect(rows[0]).toMatchObject({ weightKg: 80.4, bodyFatPct: 15.2, muscleQuality: 70 });
  });

  it('accepts a multipart upload', async () => {
    const form = new FormData();
    form.append('file', new File([csv], 'report.csv', { type: 'text/csv' }));
    const res = await app.request('/api/measurements/import', { method: 'POST', body: form });
    expect(((await res.json()) as ImportPreviewDto).created).toBe(3);
  });

  it('rejects a file that is not a Tanita export', async () => {
    const res = await app.request('/api/measurements/import', { method: 'POST', body: 'a,b\n1,2' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'unreadable_csv' });
  });

  it('merges a Shortcut weigh-in into the scale reading taken minutes later', async () => {
    // Logged by Shortcut at 07:38 local; the CSV row for that weigh-in says 07:41:10.
    clock = localToInstant('2026-01-12T07:38:00', 'Europe/Rome');
    await app.request('/api/ingest/weight', { method: 'POST', headers: auth, body: '80,3' });

    const res = (await (
      await app.request('/api/measurements/import', { method: 'POST', body: csv })
    ).json()) as ImportPreviewDto;
    expect(res).toMatchObject({ created: 2, merged: 1 });
    const rows = await db.select().from(bodyMeasurement);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === 'tanita_csv')).toBe(true);
  });
});

describe('Shortcut ingest', () => {
  it('requires the bearer token', async () => {
    expect((await app.request('/api/ingest/weight', { method: 'POST', body: '80' })).status).toBe(
      401,
    );
    const wrong = { Authorization: `Bearer ${'y'.repeat(40)}` };
    expect(
      (await app.request('/api/ingest/weight', { method: 'POST', headers: wrong, body: '80' }))
        .status,
    ).toBe(401);
  });

  it('is disabled when no token is configured', async () => {
    const noToken = createApp({ db, version: 'test', log: false });
    const res = await noToken.request('/api/ingest/weight', {
      method: 'POST',
      headers: auth,
      body: '80',
    });
    expect(res.status).toBe(503);
  });

  it('logs a weight from a bare number or JSON and updates it within ten minutes', async () => {
    const first = await app.request('/api/ingest/weight', {
      method: 'POST',
      headers: auth,
      body: '86.4',
    });
    expect(await first.json()).toMatchObject({ status: 'created', message: 'Logged 86.40 kg.' });

    clock = new Date(clock.getTime() + 5 * 60_000);
    const second = await app.request('/api/ingest/weight', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ weightKg: 86.2 }),
    });
    expect(await second.json()).toMatchObject({ status: 'updated' });
    const rows = await db.select().from(bodyMeasurement);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weightKg: 86.2, source: 'shortcut' });
  });

  it('never overwrites a scale reading with a typed number', async () => {
    await app.request('/api/ingest/tanita', { method: 'POST', headers: auth, body: csv });
    clock = localToInstant('2026-02-09T08:05:00', 'Europe/Rome');
    const res = await app.request('/api/ingest/weight', {
      method: 'POST',
      headers: auth,
      body: '99',
    });
    expect(await res.json()).toMatchObject({ status: 'kept_scale_reading' });
    const [row] = await db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.measuredAt, new Date('2026-02-09T07:02:51Z')));
    expect(row?.weightKg).toBe(80.1);
  });

  it('rejects nonsense weights', async () => {
    for (const body of ['', 'abc', '5', '{"weightKg": 900}']) {
      const res = await app.request('/api/ingest/weight', { method: 'POST', headers: auth, body });
      expect(res.status).toBe(422);
    }
  });

  it('imports a CSV and answers with a sentence the Shortcut can show', async () => {
    const res = await app.request('/api/ingest/tanita', {
      method: 'POST',
      headers: auth,
      body: csv,
    });
    expect(await res.json()).toMatchObject({ message: 'Tanita import: 3 new.' });
  });
});

describe('progress and outliers', () => {
  it('returns measurements and a trend that says what it needs', async () => {
    await app.request('/api/measurements/import', { method: 'POST', body: csv });
    const body = (await (await app.request('/api/progress')).json()) as ProgressDto;
    expect(body.measurements).toHaveLength(3);
    expect(body.trend).toMatchObject({ decidable: false, n: 3, readingsNeeded: 1 });
    expect(body.trend.reasons).toContain('too_few_readings');
  });

  it('lets a reading be marked as an outlier and back', async () => {
    await app.request('/api/measurements/import', { method: 'POST', body: csv });
    const [first] = await db.select().from(bodyMeasurement).limit(1);
    const res = await app.request(`/api/measurements/${first!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outlierOverride: true }),
    });
    expect(await res.json()).toMatchObject({ outlierOverride: true });
    const progress = (await (await app.request('/api/progress')).json()) as ProgressDto;
    expect(progress.trend.outlierIds).toContain(first!.id);
    expect((await app.request('/api/measurements/not-a-uuid', { method: 'DELETE' })).status).toBe(
      404,
    );
  });
});

describe('weekly check-in', () => {
  it('is due until adherence and training are answered', async () => {
    // Tuesday 2026-02-10 → week of Monday 2026-02-09.
    let current = (await (await app.request('/api/checkins/current')).json()) as CurrentCheckinDto;
    expect(current).toMatchObject({
      weekStart: '2026-02-09',
      today: '2026-02-10',
      due: true,
      checkin: null,
    });

    const put = (body: unknown) =>
      app.request('/api/checkins/2026-02-09', { ...json(body), method: 'PUT' });

    let saved = (await (await put({ weightKg: 86.5, waistCm: 84.5 })).json()) as CheckinDto;
    expect(saved).toMatchObject({ weightKg: 86.5, completedAt: null });
    expect(saved.girth).toMatchObject({ measuredOn: '2026-02-10', waistCm: 84.5 });

    saved = (await (
      await put({ adherence: 'mostly', trainingProgressed: 'yes', sleep: 4, energy: 3, hunger: 2 })
    ).json()) as CheckinDto;
    expect(saved.completedAt).not.toBeNull();
    // Earlier answers survive a partial update.
    expect(saved).toMatchObject({ weightKg: 86.5, adherence: 'mostly' });

    current = (await (await app.request('/api/checkins/current')).json()) as CurrentCheckinDto;
    expect(current.due).toBe(false);
    expect(current.latestWeightThisWeek?.weightKg).toBe(86.5);
  });

  it('rejects weeks that are not Mondays or have not started', async () => {
    const put = (week: string) =>
      app.request(`/api/checkins/${week}`, { ...json({ sleep: 3 }), method: 'PUT' });
    expect((await put('2026-02-10')).status).toBe(422);
    expect((await put('2026-02-16')).status).toBe(422);
    expect((await put('not-a-date')).status).toBe(404);
  });

  it('validates answers', async () => {
    const res = await app.request('/api/checkins/2026-02-09', {
      ...json({ sleep: 9, adherence: 'sometimes' }),
      method: 'PUT',
    });
    expect(res.status).toBe(422);
  });
});

describe('settings and push', () => {
  it('reports configuration and saves reminder preferences', async () => {
    const settings = (await (await app.request('/api/settings')).json()) as SettingsDto;
    expect(settings).toMatchObject({
      ingest: { configured: true },
      push: { publicKey: 'test-public-key', subscriptions: 0 },
      profile: { weighInDays: [1, 4], weighInTime: '07:30', timezone: 'Europe/Rome' },
    });

    const res = await app.request('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weighInDays: [4, 1, 1, 6], weighInTime: '06:45' }),
    });
    expect(await res.json()).toMatchObject({ weighInDays: [1, 4, 6], weighInTime: '06:45' });

    const bad = await app.request('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'Mars/Olympus' }),
    });
    expect(bad.status).toBe(422);
  });

  it('stores push subscriptions idempotently', async () => {
    const sub = {
      endpoint: 'https://web.push.apple.com/QGuQyavXutnMb',
      keys: { p256dh: 'k', auth: 'a' },
    };
    await app.request('/api/push/subscriptions', json(sub));
    await app.request('/api/push/subscriptions', json(sub));
    expect(await db.select().from(pushSubscription)).toHaveLength(1);
    await app.request('/api/push/subscriptions', {
      ...json({ endpoint: sub.endpoint }),
      method: 'DELETE',
    });
    expect(await db.select().from(pushSubscription)).toHaveLength(0);
  });
});

describe('reminders', () => {
  const at = (local: string) => localToInstant(local, 'Europe/Rome');

  it('reminds to weigh in on weigh-in days after the set time, until a reading exists', async () => {
    const owner = await loadOwner(db);
    // Thursday 2026-02-12.
    expect(await dueReminders(db, owner, at('2026-02-12T07:29'))).toEqual([]);
    expect(await dueReminders(db, owner, at('2026-02-12T07:30'))).toEqual(['weigh_in']);
    expect(await dueReminders(db, owner, at('2026-02-12T11:00'))).toEqual([]); // past the window
    expect(await dueReminders(db, owner, at('2026-02-11T07:45'))).toEqual([]); // Wednesday

    clock = at('2026-02-12T07:10');
    await app.request('/api/ingest/weight', { method: 'POST', headers: auth, body: '86' });
    expect(await dueReminders(db, owner, at('2026-02-12T07:45'))).toEqual([]);
  });

  it('reminds about the check-in on Monday evening until it is complete', async () => {
    const owner = await loadOwner(db);
    expect(await dueReminders(db, owner, at('2026-02-09T20:15'))).toContain('checkin');
    clock = at('2026-02-09T20:20');
    await app.request('/api/checkins/2026-02-09', {
      ...json({ adherence: 'on_plan', trainingProgressed: 'yes' }),
      method: 'PUT',
    });
    expect(await dueReminders(db, owner, at('2026-02-09T20:30'))).not.toContain('checkin');
  });

  it('sends each reminder once per day, and none when switched off', async () => {
    expect(await runReminders(db, fakePusher, at('2026-02-12T07:31'))).toEqual(['weigh_in']);
    expect(await runReminders(db, fakePusher, at('2026-02-12T07:32'))).toEqual([]);
    expect(sentMessages).toHaveLength(1);
    expect(await db.select().from(notificationLog)).toHaveLength(1);

    await db.update(profile).set({ remindersEnabled: false }).where(eq(profile.userId, userId));
    expect(await runReminders(db, fakePusher, at('2026-02-16T07:31'))).toEqual([]);
  });
});

describe('review fixes', () => {
  const at = (local: string) => localToInstant(local, 'Europe/Rome');

  it('keeps two Tanita readings minutes apart, and dedupes only within the same minute', async () => {
    const two = 'Date,Weight (kg)\n2026-02-09 07:30:10,86.2\n2026-02-09 07:38:00,86.0\n';
    const first = (await (
      await app.request('/api/measurements/import', { method: 'POST', body: two })
    ).json()) as ImportPreviewDto;
    expect(first.created).toBe(2);
    const sameMinute = 'Date,Weight (kg)\n2026-02-09 07:30:45,86.2\n';
    const again = (await (
      await app.request('/api/measurements/import', { method: 'POST', body: sameMinute })
    ).json()) as ImportPreviewDto;
    expect(again).toMatchObject({ created: 0, duplicates: 1 });
  });

  it('records one reading when the same weigh-in arrives twice at once', async () => {
    clock = at('2026-02-10T07:30');
    await Promise.all(
      ['86.1', '86.2', '86.3'].map((body) =>
        app.request('/api/ingest/weight', { method: 'POST', headers: auth, body }),
      ),
    );
    expect(await db.select().from(bodyMeasurement)).toHaveLength(1);
  });

  it('edits the check-in tape measurements in place, keeping fields not sent', async () => {
    const put = (body: unknown) =>
      app.request('/api/checkins/2026-02-09', { ...json(body), method: 'PUT' });
    clock = at('2026-02-09T20:00');
    await put({ waistCm: 84, chestCm: 101 });
    clock = at('2026-02-10T20:00');
    const saved = (await (await put({ waistCm: 83.5 })).json()) as CheckinDto;
    expect(saved.girth).toMatchObject({ measuredOn: '2026-02-09', waistCm: 83.5, chestCm: 101 });
  });

  it('clears completedAt when an answer is removed, and keeps the first completion time', async () => {
    const put = (body: unknown) =>
      app.request('/api/checkins/2026-02-09', { ...json(body), method: 'PUT' });
    const done = (await (
      await put({ adherence: 'on_plan', trainingProgressed: 'yes' })
    ).json()) as CheckinDto;
    clock = new Date(clock.getTime() + 60_000);
    const edited = (await (await put({ sleep: 4 })).json()) as CheckinDto;
    expect(edited.completedAt).toBe(done.completedAt);
    const cleared = (await (await put({ adherence: null })).json()) as CheckinDto;
    expect(cleared.completedAt).toBeNull();
  });

  it('rejects cross-site browser writes but not Shortcut calls', async () => {
    const crossSite = await app.request('/api/measurements', {
      ...json({ weightKg: 80 }),
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    const otherOrigin = await app.request('http://diet.example.ts.net/api/measurements', {
      ...json({ weightKg: 80 }),
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    });
    expect(otherOrigin.status).toBe(403);
    const sameOrigin = await app.request('http://diet.example.ts.net/api/measurements', {
      ...json({ weightKg: 80 }),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://diet.example.ts.net',
        Host: 'diet.example.ts.net',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(sameOrigin.status).toBe(201);
    const shortcut = await app.request('/api/ingest/weight', {
      method: 'POST',
      headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' },
      body: '80',
    });
    expect(shortcut.status).toBe(200);
  });

  it('requires JSON for JSON endpoints', async () => {
    const res = await app.request('/api/measurements', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ weightKg: 80 }),
    });
    expect(res.status).toBe(415);
  });

  it('retries a reminder that reached no device, after a pause, a limited number of times', async () => {
    let attempts = 0;
    const failing: Pusher = {
      publicKey: 'k',
      async send() {
        attempts++;
        return { sent: 0, failed: 1 };
      },
    };
    expect(await runReminders(db, failing, at('2026-02-12T07:31'))).toEqual([]);
    expect(await runReminders(db, failing, at('2026-02-12T07:40'))).toEqual([]); // too soon
    expect(attempts).toBe(1);
    await runReminders(db, failing, at('2026-02-12T07:47'));
    await runReminders(db, failing, at('2026-02-12T08:03'));
    await runReminders(db, failing, at('2026-02-12T08:19'));
    await runReminders(db, failing, at('2026-02-12T08:35'));
    expect(attempts).toBe(4); // capped

    // A later success on another day is recorded as delivered.
    expect(await runReminders(db, fakePusher, at('2026-02-16T07:31'))).toEqual(['weigh_in']);
  });
});

describe('push endpoint allowlist', () => {
  it('accepts browser push services and rejects anything else', async () => {
    const subscribe = (endpoint: string) =>
      app.request('/api/push/subscriptions', json({ endpoint, keys: { p256dh: 'k', auth: 'a' } }));
    for (const ok of [
      'https://web.push.apple.com/abc',
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
    ]) {
      expect((await subscribe(ok)).status).toBe(204);
    }
    for (const bad of [
      'http://web.push.apple.com/abc',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost:3000/api/measurements',
      'https://web.push.apple.com.evil.example/abc',
      'https://fcm.googleapis.com:8443/abc',
      'https://user@fcm.googleapis.com/abc',
    ]) {
      expect((await subscribe(bad)).status).toBe(422);
    }
  });
});
