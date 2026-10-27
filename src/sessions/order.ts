import type { SessionMeta } from '../lody/schemas.js';

export const SORT_MODES = ['created', 'activity'] as const;
export type SortMode = (typeof SORT_MODES)[number];

/** Position of an item in the order: descending `key`, then descending `id`. */
export type OrderKey = { k: number; id: string };

/** Missing or unparseable times count as 0, exactly like the CLI's `sortSessionMetas`. */
function parseTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `created` uses the immutable `createdAt`, so a keyset walk neither skips nor
 * repeats existing sessions. `activity` reproduces the CLI's own order
 * (`lastMessageAt ?? createdAt`), which moves sessions as messages arrive.
 */
export function orderKey(session: SessionMeta, mode: SortMode): OrderKey {
  const created = parseTime(session.createdAt);
  if (mode === 'created') return { k: created, id: session.id };
  const last = session.lastMessageAt;
  return { k: typeof last === 'number' && Number.isFinite(last) ? last : created, id: session.id };
}

/** Negative when `a` comes first. Ids compare by code unit so the order never depends on locale. */
export function compareKeys(a: OrderKey, b: OrderKey): number {
  if (a.k !== b.k) return b.k - a.k;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export function sortSessions(sessions: readonly SessionMeta[], mode: SortMode): SessionMeta[] {
  return sessions
    .map((session) => ({ session, key: orderKey(session, mode) }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map((entry) => entry.session);
}

/** Index of the first session strictly after `anchor`, by binary search over a sorted list. */
export function indexAfter(sorted: readonly SessionMeta[], mode: SortMode, anchor: OrderKey): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const item = sorted[mid];
    if (item && compareKeys(orderKey(item, mode), anchor) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
}
