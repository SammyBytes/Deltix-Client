import { describe, expect, it } from 'bun:test';
import { createLogger } from '../../src/shared/logger';

describe('scaffolding smoke test', () => {
  it('creates a scoped logger without throwing', () => {
    const logger = createLogger('smoke');
    expect(logger).toBeDefined();
    expect(() => logger.info('scaffold boots correctly')).not.toThrow();
  });
});
