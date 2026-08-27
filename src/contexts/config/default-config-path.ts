import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default path for the CLI's persisted connection config file. */
export const defaultConfigPath = join(homedir(), '.deltix', 'config.json');
