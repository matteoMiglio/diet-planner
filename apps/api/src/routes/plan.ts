import {
  CreatePhaseRequest,
  FoodInput,
  FoodPatch,
  type PlanDocument,
  type TodayDto,
  UpdateTargetsRequest,
  emptyPlan,
} from '@diet/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { HttpError, parseJson } from '../lib/http.js';
import { loadOwner } from '../lib/owner.js';
import { localParts } from '../lib/time.js';
import {
  activePhase,
  createPhase,
  currentTargets,
  decideProposal,
  planOverview,
  runReview,
  setTargetsByHand,
  toTargetsDto,
} from '../services/phases.js';
import {
  activatePlan,
  activePlan,
  createFood,
  createPlan,
  getPlan,
  listFoods,
  listPlans,
  savePlan,
  toPlanDto,
  updateFood,
} from '../services/plans.js';

const uuid = z.uuid();
function idParam(value: string | undefined, what: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'not_found', `No such ${what}.`);
  return parsed.data;
}

const CreatePlanRequest = z.object({
  name: z.string().trim().min(1).max(80),
  /** Copy the document of an existing plan; otherwise an empty week. */
  copyFrom: z.uuid().optional(),
});
const SavePlanRequest = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  document: z.unknown().optional(),
});

export function createPlanRoutes({ db, now }: { db: Db; now: () => Date }) {
  const r = new Hono();

  // ---------- Phase, targets, reviews ----------

  r.get('/plan', async (c) => c.json(await planOverview(db, await loadOwner(db), now())));

  r.post('/phases', async (c) => {
    const input = await parseJson(c, CreatePhaseRequest);
    return c.json(await createPhase(db, await loadOwner(db), input, now()), 201);
  });

  r.post('/targets', async (c) => {
    const input = await parseJson(c, UpdateTargetsRequest);
    return c.json(await setTargetsByHand(db, await loadOwner(db), input, now()), 201);
  });

  r.post('/reviews', async (c) => c.json(await runReview(db, await loadOwner(db), now()), 201));

  r.post('/proposals/:id/:decision{approve|reject}', async (c) => {
    const id = idParam(c.req.param('id'), 'proposal');
    const decision = c.req.param('decision') as 'approve' | 'reject';
    return c.json(await decideProposal(db, await loadOwner(db), id, decision, now()));
  });

  // ---------- Today ----------

  r.get('/today', async (c) => {
    const owner = await loadOwner(db);
    const local = localParts(now(), owner.timezone);
    const dayType = owner.trainingWeekdays.includes(local.isoWeekday) ? 'training' : 'rest';
    const p = await activePhase(db, owner.userId);
    const t = p ? await currentTargets(db, p.id, local.date) : null;
    const plan = await activePlan(db, owner.userId);
    const day = plan
      ? (plan.document as PlanDocument).days.find((d) => d.weekday === local.isoWeekday)
      : undefined;
    const body: TodayDto = {
      date: local.date,
      weekday: local.isoWeekday,
      dayType,
      targets: t ? toTargetsDto(t)[dayType] : null,
      plan: plan && day ? { id: plan.id, name: plan.name, day } : null,
    };
    return c.json(body);
  });

  // ---------- Foods ----------

  r.get('/foods', async (c) => {
    const owner = await loadOwner(db);
    const q = c.req.query('q')?.trim().slice(0, 80);
    return c.json(
      await listFoods(db, owner.userId, { q, includeArchived: c.req.query('archived') === '1' }),
    );
  });

  r.post('/foods', async (c) => {
    const input = await parseJson(c, FoodInput);
    return c.json(await createFood(db, (await loadOwner(db)).userId, input), 201);
  });

  r.patch('/foods/:id', async (c) => {
    const id = idParam(c.req.param('id'), 'food');
    const input = await parseJson(c, FoodPatch);
    return c.json(await updateFood(db, (await loadOwner(db)).userId, id, input));
  });

  // ---------- Meal plans ----------

  r.get('/plans', async (c) => c.json(await listPlans(db, (await loadOwner(db)).userId)));

  r.post('/plans', async (c) => {
    const owner = await loadOwner(db);
    const input = await parseJson(c, CreatePlanRequest);
    const source = input.copyFrom ? await getPlan(db, owner.userId, input.copyFrom) : null;
    const p = await activePhase(db, owner.userId);
    return c.json(
      await createPlan(db, owner.userId, {
        name: input.name,
        document: source?.document ?? emptyPlan(),
        phaseId: p?.id ?? null,
        ...(source && { copiedFrom: source.document as PlanDocument }),
      }),
      201,
    );
  });

  r.get('/plans/:id', async (c) => {
    const owner = await loadOwner(db);
    return c.json(toPlanDto(await getPlan(db, owner.userId, idParam(c.req.param('id'), 'plan'))));
  });

  r.put('/plans/:id', async (c) => {
    const id = idParam(c.req.param('id'), 'plan');
    const input = await parseJson(c, SavePlanRequest);
    return c.json(await savePlan(db, (await loadOwner(db)).userId, id, input));
  });

  r.post('/plans/:id/activate', async (c) => {
    const id = idParam(c.req.param('id'), 'plan');
    return c.json(await activatePlan(db, (await loadOwner(db)).userId, id, now()));
  });

  return r;
}
