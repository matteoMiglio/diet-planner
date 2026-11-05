import type {
  BarcodeLookupDto,
  FoodDto,
  FoodLogDayDto,
  LabelReadingDto,
  ScanContextDto,
} from '@diet/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelCall, ModelResult, PlanModel } from '../src/ai/model.js';
import { createApp } from '../src/app.js';
import { localToInstant } from '../src/lib/time.js';
import { createTestDb, freshOwner } from './helpers.js';

const handle = createTestDb();
const { db, sql } = handle;
let clock = localToInstant('2026-11-05T13:00', 'Europe/Rome'); // Thursday, lunch time

const NUTELLA = '3017620422003';
const UPC_A = '036000291452';
const UPC_AS_EAN = '0036000291452';
const offCalls: string[] = [];
const fakeOff: typeof fetch = async (input) => {
  const url = String(input);
  offCalls.push(url);
  if (url.includes(NUTELLA)) {
    return Response.json({
      status: 1,
      product: {
        product_name: 'Nutella',
        brands: 'Ferrero, Nutella',
        serving_quantity: 15,
        nutriscore_grade: 'unknown',
        nova_group: 4,
        additives_tags: ['en:e322', 'en:e322i'],
        ingredients_text: 'Zucchero, olio di palma, nocciole 13%...',
        nutriments: {
          'energy-kcal_100g': 539,
          proteins_100g: 6.3,
          carbohydrates_100g: 57.5,
          sugars_100g: 56.3,
          fat_100g: 30.9,
          'saturated-fat_100g': 10.6,
          fiber_100g: 0,
          salt_100g: 0.107,
        },
      },
    });
  }
  if (url.includes(UPC_AS_EAN)) {
    // Blank strings are how some products leave a nutrient empty.
    return Response.json({
      status: 1,
      product: {
        product_name: 'Cheddar',
        categories_tags: ['en:dairies', 'en:cheeses'],
        nutriments: {
          'energy-kcal_100g': '403',
          proteins_100g: '25',
          carbohydrates_100g: '1.3',
          fat_100g: '33',
          sugars_100g: '',
          'saturated-fat_100g': ' ',
          salt_100g: '-1',
        },
      },
    });
  }
  if (url.includes('4006381333931'))
    return Response.json({ status: 1, product: { product_name: 'Pen', nutriments: {} } });
  return Response.json({ status: 0, status_verbose: 'product not found' });
};

class LabelModel implements PlanModel {
  readonly name = 'claude-opus-5-5';
  images = 0;
  async call<T>(c: ModelCall<never>): Promise<ModelResult<T>> {
    this.images += c.images?.length ?? 0;
    return {
      output: {
        name: 'Fiocchi di latte',
        brand: 'Granarolo',
        servingG: 150,
        per100: {
          kcal: 99,
          proteinG: 11,
          carbsG: 2.5,
          sugarG: 2.5,
          fatG: 5,
          satFatG: 3.2,
          fibreG: null,
          saltG: 0.6,
        },
        notes: ['Salt converted from sodium.'],
      } as T,
      stopReason: 'end_turn',
      problem: null,
      raw: '',
      served: [
        {
          model: this.name,
          usage: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      ],
    };
  }
}

const labelModel = new LabelModel();
const app = createApp({
  db,
  version: 'test',
  log: false,
  now: () => clock,
  fetchOff: fakeOff,
  planModel: labelModel,
});
const send = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

beforeEach(async () => {
  await freshOwner(handle);
  offCalls.length = 0;
  clock = localToInstant('2026-11-05T13:00', 'Europe/Rome');
});
afterAll(() => sql.end());

describe('barcodes', () => {
  it('looks a product up on Open Food Facts once, then from the local catalogue', async () => {
    const first = (await (await send('GET', `/barcodes/${NUTELLA}`)).json()) as BarcodeLookupDto;
    expect(first).toMatchObject({ status: 'found', source: 'open_food_facts' });
    if (first.status !== 'found') throw new Error('not found');
    expect(first.food).toMatchObject({
      name: 'Nutella',
      brand: 'Ferrero',
      kcal: 539,
      sugarG: 56.3,
      units: { serving: 15 },
      pool: { inPool: false },
      product: {
        barcode: NUTELLA,
        source: 'off',
        nutriscoreGrade: null,
        novaGroup: 4,
        additives: ['E322', 'E322I'],
      },
    });
    expect(first.context).toMatchObject({ slot: 'lunch', remaining: null, conflicts: [] });
    expect(offCalls[0]).toContain('fields=');

    const again = (await (await send('GET', `/barcodes/${NUTELLA}`)).json()) as BarcodeLookupDto;
    expect(again).toMatchObject({ status: 'found', source: 'local' });
    expect(offCalls).toHaveLength(1);
  });

  it('treats UPC-A, EAN-13 and GTIN-14 forms as one product', async () => {
    const first = (await (await send('GET', `/barcodes/${UPC_A}`)).json()) as BarcodeLookupDto;
    if (first.status !== 'found') throw new Error('not found');
    expect(offCalls[0]).toContain(UPC_AS_EAN);
    expect(first.food.product).toMatchObject({ barcode: UPC_AS_EAN, category: 'cheese' });
    // Blank and out-of-range values are missing, not zero.
    expect(first.food).toMatchObject({ kcal: 403, sugarG: null, satFatG: null, saltG: null });
    for (const form of [UPC_AS_EAN, `0${UPC_AS_EAN}`]) {
      const again = (await (await send('GET', `/barcodes/${form}`)).json()) as BarcodeLookupDto;
      expect(again).toMatchObject({ status: 'found', source: 'local' });
    }
    expect(offCalls).toHaveLength(1);
    // Saving the same product under another form is a duplicate.
    const dup = await send('POST', '/foods', {
      name: 'Cheddar again',
      kcal: 403,
      proteinG: 25,
      carbsG: 1.3,
      fatG: 33,
      barcode: UPC_A,
    });
    expect(dup.status).toBe(409);
  });

  it('reports unknown, incomplete and invalid barcodes', async () => {
    expect(await (await send('GET', '/barcodes/8000000000002')).json()).toEqual({
      status: 'not_found',
      reason: null,
    });
    const pen = (await (await send('GET', '/barcodes/4006381333931')).json()) as BarcodeLookupDto;
    expect(pen).toMatchObject({ status: 'incomplete' });
    expect((await send('GET', '/barcodes/3017620422004')).status).toBe(422);
  });

  it('says so when Open Food Facts is unreachable', async () => {
    const offline = createApp({
      db,
      version: 'test',
      log: false,
      now: () => clock,
      fetchOff: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const res = await offline.request(`/api/barcodes/${NUTELLA}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'off_unreachable' });
  });
});

describe('scan context', () => {
  it("works out today's remaining budget and rule conflicts", async () => {
    const day = (kcal: number) => ({ kcal, proteinG: 165, fatG: 75, carbsG: 240, fibreG: 24 });
    await send('POST', '/phases', {
      type: 'surplus',
      startedOn: '2026-11-01',
      maintenanceKcal: 2040,
      targets: { training: day(2320), rest: day(2200) },
    });
    const found = (await (await send('GET', `/barcodes/${NUTELLA}`)).json()) as BarcodeLookupDto;
    if (found.status !== 'found') throw new Error('not found');
    await send('POST', '/rules', {
      spec: { kind: 'exclude_food', foodIds: [found.food.id] },
      text: 'No spreads.',
    });

    // Thursday is a rest day; nothing planned or logged yet.
    let ctx = (await (
      await send('GET', `/scan/context?foodId=${found.food.id}`)
    ).json()) as ScanContextDto;
    expect(ctx).toMatchObject({
      phase: 'surplus',
      remaining: { kcal: 2200, fatG: 75 },
      slot: 'lunch',
    });
    expect(ctx.conflicts[0]).toContain('No spreads.');

    await send('POST', '/food-log', { foodId: found.food.id, grams: 30, via: 'scan' });
    ctx = (await (await send('GET', '/scan/context')).json()) as ScanContextDto;
    expect(ctx.remaining).toEqual({ kcal: 2038, fatG: 66 });
  });
});

describe('scan context unit counting', () => {
  it('counts whole units of a fixed-unit food against a max-per-day rule', async () => {
    const yogurt = (await (
      await send('POST', '/foods', {
        name: 'Greek yogurt',
        kcal: 60,
        proteinG: 10,
        carbsG: 4,
        fatG: 0,
        units: { cup: 150 },
        pool: {
          inPool: true,
          role: 'dairy_protein',
          preferredSlots: ['breakfast'],
          priority: 'medium',
          portion: { kind: 'fixed_unit', unit: 'cup' },
        },
      })
    ).json()) as FoodDto;
    await send('POST', '/rules', {
      spec: { kind: 'max_items_per_day', foodIds: [yogurt.id], max: 2 },
      text: 'Two yogurts a day at most.',
    });
    const conflicts = async () =>
      ((await (await send('GET', `/scan/context?foodId=${yogurt.id}`)).json()) as ScanContextDto)
        .conflicts;
    expect(await conflicts()).toEqual([]);
    // One entry of two cups already uses the allowance.
    await send('POST', '/food-log', { foodId: yogurt.id, grams: 300, via: 'search' });
    expect((await conflicts())[0]).toContain('2 of the 2 allowed');
  });
});

describe('food log', () => {
  it('logs with a snapshot, totals the day, and deletes', async () => {
    const found = (await (await send('GET', `/barcodes/${NUTELLA}`)).json()) as BarcodeLookupDto;
    if (found.status !== 'found') throw new Error('not found');
    const created = await send('POST', '/food-log', {
      foodId: found.food.id,
      grams: 15,
      via: 'scan',
    });
    expect(created.status).toBe(201);
    // Editing the food later doesn't change what was logged.
    await sql`update food set kcal = 1000 where id = ${found.food.id}`;
    const day = (await (await send('GET', '/food-log')).json()) as FoodLogDayDto;
    expect(day).toMatchObject({ date: '2026-11-05', totals: { kcal: 81, fatG: 5 } });
    expect(day.entries[0]).toMatchObject({
      name: 'Nutella (Ferrero)',
      grams: 15,
      slot: 'lunch',
      via: 'scan',
    });
    expect((await send('DELETE', `/food-log/${day.entries[0]!.id}`)).status).toBe(204);
    expect(
      ((await (await send('GET', '/food-log?date=2026-11-05')).json()) as FoodLogDayDto).entries,
    ).toHaveLength(0);
    expect(
      (await send('POST', '/food-log', { foodId: found.food.id, grams: 0, via: 'scan' })).status,
    ).toBe(422);
  });
});

describe('label reading', () => {
  const photo = (type = 'image/jpeg', bytes = 1000) => {
    const form = new FormData();
    form.append('photo', new File([new Uint8Array(bytes)], 'label.jpg', { type }));
    return form;
  };

  it('reads a label photo into values to review, and saves the product with its barcode', async () => {
    const res = await app.request('/api/labels/read', { method: 'POST', body: photo() });
    const reading = (await res.json()) as LabelReadingDto;
    expect(reading).toMatchObject({ name: 'Fiocchi di latte', per100: { kcal: 99, saltG: 0.6 } });
    expect(reading.costUsd).toBeGreaterThan(0);
    expect(labelModel.images).toBeGreaterThan(0);

    const saved = (await (
      await send('POST', '/foods', {
        name: 'Fiocchi di latte',
        brand: 'Granarolo',
        kcal: 99,
        proteinG: 11,
        carbsG: 2.5,
        fatG: 5,
        saltG: 0.6,
        barcode: '8000000000002',
      })
    ).json()) as FoodDto;
    expect(saved.product).toMatchObject({ barcode: '8000000000002', source: 'custom' });
    const lookup = (await (
      await send('GET', '/barcodes/8000000000002')
    ).json()) as BarcodeLookupDto;
    expect(lookup).toMatchObject({ status: 'found', source: 'local' });
    expect(
      (
        await send('POST', '/foods', {
          name: 'Dup',
          kcal: 99,
          proteinG: 11,
          carbsG: 2.5,
          fatG: 5,
          barcode: '8000000000002',
        })
      ).status,
    ).toBe(409);
  });

  it('rejects other file types and oversized photos', async () => {
    expect(
      (await app.request('/api/labels/read', { method: 'POST', body: photo('application/pdf') }))
        .status,
    ).toBe(422);
    expect(
      (
        await app.request('/api/labels/read', {
          method: 'POST',
          body: photo('image/jpeg', 7 * 1024 * 1024),
        })
      ).status,
    ).toBe(413);
  });
});
