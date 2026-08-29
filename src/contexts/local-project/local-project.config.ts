/**
 * Schema and persistence for a Deltix project binding (`.deltix/config.toml`).
 *
 * Mirrors how a git repo carries its own `.git/config`: a `.deltix/` directory
 * lives at the project root and records which Deltix repo this working tree
 * is bound to, the remote origin, and the last branch used there. This lets
 * `deltix start` / `commit` / `push` operate on "the current project" without
 * requiring the repo name on every command line, and keeps per-checkout state
 * isolated so switching between projects never collides.
 *
 * TOML was chosen over JSON because this is a developer-edited file: it
 * supports comments and reads more naturally by hand. Parsing/serialization
 * uses Bun's built-in `Bun.TOML` (no runtime dependency).
 */
import { z } from 'zod';

/** Name of the project's Deltix binding directory. */
export const DELTIX_PROJECT_DIR_NAME = '.deltix';
/** Name of the binding file inside the project's `.deltix` directory. */
export const DELTIX_PROJECT_CONFIG_NAME = 'config.toml';

/** Validation rules shared with server-side repo IDs. */
export const REPO_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export const projectConfigSchema = z.object({
  /** The Deltix repo this directory is bound to. */
  repo: z.string().regex(REPO_NAME_PATTERN, 'invalid repo name'),
  /** Optional remote origin label (reserved; host discovery lives in config). */
  remote: z.string().min(1).optional(),
  /** Last branch used in this checkout, so commands default to it. */
  branch: z.string().min(1).default('main'),
  /** When the binding was created (Unix ms). */
  created_at: z.number().int().nonnegative().optional(),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
