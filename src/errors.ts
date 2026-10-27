/** Error surfaced to API clients as `{ error: { code, message, retryable } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** A lody CLI invocation that exited unsuccessfully or reported `ok: false`. */
export class LodyCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    /** The structured JSON line the CLI printed, when it printed one. */
    readonly payload?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'LodyCliError';
  }
}

type Rule = {
  pattern: RegExp;
  status: number;
  code: string;
  retryable?: boolean;
};

/**
 * CLI messages are plain text with no stable codes, so they are classified by
 * the wording in apps/cli (session.ts, command-runtime.ts, workspace.ts, auth.ts).
 * Order matters: the first match wins.
 */
const RULES: Rule[] = [
  { pattern: /^Session not found\b/, status: 404, code: 'session_not_found' },
  { pattern: /\bis archived\. Restore it before chatting\b/, status: 409, code: 'session_archived' },
  {
    pattern: /^Machine \S+ is offline or (?:unreachable|unavailable)|^Target machine is unavailable\b/,
    status: 503,
    code: 'machine_offline',
    retryable: true,
  },
  { pattern: /^Machine access denied\b/, status: 403, code: 'machine_access_denied' },
  {
    pattern:
      /Not logged in|CLI token is invalid or expired|CLI token cannot access this workspace|Invalid API key/,
    status: 503,
    code: 'lody_auth_failed',
  },
  { pattern: /^Workspace not found\b/, status: 404, code: 'workspace_not_found' },
  { pattern: /^Workspace selector is ambiguous\b/, status: 400, code: 'workspace_ambiguous' },
  { pattern: /^Multiple workspaces are available\b/, status: 400, code: 'workspace_required' },
  { pattern: /^No accessible workspaces found\b/, status: 403, code: 'workspace_unavailable' },
  { pattern: /^Prompt input is empty\b/, status: 400, code: 'invalid_request' },
  { pattern: /database is locked|SQLITE_BUSY/i, status: 503, code: 'lody_busy', retryable: true },
  {
    pattern:
      /^Workspace synchronization is temporarily unavailable|auth service is unreachable|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i,
    status: 503,
    code: 'lody_upstream_unavailable',
    retryable: true,
  },
];

export function mapLodyCliError(error: LodyCliError): ApiError {
  for (const rule of RULES) {
    if (rule.pattern.test(error.message)) {
      return new ApiError(rule.status, rule.code, error.message, rule.retryable ?? false);
    }
  }
  return new ApiError(502, 'lody_cli_error', error.message, false, {
    ...(error.exitCode !== null ? { exitCode: error.exitCode } : {}),
  });
}

export function toApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (error instanceof LodyCliError) return mapLodyCliError(error);
  return undefined;
}
