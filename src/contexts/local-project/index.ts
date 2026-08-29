/**
 * The "local-project" bounded context: binding a working directory to a Deltix
 * repo (`.deltix/config.toml`), so `deltix start` / `commit` / `push` operate
 * on "the current project" instead of requiring the repo name every time —
 * the Deltix equivalent of git's `.git` directory.
 *
 * This is the ONLY file other contexts/modules are allowed to import from
 * (ACL boundary). Internals of this context must never be imported directly
 * from outside.
 */
export { createLocalProjectService } from './create-local-project-service';
export { type ProjectConfig, REPO_NAME_PATTERN } from './local-project.config';
export {
  InvalidRepoNameError,
  NoProjectError,
  ProjectAlreadyInitializedError,
} from './local-project.errors';
export {
  type LocalProjectDeps,
  LocalProjectService,
  projectStateKey,
  type ResolvedProject,
  toToml,
} from './local-project.service';
