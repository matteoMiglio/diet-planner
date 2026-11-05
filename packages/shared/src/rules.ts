/**
 * Food pool metadata and planning rules (spec §5.3–5.4): the contract shared by the API,
 * the validator, the portion solver and the web editors.
 */
import { z } from 'zod';
import { SLOTS } from './plan.js';

export const ROLES = [
  'main_protein',
  'main_carb',
  'fat',
  'veg',
  'fruit',
  'dairy_protein',
  'snack',
  'other',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  main_protein: 'Main protein',
  main_carb: 'Main carb',
  fat: 'Fat',
  veg: 'Vegetables',
  fruit: 'Fruit',
  dairy_protein: 'Dairy protein',
  snack: 'Snack',
  other: 'Other',
};

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** How a food may be portioned: in free gram steps, or only in whole units. */
export const PortionRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('flexible'), stepG: z.number().positive().max(500) }),
  z.object({
    kind: z.literal('fixed_unit'),
    /** A key of the food's `units`, e.g. "cup", "slice", "egg". */
    unit: z.string().min(1).max(30),
  }),
]);
export type PortionRule = z.infer<typeof PortionRule>;

/** Pool fields a food carries when it is in the planning pool. */
export const PoolInfo = z.object({
  inPool: z.boolean(),
  role: z.enum(ROLES),
  preferredSlots: z.array(z.enum(SLOTS)).max(SLOTS.length),
  priority: z.enum(PRIORITIES),
  portion: PortionRule,
});
export type PoolInfo = z.infer<typeof PoolInfo>;

const foodIds = z.array(z.uuid()).min(1).max(20);
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7);

/** Rules code can check. `guidance` is free text the model reads but code can't check. */
export const RuleSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exclude_food'), foodIds }),
  /** At most `max` items of these foods per day (counting default options), e.g. yogurt ≤ 2. */
  z.object({ kind: z.literal('max_items_per_day'), foodIds, max: z.number().int().min(0).max(10) }),
  /** These foods never appear on the same day (any option). */
  z.object({ kind: z.literal('not_same_day'), foodIds: foodIds.min(2) }),
  z.object({
    kind: z.literal('forbidden_on_day_type'),
    foodIds,
    dayType: z.enum(['training', 'rest']),
  }),
  z.object({ kind: z.literal('allowed_weekdays'), foodIds, weekdays }),
  /** Below `minG` the item should be replaced by one of `fallbackFoodIds` (e.g. rice → Wasa). */
  z.object({
    kind: z.literal('min_portion'),
    foodIds,
    minG: z.number().positive().max(1000),
    fallbackFoodIds: z.array(z.uuid()).max(10),
  }),
  /** The main protein and main carb of lunch and dinner differ on the same day. */
  z.object({
    kind: z.literal('no_repeat_role_lunch_dinner'),
    roles: z.array(z.enum(ROLES)).min(1),
  }),
  /** Always this amount in this slot, e.g. chicken as the 190 g frozen slice at dinner. */
  z.object({
    kind: z.literal('fixed_portion'),
    foodIds: foodIds.max(1),
    slot: z.enum(SLOTS),
    grams: z.number().positive().max(3000),
  }),
  /** These slots are kept exactly as in the current plan; the generator doesn't touch them. */
  z.object({ kind: z.literal('fixed_slots'), slots: z.array(z.enum(SLOTS)).min(1) }),
  z.object({ kind: z.literal('guidance') }),
]);
export type RuleSpec = z.infer<typeof RuleSpec>;
export type RuleKind = RuleSpec['kind'];

export const RuleInput = z.object({
  spec: RuleSpec,
  /** The rule in words; sent to the model, shown in the editor. */
  text: z.string().trim().min(1).max(500),
  active: z.boolean().optional(),
});
export type RuleInput = z.infer<typeof RuleInput>;

export interface RuleDto {
  id: string;
  spec: RuleSpec;
  text: string;
  active: boolean;
}

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  exclude_food: 'Never use',
  max_items_per_day: 'At most N per day',
  not_same_day: 'Not on the same day',
  forbidden_on_day_type: 'Not on training/rest days',
  allowed_weekdays: 'Only on certain weekdays',
  min_portion: 'Minimum portion, else a swap',
  no_repeat_role_lunch_dinner: 'Lunch and dinner differ',
  fixed_portion: 'Fixed portion in a slot',
  fixed_slots: 'Keep these meals fixed',
  guidance: 'Guidance (not checked)',
};
