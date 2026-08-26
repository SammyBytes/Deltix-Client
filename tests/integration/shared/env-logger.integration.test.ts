import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetEnvCacheForTests, loadEnv } from '../../../src/shared/env';
import { createLogger } from '../../../src/shared/logger';

/**
 * Integration test: verifies env validation and the logger factory cooperate
 * correctly end-to-end (env drives logger configuration), rather than testing
 * either module in isolation.
 */
describe('shared/env + shared/logger integration', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  it('boots a logger driven by validated env vars', () => {
    const env = loadEnv({ LOG_LEVEL: 'debug', LOG_PRETTY: 'false' });

    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.LOG_PRETTY).toBe(false);

    const logger = createLogger('integration-test');
    expect(() => logger.info('cli boot sequence check')).not.toThrow();
  });
});
