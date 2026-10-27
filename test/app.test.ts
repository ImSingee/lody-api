import { describe, expect, it, vi } from 'vitest';
import { LodyCliError } from '../src/errors.js';
import { createApp } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import { SessionDetailService } from '../src/sessions/detail-service.js';
import { SessionListService } from '../src/sessions/list-service.js';
import { MessageService } from '../src/turns/message-service.js';
import { memoryStore, observed } from './helpers.js';

const KEY = 'test-key-0123456789abcdef';
const auth = { authorization: `Bearer ${KEY}` };

function setup() {
  const client = {
    listSessions: vi.fn(async () => ({
      workspaceId: 'w1',
      sessions: [
        { id: 's2', createdAt: '2026-10-02T00:00:00Z', pullRequests: [{ url: 'https://github.com/o/r/pull/7', status: 'open' }] },
        { id: 's1', createdAt: '2026-10-01T00:00:00Z' },
      ],
    })),
    showSession: vi.fn(async (id: string) => ({
      ok: true as const,
      workspace: { id: 'w1', slug: 'team' },
      session: { id, createdAt: '2026-10-01T00:00:00Z', title: 'Fix it' },
      historyCount: 4,
      messageQueueCount: 0,
    })),
    sessionStatus: vi.fn(async (id: string) => ({
      ok: true as const,
      workspace: { id: 'w1' },
      sessionId: id,
      machineOnline: true,
      liveStatus: { state: 'idle', source: 'machine' },
    })),
    chat: vi.fn(async () => ({ ok: true as const, sessionId: 's1', workspaceId: 'w1', machineId: 'm1', userTurnId: 'u1' })),
    chatAndWait: vi.fn(),
    observeSnapshot: vi.fn(async () => ({ workspaceId: 'w1', session: observed() })),
    history: vi.fn(async () => ({ ok: true as const, workspaceId: 'w1', sessionId: 's1', entries: [] })),
  };
  const store = memoryStore();
  const tracker = { track: vi.fn(), waitForTerminal: vi.fn(async () => {}), fetchReplyText: vi.fn(async () => 'pong') };
  const readiness = { check: vi.fn(async () => ({ ready: true as const, checkedAt: 'now', workspaces: [] })) };
  const app = createApp({
    apiKeys: [KEY, 'second-key-0123456789'],
    defaultWorkspace: 'team',
    sessions: new SessionListService(client, { ttlMs: 0, maxEntries: 4 }),
    details: new SessionDetailService(client),
    messages: new MessageService(client, store, tracker),
    readiness,
    limits: { syncWaitDefaultSeconds: 120, syncWaitMaxSeconds: 300, pollMaxWaitSeconds: 60 },
    logger: silentLogger,
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
  return { app, client, readiness, request, store };
}

describe('auth', () => {
  it('health checks need no key', async () => {
    const { app, readiness } = setup();
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/readyz')).status).toBe(200);
    readiness.check.mockResolvedValueOnce({
      ready: false,
      checkedAt: 'now',
      error: { code: 'lody_auth_failed', message: 'x' },
    } as never);
    expect((await app.request('/readyz')).status).toBe(503);
  });

  it.each([
    ['no header', {}],
    ['wrong key', { authorization: 'Bearer nope' }],
    ['wrong scheme', { authorization: `Basic ${KEY}` }],
  ])('rejects %s with 401', async (_label, headers) => {
    const { app } = setup();
    const res = await app.request('/v1/sessions', { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing or invalid API key.', retryable: false } });
  });

  it('accepts any configured key', async () => {
    const { app } = setup();
    const res = await app.request('/v1/sessions', { headers: { authorization: 'bearer second-key-0123456789' } });
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/sessions', () => {
  it('passes filters through and pages raw SessionMeta', async () => {
    const { request, client } = setup();
    const res = await request('/v1/sessions?all=true&query=fix&machineId=m1&agentConfigId=ac&agentRoleId=r&openedBy=p&limit=1');
    expect(res.status).toBe(200);
    expect(client.listSessions).toHaveBeenCalledWith('team', {
      all: true,
      archived: undefined,
      openedBy: 'p',
      query: 'fix',
      machineId: 'm1',
      agentConfigId: 'ac',
      agentRoleId: 'r',
    });
    const body = (await res.json()) as {
      sessions: unknown[];
      pageInfo: { hasMore: boolean; nextCursor: string };
      workspaceId: string;
    };
    expect(body.workspaceId).toBe('w1');
    expect(body.sessions).toEqual([
      { id: 's2', createdAt: '2026-10-02T00:00:00Z', pullRequests: [{ url: 'https://github.com/o/r/pull/7', status: 'open' }] },
    ]);
    expect(body.pageInfo.hasMore).toBe(true);

    const next = await request(
      `/v1/sessions?all=true&query=fix&machineId=m1&agentConfigId=ac&agentRoleId=r&openedBy=p&limit=1&cursor=${body.pageInfo.nextCursor}`
    );
    expect(((await next.json()) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('lets the request override the default workspace', async () => {
    const { request, client } = setup();
    await request('/v1/sessions?workspace=other');
    expect(client.listSessions).toHaveBeenCalledWith('other', expect.anything());
  });

  it.each([
    ['unknown parameter', '/v1/sessions?pr=https://github.com/o/r/pull/1', /unknown parameter\(s\): pr/],
    ['bad boolean', '/v1/sessions?archived=yes', /archived/],
    ['limit too large', '/v1/sessions?limit=201', /limit/],
    ['limit zero', '/v1/sessions?limit=0', /limit/],
    ['bad sort', '/v1/sessions?sort=title', /sort/],
    ['archived with all', '/v1/sessions?archived=1&all=1', /archived or all/],
  ])('400 on %s', async (_label, path, message) => {
    const res = await setup().request(path);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(message);
  });

  it('maps CLI failures to HTTP errors', async () => {
    const { request, client } = setup();
    client.listSessions.mockRejectedValueOnce(
      new LodyCliError('Multiple workspaces are available; pass --workspace. Candidates: a, b', 1)
    );
    const res = await request('/v1/sessions');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_required');
  });
});

describe('GET /v1/sessions/:id', () => {
  it('returns show output', async () => {
    const { request, client } = setup();
    const res = await request('/v1/sessions/s1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: { id: 'w1', slug: 'team' },
      session: { id: 's1', createdAt: '2026-10-01T00:00:00Z', title: 'Fix it' },
      historyCount: 4,
      latestHistoryAt: null,
      messageQueueCount: 0,
    });
    expect(client.sessionStatus).not.toHaveBeenCalled();
  });

  it('adds live status on request, and reports a failed probe beside the metadata', async () => {
    const { request, client } = setup();
    const live = (await (await request('/v1/sessions/s1?live=true')).json()) as Record<string, unknown>;
    expect(live.live).toEqual({ machineOnline: true, liveStatus: { state: 'idle', source: 'machine' } });

    client.sessionStatus.mockRejectedValueOnce(new LodyCliError('Machine m1 is offline or unreachable: x', 1));
    const res = await request('/v1/sessions/s1?live=1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { liveError: unknown }).liveError).toEqual({
      code: 'machine_offline',
      message: 'Machine m1 is offline or unreachable: x',
      retryable: true,
    });
  });

  it('404s an unknown session and 400s an invalid id', async () => {
    const { request, client } = setup();
    client.showSession.mockRejectedValueOnce(new LodyCliError('Session not found: nope', 1));
    expect((await request('/v1/sessions/nope')).status).toBe(404);
    expect((await request('/v1/sessions/-rf')).status).toBe(400);
  });
});

describe('POST /v1/sessions/:id/messages', () => {
  const post = (r: ReturnType<typeof setup>['request'], body: unknown, headers: Record<string, string> = {}) =>
    r('/v1/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('async send answers 202 with a Location for the turn', async () => {
    const { request } = setup();
    const res = await post(request, { prompt: 'hi' });
    expect(res.status).toBe(202);
    expect(res.headers.get('location')).toBe('/v1/sessions/s1/turns/u1');
    const body = (await res.json()) as { turn: Record<string, unknown>; waitTimedOut: boolean; replayed: boolean };
    expect(body).toMatchObject({ waitTimedOut: false, replayed: false });
    expect(body.turn).toMatchObject({ id: 'u1', sessionId: 's1', state: 'pending', reply: null, error: null });
  });

  it('sync send answers 200 with the reply', async () => {
    const { request, client } = setup();
    client.chatAndWait.mockResolvedValueOnce({
      kind: 'completed',
      output: {
        ok: true,
        sessionId: 's1',
        workspaceId: 'w1',
        machineId: 'm1',
        userTurnId: 'u1',
        turnId: 'a1',
        content: [{ type: 'text', text: 'pong' }],
        durationMs: 10,
      },
    });
    const res = await post(request, { prompt: 'hi', wait: true, timeoutSeconds: 60 });
    expect(res.status).toBe(200);
    expect(client.chatAndWait).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 60, workspace: 'team' }));
    const body = (await res.json()) as { turn: Record<string, unknown> };
    expect(body.turn).toMatchObject({
      state: 'completed',
      reply: { text: 'pong', content: [{ type: 'text', text: 'pong' }] },
      durationMs: 10,
    });
  });

  it('uses the default sync timeout', async () => {
    const { request, client } = setup();
    client.chatAndWait.mockResolvedValueOnce({ kind: 'wait_failed', sessionId: 's1', userTurnId: 'u1', message: 'x' });
    await post(request, { prompt: 'hi', wait: true });
    expect(client.chatAndWait).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 120 }));
  });

  it.each([
    ['archived', 'Session s1 is archived. Restore it before chatting.', 409, 'session_archived'],
    ['machine offline', 'Machine m1 is offline or unreachable: timeout', 503, 'machine_offline'],
    ['missing session', 'Session not found: s1', 404, 'session_not_found'],
  ])('maps %s', async (_label, message, status, code) => {
    const { request, client } = setup();
    client.chat.mockRejectedValueOnce(new LodyCliError(message, 1));
    const res = await post(request, { prompt: 'hi' });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it.each([
    ['not JSON', 'nope', 'invalid_json'],
    ['missing prompt', {}, 'invalid_request'],
    ['empty prompt', { prompt: '' }, 'invalid_request'],
    ['timeout above max', { prompt: 'x', wait: true, timeoutSeconds: 301 }, 'invalid_request'],
    ['unknown field', { prompt: 'x', model: 'gpt' }, 'invalid_request'],
  ])('400 on %s', async (_label, body, code) => {
    const res = await post(setup().request, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it('rejects a body over the size limit', async () => {
    const res = await post(setup().request, { prompt: 'x'.repeat(500_000) });
    expect(res.status).toBe(413);
  });

  it('validates and honours Idempotency-Key', async () => {
    const { request, client } = setup();
    expect((await post(request, { prompt: 'hi' }, { 'idempotency-key': 'bad key' })).status).toBe(400);
    const first = await post(request, { prompt: 'hi' }, { 'idempotency-key': 'k-1' });
    const second = await post(request, { prompt: 'hi' }, { 'idempotency-key': 'k-1' });
    expect(first.status).toBe(202);
    expect(((await second.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect((await post(request, { prompt: 'different' }, { 'idempotency-key': 'k-1' })).status).toBe(422);
  });
});

describe('GET /v1/sessions/:id/turns/:turnId', () => {
  it('returns a stored turn', async () => {
    const { request } = setup();
    await request('/v1/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    const res = await request('/v1/sessions/s1/turns/u1?waitSeconds=0');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { turn: { id: string; state: string } }).turn).toMatchObject({ id: 'u1', state: 'pending' });
  });

  it('validates waitSeconds against the configured maximum', async () => {
    expect((await setup().request('/v1/sessions/s1/turns/u1?waitSeconds=61')).status).toBe(400);
  });

  it('404s an unknown turn', async () => {
    const res = await setup().request('/v1/sessions/s1/turns/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('turn_not_found');
  });
});

describe('fallbacks', () => {
  it('404s unknown routes as JSON', async () => {
    const res = await setup().request('/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('hides unexpected errors behind 500', async () => {
    const { request, client } = setup();
    client.showSession.mockRejectedValueOnce(new Error('secret internals'));
    const res = await request('/v1/sessions/s1');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  it('echoes a valid X-Request-Id', async () => {
    const res = await setup().request('/v1/sessions', { headers: { 'x-request-id': 'req-123' } });
    expect(res.headers.get('x-request-id')).toBe('req-123');
  });
});
