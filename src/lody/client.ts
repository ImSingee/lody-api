import type { z } from 'zod';
import { ApiError, LodyCliError } from '../errors.js';
import {
  loginArgs,
  sessionChatArgs,
  sessionHistoryArgs,
  sessionListArgs,
  sessionObserveFollowArgs,
  sessionObserveSnapshotArgs,
  sessionShowArgs,
  sessionStatusArgs,
  workspaceListArgs,
  type SessionListFilters,
} from './args.js';
import type { LodyRunner, RunResult, StreamHandle } from './runner.js';
import {
  ChatDispatchOutputSchema,
  ChatWaitErrorPayloadSchema,
  ChatWaitOutputSchema,
  ObserveEventSchema,
  ObserveSnapshotOutputSchema,
  SessionHistoryOutputSchema,
  SessionListOutputSchema,
  SessionShowOutputSchema,
  SessionStatusOutputSchema,
  WorkspaceListOutputSchema,
  type ChatDispatchOutput,
  type ChatWaitOutput,
  type ObserveEvent,
  type ObservedSession,
  type SessionHistoryOutput,
  type SessionMeta,
  type SessionShowOutput,
  type SessionStatusOutput,
  type WorkspaceListOutput,
} from './schemas.js';

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * The CLI prints its result as one JSON line, but non-session commands can mix
 * log lines into stdout, so the result is the last line that parses as an object.
 */
export function extractJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // a log line that happens to start with `{`
    }
  }
  return undefined;
}

function lastMeaningfulLine(text: string): string | undefined {
  const lines = text
    .replace(ANSI_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1);
}

export function failureMessage(result: RunResult, payload: Record<string, unknown> | undefined): string {
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return payload.error.replace(ANSI_PATTERN, '').trim();
  }
  return (
    lastMeaningfulLine(result.stderr) ??
    lastMeaningfulLine(result.stdout) ??
    `lody exited with ${result.signal ? `signal ${result.signal}` : `code ${result.exitCode}`}`
  );
}

export type ChatWaitResult =
  | { kind: 'completed'; output: ChatWaitOutput }
  /** The turn was dispatched, but waiting ended in failure, cancellation or timeout. */
  | { kind: 'wait_failed'; sessionId: string; userTurnId: string; message: string };

export interface LodyClient {
  listSessions(
    workspace: string | undefined,
    filters: SessionListFilters
  ): Promise<{ workspaceId: string; sessions: SessionMeta[] }>;
  showSession(sessionId: string, workspace: string | undefined): Promise<SessionShowOutput>;
  sessionStatus(sessionId: string, workspace: string | undefined): Promise<SessionStatusOutput>;
  chat(input: { sessionId: string; workspace: string | undefined; prompt: string }): Promise<ChatDispatchOutput>;
  chatAndWait(input: {
    sessionId: string;
    workspace: string | undefined;
    prompt: string;
    timeoutSeconds: number;
  }): Promise<ChatWaitResult>;
  history(
    sessionId: string,
    workspace: string | undefined,
    range: { limit: number } | { all: true }
  ): Promise<SessionHistoryOutput>;
  observeSnapshot(
    sessionId: string,
    workspace: string | undefined
  ): Promise<{ workspaceId: string; session: ObservedSession }>;
  observeFollow(
    sessionId: string,
    workspace: string | undefined,
    onEvent: (event: ObserveEvent) => void
  ): StreamHandle;
  listWorkspaces(): Promise<WorkspaceListOutput>;
  login(apiKey: string, machineName: string): Promise<void>;
}

/** Extra time on top of `--timeout` for dispatch and sync before the process is killed. */
const WAIT_GRACE_MS = 90_000;

export class CliLodyClient implements LodyClient {
  constructor(private readonly runner: LodyRunner) {}

  private async exec<T extends z.ZodType>(
    args: string[],
    schema: T,
    options: { timeoutMs?: number; stdin?: string } = {}
  ): Promise<z.infer<T>> {
    const result = await this.runner.run(args, options);
    const payload = extractJsonLine(result.stdout);
    if (result.exitCode !== 0 || !payload || payload.ok === false) {
      throw new LodyCliError(failureMessage(result, payload), result.exitCode, payload);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(502, 'lody_cli_bad_output', `Unexpected output from lody ${args[0]} ${args[1]}`, false, {
        issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }
    return parsed.data;
  }

  async listSessions(workspace: string | undefined, filters: SessionListFilters) {
    const output = await this.exec(sessionListArgs(workspace, filters), SessionListOutputSchema);
    return { workspaceId: output.workspaceId, sessions: output.sessions };
  }

  showSession(sessionId: string, workspace: string | undefined) {
    return this.exec(sessionShowArgs(sessionId, workspace), SessionShowOutputSchema);
  }

  sessionStatus(sessionId: string, workspace: string | undefined) {
    return this.exec(sessionStatusArgs(sessionId, workspace), SessionStatusOutputSchema);
  }

  chat(input: { sessionId: string; workspace: string | undefined; prompt: string }) {
    return this.exec(sessionChatArgs(input), ChatDispatchOutputSchema, { stdin: input.prompt });
  }

  async chatAndWait(input: {
    sessionId: string;
    workspace: string | undefined;
    prompt: string;
    timeoutSeconds: number;
  }): Promise<ChatWaitResult> {
    try {
      const output = await this.exec(
        sessionChatArgs({ ...input, wait: { timeoutSeconds: input.timeoutSeconds } }),
        ChatWaitOutputSchema,
        { stdin: input.prompt, timeoutMs: input.timeoutSeconds * 1000 + WAIT_GRACE_MS }
      );
      return { kind: 'completed', output };
    } catch (error) {
      if (error instanceof LodyCliError) {
        const waitError = ChatWaitErrorPayloadSchema.safeParse(error.payload);
        if (waitError.success) {
          return {
            kind: 'wait_failed',
            sessionId: waitError.data.sessionId,
            userTurnId: waitError.data.userTurnId,
            message: error.message,
          };
        }
      }
      throw error;
    }
  }

  history(sessionId: string, workspace: string | undefined, range: { limit: number } | { all: true }) {
    return this.exec(sessionHistoryArgs(sessionId, workspace, range), SessionHistoryOutputSchema);
  }

  async observeSnapshot(sessionId: string, workspace: string | undefined) {
    const output = await this.exec(sessionObserveSnapshotArgs(sessionId, workspace), ObserveSnapshotOutputSchema);
    return { workspaceId: output.workspaceId, session: output.session };
  }

  observeFollow(sessionId: string, workspace: string | undefined, onEvent: (event: ObserveEvent) => void) {
    return this.runner.stream(sessionObserveFollowArgs(sessionId, workspace), (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        return;
      }
      const parsed = ObserveEventSchema.safeParse(value);
      if (parsed.success) onEvent(parsed.data);
    });
  }

  listWorkspaces() {
    return this.exec(workspaceListArgs(), WorkspaceListOutputSchema);
  }

  async login(apiKey: string, machineName: string): Promise<void> {
    const result = await this.runner.run(loginArgs(apiKey, machineName), { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      // Never echo CLI output verbatim here: it is the only place the key is on argv.
      const message = failureMessage(result, extractJsonLine(result.stdout)).replaceAll(apiKey, '<redacted>');
      throw new LodyCliError(message, result.exitCode);
    }
  }
}
