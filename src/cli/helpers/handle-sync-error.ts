import { NoProjectError } from '../../contexts/local-project';
import { NoActiveSessionError } from '../../contexts/session';
import {
  InsufficientRoleError,
  RepoNotFoundError,
  ValidationError,
  VersioningAuthenticationError,
} from '../../contexts/versioning';
import {
  CommitDataDirNotFoundError,
  LocalRepoInitError,
  PushError,
} from '../../contexts/versioning-local';
import { printError } from '../output';

export function handleSyncError(err: unknown, action: string): number {
  if (
    err instanceof NoProjectError ||
    err instanceof CommitDataDirNotFoundError ||
    err instanceof LocalRepoInitError ||
    err instanceof PushError ||
    err instanceof InsufficientRoleError ||
    err instanceof RepoNotFoundError ||
    err instanceof ValidationError
  ) {
    printError(String(err.message));
    return 1;
  }
  if (err instanceof VersioningAuthenticationError || err instanceof NoActiveSessionError) {
    printError('Authentication failed. Run `deltix login` first.');
    return 1;
  }
  printError(`${action}: ${String(err)}`);
  return 1;
}
