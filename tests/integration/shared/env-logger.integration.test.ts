import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';
import { __resetLoggerCacheForTests, createLogger } from '../../../src/shared/logger';

/**
 * Integration test: verifies that validating the app env and creating a
 * logger both work together during CLI startup, without one module
 * accidentally requiring the other's configuration (see §2 ACL boundary —
 * `shared/logger.ts` is intentionally decoupled from `shared/env.ts`).
 */
describe('shared/env + shared/logger integration', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
    __resetLoggerCacheForTests();
  });

  it('boots a logger independently of app-specific env validation', () => {
    const env = loadEnv({ NODE_ENV: 'test' });

    expect(env.NODE_ENV).toBe('test');

    const logger = createLogger('integration-test');
    expect(() => logger.info('cli boot sequence check')).not.toThrow();
  });
});
