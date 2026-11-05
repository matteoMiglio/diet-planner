import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from './routes';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
}

afterEach(() => vi.unstubAllGlobals());

describe('app shell', () => {
  it('shows Today by default with the tab bar', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const tab of ['Today', 'Plan', 'Scan', 'Progress']) {
      expect(nav).toHaveTextContent(tab);
    }
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to Today for unknown routes', () => {
    renderAt('/does-not-exist');
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });

  it('shows server and database status in Settings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ status: 'ok', db: 'ok', version: '1.2.3', time: new Date().toISOString() }),
      ),
    );
    renderAt('/settings');
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
  });

  it('says the server is unreachable when the request fails', async () => {
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
