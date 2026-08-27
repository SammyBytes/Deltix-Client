/**
 * Lightweight, configurable structured logging built on Pino.
 *
 * - `LOG_LEVEL` controls verbosity (trace..fatal), default "info".
 * - `LOG_PRETTY=true` renders human-readable, colorized output for local
 *   development (via pino-pretty). In production, plain JSON is emitted so
 *   logs can be shipped to any aggregator without extra parsing.
 * - Sensitive fields are redacted automatically — never log secrets, keys,
 *   signatures or tokens in clear text.
 *
 * IMPORTANT: pino-pretty is wired as a direct synchronous stream
 * (`pinoPretty()` passed straight to `pino()`), NOT via pino's
 * `transport: { target: 'pino-pretty' }` option. The `transport` option
 * spawns a worker thread that resolves the target module by string path at
 * runtime — this works fine under `bun run`/Node, but fails in a
 * `bun build --compile` binary (this CLI's primary distribution format,
 * see .github/copilot-instructions.md §9) because there is no `node_modules`
 * on disk for the worker to resolve against, crashing with "unable to
 * determine transport target for pino-pretty" the moment a user runs the
 * compiled binary without explicitly setting LOG_PRETTY=false. A direct
 * stream import is statically bundled into the binary and has no such
 * runtime resolution step.
 *
 * This module is truly cross-cutting and context-agnostic (see
 * .github/copilot-instructions.md §2), so it deliberately does NOT depend on
 * `./env.ts`. Later phases will add context-specific required env vars
 * (session, binary-manager, ...) to that schema, and a shared logger must
 * remain usable by any context without pulling in another context's
 * required configuration.
 */
import pino, { type Logger } from 'pino';
import pinoPretty from 'pino-pretty';
import { z } from 'zod';

const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
    return defaultValue;
  }, z.boolean().default(defaultValue));

const loggerEnvSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanFromEnv(true),
});

const REDACTED_PATHS = [
  'licenseKey',
  'signature',
  'publicKey',
  'privateKey',
  'token',
  'password',
  '*.licenseKey',
  '*.signature',
  '*.publicKey',
  '*.privateKey',
  '*.token',
  '*.password',
];

let rootLogger: Logger | undefined;

function getRootLogger(): Logger {
  if (!rootLogger) {
    const env = loggerEnvSchema.parse(Bun.env);
    const stream = env.LOG_PRETTY
      ? pinoPretty({ colorize: true, translateTime: 'HH:MM:ss.l' })
      : undefined;
    rootLogger = pino(
      {
        level: env.LOG_LEVEL,
        redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      },
      stream,
    );
  }
  return rootLogger;
}

/**
 * Creates a child logger scoped to a bounded context (e.g. "licensing",
 * "http"), so every log line carries its origin without manual tagging.
 */
export function createLogger(context: string): Logger {
  return getRootLogger().child({ context });
}

/** Test-only helper to reset the cached root logger between test cases. */
export function __resetLoggerCacheForTests(): void {
  rootLogger = undefined;
}
