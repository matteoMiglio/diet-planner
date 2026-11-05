import { type BarcodeLookupDto, localDate, LogFoodRequest } from '@diet/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { PlanModel } from '../ai/model.js';
import type { Db } from '../db/client.js';
import { food } from '../db/schema.js';
import { HttpError, parseJson } from '../lib/http.js';
import { loadOwner } from '../lib/owner.js';
import { localParts } from '../lib/time.js';
import { deleteEntry, logDay, logFood, scanContext } from '../services/foodlog.js';
import { readLabel } from '../services/labels.js';
import { toFoodDto } from '../services/plans.js';
import { lookupBarcode } from '../services/products.js';

export function createScanRoutes({
  db,
  now,
  planModel,
  fetchOff,
}: {
  db: Db;
  now: () => Date;
  planModel: PlanModel | null;
  fetchOff: typeof fetch;
}) {
  const r = new Hono();

  r.get('/barcodes/:code', async (c) => {
    const owner = await loadOwner(db);
    const code = (c.req.param('code') ?? '').trim();
    const result = await lookupBarcode(db, owner.userId, code, fetchOff);
    const body: BarcodeLookupDto =
      result.status === 'found'
        ? {
            status: 'found',
            source: result.source,
            food: toFoodDto(result.food),
            context: await scanContext(db, owner, result.food, now()),
          }
        : { status: result.status, reason: result.reason };
    return c.json(body);
  });

  r.get('/scan/context', async (c) => {
    const owner = await loadOwner(db);
    const id = c.req.query('foodId');
    let row: { id: string; name: string } | null = null;
    if (id) {
      const parsed = z.uuid().safeParse(id);
      if (!parsed.success) throw new HttpError(404, 'not_found', 'No such food.');
      [row = null] = await db
        .select({ id: food.id, name: food.name })
        .from(food)
        .where(and(eq(food.id, parsed.data), eq(food.userId, owner.userId)));
      if (!row) throw new HttpError(404, 'not_found', 'No such food.');
    }
    return c.json(await scanContext(db, owner, row, now()));
  });

  r.post(
    '/labels/read',
    bodyLimit({
      maxSize: 6 * 1024 * 1024,
      onError: () => {
        throw new HttpError(413, 'too_large', 'The photo must be under 5 MB.');
      },
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const photo = body.photo;
      if (!(photo instanceof File))
        throw new HttpError(422, 'no_photo', 'Send the photo as the "photo" field.');
      return c.json(
        await readLabel(planModel, {
          bytes: new Uint8Array(await photo.arrayBuffer()),
          type: photo.type,
        }),
      );
    },
  );

  r.get('/food-log', async (c) => {
    const owner = await loadOwner(db);
    const date = c.req.query('date');
    const parsed = date ? localDate.safeParse(date) : null;
    if (parsed && !parsed.success)
      throw new HttpError(422, 'invalid_date', 'Expected ?date=YYYY-MM-DD.');
    return c.json(
      await logDay(db, owner.userId, parsed?.data ?? localParts(now(), owner.timezone).date),
    );
  });

  r.post('/food-log', async (c) => {
    const input = await parseJson(c, LogFoodRequest);
    return c.json(await logFood(db, await loadOwner(db), input, now()), 201);
  });

  r.delete('/food-log/:id', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) throw new HttpError(404, 'not_found', 'No such entry.');
    await deleteEntry(db, (await loadOwner(db)).userId, id.data);
    return c.body(null, 204);
  });

  return r;
}
