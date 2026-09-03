import {
  LocalServerNotRunningError,
  LocalServerPortInUseError,
  LocalServerStartError,
} from '../../contexts/mysql-embedded';
import { printError } from '../output';

export function handleLocalServerError(err: unknown): number {
  if (err instanceof LocalServerPortInUseError) {
    printError(err.message);
    return 2;
  }
  if (err instanceof LocalServerNotRunningError) {
    printError(err.message);
    return 1;
  }
  if (err instanceof LocalServerStartError) {
    printError(err.message);
    return 1;
  }
  printError(`Local server command failed: ${String(err)}`);
  return 1;
}
