import { ApiError } from '../errors.js';

/**
 * Builders for lody CLI argv. Values always use the `--flag=value` form so a
 * value that starts with `-` (for example a query of `--all`) can never be
 * parsed by commander as another option; positionals are restricted to ids
 * that cannot start with `-`. Arguments go straight to `spawn`, no shell.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_FILTER_LENGTH = 512;

export function assertId(kind: string, value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new ApiError(400, 'invalid_request', `Invalid ${kind}: ${JSON.stringify(value)}`);
  }
  return value;
}

function flag(name: string, value: string): string {
  if (value.length === 0 || value.length > MAX_FILTER_LENGTH || value.includes('\0')) {
    throw new ApiError(400, 'invalid_request', `Invalid value for --${name}`);
  }
  return `--${name}=${value}`;
}

function workspaceArgs(workspace: string | undefined): string[] {
  return workspace === undefined ? [] : [flag('workspace', workspace)];
}

/** Mirrors `lody session list` filters one to one. */
export type SessionListFilters = {
  archived?: boolean;
  all?: boolean;
  openedBy?: string;
  query?: string;
  machineId?: string;
  agentConfigId?: string;
  agentRoleId?: string;
};

export function sessionListArgs(workspace: string | undefined, filters: SessionListFilters): string[] {
  const args = ['session', 'list', '--json', ...workspaceArgs(workspace)];
  if (filters.all) args.push('--all');
  if (filters.archived) args.push('--archived');
  if (filters.openedBy !== undefined) args.push(flag('opened-by', filters.openedBy));
  if (filters.query !== undefined) args.push(flag('query', filters.query));
  if (filters.machineId !== undefined) args.push(flag('machine-id', filters.machineId));
  if (filters.agentConfigId !== undefined) args.push(flag('agent-config-id', filters.agentConfigId));
  if (filters.agentRoleId !== undefined) args.push(flag('agent-role-id', filters.agentRoleId));
  return args;
}

export function sessionShowArgs(sessionId: string, workspace: string | undefined): string[] {
  return ['session', 'show', assertId('session id', sessionId), '--json', ...workspaceArgs(workspace)];
}

export function sessionStatusArgs(sessionId: string, workspace: string | undefined): string[] {
  return ['session', 'status', assertId('session id', sessionId), '--json', ...workspaceArgs(workspace)];
}

/** The prompt is piped through stdin (`--prompt-file=-`): no argv size limit, not visible in `ps`. */
export function sessionChatArgs(input: {
  sessionId: string;
  workspace: string | undefined;
  wait?: { timeoutSeconds: number };
}): string[] {
  const args = [
    'session',
    'chat',
    assertId('session id', input.sessionId),
    '--prompt-file=-',
    '--json',
    ...workspaceArgs(input.workspace),
  ];
  if (input.wait) {
    const seconds = input.wait.timeoutSeconds;
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new ApiError(400, 'invalid_request', 'timeoutSeconds must be a positive integer');
    }
    args.push('--wait', `--timeout=${seconds}`);
  }
  return args;
}

export function sessionHistoryArgs(
  sessionId: string,
  workspace: string | undefined,
  range: { limit: number } | { all: true }
): string[] {
  const args = ['session', 'history', assertId('session id', sessionId), '--json', ...workspaceArgs(workspace)];
  if ('all' in range) args.push('--all');
  else args.push(`--limit=${range.limit}`);
  return args;
}

export function sessionObserveSnapshotArgs(sessionId: string, workspace: string | undefined): string[] {
  return ['session', 'observe', assertId('session id', sessionId), '--json', ...workspaceArgs(workspace)];
}

export function sessionObserveFollowArgs(sessionId: string, workspace: string | undefined): string[] {
  return [
    'session',
    'observe',
    assertId('session id', sessionId),
    '--jsonl',
    '--follow',
    ...workspaceArgs(workspace),
  ];
}

export function workspaceListArgs(): string[] {
  return ['workspace', 'list', '--json'];
}

export function loginArgs(apiKey: string, machineName: string): string[] {
  return ['login', `--auth=${apiKey}`, `--machine-name=${machineName}`];
}
