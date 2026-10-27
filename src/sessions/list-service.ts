import { ApiError } from '../errors.js';
import type { SessionListFilters } from '../lody/args.js';
import type { LodyClient } from '../lody/client.js';
import type { SessionMeta } from '../lody/schemas.js';
import { cursorAnchor, decodeCursor, encodeCursor, listFingerprint } from './cursor.js';
import { indexAfter, orderKey, sortSessions, type SortMode } from './order.js';

type Snapshot = {
  workspaceId: string;
  sessions: SessionMeta[];
  fetchedAt: number;
  sorted: Partial<Record<SortMode, SessionMeta[]>>;
};

export type SessionPageRequest = {
  workspace: string | undefined;
  filters: SessionListFilters;
  sort: SortMode;
  limit: number;
  cursor?: string;
  fresh?: boolean;
};

export type SessionPage = {
  workspaceId: string;
  sessions: SessionMeta[];
  pageInfo: { limit: number; hasMore: boolean; nextCursor: string | null };
  snapshot: { syncedAt: string; cached: boolean; total: number };
};

export type SessionListServiceOptions = {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
};

/**
 * `lody session list` has only `--limit`, and it always loads every session
 * before cutting, so each page needs the full filtered list anyway. The list is
 * cached per (workspace, filters) for a short TTL with single-flight fetching,
 * so walking every page within the TTL costs one CLI call; pages are cut with a
 * keyset cursor, which stays valid when the next page comes from a newer snapshot.
 */
export class SessionListService {
  private readonly cache = new Map<string, Snapshot>();
  private readonly inflight = new Map<string, Promise<Snapshot>>();
  private readonly now: () => number;

  constructor(
    private readonly client: Pick<LodyClient, 'listSessions'>,
    private readonly options: SessionListServiceOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  async page(request: SessionPageRequest): Promise<SessionPage> {
    if (request.filters.all && request.filters.archived) {
      throw new ApiError(400, 'invalid_request', 'Pass either archived or all, not both.');
    }
    // Decode before fetching so a malformed cursor fails fast.
    const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor);
    if (cursor && cursor.s !== request.sort) {
      throw new ApiError(400, 'cursor_mismatch', 'cursor was issued for a different sort');
    }

    const { snapshot, cached } = await this.snapshot(request.workspace, request.filters, request.fresh === true);
    const fingerprint = listFingerprint(snapshot.workspaceId, request.filters, request.sort);
    if (cursor && cursor.f !== fingerprint) {
      throw new ApiError(400, 'cursor_mismatch', 'cursor was issued for a different workspace or filters');
    }

    const sorted = (snapshot.sorted[request.sort] ??= sortSessions(snapshot.sessions, request.sort));
    const start = cursor ? indexAfter(sorted, request.sort, cursorAnchor(cursor)) : 0;
    const items = sorted.slice(start, start + request.limit);
    const hasMore = start + items.length < sorted.length;
    const last = items.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor({ v: 1, s: request.sort, ...orderKey(last, request.sort), f: fingerprint })
        : null;

    return {
      workspaceId: snapshot.workspaceId,
      sessions: items,
      pageInfo: { limit: request.limit, hasMore, nextCursor },
      snapshot: { syncedAt: new Date(snapshot.fetchedAt).toISOString(), cached, total: sorted.length },
    };
  }

  private async snapshot(
    workspace: string | undefined,
    filters: SessionListFilters,
    fresh: boolean
  ): Promise<{ snapshot: Snapshot; cached: boolean }> {
    const key = cacheKey(workspace, filters);
    const hit = this.cache.get(key);
    if (!fresh && hit && this.now() - hit.fetchedAt < this.options.ttlMs) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return { snapshot: hit, cached: true };
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.client
        .listSessions(workspace, filters)
        .then((output) => {
          const snapshot: Snapshot = { ...output, fetchedAt: this.now(), sorted: {} };
          this.store(key, snapshot);
          return snapshot;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return { snapshot: await pending, cached: false };
  }

  private store(key: string, snapshot: Snapshot): void {
    this.cache.delete(key);
    this.cache.set(key, snapshot);
    while (this.cache.size > this.options.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function cacheKey(workspace: string | undefined, filters: SessionListFilters): string {
  return JSON.stringify([
    workspace ?? null,
    filters.all === true,
    filters.archived === true,
    filters.openedBy ?? null,
    filters.query ?? null,
    filters.machineId ?? null,
    filters.agentConfigId ?? null,
    filters.agentRoleId ?? null,
  ]);
}
