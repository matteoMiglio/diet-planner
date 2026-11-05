/**
 * Barcodes (spec §9.1): the local catalogue first, then Open Food Facts. A product found
 * there is stored as a food (outside the planning pool) so the next scan is instant and the
 * values never change under a logged entry.
 */
import type { NutriCategory } from '@diet/shared';
import { canonicalBarcode } from '@diet/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { food } from '../db/schema.js';
import { HttpError } from '../lib/http.js';

type Food = typeof food.$inferSelect;

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_FIELDS = [
  'code',
  'product_name',
  'product_name_it',
  'product_name_en',
  'brands',
  'serving_quantity',
  'nutriments',
  'nutriscore_grade',
  'categories_tags',
  'nova_group',
  'additives_tags',
  'ingredients_text',
  'ingredients_text_it',
  'ingredients_text_en',
].join(',');
/** A generic client name: no personal data goes to Open Food Facts. */
const USER_AGENT = 'DietPlanner/0.1 (self-hosted)';
const TIMEOUT_MS = 8000;

/** Open Food Facts categories that get Nutri-Score's own protein rule (2023 algorithm). */
const CHEESE = new Set(['en:cheeses']);
const RED_MEAT = new Set([
  'en:beef',
  'en:pork',
  'en:lamb-meat',
  'en:veal',
  'en:horse-meat',
  'en:goat-meat',
  'en:game-meat',
  'en:red-meats',
  'en:beef-products',
  'en:pork-products',
  'en:hams',
  'en:salamis',
]);

export function nutriCategoryOf(tags: unknown): NutriCategory {
  if (!Array.isArray(tags)) return 'general';
  if (tags.some((t) => CHEESE.has(t))) return 'cheese';
  if (tags.some((t) => RED_MEAT.has(t))) return 'red_meat';
  return 'general';
}

interface OffProduct {
  product_name?: string;
  product_name_it?: string;
  product_name_en?: string;
  brands?: string;
  serving_quantity?: number | string | null;
  nutriments?: Record<string, number | string | undefined>;
  nutriscore_grade?: string;
  categories_tags?: string[];
  nova_group?: number | string;
  additives_tags?: string[];
  ingredients_text?: string;
  ingredients_text_it?: string;
  ingredients_text_en?: string;
}

/** A number, or null for anything else: `Number('')` is 0, so blank strings are caught first. */
const num = (v: unknown): number | null => {
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
/** An optional per-100 g value: out of range counts as missing rather than failing the product. */
const per100 = (v: unknown, max = 100): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && n <= max ? n : null;
};
const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;
const roundOrNull = (v: number | null, digits = 1) => (v === null ? null : round(v, digits));
const firstText = (...values: (string | undefined)[]) =>
  values.map((v) => v?.trim()).find((v) => v) ?? null;

export type OffLookup =
  | { status: 'found'; values: typeof food.$inferInsert }
  | { status: 'not_found' }
  | { status: 'incomplete'; reason: string };

/** Fetches one product and maps it to food columns; nothing is written. */
export async function fetchOffProduct(
  code: string,
  fetchFn: typeof fetch,
  userId: string,
): Promise<OffLookup> {
  let res: Response;
  try {
    res = await fetchFn(`${OFF_URL}${code}?fields=${OFF_FIELDS}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(
      503,
      'off_unreachable',
      "Can't reach Open Food Facts right now. Try again, or read the label.",
    );
  }
  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok)
    throw new HttpError(
      503,
      'off_error',
      `Open Food Facts answered ${res.status}. Try again later.`,
    );
  const body = (await res.json()) as { status?: number; product?: OffProduct };
  // Open Food Facts answers 200 with status 0 for an unknown barcode.
  if (body.status !== 1 || !body.product) return { status: 'not_found' };
  const p = body.product;
  const n = p.nutriments ?? {};

  const name = firstText(p.product_name_it, p.product_name, p.product_name_en);
  const kcal =
    num(n['energy-kcal_100g']) ??
    (num(n['energy_100g']) !== null ? num(n['energy_100g'])! / 4.184 : null);
  const proteinG = num(n['proteins_100g']);
  const carbsG = num(n['carbohydrates_100g']);
  const fatG = num(n['fat_100g']);
  if (!name) return { status: 'incomplete', reason: 'The product has no name on Open Food Facts.' };
  if (kcal === null || proteinG === null || carbsG === null || fatG === null) {
    return {
      status: 'incomplete',
      reason: 'Open Food Facts has no complete nutrition values for it.',
    };
  }
  if (
    kcal < 0 ||
    proteinG < 0 ||
    carbsG < 0 ||
    fatG < 0 ||
    kcal > 950 ||
    proteinG > 100 ||
    carbsG > 100 ||
    fatG > 100
  ) {
    return { status: 'incomplete', reason: 'The values on Open Food Facts look wrong.' };
  }
  const grade = p.nutriscore_grade?.toLowerCase();
  const nova = num(p.nova_group);
  const serving = num(p.serving_quantity);

  return {
    status: 'found',
    values: {
      userId,
      source: 'off',
      sourceRef: code,
      barcode: code,
      name: name.slice(0, 120),
      brand: firstText(p.brands?.split(',')[0])?.slice(0, 120) ?? null,
      kcal: round(kcal),
      proteinG: round(proteinG),
      carbsG: round(carbsG),
      fatG: round(fatG),
      fibreG: roundOrNull(per100(n['fiber_100g'])),
      sugarG: roundOrNull(per100(n['sugars_100g'])),
      satFatG: roundOrNull(per100(n['saturated-fat_100g'])),
      saltG: roundOrNull(per100(n['salt_100g']), 2),
      basis: 'as_sold',
      units: serving && serving > 0 && serving <= 3000 ? { serving: round(serving) } : {},
      nutriscoreGrade: grade && /^[a-e]$/.test(grade) ? grade : null,
      nutriCategory: nutriCategoryOf(p.categories_tags),
      novaGroup: nova !== null && nova >= 1 && nova <= 4 ? nova : null,
      additives: Array.isArray(p.additives_tags)
        ? p.additives_tags.map((t) => t.replace(/^[a-z]{2}:/, '').toUpperCase()).slice(0, 50)
        : null,
      ingredientsText:
        firstText(p.ingredients_text_it, p.ingredients_text, p.ingredients_text_en)?.slice(
          0,
          4000,
        ) ?? null,
      offFetchedAt: new Date(),
      inPool: false,
    },
  };
}

export type BarcodeResult =
  | { status: 'found'; food: Food; source: 'local' | 'open_food_facts' }
  | { status: 'not_found' | 'incomplete'; reason: string | null };

export async function lookupBarcode(
  db: Db,
  userId: string,
  raw: string,
  fetchFn: typeof fetch,
): Promise<BarcodeResult> {
  const canonical = canonicalBarcode(raw);
  if (canonical === null) {
    throw new HttpError(
      422,
      'invalid_barcode',
      `${raw} isn't a valid barcode (EAN/UPC check digit).`,
    );
  }
  // UPC-A, EAN-13 with a leading zero and UPC-E are one product: stored and looked up as one code.
  const code = canonical;
  const [local] = await db
    .select()
    .from(food)
    .where(and(eq(food.userId, userId), eq(food.barcode, code)));
  if (local) return { status: 'found', food: local, source: 'local' };

  const off = await fetchOffProduct(code, fetchFn, userId);
  if (off.status === 'not_found') return { status: 'not_found', reason: null };
  if (off.status === 'incomplete') return { status: 'incomplete', reason: off.reason };
  // Two scans at once: the unique (user, barcode) index makes the second one read the first.
  const [created] = await db.insert(food).values(off.values).onConflictDoNothing().returning();
  if (created) return { status: 'found', food: created, source: 'open_food_facts' };
  const [existing] = await db
    .select()
    .from(food)
    .where(and(eq(food.userId, userId), eq(food.barcode, code)));
  return { status: 'found', food: existing!, source: 'local' };
}
