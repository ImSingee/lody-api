import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnTracker } from '../src/turns/tracker.js';
import { fakeObserveClient, flush, memoryStore, observed, record, until } from './helpers.js';

function setup(options: Partial<ConstructorParameters<typeof TurnTracker>[2]> = {}, history = {}) {
  const { client, observers } = fakeObserveClient(history);
  const store = memoryStore();
  const tracker = new TurnTracker(client, store, {
    maxObservers: 8,
    maxAgeMs: 60 * 60 * 1000,
    sweepIntervalMs: 0,
    ...options,
  });
  const begin = (partial: Parameters<typeof record>[0] = {}) => {
    const r = record(partial);
    store.upsert(r);
    tracker.track(r);
    return r;
  };
  return { client, observers, store, tracker, begin };
}

const ASSISTANT = { index: 1, id: 'a1', role: 'assistant', timestamp: '2026-10-01T00:00:00Z', text: 'pong' };

describe('TurnTracker', () => {
  afterEach(() => vi.useRealTimers());

  it('records a completed turn with the reply text from history and stops observing', async () => {
    const { observers, store, begin } = setup({}, { s1: [ASSISTANT] });
    begin();
    expect(observers).toHaveLength(1);
    expect(observers[0]?.workspace).toBe('w1');
    observers[0]?.emit({ type: 'turn.started', sessionId: 's1', userTurnId: 'u1', assistantTurnId: 'a1' });
    await flush();
    expect(store.get('s1', 'u1')?.state).toBe('running');
    observers[0]?.emit({
      type: 'turn.finished',
      sessionId: 's1',
      userTurnId: 'u1',
      assistantTurnId: 'a1',
      outcome: 'completed',
      durationMs: 1500,
    });
    await until(() => store.get('s1', 'u1')?.state === 'completed');
    expect(store.get('s1', 'u1')).toMatchObject({
      replyText: 'pong',
      assistantTurnId: 'a1',
      durationMs: 1500,
      tracking: false,
      errorCode: null,
    });
    expect(observers[0]?.stopped).toBe(true);
  });

  it('falls back to the full history when the reply is not in the recent window', async () => {
    const { client, observers, store, begin } = setup();
    client.history
      .mockResolvedValueOnce({ ok: true, workspaceId: 'w1', sessionId: 's1', entries: [] })
      .mockResolvedValueOnce({ ok: true, workspaceId: 'w1', sessionId: 's1', entries: [ASSISTANT] });
    begin();
    observers[0]?.emit({ type: 'turn.finished', sessionId: 's1', userTurnId: 'u1', assistantTurnId: 'a1', outcome: 'completed' });
    await until(() => store.get('s1', 'u1')?.state === 'completed');
    expect(store.get('s1', 'u1')?.replyText).toBe('pong');
    expect(client.history.mock.calls.map((call) => call[2])).toEqual([{ limit: 50 }, { all: true }]);
  });

  it('settles from the initial snapshot when the turn already finished', async () => {
    const { observers, store, begin } = setup({}, { s1: [ASSISTANT] });
    begin();
    observers[0]?.emit({
      type: 'snapshot',
      sessionId: 's1',
      session: observed({ latestTurn: { userTurnId: 'u1', assistantTurnId: 'a1', state: 'completed', durationMs: 9 } }),
    });
    await until(() => store.get('s1', 'u1')?.state === 'completed');
    expect(store.get('s1', 'u1')?.replyText).toBe('pong');
  });

  it('marks failed and canceled turns with error codes', async () => {
    const { observers, store, begin } = setup();
    begin({ turnId: 'u1' });
    begin({ turnId: 'u2' });
    observers[0]?.emit({ type: 'turn.finished', sessionId: 's1', userTurnId: 'u1', outcome: 'failed' });
    observers[0]?.emit({ type: 'turn.finished', sessionId: 's1', userTurnId: 'u2', outcome: 'canceled' });
    await until(() => store.listTracking().length === 0);
    expect(store.get('s1', 'u1')).toMatchObject({ state: 'failed', errorCode: 'turn_failed' });
    expect(store.get('s1', 'u2')).toMatchObject({ state: 'canceled', errorCode: 'turn_canceled' });
  });

  it('updates pending/running from snapshots and ignores turns it does not track', async () => {
    const { observers, store, begin } = setup();
    begin();
    observers[0]?.emit({
      type: 'session.changed',
      sessionId: 's1',
      session: observed({
        activeTurns: [
          { userTurnId: 'u1', state: 'running', assistantTurnId: 'a1' },
          { userTurnId: 'other', state: 'running' },
        ],
      }),
    });
    await flush();
    expect(store.get('s1', 'u1')).toMatchObject({ state: 'running', assistantTurnId: 'a1' });
    expect(store.get('s1', 'other')).toBeUndefined();
  });

  it('only gives up on a missing turn after the grace period on a synced snapshot', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const { observers, store, begin } = setup({ now: () => now, missingGraceMs: 60_000 });
    begin({ submittedAt: new Date(now).toISOString() });
    observers[0]?.emit({ type: 'snapshot', sessionId: 's1', session: observed() });
    await flush();
    expect(store.get('s1', 'u1')?.state).toBe('pending');
    now += 120_000;
    observers[0]?.emit({ type: 'session.changed', sessionId: 's1', session: observed({ freshness: 'unavailable' }) });
    await flush();
    expect(store.get('s1', 'u1')?.state).toBe('pending');
    observers[0]?.emit({ type: 'session.changed', sessionId: 's1', session: observed() });
    await until(() => store.get('s1', 'u1')?.state === 'unknown');
    expect(store.get('s1', 'u1')?.errorCode).toBe('outcome_unavailable');
  });

  it('ends every tracked turn when the session is removed', async () => {
    const { observers, store, begin } = setup();
    begin({ turnId: 'u1' });
    begin({ turnId: 'u2' });
    expect(observers).toHaveLength(1); // one observer per session
    observers[0]?.emit({ type: 'session.removed', sessionId: 's1' });
    await until(() => store.listTracking().length === 0);
    expect(store.get('s1', 'u2')).toMatchObject({ state: 'unknown', errorCode: 'session_removed' });
  });

  it('restarts an observer that exits while turns are pending', async () => {
    vi.useFakeTimers();
    const { observers, begin } = setup();
    begin();
    observers[0]?.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(observers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observers).toHaveLength(2);
    observers[1]?.crash();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(observers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(observers).toHaveLength(3);
  });

  it('queues sessions beyond maxObservers and starts them when a slot frees', async () => {
    const { observers, store, begin, tracker } = setup({ maxObservers: 1 });
    begin({ sessionId: 's1' });
    begin({ sessionId: 's2' });
    expect(observers.map((o) => o.sessionId)).toEqual(['s1']);
    expect(tracker.observerCount).toBe(1);
    observers[0]?.emit({ type: 'turn.finished', sessionId: 's1', userTurnId: 'u1', outcome: 'failed' });
    await until(() => observers.length === 2);
    expect(observers[1]?.sessionId).toBe('s2');
    expect(store.get('s1', 'u1')?.state).toBe('failed');
  });

  it('resumes tracked turns from the store', async () => {
    const { client } = fakeObserveClient();
    const persisted = memoryStore();
    persisted.upsert(record({ sessionId: 's1', turnId: 'u1' }));
    persisted.upsert(record({ sessionId: 's2', turnId: 'u2', state: 'running' }));
    persisted.upsert(record({ sessionId: 's3', turnId: 'u3', state: 'completed', tracking: false }));
    const tracker = new TurnTracker(client, persisted, { maxObservers: 8, maxAgeMs: 3_600_000, sweepIntervalMs: 0 });
    expect(tracker.resume()).toBe(2);
    expect(client.observeFollow.mock.calls.map((call) => call[0]).sort()).toEqual(['s1', 's2']);
  });

  it('waitForTerminal resolves on completion, or after the timeout', async () => {
    const { observers, store, begin, tracker } = setup();
    begin();
    const started = Date.now();
    await tracker.waitForTerminal('s1', 'u1', 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    const waiting = tracker.waitForTerminal('s1', 'u1', 5_000);
    observers[0]?.emit({ type: 'turn.finished', sessionId: 's1', userTurnId: 'u1', outcome: 'canceled' });
    await waiting;
    expect(store.get('s1', 'u1')?.state).toBe('canceled');
  });

  it('expires turns older than maxAge on sweep', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-01T00:00:00Z');
    vi.setSystemTime(now);
    const { store, begin } = setup({ maxAgeMs: 1_000, sweepIntervalMs: 500 });
    begin({ submittedAt: new Date(now).toISOString() });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.get('s1', 'u1')).toMatchObject({ state: 'unknown', errorCode: 'tracking_expired', tracking: false });
  });

  it('shutdown stops observers and ignores further tracking', async () => {
    const { observers, tracker, begin } = setup();
    begin();
    await tracker.shutdown();
    expect(observers[0]?.stopped).toBe(true);
    begin({ sessionId: 's9' });
    expect(observers).toHaveLength(1);
  });
});
