import type { RuleDto, RuleInput, RuleSpec } from '@diet/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { food, rule } from '../db/schema.js';
import { HttpError } from '../lib/http.js';

type Rule = typeof rule.$inferSelect;

export function toRuleDto(r: Rule): RuleDto {
  return { id: r.id, spec: r.spec as RuleSpec, text: r.text, active: r.active };
}

/** Every food a rule mentions must be one of the owner's foods. */
async function checkFoods(db: Db, userId: string, spec: RuleSpec) {
  const ids = [
    ...('foodIds' in spec ? spec.foodIds : []),
    ...('fallbackFoodIds' in spec ? spec.fallbackFoodIds : []),
  ];
  if (ids.length === 0) return;
  const found = await db
    .select({ id: food.id })
    .from(food)
    .where(and(eq(food.userId, userId), inArray(food.id, ids)));
  if (found.length !== new Set(ids).size) {
    throw new HttpError(422, 'unknown_food', 'The rule refers to a food that does not exist.');
  }
}

export async function listRules(db: Db, userId: string, { activeOnly = false } = {}) {
  const rows = await db
    .select()
    .from(rule)
    .where(
      activeOnly ? and(eq(rule.userId, userId), eq(rule.active, true)) : eq(rule.userId, userId),
    )
    .orderBy(asc(rule.position), asc(rule.createdAt));
  return rows.map(toRuleDto);
}

export async function createRule(db: Db, userId: string, input: RuleInput) {
  await checkFoods(db, userId, input.spec);
  const [row] = await db
    .insert(rule)
    .values({
      userId,
      kind: input.spec.kind,
      spec: input.spec,
      text: input.text,
      active: input.active ?? true,
    })
    .returning();
  return toRuleDto(row!);
}

export async function updateRule(db: Db, userId: string, id: string, input: RuleInput) {
  await checkFoods(db, userId, input.spec);
  const [row] = await db
    .update(rule)
    .set({
      kind: input.spec.kind,
      spec: input.spec,
      text: input.text,
      ...(input.active !== undefined && { active: input.active }),
    })
    .where(and(eq(rule.id, id), eq(rule.userId, userId)))
    .returning();
  if (!row) throw new HttpError(404, 'not_found', 'No such rule.');
  return toRuleDto(row);
}

export async function deleteRule(db: Db, userId: string, id: string) {
  const deleted = await db
    .delete(rule)
    .where(and(eq(rule.id, id), eq(rule.userId, userId)))
    .returning({ id: rule.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'No such rule.');
}
