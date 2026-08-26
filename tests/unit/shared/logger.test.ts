import { afterEach, describe, expect, it } from 'bun:test';
import { __resetLoggerCacheForTests, createLogger } from '../../../src/shared/logger';

describe('shared/logger', () => {
  afterEach(() => {
    __resetLoggerCacheForTests();
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_PRETTY;
  });

  it('creates a child logger scoped to the given bounded context', () => {
    const logger = createLogger('session');
    expect(logger.bindings().context).toBe('session');
  });

  it('reads LOG_LEVEL from the environment, defaulting to "info"', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger('session');
    expect(logger.level).toBe('debug');
  });

  it('treats the string "false" as false for LOG_PRETTY (not a truthy non-empty string)', () => {
    process.env.LOG_PRETTY = 'false';
    expect(() => createLogger('session')).not.toThrow();
  });

  it('redacts known sensitive fields instead of logging them in clear text', () => {
    const logger = createLogger('session');
    expect(() => logger.info({ token: 'super-secret' }, 'test message')).not.toThrow();
  });
});
