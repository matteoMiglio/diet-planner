import type { BarcodeLookupDto, FoodDto, ScanContextDto } from '@diet/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './routes';

const nutella: FoodDto = {
  id: '66666666-6666-4666-8666-666666666666',
  name: 'Nutella',
  brand: 'Ferrero',
  kcal: 539,
  proteinG: 6.3,
  carbsG: 57.5,
  fatG: 30.9,
  fibreG: 0,
  sugarG: 56.3,
  satFatG: 10.6,
  saltG: 0.11,
  basis: 'as_sold',
  units: { serving: 15 },
  notes: null,
  archived: false,
  product: {
    barcode: '3017620422003',
    source: 'off',
    nutriscoreGrade: null,
    category: 'general',
    novaGroup: 4,
    additives: ['E322'],
    ingredientsText: null,
  },
  pool: {
    inPool: false,
    role: 'other',
    preferredSlots: [],
    priority: 'medium',
    portion: { kind: 'flexible', stepG: 5 },
  },
};
const context: ScanContextDto = {
  phase: 'surplus',
  remaining: { kcal: 300, fatG: 10 },
  slot: 'afternoon_snack',
  slotRoles: ['snack', 'dairy_protein'],
  conflicts: [],
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
function fakeApi(routes: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = input.replace(/^\/api/, '');
      let body: unknown = init?.body;
      try {
        body = typeof body === 'string' ? JSON.parse(body) : body;
      } catch {
        // not JSON
      }
      calls.push({ method, path, body });
      const hit = routes[`${method} ${path}`];
      return hit !== undefined
        ? Response.json(hit)
        : Response.json({ error: 'not_found', message: 'nope' }, { status: 404 });
    }),
  );
}

const renderScan = () =>
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/scan'] })} />);

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => vi.unstubAllGlobals());

describe('Scan', () => {
  it('looks up a typed barcode, shows both scores and logs a serving', async () => {
    const found: BarcodeLookupDto = {
      status: 'found',
      source: 'open_food_facts',
      food: nutella,
      context,
    };
    fakeApi({ 'GET /barcodes/3017620422003': found, 'POST /food-log': { id: 'x' } });
    renderScan();
    fireEvent.change(await screen.findByLabelText('Barcode number'), {
      target: { value: '3017620422003' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByRole('heading', { name: 'Nutella' })).toBeInTheDocument();
    expect(screen.getByText('Fit for you now')).toBeInTheDocument();
    // Open Food Facts had no grade: computed Nutri-Score E, NOVA 4, one additive.
    // Open both cards' breakdowns (quality and fit).
    for (const b of screen.getAllByRole('button', { name: "How it's scored" })) fireEvent.click(b);
    expect(screen.getByText(/Computed Nutri-Score: E/)).toBeInTheDocument();
    expect(screen.getByText('Avoid')).toBeInTheDocument();
    // Defaults to one serving (15 g).
    expect(screen.getByRole('columnheader', { name: '15 g' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ate it/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/food-log')?.body).toEqual({
        foodId: nutella.id,
        grams: 15,
        slot: 'afternoon_snack',
        via: 'scan',
      }),
    );
    expect(await screen.findByText('Logged 15 g at afternoon snack.')).toBeInTheDocument();
  });

  it('offers to read the label when the product is unknown, then saves it with the barcode', async () => {
    fakeApi({
      'GET /barcodes/8000000000002': { status: 'not_found', reason: null },
      'POST /foods': { ...nutella, id: 'new' },
    });
    renderScan();
    fireEvent.change(await screen.findByLabelText('Barcode number'), {
      target: { value: '8000000000002' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('Not in Open Food Facts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Photograph the label/ })).toBeInTheDocument();
  });

  it('says when there is no camera, and keeps typed entry available', async () => {
    fakeApi({});
    renderScan();
    fireEvent.click(await screen.findByRole('button', { name: /Scan a barcode/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/camera/i);
    expect(screen.getByLabelText('Barcode number')).toBeInTheDocument();
  });

  it('scores a food picked from search', async () => {
    fakeApi({
      [`GET /foods?q=nut`]: [nutella],
      [`GET /scan/context?foodId=${nutella.id}`]: context,
    });
    renderScan();
    fireEvent.change(await screen.findByPlaceholderText(/search your foods/), {
      target: { value: 'nut' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Nutella/ }));
    expect(await screen.findByRole('heading', { name: 'Nutella' })).toBeInTheDocument();
  });
});
