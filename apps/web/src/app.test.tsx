import type { CurrentCheckinDto, ProgressDto, SettingsDto } from '@diet/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './routes';

// ResponsiveContainer measures its parent; jsdom has no layout.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const progress: ProgressDto = {
  measurements: [
    {
      id: 'm1',
      measuredAt: '2026-10-05T06:00:14.000Z',
      source: 'tanita_csv',
      weightKg: 87.8,
      bodyFatPct: 13.8,
      muscleMassKg: 71.95,
      visceralFat: 3,
      bodyWaterPct: 56.1,
      protocolOk: true,
      outlierOverride: null,
    },
    {
      id: 'm2',
      measuredAt: '2026-11-02T07:04:21.000Z',
      source: 'tanita_csv',
      weightKg: 86.75,
      bodyFatPct: 13,
      muscleMassKg: 71.75,
      visceralFat: 3,
      bodyWaterPct: 56.2,
      protocolOk: true,
      outlierOverride: null,
    },
  ],
  girths: [],
  trend: {
    decidable: false,
    reasons: ['too_few_readings'],
    slopeKgPerWeek: -0.26,
    ci80: [-0.9, 0.38],
    interceptKg: 86.6,
    n: 2,
    spanDays: 28,
    latestAgeDays: 3,
    windowStart: '2026-09-24T00:00:00.000Z',
    outlierIds: [],
    readingsNeeded: 2,
  },
};

const current: CurrentCheckinDto = {
  weekStart: '2026-11-02',
  today: '2026-11-05',
  checkin: null,
  latestWeightThisWeek: { measuredAt: '2026-11-02T07:04:21.000Z', weightKg: 86.75 },
  due: true,
};

const settings: SettingsDto = {
  profile: {
    timezone: 'Europe/Rome',
    trainingWeekdays: [1, 3, 5],
    remindersEnabled: true,
    weighInDays: [1, 4],
    weighInTime: '07:30',
    checkinReminderTime: '20:00',
  },
  ingest: { configured: true },
  push: { publicKey: null, subscriptions: 0 },
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[];

/** A fake API: answers by method and path, and records what the app sent. */
function fakeApi(overrides: Record<string, () => Response> = {}) {
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
        // Not JSON (a CSV upload): keep the raw text.
      }
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (overrides[key]) return overrides[key]();
      if (key === 'GET /progress') return Response.json(progress);
      if (key === 'GET /checkins/current') return Response.json(current);
      if (key === 'GET /settings') return Response.json(settings);
      if (key === 'GET /health') {
        return Response.json({
          status: 'ok',
          db: 'ok',
          version: '1.2.3',
          time: new Date().toISOString(),
        });
      }
      if (method === 'PUT' && path.startsWith('/checkins/')) return Response.json({});
      if (key === 'POST /measurements') return Response.json({}, { status: 201 });
      return Response.json({ error: 'not_found' }, { status: 404 });
    }),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  fakeApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('app shell', () => {
  it('shows Today by default with the tab bar', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const tab of ['Today', 'Plan', 'Scan', 'Progress']) expect(nav).toHaveTextContent(tab);
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to Today for unknown routes', () => {
    renderAt('/does-not-exist');
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });
});

describe('Today', () => {
  it('shows the check-in banner, the latest weight and how many weigh-ins the trend needs', async () => {
    renderAt('/');
    expect(await screen.findByText('Weekly check-in due')).toBeInTheDocument();
    expect(await screen.findByText('86.75 kg')).toBeInTheDocument();
    expect(screen.getByText('needs 2 more')).toBeInTheDocument();
  });

  it('logs a weight typed with a decimal point', async () => {
    renderAt('/');
    fireEvent.change(await screen.findByLabelText('Weight in kg'), { target: { value: '86.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/measurements',
        body: { weightKg: 86.4 },
      }),
    );
  });
});

describe('check-in', () => {
  it('prefills the scale weight but does not send it back as a new reading', async () => {
    const router = renderAt('/checkin');
    expect(await screen.findByDisplayValue('86.75')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Waist at the navel/), { target: { value: '84,5' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Mostly' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Progressed' }));
    fireEvent.click(screen.getByRole('button', { name: /Save check-in/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/checkins/2026-11-02');
    expect(put?.body).toMatchObject({
      waistCm: 84.5,
      adherence: 'mostly',
      trainingProgressed: 'yes',
    });
    expect(put?.body).not.toHaveProperty('weightKg');
  });

  it('sends a weight that was typed over the prefilled one', async () => {
    renderAt('/checkin');
    fireEvent.change(await screen.findByDisplayValue('86.75'), { target: { value: '86.3' } });
    fireEvent.click(screen.getByRole('button', { name: /Save check-in/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ weightKg: 86.3 }),
    );
  });

  it("logs a new reading when today's weight equals the prefilled one", async () => {
    renderAt('/checkin');
    const field = await screen.findByDisplayValue('86.75');
    fireEvent.change(field, { target: { value: '86.7' } });
    fireEvent.change(field, { target: { value: '86.75' } });
    fireEvent.click(screen.getByRole('button', { name: /Save check-in/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ weightKg: 86.75 }),
    );
  });

  it('shows the server error and stays on the form', async () => {
    fakeApi({
      'PUT /checkins/2026-11-02': () =>
        Response.json(
          { error: 'invalid_body', message: 'The request body is invalid.' },
          { status: 422 },
        ),
    });
    renderAt('/checkin');
    fireEvent.click(await screen.findByRole('button', { name: /Save check-in/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The request body is invalid.');
  });
});

describe('Progress', () => {
  it('explains why the trend is not reliable yet', async () => {
    renderAt('/progress');
    expect(await screen.findByText(/not reliable yet/)).toBeInTheDocument();
    expect(screen.getByText(/2 more weigh-ins in the last 6 weeks/)).toBeInTheDocument();
    expect(screen.getByText(/No waist measurements yet/)).toBeInTheDocument();
  });

  it('previews an import before writing it', async () => {
    fakeApi({
      'POST /measurements/import?dryRun=1': () =>
        Response.json({
          dryRun: true,
          created: 1,
          merged: 0,
          duplicates: 37,
          rows: [],
          errors: [],
        }),
      'POST /measurements/import': () =>
        Response.json({
          dryRun: false,
          created: 1,
          merged: 0,
          duplicates: 37,
          rows: [],
          errors: [],
        }),
    });
    const { container } = render(
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/progress'] })} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Import/ }));
    const input = container.ownerDocument.querySelector('input[type=file]') as HTMLInputElement;
    // jsdom's File#text never resolves; browsers implement it.
    const file = new File(['Date,Weight (kg)'], 'r.csv');
    file.text = async () => 'Date,Weight (kg)';
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('Already imported')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/measurements/import')).toBe(false);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/measurements/import')).toBe(true);
  });
});

describe('Settings', () => {
  it('shows server status, reminder settings and the Shortcut addresses', async () => {
    renderAt('/settings');
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Mon', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tue', pressed: false })).toBeInTheDocument();
    expect(screen.getByText(/\/api\/ingest\/weight$/)).toBeInTheDocument();
    expect(screen.getByText(/Push isn't configured/)).toBeInTheDocument();
  });

  it('saves a weigh-in day when tapped', async () => {
    fakeApi({
      'PATCH /profile': () => Response.json({ ...settings.profile, weighInDays: [1, 4, 6] }),
    });
    renderAt('/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Sat' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: '/profile',
        body: { weighInDays: [1, 4, 6] },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Sat', pressed: true })).toBeInTheDocument();
  });

  it('says the server is unreachable when requests fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderAt('/settings');
    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
  });
});
