import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  // Requiring a JSON content type also means a cross-site form can't post here without a
  // CORS preflight, which this server never grants.
  if (!(c.req.header('Content-Type') ?? '').startsWith('application/json')) {
    throw new HttpError(
      415,
      'unsupported_media_type',
      'Send JSON with Content-Type: application/json.',
    );
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(422, 'invalid_body', 'The request body is invalid.', parsed.error.issues);
  }
  return parsed.data;
}

/** Constant-time bearer token check. A missing server token disables the route entirely. */
export function bearerAuth(getToken: () => string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const expected = getToken();
    if (!expected) throw new HttpError(503, 'ingest_disabled', 'INGEST_TOKEN is not configured.');
    const header = c.req.header('Authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpError(401, 'unauthorized', 'Missing or wrong token.');
    }
    await next();
  };
}

/** Fixed-window rate limit, in memory. Enough for one user and a misbehaving Shortcut. */
export function rateLimit(limit: number, windowMs: number): MiddlewareHandler {
  let windowStart = 0;
  let count = 0;
  return async (_c, next) => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    if (++count > limit) throw new HttpError(429, 'rate_limited', 'Too many requests, slow down.');
    await next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects state-changing browser requests that come from another site (CSRF). Browsers send
 * `Sec-Fetch-Site` and `Origin`; requests without them (curl, Shortcuts) aren't from a page and
 * pass. Bearer-token routes don't need this and shouldn't sit behind it.
 */
export function sameOriginWrites(): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const site = c.req.header('Sec-Fetch-Site');
      if (site && site !== 'same-origin' && site !== 'none') {
        throw new HttpError(403, 'cross_site', 'Cross-site requests are not allowed.');
      }
      const origin = c.req.header('Origin');
      if (origin) {
        let originHost: string;
        try {
          originHost = new URL(origin).host;
        } catch {
          throw new HttpError(403, 'cross_site', 'Cross-site requests are not allowed.');
        }
        const hosts = [c.req.header('Host'), c.req.header('X-Forwarded-Host')].filter(Boolean);
        if (!hosts.includes(originHost)) {
          throw new HttpError(403, 'cross_site', 'Cross-site requests are not allowed.');
        }
      }
    }
    await next();
  };
}
