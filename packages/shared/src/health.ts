import { z } from 'zod';

/** Response of `GET /api/health`. Shared so the UI and the API can't drift. */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  db: z.enum(['ok', 'down']),
  time: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
