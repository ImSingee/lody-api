import { describe, expect, it, vi } from 'vitest';
import type { SessionListFilters } from '../src/lody/args.js';
import type { SessionMeta } from '../src/lody/schemas.js';
import { decodeCursor, encodeCursor, listFingerprint, type Cursor } from '../src/sessions/cursor.js';
import { SessionListService } from '../src/sessions/list-service.js';
import { compareKeys, indexAfter, orderKey, sortSessions } from '../src/sessions/order.js';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');

function session(id: string, createdOffsetMin: number, lastMessageAt?: number): SessionMeta {
  return {
    id,
    createdAt: new Date(T0 + createdOffsetMin * 60_000).toISOString(),
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
  };
}

const ids = (sessions: SessionMeta[]) => sessions.map((s) => s.id);

describe('ordering', () => {
  it('created: newest first, ties broken by id descending', () => {
    const sorted = sortSessions(
      [session('a', 1), session('c', 2), session('b', 2), session('d', 0)],
      'created'
    );
    expect(ids(sorted)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('activity: lastMessageAt, falling back to createdAt like the CLI', () => {
    const sorted = sortSessions(
      [session('old-but-active', 0, T0 + 99 * 60_000), session('new', 50), session('mid', 10, T0 + 20 * 60_000)],
      'activity'
    );
    expect(ids(sorted)).toEqual(['old-but-active', 'new', 'mid']);
  });

  it('unparseable or missing createdAt sorts as 0 (last), like the CLI', () => {
    const bad = { id: 'bad', createdAt: 'not a date' };
    const bare = { id: 'bare' }; // real workspaces contain id-only metadata
    expect(ids(sortSessions([bad, bare, session('a', 1)], 'created'))).toEqual(['a', 'bare', 'bad']);
    expect(orderKey(bad, 'created').k).toBe(0);
    expect(orderKey(bare, 'created').k).toBe(0);
    expect(orderKey(bare, 'activity').k).toBe(0);
    expect(orderKey({ id: 'x', lastMessageAt: 'soon' }, 'activity').k).toBe(0);
    expect(orderKey({ id: 'x', lastMessageAt: 1.5 }, 'activity').k).toBe(1.5);
  });

  it('pages through id-only sessions without losing them', async () => {
    const { client } = fakeClient([{ id: 'z' }, { id: 'y' }, session('a', 1)]);
    const { seen } = await walk(service(client), 1);
    expect(seen).toEqual(['a', 'z', 'y']);
  });

  it('compares ids by code unit, independent of locale', () => {
    expect(compareKeys({ k: 1, id: 'B' }, { k: 1, id: 'a' })).toBeGreaterThan(0); // 'a' > 'B' → 'a' first
    expect(compareKeys({ k: 1, id: 'x' }, { k: 1, id: 'x' })).toBe(0);
  });

  it('indexAfter finds the first item strictly after an anchor, even if the anchor is gone', () => {
    const sorted = sortSessions([session('e', 5), session('d', 4), session('b', 2), session('a', 1)], 'created');
    expect(indexAfter(sorted, 'created', orderKey(session('d', 4), 'created'))).toBe(2);
    // 'c' at minute 3 was deleted: continue from what would have followed it.
    expect(indexAfter(sorted, 'created', orderKey(session('c', 3), 'created'))).toBe(2);
    expect(indexAfter(sorted, 'created', { k: Number.MAX_SAFE_INTEGER, id: 'z' })).toBe(0);
    expect(indexAfter(sorted, 'created', orderKey(session('a', 1), 'created'))).toBe(4);
    expect(indexAfter([], 'created', { k: 1, id: 'x' })).toBe(0);
  });
});

describe('cursor', () => {
  const cursor: Cursor = { v: 1, s: 'created', k: 1_700_000_000_000, id: '11111111-2222', f: 'abc' };

  it('round-trips through an opaque base64url string', () => {
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'abc$%'],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['wrong version', Buffer.from(JSON.stringify({ ...cursor, v: 2 })).toString('base64url')],
    ['unknown sort', Buffer.from(JSON.stringify({ ...cursor, s: 'title' })).toString('base64url')],
    ['missing id', Buffer.from(JSON.stringify({ ...cursor, id: '' })).toString('base64url')],
    ['non-finite key', Buffer.from('{"v":1,"s":"created","k":"1","id":"a","f":"x"}').toString('base64url')],
    ['too long', 'a'.repeat(1025)],
  ])('rejects a cursor that is %s', (_label, raw) => {
    expect(() => decodeCursor(raw)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_cursor' }));
  });

  it('fingerprint changes with workspace, sort and every filter', () => {
    const base = listFingerprint('w1', {}, 'created');
    const variants: Array<[string, SessionListFilters, 'created' | 'activity']> = [
      ['w2', {}, 'created'],
      ['w1', {}, 'activity'],
      ['w1', { all: true }, 'created'],
      ['w1', { archived: true }, 'created'],
      ['w1', { openedBy: 'x' }, 'created'],
      ['w1', { query: 'x' }, 'created'],
      ['w1', { machineId: 'x' }, 'created'],
      ['w1', { agentConfigId: 'x' }, 'created'],
      ['w1', { agentRoleId: 'x' }, 'created'],
    ];
    for (const [workspace, filters, sort] of variants) {
      expect(listFingerprint(workspace, filters, sort)).not.toBe(base);
    }
    expect(listFingerprint('w1', { all: false }, 'created')).toBe(base);
  });
});

function fakeClient(initial: SessionMeta[]) {
  const state = { sessions: initial, calls: 0 };
  const client = {
    listSessions: vi.fn(async () => {
      state.calls += 1;
      return { workspaceId: 'w1', sessions: [...state.sessions] };
    }),
  };
  return { client, state };
}

function service(client: ReturnType<typeof fakeClient>['client'], clock = { t: 0 }, ttlMs = 15_000, maxEntries = 32) {
  return new SessionListService(client, { ttlMs, maxEntries, now: () => clock.t });
}

const many = (n: number) => Array.from({ length: n }, (_, i) => session(`s${String(i).padStart(3, '0')}`, i));

async function walk(svc: SessionListService, limit: number, sort: 'created' | 'activity' = 'created') {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await svc.page({ workspace: undefined, filters: {}, sort, limit, ...(cursor ? { cursor } : {}) });
    pages += 1;
    seen.push(...ids(page.sessions));
    if (!page.pageInfo.hasMore) {
      expect(page.pageInfo.nextCursor).toBeNull();
      return { seen, pages };
    }
    expect(page.pageInfo.nextCursor).toBeTypeOf('string');
    cursor = page.pageInfo.nextCursor ?? undefined;
  }
}

describe('SessionListService paging', () => {
  it('walks every session exactly once in order', async () => {
    const { client } = fakeClient(many(23));
    const { seen, pages } = await walk(service(client), 5);
    expect(pages).toBe(5);
    expect(seen).toEqual(ids(sortSessions(many(23), 'created')));
    expect(new Set(seen).size).toBe(23);
  });

  it('ends without a dangling cursor when the total is an exact multiple of the limit', async () => {
    const { client } = fakeClient(many(10));
    const svc = service(client);
    const first = await svc.page({ workspace: undefined, filters: {}, sort: 'created', limit: 5 });
    expect(first.pageInfo.hasMore).toBe(true);
    const second = await svc.page({
      workspace: undefined,
      filters: {},
      sort: 'created',
      limit: 5,
      cursor: first.pageInfo.nextCursor ?? '',
    });
    expect(second.sessions).toHaveLength(5);
    expect(second.pageInfo).toEqual({ limit: 5, hasMore: false, nextCursor: null });
  });

  it('handles empty lists and limits larger than the list', async () => {
    expect(
      (await service(fakeClient([]).client).page({ workspace: undefined, filters: {}, sort: 'created', limit: 50 }))
        .pageInfo
    ).toEqual({ limit: 50, hasMore: false, nextCursor: null });
    const page = await service(fakeClient(many(3)).client).page({
      workspace: undefined,
      filters: {},
      sort: 'created',
      limit: 200,
    });
    expect(page.sessions).toHaveLength(3);
    expect(page.snapshot.total).toBe(3);
  });

  it('uses one CLI call for a whole walk within the TTL', async () => {
    const { client } = fakeClient(many(40));
    await walk(service(client), 7);
    expect(client.listSessions).toHaveBeenCalledTimes(1);
  });

  it('created order: changes between snapshots neither skip nor repeat existing sessions', async () => {
    const { client, state } = fakeClient(many(10)); // s009 … s000
    const clock = { t: 0 };
    const svc = service(client, clock, 1_000);
    const first = await svc.page({ workspace: undefined, filters: {}, sort: 'created', limit: 4 });
    expect(ids(first.sessions)).toEqual(['s009', 's008', 's007', 's006']);

    // Before the next page: a new session, a deletion behind the cursor (s008),
    // a deletion of the anchor itself (s006), a deletion ahead (s003), and fresh
    // activity on s001, which would jump to the top in activity order.
    state.sessions = [
      session('s010', 10),
      ...many(10).filter((s) => !['s008', 's006', 's003'].includes(s.id)).map((s) =>
        s.id === 's001' ? { ...s, lastMessageAt: T0 + 999 * 60_000 } : s
      ),
    ];
    clock.t = 5_000; // TTL expired: next page reads a new snapshot

    const rest: string[] = [];
    let cursor = first.pageInfo.nextCursor ?? undefined;
    while (cursor) {
      const page = await svc.page({ workspace: undefined, filters: {}, sort: 'created', limit: 4, cursor });
      rest.push(...ids(page.sessions));
      cursor = page.pageInfo.nextCursor ?? undefined;
    }
    expect(rest).toEqual(['s005', 's004', 's002', 's001', 's000']);
    expect(client.listSessions).toHaveBeenCalledTimes(2);
  });

  it('activity order documents its known gap: a session that becomes active mid-walk is skipped', async () => {
    const { client, state } = fakeClient(many(6).map((s, i) => ({ ...s, lastMessageAt: T0 + i * 60_000 })));
    const clock = { t: 0 };
    const svc = service(client, clock, 1_000);
    const first = await svc.page({ workspace: undefined, filters: {}, sort: 'activity', limit: 3 });
    expect(ids(first.sessions)).toEqual(['s005', 's004', 's003']);
    state.sessions = state.sessions.map((s) => (s.id === 's000' ? { ...s, lastMessageAt: T0 + 999 * 60_000 } : s));
    clock.t = 5_000;
    const second = await svc.page({
      workspace: undefined,
      filters: {},
      sort: 'activity',
      limit: 3,
      cursor: first.pageInfo.nextCursor ?? '',
    });
    expect(ids(second.sessions)).toEqual(['s002', 's001']);
  });

  it('rejects a cursor reused with different filters, workspace or sort', async () => {
    const { client } = fakeClient(many(5));
    const svc = service(client);
    const first = await svc.page({ workspace: undefined, filters: {}, sort: 'created', limit: 2 });
    const cursor = first.pageInfo.nextCursor ?? '';
    await expect(
      svc.page({ workspace: undefined, filters: { query: 'x' }, sort: 'created', limit: 2, cursor })
    ).rejects.toMatchObject({ status: 400, code: 'cursor_mismatch' });
    await expect(
      svc.page({ workspace: undefined, filters: {}, sort: 'activity', limit: 2, cursor })
    ).rejects.toMatchObject({ status: 400, code: 'cursor_mismatch' });
  });

  it('a malformed cursor fails before calling the CLI', async () => {
    const { client } = fakeClient(many(5));
    await expect(
      service(client).page({ workspace: undefined, filters: {}, sort: 'created', limit: 2, cursor: 'garbage!' })
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
    expect(client.listSessions).not.toHaveBeenCalled();
  });

  it('rejects archived together with all', async () => {
    await expect(
      service(fakeClient([]).client).page({
        workspace: undefined,
        filters: { archived: true, all: true },
        sort: 'created',
        limit: 1,
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('SessionListService cache', () => {
  it('serves from cache within the TTL and refetches after it', async () => {
    const { client } = fakeClient(many(3));
    const clock = { t: 0 };
    const svc = service(client, clock, 10_000);
    const req = { workspace: undefined, filters: {}, sort: 'created' as const, limit: 10 };
    expect((await svc.page(req)).snapshot.cached).toBe(false);
    clock.t = 9_999;
    expect((await svc.page(req)).snapshot.cached).toBe(true);
    clock.t = 10_000;
    expect((await svc.page(req)).snapshot.cached).toBe(false);
    expect(client.listSessions).toHaveBeenCalledTimes(2);
  });

  it('merges concurrent requests into one CLI call', async () => {
    const { client } = fakeClient(many(3));
    const svc = service(client);
    const req = { workspace: undefined, filters: {}, sort: 'created' as const, limit: 10 };
    await Promise.all([svc.page(req), svc.page(req), svc.page({ ...req, sort: 'activity' })]);
    expect(client.listSessions).toHaveBeenCalledTimes(1);
  });

  it('fresh=true bypasses a valid cache entry', async () => {
    const { client } = fakeClient(many(3));
    const svc = service(client);
    const req = { workspace: undefined, filters: {}, sort: 'created' as const, limit: 10 };
    await svc.page(req);
    expect((await svc.page({ ...req, fresh: true })).snapshot.cached).toBe(false);
    expect(client.listSessions).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by workspace and filters, and evicts least recently used entries', async () => {
    const { client } = fakeClient(many(3));
    const svc = service(client, { t: 0 }, 60_000, 2);
    const page = (filters: SessionListFilters, workspace?: string) =>
      svc.page({ workspace, filters, sort: 'created', limit: 10 });
    await page({});
    await page({ query: 'a' });
    await page({}); // touch {} so {query:'a'} is the LRU entry
    await page({}, 'other');
    expect(client.listSessions).toHaveBeenCalledTimes(3);
    await page({}); // still cached
    expect(client.listSessions).toHaveBeenCalledTimes(3);
    await page({ query: 'a' }); // evicted
    expect(client.listSessions).toHaveBeenCalledTimes(4);
  });

  it('does not cache failures', async () => {
    const client = {
      listSessions: vi
        .fn()
        .mockRejectedValueOnce(new Error('sync failed'))
        .mockResolvedValue({ workspaceId: 'w1', sessions: [] }),
    };
    const svc = new SessionListService(client, { ttlMs: 60_000, maxEntries: 4 });
    const req = { workspace: undefined, filters: {}, sort: 'created' as const, limit: 10 };
    await expect(svc.page(req)).rejects.toThrow('sync failed');
    await expect(svc.page(req)).resolves.toMatchObject({ sessions: [] });
  });
});
