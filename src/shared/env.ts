/**
 * Centralized, validated access to environment variables.
 *
 * Every env var the CLI depends on is declared and validated here with zod.
 * Fails fast and loudly if a required variable is missing or malformed.
 * This schema will grow in later phases (session/auth, binary manager, etc.)
 * — add new variables here, never read `Bun.env` ad-hoc elsewhere.
 */
import { z } from 'zod';

/**
 * `z.coerce.boolean()` is a footgun: it runs `Boolean(value)`, so the string
 * "false" (being non-empty) coerces to `true`. This helper parses common
 * boolean-ish env var spellings explicitly instead.
 */
const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
    return defaultValue;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanFromEnv(true),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: Record<string, string | undefined> = Bun.env): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(source);
  }
  return cachedEnv;
}

/** Test-only helper to reset the cache between test cases. */
export function __resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
