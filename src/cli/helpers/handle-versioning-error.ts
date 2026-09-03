import { NoActiveSessionError } from '../../contexts/session';
import {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  InsufficientRoleError,
  ProtectedBranchError,
  RepoAlreadyExistsError,
  RepoNotFoundError,
  RoleAssignmentNotFoundError,
  UserNotFoundError,
  ValidationError,
  VersioningAuthenticationError,
} from '../../contexts/versioning';
import { printError } from '../output';

export function handleVersioningError(err: unknown, action: string): number {
  if (err instanceof NoActiveSessionError || err instanceof VersioningAuthenticationError) {
    printError('Not logged in. Run `deltix login` first.');
    return 1;
  }
  if (
    err instanceof InsufficientRoleError ||
    err instanceof RepoNotFoundError ||
    err instanceof BranchNotFoundError ||
    err instanceof BranchAlreadyExistsError ||
    err instanceof ProtectedBranchError ||
    err instanceof RepoAlreadyExistsError ||
    err instanceof RoleAssignmentNotFoundError ||
    err instanceof UserNotFoundError ||
    err instanceof ValidationError
  ) {
    printError(`${action}: ${err.message}`);
    return 1;
  }
  printError(`${action}: ${String(err)}`);
  return 1;
}
