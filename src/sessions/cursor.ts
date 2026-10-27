import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { SessionListFilters } from '../lody/args.js';
import { SORT_MODES, type OrderKey, type SortMode } from './order.js';

const CursorSchema = z.object({
  v: z.literal(1),
  s: z.enum(SORT_MODES),
  k: z.number().finite(),
  id: z.string().min(1).max(200),
  f: z.string().min(1).max(64),
});

export type Cursor = z.infer<typeof CursorSchema>;

const MAX_CURSOR_LENGTH = 1024;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  const invalid = () => new ApiError(400, 'invalid_cursor', 'cursor is malformed');
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = CursorSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/**
 * Binds a cursor to the resolved workspace, the filters and the sort, so a
 * cursor cannot silently continue a different listing.
 */
export function listFingerprint(workspaceId: string, filters: SessionListFilters, sort: SortMode): string {
  const canonical = JSON.stringify([
    workspaceId,
    sort,
    filters.all === true,
    filters.archived === true,
    filters.openedBy ?? null,
    filters.query ?? null,
    filters.machineId ?? null,
    filters.agentConfigId ?? null,
    filters.agentRoleId ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

export function cursorAnchor(cursor: Cursor): OrderKey {
  return { k: cursor.k, id: cursor.id };
}
