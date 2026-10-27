import { describe, expect, it, vi } from 'vitest';
import { ApiError, LodyCliError } from '../src/errors.js';
import type { ChatWaitResult } from '../src/lody/client.js';
import { MessageService } from '../src/turns/message-service.js';
import { ASYNC_FAILURE_MESSAGE } from '../src/turns/tracker.js';
import type { TurnRecord } from '../src/turns/types.js';
import { memoryStore, observed, record } from './helpers.js';

const NOW = Date.parse('2026-10-27T08:00:00.000Z');

function setup() {
  const store = memoryStore();
  const client = {
    chat: vi.fn(async (input: { sessionId: string }) => ({
      ok: true as const,
      sessionId: input.sessionId,
      workspaceId: 'w1',
      machineId: 'm1',
      userTurnId: 'u1',
    })),
    chatAndWait: vi.fn(
      async (): Promise<ChatWaitResult> => ({
        kind: 'completed',
        output: {
          ok: true,
          sessionId: 's1',
          workspaceId: 'w1',
          machineId: 'm1',
          userTurnId: 'u1',
          turnId: 'a1',
          content: [{ type: 'text', text: 'pong' }],
          durationMs: 1234,
        },
      })
    ),
    observeSnapshot: vi.fn(async () => ({ workspaceId: 'w1', session: observed() })),
    history: vi.fn(async () => ({
      ok: true as const,
      workspaceId: 'w1',
      sessionId: 's1',
      entries: [] as Array<{ index: number; id: string; role: string; timestamp: string; text: string }>,
    })),
  };
  const tracked: TurnRecord[] = [];
  const tracker = {
    track: vi.fn((r: TurnRecord) => void tracked.push(r)),
    waitForTerminal: vi.fn(async () => {}),
    fetchReplyText: vi.fn(async () => 'pong'),
  };
  const service = new MessageService(client, store, tracker, { now: () => NOW });
  return { store, client, tracker, tracked, service };
}

const send = (overrides: Partial<Parameters<MessageService['send']>[0]> = {}) => ({
  sessionId: 's1',
  workspace: 'team',
  prompt: 'ping',
  wait: false,
  timeoutSeconds: 120,
  ...overrides,
});

describe('MessageService.send', () => {
  it('async: dispatches, persists a pending turn and starts tracking', async () => {
    const { service, store, tracked, client } = setup();
    const result = await service.send(send());
    expect(result).toMatchObject({ status: 202, waitTimedOut: false, replayed: false });
    expect(result.turn).toMatchObject({ sessionId: 's1', turnId: 'u1', workspace: 'w1', state: 'pending', tracking: true });
    expect(store.get('s1', 'u1')?.state).toBe('pending');
    expect(tracked).toHaveLength(1);
    expect(client.chat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', workspace: 'team', prompt: 'ping' }));
  });

  it('sync: returns the completed turn with reply text and raw content', async () => {
    const { service, store, tracker, client } = setup();
    const result = await service.send(send({ wait: true, timeoutSeconds: 30 }));
    expect(client.chatAndWait).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 30 }));
    expect(tracker.fetchReplyText).toHaveBeenCalledWith('s1', 'w1', 'a1');
    expect(result.status).toBe(200);
    expect(result.turn).toMatchObject({
      state: 'completed',
      assistantTurnId: 'a1',
      replyText: 'pong',
      replyContent: [{ type: 'text', text: 'pong' }],
      durationMs: 1234,
      tracking: false,
    });
    expect(store.get('s1', 'u1')?.state).toBe('completed');
  });

  it('sync: still returns the turn when the reply text lookup fails', async () => {
    const { service, tracker } = setup();
    tracker.fetchReplyText.mockRejectedValueOnce(new Error('history down'));
    const result = await service.send(send({ wait: true }));
    expect(result.turn).toMatchObject({ state: 'completed', replyText: null });
  });

  it('sync timeout: answers 202 and hands the turn to the tracker', async () => {
    const { service, client, tracked } = setup();
    client.chatAndWait.mockResolvedValueOnce({
      kind: 'wait_failed',
      sessionId: 's1',
      userTurnId: 'u1',
      message: 'Timed out waiting for session turn completion after 30s',
    });
    const result = await service.send(send({ wait: true, timeoutSeconds: 30 }));
    expect(result).toMatchObject({ status: 202, waitTimedOut: true });
    expect(result.turn).toMatchObject({ state: 'pending', tracking: true, workspace: 'team' });
    expect(tracked).toHaveLength(1);
  });

  it('sync failure: keeps the CLI failure reason', async () => {
    const { service, client } = setup();
    client.chatAndWait.mockResolvedValueOnce({
      kind: 'wait_failed',
      sessionId: 's1',
      userTurnId: 'u1',
      message: 'Claude Code authentication expired',
    });
    const result = await service.send(send({ wait: true }));
    expect(result.status).toBe(200);
    expect(result.turn).toMatchObject({
      state: 'failed',
      errorCode: 'turn_failed',
      errorMessage: 'Claude Code authentication expired',
      tracking: false,
    });
  });

  it('sync cancel: reports canceled', async () => {
    const { service, client } = setup();
    client.chatAndWait.mockResolvedValueOnce({
      kind: 'wait_failed',
      sessionId: 's1',
      userTurnId: 'u1',
      message: 'Session turn was canceled.',
    });
    expect((await service.send(send({ wait: true }))).turn).toMatchObject({ state: 'canceled', errorCode: 'turn_canceled' });
  });

  it('pre-dispatch CLI errors propagate and nothing is stored', async () => {
    const { service, client, store } = setup();
    client.chat.mockRejectedValueOnce(new LodyCliError('Machine m1 is offline or unreachable: timeout', 1));
    await expect(service.send(send({ idempotencyKey: 'k1' }))).rejects.toBeInstanceOf(LodyCliError);
    expect(store.get('s1', 'u1')).toBeUndefined();
    expect(store.getIdempotency('k1')).toBeUndefined();
  });

  it('rejects a blank prompt', async () => {
    await expect(setup().service.send(send({ prompt: '  \n ' }))).rejects.toMatchObject({ status: 400 });
  });

  describe('idempotency', () => {
    it('replays the same turn for a repeated key without sending again', async () => {
      const { service, client } = setup();
      const first = await service.send(send({ idempotencyKey: 'k1' }));
      const second = await service.send(send({ idempotencyKey: 'k1' }));
      expect(client.chat).toHaveBeenCalledTimes(1);
      expect(second).toMatchObject({ status: 202, replayed: true });
      expect(second.turn.turnId).toBe(first.turn.turnId);
    });

    it('replays a finished turn as 200', async () => {
      const { service, store } = setup();
      await service.send(send({ idempotencyKey: 'k1' }));
      store.upsert(record({ state: 'completed', tracking: false, submittedAt: new Date(NOW).toISOString() }));
      expect(await service.send(send({ idempotencyKey: 'k1' }))).toMatchObject({ status: 200, replayed: true });
    });

    it('a wait=true replay waits for the tracked turn', async () => {
      const { service, tracker } = setup();
      await service.send(send({ idempotencyKey: 'k1' }));
      const replay = await service.send(send({ idempotencyKey: 'k1', wait: true, timeoutSeconds: 5 }));
      expect(tracker.waitForTerminal).toHaveBeenCalledWith('s1', 'u1', 5_000);
      expect(replay).toMatchObject({ status: 202, waitTimedOut: true, replayed: true });
    });

    it('rejects a key reused for a different prompt or session', async () => {
      const { service } = setup();
      await service.send(send({ idempotencyKey: 'k1' }));
      await expect(service.send(send({ idempotencyKey: 'k1', prompt: 'other' }))).rejects.toMatchObject({
        status: 422,
        code: 'idempotency_key_reused',
      });
      await expect(service.send(send({ idempotencyKey: 'k1', sessionId: 's2' }))).rejects.toMatchObject({ status: 422 });
    });

    it('concurrent requests with one key dispatch once', async () => {
      const { service, client } = setup();
      let release!: () => void;
      client.chat.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ ok: true, sessionId: 's1', workspaceId: 'w1', machineId: 'm1', userTurnId: 'u1' });
          })
      );
      const a = service.send(send({ idempotencyKey: 'k1' }));
      const b = service.send(send({ idempotencyKey: 'k1' }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      const [ra, rb] = await Promise.all([a, b]);
      expect(client.chat).toHaveBeenCalledTimes(1);
      expect([ra.replayed, rb.replayed].sort()).toEqual([false, true]);
    });

    it('a failed attempt does not burn the key', async () => {
      const { service, client } = setup();
      client.chat.mockRejectedValueOnce(new LodyCliError('Machine m1 is offline or unavailable.', 1));
      await expect(service.send(send({ idempotencyKey: 'k1' }))).rejects.toBeInstanceOf(LodyCliError);
      await expect(service.send(send({ idempotencyKey: 'k1' }))).resolves.toMatchObject({ status: 202, replayed: false });
    });
  });
});

describe('MessageService.getTurn', () => {
  const get = (overrides: Partial<Parameters<MessageService['getTurn']>[0]> = {}) => ({
    sessionId: 's1',
    turnId: 'u1',
    workspace: 'team',
    waitSeconds: 0,
    ...overrides,
  });

  it('returns a stored turn, long-polling while it is unfinished', async () => {
    const { service, store, tracker } = setup();
    store.upsert(record());
    tracker.waitForTerminal.mockImplementationOnce(async () => {
      store.upsert(record({ state: 'completed', assistantTurnId: 'a1', replyText: 'done', tracking: false }));
    });
    const turn = await service.getTurn(get({ waitSeconds: 10 }));
    expect(tracker.waitForTerminal).toHaveBeenCalledWith('s1', 'u1', 10_000);
    expect(turn).toMatchObject({ state: 'completed', replyText: 'done' });
  });

  it('does not wait when waitSeconds is 0 or the turn is finished', async () => {
    const { service, store, tracker } = setup();
    store.upsert(record());
    await service.getTurn(get());
    store.upsert(record({ state: 'failed', tracking: false }));
    await service.getTurn(get({ waitSeconds: 30 }));
    expect(tracker.waitForTerminal).not.toHaveBeenCalled();
  });

  it('retries a missing reply text on read', async () => {
    const { service, store, tracker } = setup();
    store.upsert(record({ state: 'completed', assistantTurnId: 'a1', replyText: null, tracking: false }));
    tracker.fetchReplyText.mockResolvedValueOnce('late text');
    expect((await service.getTurn(get())).replyText).toBe('late text');
    expect(store.get('s1', 'u1')?.replyText).toBe('late text');
  });

  it('discovers an active turn it did not send and starts tracking it', async () => {
    const { service, client, tracked } = setup();
    client.observeSnapshot.mockResolvedValueOnce({
      workspaceId: 'w1',
      session: observed({ activeTurns: [{ userTurnId: 'u1', state: 'running', assistantTurnId: 'a1' }] }),
    });
    const turn = await service.getTurn(get());
    expect(turn).toMatchObject({ state: 'running', assistantTurnId: 'a1', workspace: 'w1', tracking: true });
    expect(tracked).toHaveLength(1);
  });

  it('discovers a finished latest turn with its reply', async () => {
    const { service, client } = setup();
    client.observeSnapshot.mockResolvedValueOnce({
      workspaceId: 'w1',
      session: observed({ latestTurn: { userTurnId: 'u1', state: 'completed', assistantTurnId: 'a1', durationMs: 7 } }),
    });
    expect(await service.getTurn(get())).toMatchObject({ state: 'completed', replyText: 'pong', durationMs: 7, tracking: false });
  });

  it('discovers a failed latest turn without a reason', async () => {
    const { service, client } = setup();
    client.observeSnapshot.mockResolvedValueOnce({
      workspaceId: 'w1',
      session: observed({ latestTurn: { userTurnId: 'u1', state: 'failed' } }),
    });
    expect(await service.getTurn(get())).toMatchObject({ state: 'failed', errorMessage: ASYNC_FAILURE_MESSAGE });
  });

  it('reports an older turn present in history as unknown', async () => {
    const { service, client } = setup();
    client.history.mockResolvedValueOnce({
      ok: true,
      workspaceId: 'w1',
      sessionId: 's1',
      entries: [{ index: 0, id: 'u1', role: 'user', timestamp: 't', text: 'hi' }],
    });
    expect(await service.getTurn(get())).toMatchObject({ state: 'unknown', errorCode: 'outcome_unavailable' });
  });

  it('404s a turn that does not exist', async () => {
    const { service } = setup();
    const error = await service.getTurn(get()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'turn_not_found' });
  });

  it('propagates session-level errors from discovery', async () => {
    const { service, client } = setup();
    client.observeSnapshot.mockRejectedValueOnce(new LodyCliError('Session not found: s1', 1));
    await expect(service.getTurn(get())).rejects.toMatchObject({ message: 'Session not found: s1' });
  });
});
