/**
 * Centralized, validated access to environment variables.
 *
 * Every env var the CLI depends on is declared and validated here with zod.
 * Fails fast and loudly if a required variable is missing or malformed.
 * This schema will grow in later phases (session/auth, binary manager, etc.)
 * — add new variables here, never read `Bun.env` ad-hoc elsewhere.
 */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DELTIX_SERVER_URL: z.string().url().default('http://127.0.0.1:9090'),
  DELTIX_CREDENTIALS_PATH: z.string().min(1).optional(),
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
