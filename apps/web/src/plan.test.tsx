import type { FoodDto, MealPlanDto, PlanOverviewDto, TargetsDto, TodayDto } from '@diet/shared';
import { emptyPlan } from '@diet/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './routes';

const oats: FoodDto = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Oats',
  brand: null,
  kcal: 372,
  proteinG: 13.5,
  carbsG: 58.7,
  fatG: 7,
  fibreG: 10,
  basis: 'dry',
  units: {},
  notes: null,
  archived: false,
  sugarG: null,
  satFatG: null,
  saltG: null,
  product: null,
  pool: {
    inPool: true,
    role: 'main_carb',
    preferredSlots: ['breakfast'],
    priority: 'high',
    portion: { kind: 'flexible', stepG: 5 },
  },
};
const yogurt: FoodDto = {
  ...oats,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Greek yogurt 0%',
  kcal: 57,
  proteinG: 10,
  carbsG: 4,
  fatG: 0,
  fibreG: 0,
  units: { cup: 150 },
};

const targets: TargetsDto = {
  id: 't1',
  version: 1,
  effectiveFrom: '2026-08-24',
  training: { kcal: 2315, proteinG: 165, fatG: 74, carbsG: 247, fibreG: 25 },
  rest: { kcal: 2195, proteinG: 165, fatG: 74, carbsG: 217, fibreG: 22 },
  carbChangeG: 0,
  reasoning: 'Built from maintenance 2040 kcal at 87.0 kg.',
  createdBy: 'engine',
};

const planDraft: MealPlanDto = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'My plan',
  status: 'draft',
  phaseId: null,
  document: emptyPlan(),
  activatedAt: null,
  updatedAt: '2026-11-05T10:00:00Z',
};

function overview(partial: Partial<PlanOverviewDto> = {}): PlanOverviewDto {
  return {
    phase: {
      id: 'p1',
      type: 'surplus',
      startedOn: '2026-08-24',
      endedOn: null,
      status: 'active',
      rateBandKgPerWeek: [0.1, 0.2],
      targetWeightKg: null,
      holdBandKg: 0.5,
      surplusPct: 0.1,
      deficitRatePctPerWeek: null,
      reviewEveryDays: 21,
      intent: null,
    },
    targets,
    maintenance: { kcal: 2040, asOf: '2026-08-24', method: 'phase_start' },
    nextReviewOn: '2026-11-16',
    lastReview: null,
    pendingProposal: null,
    activePlan: null,
    trainingWeekdays: [1, 3, 5],
    ...partial,
  };
}

type Call = { method: string; path: string; body: unknown };
let calls: Call[];

function fakeApi(routes: Record<string, unknown | (() => Response)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = input.replace(/^\/api/, '');
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const hit = routes[`${method} ${path}`];
      if (typeof hit === 'function') return (hit as () => Response)();
      if (hit !== undefined) return Response.json(hit);
      return Response.json({ error: 'not_found', message: 'not found' }, { status: 404 });
    }),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Today with a plan', () => {
  it('shows the day type, meals and totals, and switches options', async () => {
    const snap = (f: FoodDto) => ({
      name: f.name,
      kcal: f.kcal,
      proteinG: f.proteinG,
      carbsG: f.carbsG,
      fatG: f.fatG,
      fibreG: f.fibreG,
    });
    const today: TodayDto = {
      date: '2026-11-05',
      weekday: 4,
      dayType: 'rest',
      targets: targets.rest,
      plan: {
        id: 'x',
        name: 'Lean Surplus',
        day: {
          weekday: 4,
          meals: [
            {
              slot: 'afternoon_snack',
              options: [
                {
                  label: 'S1',
                  items: [
                    {
                      foodId: yogurt.id,
                      grams: 150,
                      display: { unit: 'cup', qty: 1 },
                      snapshot: snap(yogurt),
                    },
                  ],
                },
                { label: 'S2', items: [{ foodId: oats.id, grams: 50, snapshot: snap(oats) }] },
              ],
            },
          ],
        },
      },
    };
    fakeApi({
      'GET /today': today,
      'GET /checkins/current': { due: false },
      'GET /progress': {
        measurements: [],
        girths: [],
        trend: { decidable: false, reasons: [], readingsNeeded: 4, slopeKgPerWeek: null },
      },
    });
    renderAt('/');
    expect(await screen.findByText('Rest day')).toBeInTheDocument();
    expect(screen.getByText('1 cup')).toBeInTheDocument();
    expect(screen.getByText('86')).toBeInTheDocument(); // 150 g yogurt
    fireEvent.click(screen.getByRole('radio', { name: 'S2' }));
    expect(await screen.findByText('186')).toBeInTheDocument(); // 50 g oats
    expect(screen.getByText('50 g')).toBeInTheDocument();
  });
});

describe('Plan overview', () => {
  it('invites to start a phase when there is none', async () => {
    fakeApi({
      'GET /plan': overview({ phase: null, targets: null, maintenance: null, nextReviewOn: null }),
    });
    renderAt('/plan');
    expect(await screen.findByText('No phase yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a phase' })).toHaveAttribute(
      'href',
      '/plan/phase',
    );
  });

  it('shows targets and the next review, and applies a pending proposal', async () => {
    const pending = {
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'targets_change' as const,
      status: 'pending' as const,
      reasoning: 'Weight changes 0.00 kg/week; below the 0.10 kg/week lower limit.',
      createdAt: '2026-11-05T11:00:00Z',
      targets: { ...targets, training: { ...targets.training, kcal: 2465 } },
      deltaKcal: { training: 150, rest: 0 },
    };
    fakeApi({
      'GET /plan': overview({ pendingProposal: pending }),
      [`POST /proposals/${pending.id}/approve`]: {
        proposal: { ...pending, status: 'approved' },
        targets,
      },
    });
    renderAt('/plan');
    expect(await screen.findByText('Lean surplus')).toBeInTheDocument();
    expect(screen.getByText(/Next: /)).toBeInTheDocument();
    expect(
      screen.getByText(/Training days: \+150 kcal · Rest days: no change/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/proposals/${pending.id}/approve`)).toBe(true),
    );
  });

  it('runs a review on demand', async () => {
    fakeApi({
      'GET /plan': overview(),
      'POST /reviews': {
        id: 'r',
        ranOn: '2026-11-05',
        outcome: 'hold',
        explanation: 'x',
        proposalId: null,
      },
    });
    renderAt('/plan');
    fireEvent.click(await screen.findByRole('button', { name: /Run review now/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/reviews')).toBe(true),
    );
  });
});

describe('Phase setup', () => {
  it('previews engine targets and starts the phase', async () => {
    fakeApi({
      'GET /plan': overview({ phase: null, targets: null }),
      'GET /progress': {
        measurements: [],
        girths: [],
        trend: { interceptKg: 87, decidable: false, reasons: [], readingsNeeded: 1 },
      },
      'POST /phases': { phase: {}, targets },
    });
    const router = renderAt('/plan/phase');
    await screen.findByRole('heading', { name: 'Start a phase' });
    // Maintenance prefilled from the estimate, bodyweight from the trend: 2040 × 1.10 split 3/4.
    expect(await screen.findByText(/averaging 224[0-9] kcal/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start the phase' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/plan'));
    expect(calls.find((c) => c.path === '/phases')?.body).toMatchObject({
      type: 'surplus',
      maintenanceKcal: 2040,
      bodyweightKg: 87,
      surplusPct: 0.1,
    });
  });
});

describe('Plan editor', () => {
  it('adds a food to a new meal, shows totals against the day target, and saves', async () => {
    fakeApi({
      [`GET /plans/${planDraft.id}`]: planDraft,
      'GET /foods': [oats, yogurt],
      'GET /plan': overview(),
      [`PUT /plans/${planDraft.id}`]: planDraft,
    });
    renderAt(`/plan/edit/${planDraft.id}`);
    fireEvent.click(await screen.findByRole('tab', { name: 'Mon' }));
    expect(screen.getByText('Training day · default options')).toBeInTheDocument();
    expect(screen.getByText('/ 2315')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'breakfast' } });
    const picker = await screen.findByRole('dialog', { name: 'Pick a food' });
    fireEvent.click(within(picker).getByText('Oats'));
    // 100 g of oats by default.
    expect(await screen.findByText('372')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount of Oats'), { target: { value: '40' } });
    expect(await screen.findByText('149')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const doc = calls.find((c) => c.method === 'PUT')!.body as {
      document: typeof planDraft.document;
    };
    expect(doc.document.days[0]!.meals[0]).toMatchObject({
      slot: 'breakfast',
      options: [{ label: 'A', items: [{ foodId: oats.id, grams: 40 }] }],
    });
  });
});

describe('Plan editor rows', () => {
  it("shows each day's own amount when switching between days with the same food", async () => {
    const snap = { name: 'Oats', kcal: 372, proteinG: 13.5, carbsG: 58.7, fatG: 7, fibreG: 10 };
    const doc = emptyPlan();
    doc.days[0]!.meals = [
      {
        slot: 'breakfast',
        options: [{ label: 'A', items: [{ foodId: oats.id, grams: 40, snapshot: snap }] }],
      },
    ];
    doc.days[1]!.meals = [
      {
        slot: 'breakfast',
        options: [{ label: 'A', items: [{ foodId: oats.id, grams: 60, snapshot: snap }] }],
      },
    ];
    fakeApi({
      [`GET /plans/${planDraft.id}`]: { ...planDraft, document: doc },
      'GET /foods': [oats],
      'GET /plan': overview(),
    });
    renderAt(`/plan/edit/${planDraft.id}`);
    fireEvent.click(await screen.findByRole('tab', { name: 'Mon' }));
    expect(screen.getByLabelText('Amount of Oats')).toHaveValue('40');
    fireEvent.click(screen.getByRole('tab', { name: 'Tue' }));
    expect(screen.getByLabelText('Amount of Oats')).toHaveValue('60');
  });
});

describe('Plan generation', () => {
  const run = (patch: object) => ({
    id: '55555555-5555-4555-8555-555555555555',
    status: 'running',
    model: 'claude-opus-5-5',
    createdAt: '2026-11-05T11:00:00Z',
    finishedAt: null,
    costUsd: 0,
    error: null,
    planId: null,
    result: null,
    ...patch,
  });

  it('starts a generation with preferences and shows the draft when it is ready', async () => {
    let runs: object[] = [];
    fakeApi({
      'GET /plan': overview(),
      'GET /ai-runs': () => Response.json(runs),
      'POST /plans/generate': () => {
        runs = [
          run({
            status: 'succeeded',
            planId: planDraft.id,
            costUsd: 0.31,
            result: {
              summary: 'Fish twice, chicken at dinner.',
              repaired: false,
              solverChanges: ['Mon lunch: Rice 80 → 90 g'],
              errors: [],
              warnings: [],
            },
          }),
        ];
        return Response.json(runs[0], { status: 202 });
      },
    });
    renderAt('/plan');
    fireEvent.change(await screen.findByLabelText(/Anything for this week/), {
      target: { value: 'more fish' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(await screen.findByText('New draft ready')).toBeInTheDocument();
    expect(screen.getByText('Fish twice, chicken at dinner.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review the draft' })).toHaveAttribute(
      'href',
      `/plan/edit/${planDraft.id}`,
    );
    expect(screen.getByText('$0.31')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/plans/generate')?.body).toEqual({
      preferences: 'more fish',
    });
  });

  it('shows progress while a run is going, and what failed when it fails', async () => {
    fakeApi({ 'GET /plan': overview(), 'GET /ai-runs': [run({ status: 'running' })] });
    renderAt('/plan');
    expect(await screen.findByRole('status')).toHaveTextContent('Building the week');

    fakeApi({
      'GET /plan': overview(),
      'GET /ai-runs': [
        run({
          status: 'failed',
          error: 'The plan still breaks 2 check(s) after one repair.',
          result: {
            summary: '',
            repaired: true,
            solverChanges: [],
            errors: ['Wed: 2,412 kcal vs target 2,200'],
            warnings: [],
          },
        }),
      ],
    });
    renderAt('/plan');
    expect(await screen.findByText(/didn't produce a valid plan/)).toBeInTheDocument();
    expect(screen.getByText('Wed: 2,412 kcal vs target 2,200')).toBeInTheDocument();
  });
});

describe('Rules', () => {
  it('adds a rule from a food search and fills in the wording', async () => {
    fakeApi({
      'GET /rules': [],
      'GET /foods': [oats, yogurt],
      'POST /rules': { id: 'r1', spec: {}, text: '', active: true },
    });
    renderAt('/rules');
    fireEvent.click(await screen.findByRole('button', { name: /Add/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Type'), {
      target: { value: 'max_items_per_day' },
    });
    fireEvent.change(within(dialog).getByLabelText('Search foods'), { target: { value: 'yog' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Greek yogurt 0%' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/rules')).toBe(true),
    );
    expect(calls.find((c) => c.path === '/rules' && c.method === 'POST')?.body).toEqual({
      spec: { kind: 'max_items_per_day', foodIds: [yogurt.id], max: 2 },
      text: 'At most 2 of Greek yogurt 0% per day.',
      active: true,
    });
  });

  it('needs at least one food', async () => {
    fakeApi({ 'GET /rules': [], 'GET /foods': [oats] });
    renderAt('/rules');
    fireEvent.click(await screen.findByRole('button', { name: /Add/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one food');
  });
});
