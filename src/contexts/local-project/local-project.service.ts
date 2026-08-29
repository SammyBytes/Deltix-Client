/**
 * The local-project lifecycle: binding a working directory on disk to a
 * Deltix repo — the equivalent of `git init` for Deltix.
 *
 *   - `init(cwd, repo)`   creates `.deltix/config.toml` at the project root,
 *                         recording the bound repo and default branch.
 *   - `resolve(cwd)`      walks up from `cwd` to the filesystem root looking
 *                         for `.deltix/config.toml` (like git finding `.git`),
 *                         so any command run deep inside the working tree
 *                         resolves to the same project.
 *
 * Parsing/serialization uses Bun's built-in `Bun.TOML`; the schema is
 * validated with zod so a hand-edited file fails fast with a clear error.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DELTIX_PROJECT_CONFIG_NAME,
  DELTIX_PROJECT_DIR_NAME,
  type ProjectConfig,
  projectConfigSchema,
} from './local-project.config';
import {
  InvalidRepoNameError,
  NoProjectError,
  ProjectAlreadyInitializedError,
} from './local-project.errors';

/** A resolved project: its absolute root plus the parsed binding. */
export interface ResolvedProject {
  /** Absolute path of the directory containing `.deltix/`. */
  root: string;
  /** Absolute path of the `.deltix/config.toml` file. */
  configPath: string;
  config: ProjectConfig;
}

export interface LocalProjectDeps {
  now?: () => number;
}

/** Stable 16-hex directory key derived from an absolute project root. */
export function projectStateKey(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}

export class LocalProjectService {
  private readonly now: () => number;

  constructor(deps: LocalProjectDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Binds `cwd` to a Deltix repo by writing `.deltix/config.toml`. Fails if
   * the directory (or any ancestor) is already a Deltix project, matching
   * `git init` refusing to re-init a subdirectory of an existing repo.
   */
  async init(cwd: string, repo: string): Promise<ResolvedProject> {
    const root = resolve(cwd);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(repo)) {
      throw new InvalidRepoNameError();
    }
    const existing = await this.resolveQuiet(root);
    if (existing) {
      throw new ProjectAlreadyInitializedError(existing.configPath);
    }

    const configDir = join(root, DELTIX_PROJECT_DIR_NAME);
    const configPath = join(configDir, DELTIX_PROJECT_CONFIG_NAME);
    const config: ProjectConfig = { repo, branch: 'main', created_at: this.now() };
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, toToml(config), { mode: 0o600 });
    return { root, configPath, config };
  }

  /** Records the branch last used in this project so commands can default to it. */
  async setBranch(cwd: string, branch: string): Promise<ResolvedProject> {
    const project = await this.resolve(cwd);
    const config: ProjectConfig = { ...project.config, branch };
    const configDir = join(project.root, DELTIX_PROJECT_DIR_NAME);
    await mkdir(configDir, { recursive: true });
    await writeFile(project.configPath, toToml(config), { mode: 0o600 });
    return { root: project.root, configPath: project.configPath, config };
  }

  /**
   * Finds the nearest Deltix project by walking from `cwd` up to the filesystem
   * root. Throws `NoProjectError` when none exists.
   */
  async resolve(cwd: string): Promise<ResolvedProject> {
    const found = await this.resolveQuiet(cwd);
    if (!found) throw new NoProjectError();
    return found;
  }

  private async resolveQuiet(cwd: string): Promise<ResolvedProject | null> {
    let current = resolve(cwd);
    for (;;) {
      const configPath = join(current, DELTIX_PROJECT_DIR_NAME, DELTIX_PROJECT_CONFIG_NAME);
      try {
        const raw = await readFile(configPath, 'utf8');
        return { root: current, configPath, config: parseToml(raw) };
      } catch {
        // No binding here — move on to the parent directory, if any.
      }
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function parseToml(raw: string): ProjectConfig {
  const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
  return projectConfigSchema.parse(parsed);
}

/** Renders a ProjectConfig to TOML. */
export function toToml(config: ProjectConfig): string {
  return Bun.TOML.stringify(config as Record<string, unknown>);
}
