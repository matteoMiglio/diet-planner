import type {
  CreatePhaseRequest,
  PhaseDto,
  PlanOverviewDto,
  ProposalDto,
  ReviewDto,
  Targets,
  TargetsDto,
} from '@diet/shared';
import { adaptiveMaintenance, phaseTargets, reviewDecision, weightTrend } from '@diet/shared';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  checkin,
  girthMeasurement,
  maintenanceEstimate,
  phase,
  proposal,
  review,
  targets,
} from '../db/schema.js';
import { HttpError } from '../lib/http.js';
import type { Profile } from '../lib/owner.js';
import { addDays, isoWeekStart, localParts } from '../lib/time.js';
import { listMeasurements } from './measurements.js';
import { activePlan, toPlanDto } from './plans.js';

type Phase = typeof phase.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Serialises everything that changes phases, targets or proposals for one user, so two
 * requests can't allocate the same targets version or approve against stale targets.
 */
async function lockPlanning(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`planning:${userId}`}))`);
}
type TargetsRow = typeof targets.$inferSelect;
type ProposalRow = typeof proposal.$inferSelect;
type ReviewRow = typeof review.$inferSelect;

/** A daily carb change this big refills or drains glycogen: ignore the scale for two weeks. */
const GRACE_CARB_CHANGE_G = 40;
const GRACE_DAYS = 14;

const DEFAULT_RATE_BAND: Partial<Record<PhaseDto['type'], [number, number]>> = {
  surplus: [0.1, 0.2],
};

export function toPhaseDto(p: Phase): PhaseDto {
  return {
    id: p.id,
    type: p.type as PhaseDto['type'],
    startedOn: p.startedOn,
    endedOn: p.endedOn,
    status: p.status as PhaseDto['status'],
    rateBandKgPerWeek:
      p.rateBandLowKgPerWeek !== null && p.rateBandHighKgPerWeek !== null
        ? [p.rateBandLowKgPerWeek, p.rateBandHighKgPerWeek]
        : null,
    targetWeightKg: p.targetWeightKg,
    holdBandKg: p.holdBandKg,
    surplusPct: p.surplusPct,
    deficitRatePctPerWeek: p.deficitRatePctPerWeek,
    reviewEveryDays: p.reviewEveryDays,
    intent: p.intent,
  };
}

export function toTargetsDto(t: TargetsRow): TargetsDto {
  return {
    id: t.id,
    version: t.version,
    effectiveFrom: t.effectiveFrom,
    training: {
      kcal: t.trainingKcal,
      proteinG: t.trainingProteinG,
      fatG: t.trainingFatG,
      carbsG: t.trainingCarbsG,
      fibreG: t.trainingFibreG,
    },
    rest: {
      kcal: t.restKcal,
      proteinG: t.restProteinG,
      fatG: t.restFatG,
      carbsG: t.restCarbsG,
      fibreG: t.restFibreG,
    },
    carbChangeG: t.carbChangeG,
    reasoning: t.reasoning,
    createdBy: t.createdBy as TargetsDto['createdBy'],
  };
}

function toProposalDto(p: ProposalRow): ProposalDto {
  const payload = p.payload as {
    targets?: Targets;
    deltaKcal?: { training: number; rest: number };
  };
  return {
    id: p.id,
    kind: p.kind as ProposalDto['kind'],
    status: p.status as ProposalDto['status'],
    reasoning: p.reasoning,
    createdAt: p.createdAt.toISOString(),
    targets: payload.targets ?? null,
    deltaKcal: payload.deltaKcal ?? null,
  };
}

function toReviewDto(r: ReviewRow): ReviewDto {
  return {
    id: r.id,
    ranOn: r.ranOn,
    outcome: r.outcome as ReviewDto['outcome'],
    explanation: r.explanation,
    proposalId: r.proposalId,
  };
}

function targetColumns(t: Targets) {
  return {
    trainingKcal: t.training.kcal,
    trainingProteinG: t.training.proteinG,
    trainingFatG: t.training.fatG,
    trainingCarbsG: t.training.carbsG,
    trainingFibreG: t.training.fibreG,
    restKcal: t.rest.kcal,
    restProteinG: t.rest.proteinG,
    restFatG: t.rest.fatG,
    restCarbsG: t.rest.carbsG,
    restFibreG: t.rest.fibreG,
  };
}

/** Average daily carb change, weighted by training days, between two target sets. */
function carbChange(prev: Targets | null, next: Targets, trainingDays: number): number {
  if (!prev) return 0;
  const avg = (t: Targets) =>
    (t.training.carbsG * trainingDays + t.rest.carbsG * (7 - trainingDays)) / 7;
  return Math.round(avg(next) - avg(prev));
}

export async function activePhase(db: Db, userId: string): Promise<Phase | null> {
  const [row] = await db
    .select()
    .from(phase)
    .where(and(eq(phase.userId, userId), eq(phase.status, 'active')));
  return row ?? null;
}

/** The targets in effect on `today`; null when none have started yet. */
export async function currentTargets(
  db: Db | Tx,
  phaseId: string,
  today: string,
): Promise<TargetsRow | null> {
  const rows = await db
    .select()
    .from(targets)
    .where(eq(targets.phaseId, phaseId))
    .orderBy(desc(targets.version));
  return rows.find((t) => t.effectiveFrom <= today) ?? null;
}

async function latestMaintenance(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(maintenanceEstimate)
    .where(eq(maintenanceEstimate.userId, userId))
    .orderBy(desc(maintenanceEstimate.asOf), desc(maintenanceEstimate.createdAt))
    .limit(1);
  return row ?? null;
}

async function insertTargets(
  db: Tx,
  input: {
    userId: string;
    phaseId: string;
    effectiveFrom: string;
    targets: Targets;
    previous: Targets | null;
    trainingDays: number;
    reasoning: string;
    createdBy: 'engine' | 'manual';
  },
) {
  const [last] = await db
    .select({ version: targets.version })
    .from(targets)
    .where(eq(targets.phaseId, input.phaseId))
    .orderBy(desc(targets.version))
    .limit(1);
  const [row] = await db
    .insert(targets)
    .values({
      userId: input.userId,
      phaseId: input.phaseId,
      version: (last?.version ?? 0) + 1,
      effectiveFrom: input.effectiveFrom,
      ...targetColumns(input.targets),
      carbChangeG: carbChange(input.previous, input.targets, input.trainingDays),
      reasoning: input.reasoning,
      createdBy: input.createdBy,
    })
    .returning();
  return row!;
}

async function currentBodyweight(db: Db, userId: string, now: Date): Promise<number | null> {
  const measurements = await listMeasurements(db, userId);
  const trend = weightTrend(measurements.map(toReading), { now });
  return trend.interceptKg ?? measurements.at(-1)?.weightKg ?? null;
}

function toReading(m: Awaited<ReturnType<typeof listMeasurements>>[number]) {
  return {
    id: m.id,
    measuredAt: m.measuredAt,
    weightKg: m.weightKg,
    protocolOk: m.protocolOk,
    outlierOverride: m.outlierOverride,
  };
}

/**
 * Starts a phase: closes the current one, records the maintenance figure it is built on,
 * and creates its first targets (from the engine unless given by hand).
 */
export async function createPhase(db: Db, owner: Profile, input: CreatePhaseRequest, now: Date) {
  const today = localParts(now, owner.timezone).date;
  if (input.startedOn > today) {
    throw new HttpError(
      422,
      'future_start',
      'A phase starts today or on a past date, not in the future.',
    );
  }
  const bodyweightKg = input.bodyweightKg ?? (await currentBodyweight(db, owner.userId, now));
  if (!bodyweightKg && !input.targets) {
    throw new HttpError(
      422,
      'no_bodyweight',
      'Log a weight (or give bodyweightKg) to compute targets.',
    );
  }
  const trainingDays = owner.trainingWeekdays.length;
  const computed = bodyweightKg
    ? phaseTargets({
        phase: input.type,
        maintenanceKcal: input.maintenanceKcal,
        bodyweightKg,
        trainingDaysPerWeek: trainingDays,
        ...(input.surplusPct !== undefined && { surplusPct: input.surplusPct }),
        ...(input.deficitRatePctPerWeek !== undefined && {
          deficitRatePctPerWeek: input.deficitRatePctPerWeek,
        }),
      })
    : null;
  if (!input.targets && computed && !computed.feasible) {
    throw new HttpError(422, 'infeasible_targets', computed.notes.join(' '));
  }
  const chosen = input.targets ?? computed!.targets;
  const reasoning = input.targets
    ? 'Entered by hand.'
    : [
        `Built from maintenance ${input.maintenanceKcal} kcal at ${bodyweightKg!.toFixed(1)} kg.`,
        ...computed!.notes,
      ].join(' ');
  const rateBand = input.rateBandKgPerWeek ?? DEFAULT_RATE_BAND[input.type] ?? null;

  return db.transaction(async (tx) => {
    await lockPlanning(tx, owner.userId);
    const previous = await tx
      .select()
      .from(phase)
      .where(and(eq(phase.userId, owner.userId), eq(phase.status, 'active')));
    // Compare with the targets the new phase replaces, so a big carb change starts the
    // water grace period here too.
    const replaced = previous[0] ? await currentTargets(tx, previous[0].id, input.startedOn) : null;
    for (const p of previous) {
      if (input.startedOn <= p.startedOn) {
        throw new HttpError(
          422,
          'start_before_current',
          'A new phase must start after the current one.',
        );
      }
      await tx
        .update(phase)
        .set({ status: 'closed', endedOn: addDays(input.startedOn, -1) })
        .where(eq(phase.id, p.id));
    }
    await tx
      .update(proposal)
      .set({ status: 'expired', decidedAt: now })
      .where(and(eq(proposal.userId, owner.userId), eq(proposal.status, 'pending')));

    const [created] = await tx
      .insert(phase)
      .values({
        userId: owner.userId,
        type: input.type,
        startedOn: input.startedOn,
        rateBandLowKgPerWeek: rateBand?.[0] ?? null,
        rateBandHighKgPerWeek: rateBand?.[1] ?? null,
        targetWeightKg: input.targetWeightKg ?? null,
        surplusPct: input.surplusPct ?? (input.type === 'surplus' ? 0.1 : null),
        deficitRatePctPerWeek: input.deficitRatePctPerWeek ?? (input.type === 'cut' ? 0.005 : null),
        reviewEveryDays: input.reviewEveryDays ?? 21,
        intent: input.intent ?? null,
      })
      .returning();
    await tx.insert(maintenanceEstimate).values({
      userId: owner.userId,
      asOf: input.startedOn,
      kcal: input.maintenanceKcal,
      method: 'phase_start',
      inputs: { bodyweightKg },
    });
    const t = await insertTargets(tx, {
      userId: owner.userId,
      phaseId: created!.id,
      effectiveFrom: input.startedOn,
      targets: chosen,
      previous: replaced ? toTargetsDto(replaced) : null,
      trainingDays,
      reasoning,
      createdBy: input.targets ? 'manual' : 'engine',
    });
    return {
      phase: toPhaseDto(created!),
      targets: toTargetsDto(t),
      floorBinds: computed?.floorBinds ?? false,
    };
  });
}

export async function setTargetsByHand(
  db: Db,
  owner: Profile,
  input: { targets: Targets; reasoning: string; effectiveFrom?: string | undefined },
  now: Date,
) {
  const today = localParts(now, owner.timezone).date;
  return db.transaction(async (tx) => {
    await lockPlanning(tx, owner.userId);
    const [p] = await tx
      .select()
      .from(phase)
      .where(and(eq(phase.userId, owner.userId), eq(phase.status, 'active')));
    if (!p) throw new HttpError(409, 'no_phase', 'Start a phase first.');
    const previous = await currentTargets(tx, p.id, today);
    const row = await insertTargets(tx, {
      userId: owner.userId,
      phaseId: p.id,
      effectiveFrom: input.effectiveFrom ?? today,
      targets: input.targets,
      previous: previous ? toTargetsDto(previous) : null,
      trainingDays: owner.trainingWeekdays.length,
      reasoning: input.reasoning,
      createdBy: 'manual',
    });
    // A proposal computed from the old targets no longer applies.
    await tx
      .update(proposal)
      .set({ status: 'expired', decidedAt: now })
      .where(
        and(
          eq(proposal.userId, owner.userId),
          eq(proposal.kind, 'targets_change'),
          eq(proposal.status, 'pending'),
        ),
      );
    return toTargetsDto(row);
  });
}

/**
 * Mean planned daily intake over [from, to], following the targets that were in effect on
 * each day (across phases) and the day type of each weekday. Intake is not logged, so the
 * targets stand in for it; the review records that this is the source.
 */
async function plannedIntake(
  db: Db,
  owner: Profile,
  from: string,
  to: string,
): Promise<number | null> {
  const rows = await db
    .select()
    .from(targets)
    .where(and(eq(targets.userId, owner.userId), lte(targets.effectiveFrom, to)))
    .orderBy(asc(targets.effectiveFrom), asc(targets.createdAt));
  let sum = 0;
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const inEffect = rows.filter((t) => t.effectiveFrom <= d).at(-1);
    if (!inEffect) continue;
    const isoWeekday = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    sum += owner.trainingWeekdays.includes(isoWeekday) ? inEffect.trainingKcal : inEffect.restKcal;
    days++;
  }
  return days > 0 ? sum / days : null;
}

function nextReviewOn(p: Phase, t: TargetsRow | null, last: ReviewRow | null): string {
  const from = [p.startedOn, t?.effectiveFrom, last?.ranOn].filter(Boolean).sort().at(-1)!;
  return addDays(from, p.reviewEveryDays);
}

export async function planOverview(db: Db, owner: Profile, now: Date): Promise<PlanOverviewDto> {
  const today = localParts(now, owner.timezone).date;
  const p = await activePhase(db, owner.userId);
  const t = p ? await currentTargets(db, p.id, today) : null;
  const [last] = p
    ? await db
        .select()
        .from(review)
        .where(eq(review.phaseId, p.id))
        .orderBy(desc(review.createdAt))
        .limit(1)
    : [];
  const [pending] = await db
    .select()
    .from(proposal)
    .where(and(eq(proposal.userId, owner.userId), eq(proposal.status, 'pending')))
    .orderBy(desc(proposal.createdAt))
    .limit(1);
  const maintenance = await latestMaintenance(db, owner.userId);
  const plan = await activePlan(db, owner.userId);
  return {
    phase: p ? toPhaseDto(p) : null,
    targets: t ? toTargetsDto(t) : null,
    maintenance: maintenance
      ? { kcal: maintenance.kcal, asOf: maintenance.asOf, method: maintenance.method }
      : null,
    nextReviewOn: p ? nextReviewOn(p, t, last ?? null) : null,
    lastReview: last ? toReviewDto(last) : null,
    pendingProposal: pending ? toProposalDto(pending) : null,
    activePlan: plan ? toPlanDto(plan) : null,
    trainingWeekdays: owner.trainingWeekdays,
  };
}

/** The last review run on a local date, if any (for the review notification). */
export async function latestReviewOn(db: Db, userId: string, localDate: string) {
  const [row] = await db
    .select()
    .from(review)
    .where(and(eq(review.userId, userId), eq(review.ranOn, localDate)))
    .orderBy(desc(review.createdAt))
    .limit(1);
  return row ?? null;
}

/** Is a review due today (and not yet run)? Used by the reminder loop. */
export async function reviewDue(db: Db, owner: Profile, now: Date): Promise<boolean> {
  const today = localParts(now, owner.timezone).date;
  const p = await activePhase(db, owner.userId);
  if (!p) return false;
  const t = await currentTargets(db, p.id, today);
  const [last] = await db
    .select()
    .from(review)
    .where(eq(review.phaseId, p.id))
    .orderBy(desc(review.createdAt))
    .limit(1);
  return nextReviewOn(p, t, last ?? null) <= today;
}

/**
 * Runs the review (spec §6.4): gathers the trend, recent check-ins and waist change, asks the
 * engine for a decision, records it, updates the maintenance estimate when the data allows,
 * and turns a change into a proposal. Nothing changes the targets until a proposal is approved.
 */
export async function runReview(db: Db, owner: Profile, now: Date): Promise<ReviewDto> {
  const today = localParts(now, owner.timezone).date;
  const p = await activePhase(db, owner.userId);
  if (!p) throw new HttpError(409, 'no_phase', 'Start a phase first.');
  const t = await currentTargets(db, p.id, today);
  if (!t) throw new HttpError(409, 'no_targets', 'The phase has no targets.');
  const current = toTargetsDto(t);
  const trainingDays = owner.trainingWeekdays.length;

  const graceUntil =
    Math.abs(t.carbChangeG) >= GRACE_CARB_CHANGE_G ? addDays(t.effectiveFrom, GRACE_DAYS) : null;
  const inGracePeriod = graceUntil !== null && today < graceUntil;

  const readings = (await listMeasurements(db, owner.userId)).map(toReading);
  const trend = weightTrend(readings, {
    now,
    graceUntil: graceUntil ? new Date(`${graceUntil}T00:00:00Z`) : null,
  });
  const recent = weightTrend(readings, {
    now,
    windowDays: 14,
    extendedWindowDays: 14,
    minReadings: 2,
  });

  // Only recent check-ins count: the latest from this week or the last two, so answers from
  // months ago can't authorise a change today.
  const checkins = await db
    .select()
    .from(checkin)
    .where(
      and(
        eq(checkin.userId, owner.userId),
        gte(checkin.weekStart, addDays(isoWeekStart(today), -21)),
      ),
    )
    .orderBy(desc(checkin.weekStart))
    .limit(2);
  const girths = await db
    .select()
    .from(girthMeasurement)
    .where(
      and(
        eq(girthMeasurement.userId, owner.userId),
        gte(girthMeasurement.measuredOn, trend.windowStart.toISOString().slice(0, 10)),
      ),
    )
    .orderBy(girthMeasurement.measuredOn);
  const waists = girths.filter((g) => g.waistCm !== null);
  const waistChangeCm = waists.length >= 2 ? waists.at(-1)!.waistCm! - waists[0]!.waistCm! : null;

  // Update the information-only maintenance estimate first when the evidence is good enough
  // (a decidable trend and the plan followed; intake is taken to be the targets), so the
  // surplus ceiling below is checked against what the scale has actually shown.
  const maintenance = await latestMaintenance(db, owner.userId);
  const adherenceOk =
    checkins.length >= 2 &&
    checkins.every((c) => c.adherence === 'on_plan' || c.adherence === 'mostly');
  const intakeKcal =
    trend.decidable && adherenceOk
      ? await plannedIntake(db, owner, trend.windowStart.toISOString().slice(0, 10), today)
      : null;
  const updatedMaintenance =
    intakeKcal !== null && trend.slopeKgPerWeek !== null && maintenance
      ? adaptiveMaintenance({
          previousKcal: maintenance.kcal,
          meanIntakeKcal: intakeKcal,
          slopeKgPerWeek: trend.slopeKgPerWeek,
        })
      : null;
  const maintenanceKcal =
    updatedMaintenance?.kcal ?? maintenance?.kcal ?? Math.round(averageKcal(current, trainingDays));
  const bodyweightKg = trend.interceptKg ?? readings.at(-1)?.weightKg;
  if (!bodyweightKg) throw new HttpError(409, 'no_weight', 'Log a weight first.');

  const weeksInPhase = Math.floor(
    (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${p.startedOn}T00:00:00Z`).getTime()) /
      (7 * 86_400_000),
  );
  const phaseDto = toPhaseDto(p);
  const input = {
    phase: {
      type: phaseDto.type,
      rateBandKgPerWeek: phaseDto.rateBandKgPerWeek,
      targetWeightKg: phaseDto.targetWeightKg,
      holdBandKg: phaseDto.holdBandKg,
      weeksInPhase,
    },
    targets: { training: current.training, rest: current.rest },
    maintenanceKcal,
    bodyweightKg,
    trainingDaysPerWeek: trainingDays,
    trend: {
      decidable: trend.decidable,
      reasons: trend.reasons,
      slopeKgPerWeek: trend.slopeKgPerWeek,
      ci80: trend.ci80,
      interceptKg: trend.interceptKg,
      readingsNeeded: trend.readingsNeeded,
    },
    recentSlopeKgPerWeek: recent.slopeKgPerWeek,
    inGracePeriod,
    checkins: checkins.map((c) => ({
      weekStart: c.weekStart,
      adherence: c.adherence as 'on_plan' | 'mostly' | 'off' | null,
      trainingProgressed: c.trainingProgressed as 'yes' | 'no' | 'deload' | null,
      sleep: c.sleep,
      energy: c.energy,
    })),
    waistChangeCm,
  };
  const decision = reviewDecision(input);

  return db.transaction(async (tx) => {
    await lockPlanning(tx, owner.userId);
    if (updatedMaintenance) {
      await tx.insert(maintenanceEstimate).values({
        userId: owner.userId,
        asOf: today,
        kcal: updatedMaintenance.kcal,
        method: 'adaptive',
        inputs: {
          observedTdee: Math.round(updatedMaintenance.observedTdee),
          slopeKgPerWeek: trend.slopeKgPerWeek,
          meanIntakeKcal: Math.round(intakeKcal!),
          intakeSource: 'targets_in_effect',
        },
      });
    }

    let proposalId: string | null = null;
    if (decision.action !== 'hold') {
      const kind = decision.action === 'change' ? 'targets_change' : 'diet_break';
      // A new review replaces an older proposal of the same kind still waiting for a decision.
      await tx
        .update(proposal)
        .set({ status: 'expired', decidedAt: now })
        .where(
          and(
            eq(proposal.userId, owner.userId),
            eq(proposal.kind, kind),
            eq(proposal.status, 'pending'),
          ),
        );
      const [created] = await tx
        .insert(proposal)
        .values({
          userId: owner.userId,
          kind,
          phaseId: p.id,
          reasoning: decision.explanation,
          payload:
            decision.action === 'change'
              ? {
                  // The targets this proposal was computed from; approval checks they still apply.
                  baseTargetsId: t.id,
                  targets: decision.targets,
                  deltaKcal: decision.deltaKcal,
                  rule: decision.rule,
                  capped: decision.capped,
                }
              : {},
        })
        .returning({ id: proposal.id });
      proposalId = created!.id;
    }

    const [row] = await tx
      .insert(review)
      .values({
        userId: owner.userId,
        phaseId: p.id,
        ranOn: today,
        outcome: decision.action,
        explanation: decision.explanation,
        inputs: input,
        proposalId,
      })
      .returning();
    return toReviewDto(row!);
  });
}

function averageKcal(t: Targets, trainingDays: number): number {
  return (t.training.kcal * trainingDays + t.rest.kcal * (7 - trainingDays)) / 7;
}

export async function decideProposal(
  db: Db,
  owner: Profile,
  id: string,
  decision: 'approve' | 'reject',
  now: Date,
): Promise<{ proposal: ProposalDto; targets: TargetsDto | null }> {
  const today = localParts(now, owner.timezone).date;
  const result = await db.transaction(async (tx) => {
    await lockPlanning(tx, owner.userId);
    const [row] = await tx
      .select()
      .from(proposal)
      .where(and(eq(proposal.id, id), eq(proposal.userId, owner.userId)));
    if (!row) throw new HttpError(404, 'not_found', 'No such proposal.');
    if (row.status !== 'pending') {
      throw new HttpError(409, 'already_decided', `This proposal is ${row.status}.`);
    }

    let newTargets: TargetsDto | null = null;
    if (decision === 'approve' && row.kind === 'targets_change') {
      const [p] = await tx
        .select()
        .from(phase)
        .where(and(eq(phase.userId, owner.userId), eq(phase.status, 'active')));
      const current = p && p.id === row.phaseId ? await currentTargets(tx, p.id, today) : null;
      const payload = row.payload as { targets: Targets; baseTargetsId?: string };
      // Targets changed since the review (by hand, another approval, a new phase): applying
      // this would silently overwrite them, so the proposal expires instead.
      if (!p || !current || current.id !== payload.baseTargetsId) {
        await tx
          .update(proposal)
          .set({ status: 'expired', decidedAt: now })
          .where(eq(proposal.id, id));
        return { stale: true as const };
      }
      const inserted = await insertTargets(tx, {
        userId: owner.userId,
        phaseId: p.id,
        effectiveFrom: today,
        targets: payload.targets,
        previous: toTargetsDto(current),
        trainingDays: owner.trainingWeekdays.length,
        reasoning: row.reasoning,
        createdBy: 'engine',
      });
      newTargets = toTargetsDto(inserted);
    }
    const [updated] = await tx
      .update(proposal)
      .set({ status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: now })
      .where(eq(proposal.id, id))
      .returning();
    return { stale: false as const, proposal: toProposalDto(updated!), targets: newTargets };
  });
  if (result.stale) {
    throw new HttpError(
      409,
      'stale_proposal',
      'The targets changed after this proposal was made, so it no longer applies. Run a new review.',
    );
  }
  return { proposal: result.proposal, targets: result.targets };
}
