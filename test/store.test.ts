import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTurnStore } from '../src/turns/store.js';
import { memoryStore, record } from './helpers.js';

describe('SqliteTurnStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('upserts and reads turns, including JSON reply content', () => {
    const store = memoryStore();
    store.upsert(record());
    store.upsert(
      record({
        state: 'completed',
        replyText: 'pong',
        replyContent: [{ type: 'text', text: 'pong' }],
        assistantTurnId: 'a1',
        tracking: false,
      })
    );
    expect(store.get('s1', 'u1')).toMatchObject({
      state: 'completed',
      replyText: 'pong',
      replyContent: [{ type: 'text', text: 'pong' }],
      assistantTurnId: 'a1',
      tracking: false,
    });
    expect(store.get('s1', 'missing')).toBeUndefined();
  });

  it('lists only turns still being tracked', () => {
    const store = memoryStore();
    store.upsert(record({ turnId: 'a' }));
    store.upsert(record({ turnId: 'b', state: 'completed', tracking: false }));
    store.upsert(record({ sessionId: 's2', turnId: 'c', state: 'running' }));
    expect(store.listTracking().map((r) => r.turnId).sort()).toEqual(['a', 'c']);
  });

  it('keeps the first idempotency entry for a key', () => {
    const store = memoryStore();
    const entry = { key: 'k', sessionId: 's1', requestHash: 'h1', turnId: 'u1', createdAt: '2026-10-01T00:00:00Z' };
    store.putIdempotency(entry);
    store.putIdempotency({ ...entry, turnId: 'u2' });
    expect(store.getIdempotency('k')).toEqual(entry);
    expect(store.getIdempotency('nope')).toBeUndefined();
  });

  it('prunes finished turns and old keys but never tracked turns', () => {
    const store = memoryStore();
    const old = '2026-01-01T00:00:00.000Z';
    store.upsert(record({ turnId: 'old-done', state: 'completed', tracking: false, updatedAt: old }));
    store.upsert(record({ turnId: 'old-tracking', updatedAt: old }));
    store.upsert(record({ turnId: 'new-done', state: 'completed', tracking: false }));
    store.putIdempotency({ key: 'old', sessionId: 's1', requestHash: 'h', turnId: 'x', createdAt: old });
    expect(store.pruneBefore('2026-06-01T00:00:00.000Z')).toBe(1);
    expect(store.get('s1', 'old-done')).toBeUndefined();
    expect(store.get('s1', 'old-tracking')).toBeDefined();
    expect(store.get('s1', 'new-done')).toBeDefined();
    expect(store.getIdempotency('old')).toBeUndefined();
  });

  it('persists across reopen on disk', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lody-api-store-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'turns.sqlite');
    const first = new SqliteTurnStore(file);
    first.upsert(record());
    first.close();
    const second = new SqliteTurnStore(file);
    expect(second.listTracking()).toHaveLength(1);
    second.close();
  });
});
