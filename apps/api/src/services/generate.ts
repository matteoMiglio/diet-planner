/**
 * AI meal-plan generation (spec §7): payload → model → validate → portion solver → one repair
 * round for the failing days → validate → draft plan. Nothing reaches the active plan: the
 * result is a draft the person reviews in the editor and activates themselves.
 */
import type {
  AiRunDto,
  PlanContext,
  PlanError,
  PlanFood,
  RuleSpec,
  Slot,
  Targets,
  ValidationResult,
} from '@diet/shared';
import { dayMacros, PlanDocument, solvePortions, validatePlan } from '@diet/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiRun, food, mealPlan } from '../db/schema.js';
import { HttpError } from '../lib/http.js';
import type { Profile } from '../lib/owner.js';
import { localParts } from '../lib/time.js';
import { costOf, type PlanModel, type ServedUsage } from '../ai/model.js';
import {
  AiPlan,
  generationMessage,
  type PlanPayload,
  PROMPT_VERSION,
  repairMessage,
  SYSTEM_PROMPT,
} from '../ai/plan-prompt.js';
import { activePhase, currentTargets, toTargetsDto } from './phases.js';
import { activePlan } from './plans.js';
import { listRules } from './rules.js';

const MAX_TOKENS = 32_000;
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SLOT_ORDER: Slot[] = [
  'breakfast',
  'morning_snack',
  'lunch',
  'afternoon_snack',
  'dinner',
  'evening_snack',
];
const GENERATED_SLOTS: Slot[] = [
  'breakfast',
  'morning_snack',
  'lunch',
  'afternoon_snack',
  'dinner',
];
/** Every day has these; snacks are optional. */
const MAIN_MEALS: Slot[] = ['breakfast', 'lunch', 'dinner'];
/** A cut's calorie floor (spec §6.3) also binds generated plans. */
const CUT_KCAL_FLOOR = 2000;

type Food = typeof food.$inferSelect;
type Run = typeof aiRun.$inferSelect;
type Meals = PlanDocument['days'][number]['meals'];

export type RunDto = AiRunDto;

export function toRunDto(r: Run): RunDto {
  return {
    id: r.id,
    status: r.status as RunDto['status'],
    model: r.model,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    costUsd: r.costUsd,
    error: r.error,
    planId: r.planId,
    result: (r.result as RunDto['result']) ?? null,
  };
}

// ---------- Context ----------

/** The food fields generation needs (a subset of a food row). */
export type PoolFood = Pick<
  Food,
  | 'id'
  | 'name'
  | 'kcal'
  | 'proteinG'
  | 'carbsG'
  | 'fatG'
  | 'fibreG'
  | 'units'
  | 'role'
  | 'preferredSlots'
  | 'priority'
  | 'portion'
  | 'notes'
>;

export interface ContextData {
  targets: Targets;
  trainingWeekdays: number[];
  phaseType: string | null;
  /** Foods in the pool, ordered by name (their order sets the refs F01, F02, ...). */
  pool: PoolFood[];
  /** Foods the active plan uses that aren't selectable (archived, out of the pool). */
  extra: PoolFood[];
  rules: { spec: RuleSpec; text: string }[];
  /** The active plan, for fixed slots and continuity. */
  current: { name: string; document: PlanDocument } | null;
  preferences: string | null;
  phaseId: string | null;
}

export interface Context {
  ctx: PlanContext;
  payload: PlanPayload;
  refToId: Map<string, string>;
  fixedSlots: Slot[];
  /** The fixed slots' meals per weekday, copied (with their snapshots) from the active plan. */
  fixedMeals: Map<number, Meals>;
  phaseId: string | null;
  /** Things the person should know about the setup (e.g. foods left out of the pool). */
  notes: string[];
}

const toPlanFood = (f: PoolFood): PlanFood => ({
  id: f.id,
  name: f.name,
  per100: { kcal: f.kcal, proteinG: f.proteinG, carbsG: f.carbsG, fatG: f.fatG, fibreG: f.fibreG },
  units: f.units,
  role: f.role as PlanFood['role'],
  portion: f.portion,
});

/** A rule in words plus its exact check, with foods as pool refs. */
function describeRule(spec: RuleSpec, text: string, refOf: (id: string) => string): string {
  const refs = (ids: string[]) => ids.map(refOf).join(', ');
  switch (spec.kind) {
    case 'exclude_food':
      return `${text} [never use ${refs(spec.foodIds)}]`;
    case 'max_items_per_day':
      return `${text} [at most ${spec.max} unit(s) of ${refs(spec.foodIds)} per day in default options; a whole-unit food counts its units]`;
    case 'not_same_day':
      return `${text} [${refs(spec.foodIds)} never on the same day, except as alternative options of one meal]`;
    case 'forbidden_on_day_type':
      return `${text} [${refs(spec.foodIds)} not on ${spec.dayType} days]`;
    case 'allowed_weekdays':
      return `${text} [${refs(spec.foodIds)} only on weekdays ${spec.weekdays.join(', ')}]`;
    case 'min_portion':
      return `${text} [${refs(spec.foodIds)} at least ${spec.minG} g; below that use ${refs(spec.fallbackFoodIds) || 'another food'}]`;
    case 'no_repeat_role_lunch_dinner':
      return `${text} [lunch and dinner on the same day share no ${spec.roles.join('/')} food]`;
    case 'fixed_portion':
      return `${text} [${refs(spec.foodIds)} in ${spec.slot} is always exactly ${spec.grams} g]`;
    case 'fixed_slots':
    case 'guidance':
      return text;
  }
}

const round = (v: number) => Math.round(v);

/** Builds the model payload and the checking context from plain data. No I/O. */
export function makeContext(data: ContextData): Context {
  const notes: string[] = [];
  const currentDoc = data.current?.document ?? null;

  // A slot is fixed only when the active plan has it on every day; otherwise it's generated
  // everywhere, so no day ends up without it.
  const requested = [
    ...new Set(data.rules.flatMap((r) => (r.spec.kind === 'fixed_slots' ? r.spec.slots : []))),
  ];
  const fixedSlots = requested.filter(
    (slot) =>
      currentDoc !== null &&
      [1, 2, 3, 4, 5, 6, 7].every((w) =>
        currentDoc.days.find((d) => d.weekday === w)?.meals.some((m) => m.slot === slot),
      ),
  );
  for (const slot of requested.filter((s) => !fixedSlots.includes(s))) {
    notes.push(
      `The ${slot.replace('_', ' ')} isn't in the active plan on every day, so it was generated instead of kept.`,
    );
  }
  const fixedMeals = new Map<number, Meals>();
  for (const day of currentDoc?.days ?? []) {
    fixedMeals.set(
      day.weekday,
      structuredClone(day.meals.filter((m) => fixedSlots.includes(m.slot))),
    );
  }

  // Only pool foods are offered to the model. A whole-unit food without a unit weight can't
  // be portioned or checked, so it's left out.
  const usable = data.pool.filter((f) => {
    if (f.portion.kind === 'fixed_unit' && !(f.units[f.portion.unit]! > 0)) {
      notes.push(`${f.name} was left out: its "${f.portion.unit}" portion has no weight.`);
      return false;
    }
    return true;
  });
  const refOf = new Map(usable.map((f, i) => [f.id, `F${String(i + 1).padStart(2, '0')}`]));
  const refToId = new Map([...refOf].map(([id, ref]) => [ref, id]));
  const ref = (id: string) => refOf.get(id) ?? '?';
  const allFoods = new Map([...data.extra, ...usable].map((f) => [f.id, toPlanFood(f)]));
  const lookup = (id: string) => allFoods.get(id)?.per100;

  const payload: PlanPayload = {
    targets: { training: data.targets.training, rest: data.targets.rest },
    week: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      dayType: data.trainingWeekdays.includes(weekday) ? 'training' : 'rest',
    })),
    slots: GENERATED_SLOTS.filter((s) => !fixedSlots.includes(s)),
    fixed: [...fixedMeals].map(([weekday, meals]) => {
      // Totals use the meals' own snapshots: exactly what the validator counts.
      const t = dayMacros({ weekday, meals }, lookup);
      return {
        weekday,
        meals: meals.map((m) => ({
          slot: m.slot,
          items: (m.options[0]?.items ?? []).map(
            (i) => `${i.snapshot?.name ?? allFoods.get(i.foodId)?.name ?? 'food'} ${i.grams} g`,
          ),
        })),
        totals: {
          kcal: round(t.kcal),
          proteinG: round(t.proteinG),
          carbsG: round(t.carbsG),
          fatG: round(t.fatG),
        },
      };
    }),
    pool: usable.map((f) => ({
      ref: ref(f.id),
      name: f.name,
      role: f.role,
      preferredSlots: f.preferredSlots,
      priority: f.priority,
      portion:
        f.portion.kind === 'fixed_unit'
          ? { kind: 'fixed_unit', unit: f.portion.unit, unitG: f.units[f.portion.unit]! }
          : f.portion,
      per100: {
        kcal: f.kcal,
        proteinG: f.proteinG,
        carbsG: f.carbsG,
        fatG: f.fatG,
        fibreG: f.fibreG,
      },
      notes: f.notes,
    })),
    rules: {
      hard: data.rules
        .filter((r) => !['guidance', 'fixed_slots'].includes(r.spec.kind))
        .map((r) => describeRule(r.spec, r.text, ref)),
      guidance: data.rules.filter((r) => r.spec.kind === 'guidance').map((r) => r.text),
    },
    previous:
      data.current && currentDoc
        ? {
            summary: data.current.name,
            days: currentDoc.days.map((d) => ({
              weekday: d.weekday,
              meals: d.meals.map((m) => ({
                slot: m.slot,
                items: (m.options[0]?.items ?? []).map(
                  (i) =>
                    `${i.snapshot?.name ?? allFoods.get(i.foodId)?.name ?? 'food'} ${i.grams} g`,
                ),
              })),
            })),
          }
        : null,
    preferences: data.preferences?.trim() || null,
    ...(data.phaseType === 'cut' && { kcalFloorPerDay: CUT_KCAL_FLOOR }),
  };

  return {
    ctx: {
      foods: allFoods,
      rules: data.rules.map((r) => r.spec),
      targets: data.targets,
      trainingWeekdays: data.trainingWeekdays,
      lockedSlots: fixedSlots,
      requiredSlots: [...new Set([...MAIN_MEALS, ...fixedSlots])],
      selectableFoodIds: new Set(usable.map((f) => f.id)),
      ...(data.phaseType === 'cut' && { kcalFloorPerDay: CUT_KCAL_FLOOR }),
    },
    payload,
    refToId,
    fixedSlots,
    fixedMeals,
    phaseId: data.phaseId,
    notes,
  };
}

/** Loads everything generation needs for the owner and builds the context. */
export async function buildContext(
  db: Db,
  owner: Profile,
  now: Date,
  preferences: string | null,
): Promise<Context> {
  const today = localParts(now, owner.timezone).date;
  const p = await activePhase(db, owner.userId);
  const t = p ? await currentTargets(db, p.id, today) : null;
  if (!p || !t) {
    throw new HttpError(
      409,
      'no_targets',
      'Start a phase first: the plan is built to its targets.',
    );
  }
  const targetsDto = toTargetsDto(t);

  const pool = await db
    .select()
    .from(food)
    .where(and(eq(food.userId, owner.userId), eq(food.inPool, true), eq(food.archived, false)))
    .orderBy(food.name);
  if (pool.length < 5) {
    throw new HttpError(
      409,
      'pool_too_small',
      'Put at least 5 foods in the planning pool first (Foods → In the pool).',
    );
  }
  const rules = await listRules(db, owner.userId, { activeOnly: true });
  const current = await activePlan(db, owner.userId);
  const currentDoc = (current?.document as PlanDocument | undefined) ?? null;
  const poolIds = new Set(pool.map((f) => f.id));
  const extraIds = [
    ...new Set(
      (currentDoc?.days ?? []).flatMap((d) =>
        d.meals.flatMap((m) => m.options.flatMap((o) => o.items.map((i) => i.foodId))),
      ),
    ),
  ].filter((id) => !poolIds.has(id));
  const extra = extraIds.length
    ? await db
        .select()
        .from(food)
        .where(and(eq(food.userId, owner.userId), inArray(food.id, extraIds)))
    : [];

  return makeContext({
    targets: { training: targetsDto.training, rest: targetsDto.rest },
    trainingWeekdays: owner.trainingWeekdays,
    phaseType: p.type,
    pool,
    extra,
    rules,
    current: current && currentDoc ? { name: current.name, document: currentDoc } : null,
    preferences,
    phaseId: p.id,
  });
}

// ---------- Model output → plan ----------

const UNKNOWN_FOOD = '00000000-0000-4000-8000-000000000000';

/** Converts the model's days into plan days (generated slots only). */
function toDays(ai: AiPlan, c: Context): PlanDocument['days'] {
  return ai.days.map((d) => ({
    weekday: d.weekday,
    meals: d.meals
      .filter((m) => !c.fixedSlots.includes(m.slot))
      .map((m) => ({
        slot: m.slot,
        notes: m.notes?.slice(0, 500) ?? null,
        options: m.options.map((o) => ({
          label: o.label.slice(0, 24) || 'A',
          items: o.items.map((i) => ({
            foodId: c.refToId.get(i.food) ?? UNKNOWN_FOOD,
            grams: Math.round(i.grams * 10) / 10,
          })),
        })),
      })),
  }));
}

/** Adds the fixed slots back (with their own snapshots) and orders everything. */
function assemble(days: PlanDocument['days'], c: Context): PlanDocument {
  const byDay = new Map(days.map((d) => [d.weekday, d]));
  return {
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
      const fixed = c.fixedMeals.get(weekday) ?? [];
      const generated = (byDay.get(weekday)?.meals ?? []).filter(
        (m) => !fixed.some((f) => f.slot === m.slot),
      );
      const meals = structuredClone([...fixed, ...generated]);
      meals.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
      return { weekday, meals };
    }),
  };
}

/**
 * The validator plus the plan document's own schema (limits on options, items, labels), so a
 * draft that passes here can always be opened and saved in the editor.
 */
function check(doc: PlanDocument, c: Context): ValidationResult {
  const v = validatePlan(doc, c.ctx);
  const schema = PlanDocument.safeParse(doc);
  if (schema.success) return v;
  const extra: PlanError[] = schema.error.issues.map((issue) => {
    const dayIndex =
      issue.path[0] === 'days' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
    const weekday = dayIndex !== null ? (doc.days[dayIndex]?.weekday ?? null) : null;
    const where = issue.path.slice(2).join('.');
    return {
      weekday,
      slot: null,
      code: 'shape',
      message: `${weekday ? WEEKDAY[weekday - 1] : 'Plan'}${where ? ` ${where}` : ''}: ${issue.message}`,
    };
  });
  return { ...v, ok: false, errors: [...v.errors, ...extra] };
}

function failingWeekdays(v: ValidationResult): number[] {
  const days = v.errors.map((e) => e.weekday).filter((w): w is number => w !== null);
  // A plan-level error (e.g. a missing day) means every day is up for repair.
  return v.errors.some((e) => e.weekday === null)
    ? [1, 2, 3, 4, 5, 6, 7]
    : [...new Set(days)].sort();
}

// ---------- The pipeline ----------

/** Filled in as the pipeline runs, so a crash midway still leaves usage and attempts on record. */
export interface RunLog {
  served: ServedUsage[];
  attempts: unknown[];
}

export interface PipelineOutcome {
  ok: boolean;
  /** The validated plan, only when ok. */
  doc: PlanDocument | null;
  result: NonNullable<AiRunDto['result']> | null;
  error: string | null;
}

/**
 * The generation pipeline without the database: model → plan → solver → validate, then one
 * repair round for the failing days. Used by runs and by the eval script.
 */
export async function runPipeline(
  model: PlanModel,
  c: Context,
  log: RunLog,
): Promise<PipelineOutcome> {
  const describeChange = (ch: {
    weekday: number;
    slot: string;
    foodName: string;
    fromG: number;
    toG: number;
  }) =>
    `${WEEKDAY[ch.weekday - 1]} ${ch.slot.replace('_', ' ')}: ${ch.foodName} ${ch.fromG} → ${ch.toG} g`;

  // Attempt 1
  const first = await model.call({
    system: SYSTEM_PROMPT,
    user: generationMessage(c.payload),
    schema: AiPlan,
    maxTokens: MAX_TOKENS,
  });
  log.served.push(...first.served);
  if (!first.output) {
    log.attempts.push({
      attempt: 1,
      stopReason: first.stopReason,
      problem: first.problem,
      served: first.served,
      raw: first.raw.slice(0, 20_000),
    });
    return {
      ok: false,
      doc: null,
      result: null,
      error: `The model returned no usable plan (${first.problem ?? first.stopReason ?? 'unknown'}).`,
    };
  }
  let ai = first.output;
  let solved = solvePortions(assemble(toDays(ai, c), c), c.ctx, { lockedSlots: c.fixedSlots });
  let doc = solved.doc;
  let changes = solved.changes;
  let v = check(doc, c);
  log.attempts.push({
    attempt: 1,
    stopReason: first.stopReason,
    served: first.served,
    errors: v.errors.map((e) => e.message),
  });

  // Attempt 2: repair only the failing days; the passing ones are kept.
  let repaired = false;
  if (!v.ok) {
    const failing = failingWeekdays(v);
    const second = await model.call({
      system: SYSTEM_PROMPT,
      user: repairMessage(
        c.payload,
        ai,
        v.errors.map((e) => e.message),
        failing,
      ),
      schema: AiPlan,
      maxTokens: MAX_TOKENS,
    });
    log.served.push(...second.served);
    repaired = true;
    if (second.output) {
      // Passing days keep their (possibly solver-adjusted) meals; failing days take the
      // repaired version when the model returned one.
      const repairedDays = new Map(toDays(second.output, c).map((d) => [d.weekday, d]));
      const merged = doc.days.map((d) =>
        failing.includes(d.weekday) && repairedDays.has(d.weekday)
          ? repairedDays.get(d.weekday)!
          : { ...d, meals: d.meals.filter((m) => !c.fixedSlots.includes(m.slot)) },
      );
      ai = { ...ai, summary: second.output.summary || ai.summary };
      solved = solvePortions(assemble(merged, c), c.ctx, { lockedSlots: c.fixedSlots });
      doc = solved.doc;
      // Earlier fixes on replaced days no longer describe the plan.
      changes = [...changes.filter((ch) => !failing.includes(ch.weekday)), ...solved.changes];
      v = check(doc, c);
    }
    log.attempts.push({
      attempt: 2,
      stopReason: second.stopReason,
      problem: second.problem,
      served: second.served,
      errors: v.errors.map((e) => e.message),
    });
  }

  const result = {
    summary: ai.summary,
    repaired,
    solverChanges: changes.map(describeChange),
    errors: v.errors.map((e) => e.message),
    warnings: [...c.notes, ...v.warnings.map((w) => w.message)],
  };
  return v.ok
    ? { ok: true, doc, result, error: null }
    : {
        ok: false,
        doc: null,
        result,
        error: `The plan still breaks ${v.errors.length} check(s) after one repair.`,
      };
}

// ---------- Runs ----------

export async function startGeneration(
  db: Db,
  model: PlanModel | null,
  owner: Profile,
  input: { preferences: string | null },
  now: Date,
): Promise<RunDto> {
  if (!model)
    throw new HttpError(
      503,
      'ai_disabled',
      'Set ANTHROPIC_API_KEY on the server to generate plans.',
    );

  // Fails fast (409) when there's no phase or pool, before anything is queued.
  const context = await buildContext(db, owner, now, input.preferences);
  let run: Run | undefined;
  try {
    // The partial unique index on queued/running runs makes this the admission check: two
    // requests at once can't both start a paid generation.
    [run] = await db
      .insert(aiRun)
      .values({
        userId: owner.userId,
        kind: 'generate_plan',
        model: model.name,
        promptVersion: PROMPT_VERSION,
        input: { payload: context.payload },
      })
      .returning();
  } catch (err) {
    if (
      (err as { cause?: { code?: string }; code?: string }).cause?.code === '23505' ||
      (err as { code?: string }).code === '23505'
    ) {
      throw new HttpError(409, 'already_running', 'A plan is already being generated.');
    }
    throw err;
  }
  void executeRun(db, model, owner, run!.id, context);
  return toRunDto(run!);
}

/** Runs a queued generation to completion and records it. Never throws. */
export async function executeRun(
  db: Db,
  model: PlanModel,
  owner: Profile,
  runId: string,
  c: Context,
): Promise<RunDto | null> {
  const log: RunLog = { served: [], attempts: [] };
  try {
    await db
      .update(aiRun)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(aiRun.id, runId));
    let outcome: PipelineOutcome;
    try {
      outcome = await runPipeline(model, c, log);
    } catch (err) {
      console.error('plan generation failed', err);
      outcome = {
        ok: false,
        doc: null,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const cost = costOf(log.served);
    const usage = log.served.reduce(
      (sum, s) => ({
        input: sum.input + s.usage.inputTokens + s.usage.cacheWriteTokens,
        output: sum.output + s.usage.outputTokens,
        cacheRead: sum.cacheRead + s.usage.cacheReadTokens,
      }),
      { input: 0, output: 0, cacheRead: 0 },
    );
    const result =
      outcome.result && !cost.known
        ? {
            ...outcome.result,
            warnings: [
              ...outcome.result.warnings,
              'Part of this run was served by a model without a known price; the cost shown is incomplete.',
            ],
          }
        : outcome.result;

    // The draft and the run's completion are saved together: never a draft without a run
    // pointing at it, never a run stuck "running" because the draft failed.
    const [row] = await db.transaction(async (tx) => {
      const planId =
        outcome.ok && outcome.doc ? await saveDraft(tx, owner.userId, c, outcome.doc) : null;
      return tx
        .update(aiRun)
        .set({
          status: outcome.ok ? 'succeeded' : 'failed',
          result,
          error: outcome.error,
          planId,
          attempts: log.attempts,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          costUsd: Math.round(cost.usd * 10_000) / 10_000,
          finishedAt: new Date(),
        })
        .where(eq(aiRun.id, runId))
        .returning();
    });
    return toRunDto(row!);
  } catch (err) {
    // Last resort: the run must not stay "running" and block every future generation.
    console.error('recording the plan generation failed', err);
    await db
      .update(aiRun)
      .set({
        status: 'failed',
        error: 'The run could not be recorded; see the server log.',
        finishedAt: new Date(),
      })
      .where(eq(aiRun.id, runId))
      .catch((e: unknown) => console.error('could not mark the run failed', e));
    return null;
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function saveDraft(tx: Tx, userId: string, c: Context, doc: PlanDocument): Promise<string> {
  // Generated items get snapshots of the food values they were validated with; fixed items
  // keep the snapshots they came with, so the draft is exactly the plan that was checked.
  for (const day of doc.days) {
    for (const meal of day.meals) {
      for (const option of meal.options) {
        for (const item of option.items) {
          if (item.snapshot) continue;
          const f = c.ctx.foods.get(item.foodId)!;
          item.snapshot = { name: f.name, ...f.per100 };
        }
      }
    }
  }
  const stamp = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const [row] = await tx
    .insert(mealPlan)
    .values({
      userId,
      name: `Generated ${stamp}`,
      status: 'draft',
      createdBy: 'ai',
      document: doc,
      phaseId: c.phaseId,
    })
    .returning({ id: mealPlan.id });
  return row!.id;
}

export async function getRun(db: Db, userId: string, id: string): Promise<RunDto> {
  const [row] = await db
    .select()
    .from(aiRun)
    .where(and(eq(aiRun.id, id), eq(aiRun.userId, userId)));
  if (!row) throw new HttpError(404, 'not_found', 'No such run.');
  return toRunDto(row);
}

export async function listRuns(db: Db, userId: string): Promise<RunDto[]> {
  const rows = await db
    .select()
    .from(aiRun)
    .where(eq(aiRun.userId, userId))
    .orderBy(desc(aiRun.createdAt))
    .limit(20);
  return rows.map(toRunDto);
}

/** Runs left queued or running by a restart will never finish: mark them failed. */
export async function failInterruptedRuns(db: Db): Promise<void> {
  await db
    .update(aiRun)
    .set({ status: 'failed', error: 'Interrupted by a server restart.', finishedAt: new Date() })
    .where(inArray(aiRun.status, ['queued', 'running']));
}
