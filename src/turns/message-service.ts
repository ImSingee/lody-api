import { createHash } from 'node:crypto';
import { ApiError } from '../errors.js';
import type { LodyClient } from '../lody/client.js';
import type { ObservedTurn } from '../lody/schemas.js';
import { silentLogger, type Logger } from '../logger.js';
import type { TurnStore } from './store.js';
import type { TurnTracker } from './tracker.js';
import { ASYNC_FAILURE_MESSAGE } from './tracker.js';
import { isTerminal, type TurnRecord } from './types.js';

export type SendMessageInput = {
  sessionId: string;
  workspace: string | undefined;
  prompt: string;
  wait: boolean;
  timeoutSeconds: number;
  idempotencyKey?: string | undefined;
};

export type SendMessageResult = {
  status: 200 | 202;
  turn: TurnRecord;
  /** `wait=true` hit its timeout; the turn keeps running and is being tracked. */
  waitTimedOut: boolean;
  /** Answered from an earlier request with the same Idempotency-Key. */
  replayed: boolean;
};

export type GetTurnInput = {
  sessionId: string;
  turnId: string;
  workspace: string | undefined;
  waitSeconds: number;
};

const WAIT_TIMEOUT_PATTERN = /^Timed out waiting for session turn completion\b/;
const WAIT_CANCELED_MESSAGE = 'Session turn was canceled.';

export class MessageService {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(
    private readonly client: Pick<LodyClient, 'chat' | 'chatAndWait' | 'observeSnapshot' | 'history'>,
    private readonly store: TurnStore,
    private readonly tracker: Pick<TurnTracker, 'track' | 'waitForTerminal' | 'fetchReplyText'>,
    options: { now?: () => number; logger?: Logger } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (!input.prompt.trim()) throw new ApiError(400, 'invalid_request', 'prompt must not be blank');
    const key = input.idempotencyKey;
    if (key === undefined) return this.dispatch(input);

    // Serialize requests sharing a key so a concurrent retry cannot send twice.
    for (;;) {
      const replay = await this.replay(key, input);
      if (replay) return replay;
      const running = this.inflight.get(key);
      if (!running) break;
      await running.catch(() => undefined);
    }
    const attempt = this.dispatch(input);
    this.inflight.set(key, attempt);
    try {
      const result = await attempt;
      this.store.putIdempotency({
        key,
        sessionId: input.sessionId,
        requestHash: requestHash(input),
        turnId: result.turn.turnId,
        createdAt: new Date(this.now()).toISOString(),
      });
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async replay(key: string, input: SendMessageInput): Promise<SendMessageResult | undefined> {
    const entry = this.store.getIdempotency(key);
    if (!entry) return undefined;
    if (entry.sessionId !== input.sessionId || entry.requestHash !== requestHash(input)) {
      throw new ApiError(422, 'idempotency_key_reused', 'Idempotency-Key was already used for a different request.');
    }
    if (input.wait) {
      await this.tracker.waitForTerminal(entry.sessionId, entry.turnId, input.timeoutSeconds * 1000);
    }
    const turn = this.store.get(entry.sessionId, entry.turnId);
    if (!turn) return undefined;
    const done = isTerminal(turn.state);
    return { status: done ? 200 : 202, turn, waitTimedOut: input.wait && !done, replayed: true };
  }

  private async dispatch(input: SendMessageInput): Promise<SendMessageResult> {
    const submittedAt = new Date(this.now()).toISOString();
    if (!input.wait) {
      const output = await this.client.chat(input);
      const turn = this.newRecord(output.sessionId, output.userTurnId, output.workspaceId, submittedAt);
      this.store.upsert(turn);
      this.tracker.track(turn);
      return { status: 202, turn, waitTimedOut: false, replayed: false };
    }

    const result = await this.client.chatAndWait(input);
    if (result.kind === 'completed') {
      const { output } = result;
      const replyText = await this.tracker
        .fetchReplyText(output.sessionId, output.workspaceId, output.turnId)
        .catch((error: unknown) => {
          this.logger.warn('reply text fetch failed after wait', { sessionId: output.sessionId, error });
          return null;
        });
      const at = new Date(this.now()).toISOString();
      const turn: TurnRecord = {
        ...this.newRecord(output.sessionId, output.userTurnId, output.workspaceId, submittedAt),
        state: 'completed',
        assistantTurnId: output.turnId,
        replyText,
        replyContent: output.content,
        durationMs: output.durationMs,
        finishedAt: at,
        updatedAt: at,
        tracking: false,
      };
      this.store.upsert(turn);
      return { status: 200, turn, waitTimedOut: false, replayed: false };
    }

    const base = this.newRecord(result.sessionId, result.userTurnId, input.workspace ?? null, submittedAt);
    if (WAIT_TIMEOUT_PATTERN.test(result.message)) {
      // `--wait` timing out does not cancel the turn; keep following it.
      this.store.upsert(base);
      this.tracker.track(base);
      return { status: 202, turn: base, waitTimedOut: true, replayed: false };
    }
    const canceled = result.message === WAIT_CANCELED_MESSAGE;
    const at = new Date(this.now()).toISOString();
    const turn: TurnRecord = {
      ...base,
      state: canceled ? 'canceled' : 'failed',
      errorCode: canceled ? 'turn_canceled' : 'turn_failed',
      errorMessage: canceled ? 'The turn was canceled.' : result.message,
      finishedAt: at,
      updatedAt: at,
      tracking: false,
    };
    this.store.upsert(turn);
    return { status: 200, turn, waitTimedOut: false, replayed: false };
  }

  async getTurn(input: GetTurnInput): Promise<TurnRecord> {
    let turn = this.store.get(input.sessionId, input.turnId) ?? (await this.discover(input));
    if (!isTerminal(turn.state) && input.waitSeconds > 0) {
      await this.tracker.waitForTerminal(input.sessionId, input.turnId, input.waitSeconds * 1000);
      turn = this.store.get(input.sessionId, input.turnId) ?? turn;
    }
    if (turn.state === 'completed' && turn.replyText === null && turn.assistantTurnId) {
      const replyText = await this.tracker
        .fetchReplyText(turn.sessionId, turn.workspace, turn.assistantTurnId)
        .catch(() => null);
      if (replyText !== null) {
        turn = { ...turn, replyText, updatedAt: new Date(this.now()).toISOString() };
        this.store.upsert(turn);
      }
    }
    return turn;
  }

  /**
   * A turn this server did not send (or sent before its store was lost). The CLI
   * only exposes the latest and the active turns of a session, so older turns
   * are reported as `unknown` once their user entry is confirmed in history.
   */
  private async discover(input: GetTurnInput): Promise<TurnRecord> {
    const snapshot = await this.client.observeSnapshot(input.sessionId, input.workspace);
    const { session } = snapshot;
    const observed: ObservedTurn | undefined =
      session.activeTurns.find((turn) => turn.userTurnId === input.turnId) ??
      (session.latestTurn?.userTurnId === input.turnId ? session.latestTurn : undefined);
    const at = new Date(this.now()).toISOString();
    const base = this.newRecord(input.sessionId, input.turnId, snapshot.workspaceId, at);

    if (!observed) {
      const history = await this.client.history(input.sessionId, snapshot.workspaceId, { all: true });
      if (!history.entries.some((entry) => entry.id === input.turnId && entry.role === 'user')) {
        throw new ApiError(404, 'turn_not_found', `Turn not found in session ${input.sessionId}: ${input.turnId}`);
      }
      const turn: TurnRecord = {
        ...base,
        state: 'unknown',
        errorCode: 'outcome_unavailable',
        errorMessage: 'The lody CLI only reports outcomes for the latest and active turns of a session.',
        tracking: false,
      };
      this.store.upsert(turn);
      return turn;
    }

    const assistantTurnId = observed.assistantTurnId ?? null;
    if (observed.state === 'pending' || observed.state === 'running' || observed.state === 'unknown') {
      const turn: TurnRecord = { ...base, state: observed.state === 'running' ? 'running' : 'pending', assistantTurnId };
      this.store.upsert(turn);
      this.tracker.track(turn);
      return turn;
    }

    const replyText =
      observed.state === 'completed' && assistantTurnId
        ? await this.tracker.fetchReplyText(input.sessionId, snapshot.workspaceId, assistantTurnId).catch(() => null)
        : null;
    const turn: TurnRecord = {
      ...base,
      state: observed.state,
      assistantTurnId,
      replyText,
      durationMs: observed.durationMs ?? null,
      errorCode: observed.state === 'failed' ? 'turn_failed' : observed.state === 'canceled' ? 'turn_canceled' : null,
      errorMessage:
        observed.state === 'failed'
          ? ASYNC_FAILURE_MESSAGE
          : observed.state === 'canceled'
            ? 'The turn was canceled.'
            : null,
      finishedAt: at,
      tracking: false,
    };
    this.store.upsert(turn);
    return turn;
  }

  private newRecord(sessionId: string, turnId: string, workspace: string | null, submittedAt: string): TurnRecord {
    return {
      sessionId,
      turnId,
      workspace,
      state: 'pending',
      assistantTurnId: null,
      replyText: null,
      replyContent: null,
      errorCode: null,
      errorMessage: null,
      durationMs: null,
      submittedAt,
      finishedAt: null,
      updatedAt: submittedAt,
      tracking: true,
    };
  }
}

function requestHash(input: SendMessageInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.sessionId, input.workspace ?? null, input.prompt]))
    .digest('hex');
}
