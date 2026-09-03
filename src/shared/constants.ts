/**
 * Defaults and limits — avoids scattered magic numbers/strings.
 * Single place to change ports, timeouts and default names.
 */

// Ports
export const DEFAULT_MYSQL_PORT = 3306 as const;
export const DEFAULT_DOLT_PORT = 3307 as const;
export const DEFAULT_SERVER_PORT = 9090 as const;
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}` as const;

// Branches and prefixes
export const DEFAULT_BRANCH = 'main' as const;
export const REMOTE_TRACKING_PREFIX = 'origin/' as const;
export const REMOTE_TRACKING_BRANCH = `${REMOTE_TRACKING_PREFIX}${DEFAULT_BRANCH}` as const;

// Timeouts (ms) — named by intent, not value
export const TIMEOUT = {
  /** fast probe to :3307 / probePort (500ms + 250ms retry) */
  PORT_PROBE: 500,
  PORT_RETRY_INTERVAL: 250,
  /** mysql connect fast (status, branch list) */
  MYSQL_CONNECT_FAST: 800,
  MYSQL_CONNECT_NORMAL: 1200,
  MYSQL_CONNECT_SLOW: 1500,
  MYSQL_CONNECT_BOOTSTRAP: 2000,
  /** dolt CLI */
  DOLT_BRANCH: 10_000,
  DOLT_DIFF_STAT: 15_000,
  DOLT_COMMIT: 30_000,
  DOLT_MERGE: 30_000,
  DOLT_PULL_MERGE: 60_000,
  DOLT_IMPORT: 120_000,
  /** server readiness */
  SERVER_READY: 20_000,
} as const;

// Default identity for commits without session
export const DEFAULT_COMMIT_AUTHOR = 'deltix' as const;
export const DEFAULT_COMMIT_EMAIL_DOMAIN = 'deltix.local' as const;

// Validation
export const REPO_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/ as const;
export const BRANCH_NAME_RE = /^[A-Za-z0-9/_-]{1,64}$/ as const;
export const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/ as const;

// Usage messages (avoids magic strings in CLI)
export const USAGE = {
  REPO_REQUIRED: 'Usage: deltix repo <create|list|get> [repo]',
  BRANCH_REQUIRED: 'Usage: deltix branch <list|local|create|checkout|delete|current> [repo] [name]',
  CHECKOUT_REQUIRED: 'Usage: deltix checkout <branch> [<repo>]',
  MERGE_REQUIRED: 'Usage: deltix merge <repo> <sourceBranch> [targetBranch]',
  DIFF_REQUIRED:
    'Usage: deltix diff [<repo> [<from> <to> | <table>]]  (no refs = working-tree diff)',
} as const;
