import { z } from 'zod';

/**
 * CLI output contracts (lody apps/cli/src/commands/session*.ts). Objects are
 * loose: only the fields this server reads are checked, and everything else
 * passes through untouched so `SessionMeta` reaches callers as the CLI printed it.
 */

/**
 * Only `id` is guaranteed: real workspaces contain sessions whose metadata is
 * little more than an id (no `createdAt`), and the CLI still lists them.
 */
export const SessionMetaSchema = z.looseObject({
  id: z.string().min(1),
  createdAt: z.unknown().optional(),
  lastMessageAt: z.unknown().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const SessionListOutputSchema = z.looseObject({
  ok: z.literal(true),
  workspaceId: z.string(),
  sessions: z.array(SessionMetaSchema),
});

export const SessionShowOutputSchema = z.looseObject({
  ok: z.literal(true),
  workspace: z.looseObject({ id: z.string() }),
  session: SessionMetaSchema,
  historyCount: z.number(),
  latestHistoryAt: z.string().optional(),
  messageQueueCount: z.number(),
});
export type SessionShowOutput = z.infer<typeof SessionShowOutputSchema>;

export const SessionStatusOutputSchema = z.looseObject({
  ok: z.literal(true),
  sessionId: z.string(),
  machineOnline: z.boolean(),
  liveStatus: z.looseObject({ state: z.string() }),
});
export type SessionStatusOutput = z.infer<typeof SessionStatusOutputSchema>;

export const ChatDispatchOutputSchema = z.looseObject({
  ok: z.literal(true),
  sessionId: z.string(),
  workspaceId: z.string(),
  machineId: z.string(),
  userTurnId: z.string(),
});
export type ChatDispatchOutput = z.infer<typeof ChatDispatchOutputSchema>;

export const ChatWaitOutputSchema = ChatDispatchOutputSchema.extend({
  turnId: z.string(),
  content: z.array(z.unknown()),
  durationMs: z.number(),
});
export type ChatWaitOutput = z.infer<typeof ChatWaitOutputSchema>;

/** `{ ok: false, sessionId, userTurnId, error }`: the turn was dispatched but `--wait` failed. */
export const ChatWaitErrorPayloadSchema = z.looseObject({
  ok: z.literal(false),
  sessionId: z.string(),
  userTurnId: z.string(),
  error: z.string(),
});

export const TranscriptEntrySchema = z.looseObject({
  index: z.number(),
  id: z.string(),
  role: z.string(),
  timestamp: z.string(),
  text: z.string(),
});

export const SessionHistoryOutputSchema = z.looseObject({
  ok: z.literal(true),
  workspaceId: z.string(),
  sessionId: z.string(),
  entries: z.array(TranscriptEntrySchema),
});
export type SessionHistoryOutput = z.infer<typeof SessionHistoryOutputSchema>;

export const ObservedTurnSchema = z.looseObject({
  userTurnId: z.string(),
  assistantTurnId: z.string().optional(),
  state: z.enum(['pending', 'running', 'unknown', 'completed', 'failed', 'canceled']),
  durationMs: z.number().optional(),
});
export type ObservedTurn = z.infer<typeof ObservedTurnSchema>;

export const ObservedSessionSchema = z.looseObject({
  sessionId: z.string(),
  machineId: z.string(),
  archived: z.boolean(),
  state: z.string(),
  freshness: z.enum(['synced', 'unavailable']),
  latestTurn: ObservedTurnSchema.optional(),
  activeTurns: z.array(ObservedTurnSchema),
});
export type ObservedSession = z.infer<typeof ObservedSessionSchema>;

export const ObserveSnapshotOutputSchema = z.looseObject({
  ok: z.literal(true),
  workspaceId: z.string(),
  session: ObservedSessionSchema,
});

const TurnIdentity = {
  sessionId: z.string(),
  userTurnId: z.string(),
  assistantTurnId: z.string().optional(),
};

/** One `--jsonl --follow` line; unknown event types are ignored by the tracker. */
export const ObserveEventSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.enum(['snapshot', 'session.changed']), sessionId: z.string(), session: ObservedSessionSchema }),
  z.looseObject({ type: z.literal('turn.started'), ...TurnIdentity }),
  z.looseObject({
    type: z.literal('turn.finished'),
    ...TurnIdentity,
    outcome: z.enum(['completed', 'failed', 'canceled']),
    durationMs: z.number().optional(),
  }),
  z.looseObject({ type: z.literal('session.removed'), sessionId: z.string() }),
  z.looseObject({ type: z.literal('ready') }),
  z.looseObject({ type: z.literal('error'), error: z.string() }),
]);
export type ObserveEvent = z.infer<typeof ObserveEventSchema>;

export const WorkspaceListOutputSchema = z.looseObject({
  ok: z.literal(true),
  workspaces: z.array(z.looseObject({ id: z.string(), name: z.string().optional(), slug: z.string().optional() })),
});
export type WorkspaceListOutput = z.infer<typeof WorkspaceListOutputSchema>;
