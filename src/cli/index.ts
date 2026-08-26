#!/usr/bin/env bun
/**
 * Deltix-Client CLI entrypoint (scaffolding).
 *
 * Command wiring for `deltix <command>` lands progressively as each roadmap
 * phase implements its bounded context (session, dataflow, etc.).
 */
import { createLogger } from '../shared/logger';

const logger = createLogger('cli');

if (import.meta.main) {
  logger.info('Deltix-Client scaffold — see roadmap phases for feature implementation');
}
