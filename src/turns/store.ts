import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TURN_STATES, type TurnRecord, type TurnState } from './types.js';

export type IdempotencyEntry = {
  key: string;
  sessionId: string;
  requestHash: string;
  turnId: string;
  createdAt: string;
};

export interface TurnStore {
  get(sessionId: string, turnId: string): TurnRecord | undefined;
  upsert(record: TurnRecord): void;
  listTracking(): TurnRecord[];
  getIdempotency(key: string): IdempotencyEntry | undefined;
  putIdempotency(entry: IdempotencyEntry): void;
  pruneBefore(isoTime: string): number;
  close(): void;
}

type Row = {
  session_id: string;
  turn_id: string;
  workspace: string | null;
  state: string;
  assistant_turn_id: string | null;
  reply_text: string | null;
  reply_content: string | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  submitted_at: string;
  finished_at: string | null;
  updated_at: string;
  tracking: number;
};

function toRecord(row: Row): TurnRecord {
  const state = (TURN_STATES as readonly string[]).includes(row.state) ? (row.state as TurnState) : 'unknown';
  return {
    sessionId: row.session_id,
    turnId: row.turn_id,
    workspace: row.workspace,
    state,
    assistantTurnId: row.assistant_turn_id,
    replyText: row.reply_text,
    replyContent: row.reply_content === null ? null : (JSON.parse(row.reply_content) as unknown[]),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    submittedAt: row.submitted_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    tracking: row.tracking === 1,
  };
}

/** Turn records and idempotency keys on the data volume, so tracking survives restarts. */
export class SqliteTurnStore implements TurnStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS turns (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        workspace TEXT,
        state TEXT NOT NULL,
        assistant_turn_id TEXT,
        reply_text TEXT,
        reply_content TEXT,
        error_code TEXT,
        error_message TEXT,
        duration_ms INTEGER,
        submitted_at TEXT NOT NULL,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        tracking INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS turns_tracking ON turns (tracking) WHERE tracking = 1;
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  get(sessionId: string, turnId: string): TurnRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? AND turn_id = ?')
      .get(sessionId, turnId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  upsert(record: TurnRecord): void {
    this.db
      .prepare(
        `INSERT INTO turns (session_id, turn_id, workspace, state, assistant_turn_id, reply_text, reply_content,
           error_code, error_message, duration_ms, submitted_at, finished_at, updated_at, tracking)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, turn_id) DO UPDATE SET
           workspace = excluded.workspace, state = excluded.state,
           assistant_turn_id = excluded.assistant_turn_id, reply_text = excluded.reply_text,
           reply_content = excluded.reply_content, error_code = excluded.error_code,
           error_message = excluded.error_message, duration_ms = excluded.duration_ms,
           finished_at = excluded.finished_at, updated_at = excluded.updated_at, tracking = excluded.tracking`
      )
      .run(
        record.sessionId,
        record.turnId,
        record.workspace,
        record.state,
        record.assistantTurnId,
        record.replyText,
        record.replyContent === null ? null : JSON.stringify(record.replyContent),
        record.errorCode,
        record.errorMessage,
        record.durationMs,
        record.submittedAt,
        record.finishedAt,
        record.updatedAt,
        record.tracking ? 1 : 0
      );
  }

  listTracking(): TurnRecord[] {
    const rows = this.db.prepare('SELECT * FROM turns WHERE tracking = 1').all() as Row[];
    return rows.map(toRecord);
  }

  getIdempotency(key: string): IdempotencyEntry | undefined {
    const row = this.db.prepare('SELECT * FROM idempotency WHERE key = ?').get(key) as
      | { key: string; session_id: string; request_hash: string; turn_id: string; created_at: string }
      | undefined;
    return row
      ? {
          key: row.key,
          sessionId: row.session_id,
          requestHash: row.request_hash,
          turnId: row.turn_id,
          createdAt: row.created_at,
        }
      : undefined;
  }

  putIdempotency(entry: IdempotencyEntry): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO idempotency (key, session_id, request_hash, turn_id, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(entry.key, entry.sessionId, entry.requestHash, entry.turnId, entry.createdAt);
  }

  /** Drops finished turns and idempotency keys older than the cutoff. */
  pruneBefore(isoTime: string): number {
    const turns = this.db.prepare('DELETE FROM turns WHERE tracking = 0 AND updated_at < ?').run(isoTime);
    this.db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(isoTime);
    return Number(turns.changes);
  }

  close(): void {
    this.db.close();
  }
}
