export const TURN_STATES = ['pending', 'running', 'completed', 'failed', 'canceled', 'unknown'] as const;
export type TurnState = (typeof TURN_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TurnState> = new Set(['completed', 'failed', 'canceled', 'unknown']);

export function isTerminal(state: TurnState): boolean {
  return TERMINAL_STATES.has(state);
}

/** One user turn, keyed by the CLI's `userTurnId`. */
export type TurnRecord = {
  sessionId: string;
  turnId: string;
  /** Workspace id when known, else the selector the turn was sent with. */
  workspace: string | null;
  state: TurnState;
  assistantTurnId: string | null;
  replyText: string | null;
  /** Raw `MessageContent[]`; only `wait=true` responses carry it. */
  replyContent: unknown[] | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  submittedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  /** False once the tracker has given up on the turn (age limit or session removed). */
  tracking: boolean;
};

export function turnToJson(record: TurnRecord) {
  return {
    id: record.turnId,
    sessionId: record.sessionId,
    workspace: record.workspace,
    state: record.state,
    assistantTurnId: record.assistantTurnId,
    reply:
      record.replyText !== null || record.replyContent !== null
        ? {
            text: record.replyText,
            ...(record.replyContent !== null ? { content: record.replyContent } : {}),
          }
        : null,
    error: record.errorCode !== null ? { code: record.errorCode, message: record.errorMessage } : null,
    durationMs: record.durationMs,
    submittedAt: record.submittedAt,
    finishedAt: record.finishedAt,
    updatedAt: record.updatedAt,
  };
}
