import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  /** Directory with the built web app; served as static files when set. */
  WEB_DIST: z.string().optional(),
  APP_VERSION: z.string().default('dev'),
  TZ_DEFAULT: z.string().default('Europe/Rome'),
  /** Bearer token for the iOS Shortcut endpoints. Unset disables them. */
  INGEST_TOKEN: z.string().min(32, 'INGEST_TOKEN must be at least 32 characters').optional(),
  /** Web push. All three set enables reminders; generate with `npx web-push generate-vapid-keys`. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Claude API key for plan generation. Unset disables it. */
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, 'VAPID_SUBJECT must start with mailto: or https://')
    .optional(),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Compose passes unset variables as empty strings; treat those as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
