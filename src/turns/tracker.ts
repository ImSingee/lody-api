import { EventEmitter } from 'node:events';
import type { LodyClient } from '../lody/client.js';
import type { StreamHandle } from '../lody/runner.js';
import type { ObserveEvent, ObservedSession } from '../lody/schemas.js';
import { silentLogger, type Logger } from '../logger.js';
import type { TurnStore } from './store.js';
import { isTerminal, type TurnRecord, type TurnState } from './types.js';

export type TurnTrackerOptions = {
  maxObservers: number;
  /** Turns older than this stop being tracked and end as `unknown`. */
  maxAgeMs: number;
  /**
   * A turn missing from both `activeTurns` and `latestTurn` of a synced snapshot
   * has finished with an outcome the CLI no longer exposes. Before this grace the
   * absence may just be sync lag right after dispatch.
   */
  missingGraceMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  logger?: Logger;
};

type Watch = {
  sessionId: string;
  workspace: string | null;
  turnIds: Set<string>;
  handle?: StreamHandle;
  restartTimer?: NodeJS.Timeout;
  failures: number;
  stopping: boolean;
};

type Finish = {
  state: Extract<TurnState, 'completed' | 'failed' | 'canceled' | 'unknown'>;
  assistantTurnId?: string | undefined;
  durationMs?: number | undefined;
  errorCode?: string;
  errorMessage?: string;
};

const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

export const ASYNC_FAILURE_MESSAGE =
  'The agent turn failed. The lody CLI only reports the failure reason to a waiting caller (wait=true).';

/**
 * Follows unfinished turns with one `lody session observe --jsonl --follow`
 * per session and records their outcome in the store. Observers stop when a
 * session has no unfinished turns; `resume()` restarts them after a restart.
 */
export class TurnTracker {
  private readonly watches = new Map<string, Watch>();
  private readonly waiting: string[] = [];
  private readonly events = new EventEmitter();
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly missingGraceMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;
  private running = 0;
  private closed = false;

  constructor(
    private readonly client: Pick<LodyClient, 'observeFollow' | 'history'>,
    private readonly store: TurnStore,
    private readonly options: TurnTrackerOptions
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.missingGraceMs = options.missingGraceMs ?? 60_000;
    this.events.setMaxListeners(0);
    const sweepInterval = options.sweepIntervalMs ?? 60_000;
    if (sweepInterval > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), sweepInterval);
      this.sweepTimer.unref();
    }
  }

  /** Starts following a persisted, unfinished turn. */
  track(record: TurnRecord): void {
    if (this.closed || isTerminal(record.state)) return;
    let watch = this.watches.get(record.sessionId);
    if (!watch) {
      watch = {
        sessionId: record.sessionId,
        workspace: record.workspace,
        turnIds: new Set(),
        failures: 0,
        stopping: false,
      };
      this.watches.set(record.sessionId, watch);
    }
    watch.turnIds.add(record.turnId);
    if (!watch.handle && !watch.restartTimer && !this.waiting.includes(watch.sessionId)) {
      this.startObserver(watch);
    }
  }

  resume(): number {
    const records = this.store.listTracking();
    for (const record of records) this.track(record);
    return records.length;
  }

  /** Resolves when the turn is terminal or the timeout elapses, whichever comes first. */
  async waitForTerminal(sessionId: string, turnId: string, timeoutMs: number): Promise<void> {
    const key = eventKey(sessionId, turnId);
    const done = () => {
      const record = this.store.get(sessionId, turnId);
      return !record || isTerminal(record.state);
    };
    if (done() || timeoutMs <= 0) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.events.off(key, onChange);
        resolve();
      };
      const onChange = () => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.events.on(key, onChange);
    });
  }

  /** Visible text of an assistant entry: the same last-visible-item rule the CLI prints. */
  async fetchReplyText(sessionId: string, workspace: string | null, assistantTurnId: string): Promise<string | null> {
    const ws = workspace ?? undefined;
    const recent = await this.client.history(sessionId, ws, { limit: 50 });
    const hit = recent.entries.find((entry) => entry.id === assistantTurnId);
    if (hit) return hit.text;
    const full = await this.client.history(sessionId, ws, { all: true });
    return full.entries.find((entry) => entry.id === assistantTurnId)?.text ?? null;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const stops: Promise<void>[] = [];
    for (const watch of this.watches.values()) {
      watch.stopping = true;
      if (watch.restartTimer) clearTimeout(watch.restartTimer);
      if (watch.handle) stops.push(watch.handle.stop());
    }
    this.waiting.length = 0;
    await Promise.all(stops);
  }

  get observerCount(): number {
    return this.running;
  }

  private startObserver(watch: Watch): void {
    if (this.closed || watch.stopping) return;
    if (this.running >= this.options.maxObservers) {
      if (!this.waiting.includes(watch.sessionId)) this.waiting.push(watch.sessionId);
      return;
    }
    this.running += 1;
    const log = this.logger.child({ sessionId: watch.sessionId });
    log.debug('observer starting', { turns: watch.turnIds.size });
    const handle = this.client.observeFollow(watch.sessionId, watch.workspace ?? undefined, (event) => {
      void this.onEvent(watch, event).catch((error: unknown) => log.error('observer event failed', { error }));
    });
    watch.handle = handle;
    void handle.exited.then((exit) => {
      this.running -= 1;
      watch.handle = undefined;
      this.drainWaiting();
      if (watch.stopping || this.closed) return;
      if (watch.turnIds.size === 0) {
        this.watches.delete(watch.sessionId);
        return;
      }
      const delay = RESTART_BACKOFF_MS[Math.min(watch.failures, RESTART_BACKOFF_MS.length - 1)] ?? 60_000;
      watch.failures += 1;
      log.warn('observer exited; restarting', {
        exitCode: exit.exitCode,
        signal: exit.signal,
        delayMs: delay,
        stderr: exit.stderr.slice(-500),
      });
      watch.restartTimer = setTimeout(() => {
        watch.restartTimer = undefined;
        this.startObserver(watch);
      }, delay);
      watch.restartTimer.unref();
    });
  }

  private drainWaiting(): void {
    while (this.running < this.options.maxObservers && this.waiting.length > 0) {
      const sessionId = this.waiting.shift();
      const watch = sessionId ? this.watches.get(sessionId) : undefined;
      if (watch && watch.turnIds.size > 0 && !watch.handle) this.startObserver(watch);
    }
  }

  private async onEvent(watch: Watch, event: ObserveEvent): Promise<void> {
    switch (event.type) {
      case 'snapshot':
      case 'session.changed':
        watch.failures = 0;
        await this.applySnapshot(watch, event.session);
        return;
      case 'turn.started':
        if (watch.turnIds.has(event.userTurnId)) {
          this.update(watch.sessionId, event.userTurnId, {
            state: 'running',
            ...(event.assistantTurnId ? { assistantTurnId: event.assistantTurnId } : {}),
          });
        }
        return;
      case 'turn.finished':
        if (watch.turnIds.has(event.userTurnId)) {
          await this.finish(watch, event.userTurnId, {
            state: event.outcome,
            assistantTurnId: event.assistantTurnId,
            durationMs: event.durationMs,
          });
        }
        return;
      case 'session.removed':
        for (const turnId of [...watch.turnIds]) {
          await this.finish(watch, turnId, {
            state: 'unknown',
            errorCode: 'session_removed',
            errorMessage: 'The session was deleted before the turn finished.',
          });
        }
        return;
      case 'error':
        this.logger.warn('observer reported error', { sessionId: watch.sessionId, error: event.error });
        return;
      case 'ready':
        return;
    }
  }

  private async applySnapshot(watch: Watch, session: ObservedSession): Promise<void> {
    for (const turnId of [...watch.turnIds]) {
      const active = session.activeTurns.find((turn) => turn.userTurnId === turnId);
      const latest = session.latestTurn?.userTurnId === turnId ? session.latestTurn : undefined;
      const observed = active ?? latest;
      if (observed) {
        if (observed.state === 'completed' || observed.state === 'failed' || observed.state === 'canceled') {
          await this.finish(watch, turnId, {
            state: observed.state,
            assistantTurnId: observed.assistantTurnId,
            durationMs: observed.durationMs,
          });
        } else if (observed.state === 'pending' || observed.state === 'running') {
          this.update(watch.sessionId, turnId, {
            state: observed.state,
            ...(observed.assistantTurnId ? { assistantTurnId: observed.assistantTurnId } : {}),
          });
        }
        continue;
      }
      const record = this.store.get(watch.sessionId, turnId);
      const age = record ? this.now() - Date.parse(record.submittedAt) : Infinity;
      if (session.freshness === 'synced' && age > this.missingGraceMs) {
        await this.finish(watch, turnId, {
          state: 'unknown',
          errorCode: 'outcome_unavailable',
          errorMessage: 'The turn finished, but a newer turn replaced it before its outcome was observed.',
        });
      }
    }
  }

  private update(sessionId: string, turnId: string, patch: Partial<TurnRecord>): void {
    const record = this.store.get(sessionId, turnId);
    if (!record || isTerminal(record.state)) return;
    const next = { ...record, ...patch, updatedAt: new Date(this.now()).toISOString() };
    if (next.state === record.state && next.assistantTurnId === record.assistantTurnId) return;
    this.store.upsert(next);
    this.events.emit(eventKey(sessionId, turnId));
  }

  private async finish(watch: Watch, turnId: string, result: Finish): Promise<void> {
    if (!watch.turnIds.delete(turnId)) return;
    const record = this.store.get(watch.sessionId, turnId);
    if (record && !isTerminal(record.state)) {
      const assistantTurnId = result.assistantTurnId ?? record.assistantTurnId;
      let replyText: string | null = null;
      if (result.state === 'completed' && assistantTurnId) {
        replyText = await this.fetchReplyText(watch.sessionId, record.workspace, assistantTurnId).catch(
          (error: unknown) => {
            this.logger.warn('reply fetch failed; it will be retried on read', { sessionId: watch.sessionId, error });
            return null;
          }
        );
      }
      const errorCode =
        result.errorCode ??
        (result.state === 'failed' ? 'turn_failed' : result.state === 'canceled' ? 'turn_canceled' : null);
      const errorMessage =
        result.errorMessage ??
        (result.state === 'failed'
          ? ASYNC_FAILURE_MESSAGE
          : result.state === 'canceled'
            ? 'The turn was canceled.'
            : null);
      const at = new Date(this.now()).toISOString();
      this.store.upsert({
        ...record,
        state: result.state,
        assistantTurnId,
        replyText,
        errorCode,
        errorMessage,
        durationMs: result.durationMs ?? record.durationMs,
        finishedAt: at,
        updatedAt: at,
        tracking: false,
      });
      this.events.emit(eventKey(watch.sessionId, turnId));
    }
    if (watch.turnIds.size === 0) this.release(watch);
  }

  private release(watch: Watch): void {
    watch.stopping = true;
    if (watch.restartTimer) clearTimeout(watch.restartTimer);
    this.watches.delete(watch.sessionId);
    const index = this.waiting.indexOf(watch.sessionId);
    if (index >= 0) this.waiting.splice(index, 1);
    void watch.handle?.stop();
  }

  private async sweep(): Promise<void> {
    const cutoff = this.now() - this.options.maxAgeMs;
    for (const watch of [...this.watches.values()]) {
      for (const turnId of [...watch.turnIds]) {
        const record = this.store.get(watch.sessionId, turnId);
        if (!record || Date.parse(record.submittedAt) < cutoff) {
          await this.finish(watch, turnId, {
            state: 'unknown',
            errorCode: 'tracking_expired',
            errorMessage: 'The turn did not finish within the tracking window.',
          });
        }
      }
    }
  }
}

function eventKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}
