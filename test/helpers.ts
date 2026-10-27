import { vi } from 'vitest';
import type { StreamHandle } from '../src/lody/runner.js';
import type { ObserveEvent, ObservedSession, SessionHistoryOutput } from '../src/lody/schemas.js';
import { SqliteTurnStore } from '../src/turns/store.js';
import type { TurnRecord } from '../src/turns/types.js';

export type FakeObserver = {
  sessionId: string;
  workspace: string | undefined;
  emit(event: ObserveEvent): void;
  /** Simulates the observe process dying on its own. */
  crash(exitCode?: number): void;
  stopped: boolean;
};

/** A LodyClient stand-in whose observe streams are driven by the test. */
export function fakeObserveClient(history: Record<string, SessionHistoryOutput['entries']> = {}) {
  const observers: FakeObserver[] = [];
  const client = {
    observeFollow: vi.fn((sessionId: string, workspace: string | undefined, onEvent: (event: ObserveEvent) => void) => {
      let resolveExit!: (value: { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }) => void;
      const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }>(
        (resolve) => (resolveExit = resolve)
      );
      const observer: FakeObserver = {
        sessionId,
        workspace,
        stopped: false,
        emit: (event) => onEvent(event),
        crash: (exitCode = 1) => resolveExit({ exitCode, signal: null, stderr: 'boom' }),
      };
      observers.push(observer);
      const handle: StreamHandle = {
        pid: 1,
        exited,
        stop: async () => {
          observer.stopped = true;
          resolveExit({ exitCode: null, signal: 'SIGTERM', stderr: '' });
          await exited;
        },
      };
      return handle;
    }),
    history: vi.fn(async (sessionId: string, _workspace: string | undefined, _range: unknown) => ({
      ok: true as const,
      workspaceId: 'w1',
      sessionId,
      entries: history[sessionId] ?? [],
    })),
  };
  return { client, observers };
}

export function observed(partial: Partial<ObservedSession> = {}): ObservedSession {
  return {
    sessionId: 's1',
    machineId: 'm1',
    archived: false,
    state: 'idle',
    freshness: 'synced',
    activeTurns: [],
    ...partial,
  };
}

export function record(partial: Partial<TurnRecord> = {}): TurnRecord {
  const at = partial.submittedAt ?? new Date().toISOString();
  return {
    sessionId: 's1',
    turnId: 'u1',
    workspace: 'w1',
    state: 'pending',
    assistantTurnId: null,
    replyText: null,
    replyContent: null,
    errorCode: null,
    errorMessage: null,
    durationMs: null,
    submittedAt: at,
    finishedAt: null,
    updatedAt: at,
    tracking: true,
    ...partial,
  };
}

export function memoryStore() {
  return new SqliteTurnStore(':memory:');
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
