import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { BuildInfo } from '../build-info.js';
import { ApiError, toApiError } from '../errors.js';
import { assertId } from '../lody/args.js';
import type { ReadyState } from '../lody/auth.js';
import type { Logger } from '../logger.js';
import type { SessionDetailService } from '../sessions/detail-service.js';
import type { SessionListService } from '../sessions/list-service.js';
import { SORT_MODES } from '../sessions/order.js';
import type { MessageService } from '../turns/message-service.js';
import { turnToJson } from '../turns/types.js';

export type AppDeps = {
  build: BuildInfo;
  apiKeys: string[];
  defaultWorkspace: string | undefined;
  sessions: SessionListService;
  details: SessionDetailService;
  messages: MessageService;
  readiness: { check(): Promise<ReadyState> };
  limits: { syncWaitDefaultSeconds: number; syncWaitMaxSeconds: number; pollMaxWaitSeconds: number };
  logger: Logger;
};

type Env = { Variables: { requestId: string } };

const MAX_PROMPT_LENGTH = 100_000;

const booleanParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');
const textParam = z.string().min(1).max(512);

const ListQuerySchema = z.strictObject({
  workspace: textParam.optional(),
  archived: booleanParam.optional(),
  all: booleanParam.optional(),
  openedBy: textParam.optional(),
  query: textParam.optional(),
  machineId: textParam.optional(),
  agentConfigId: textParam.optional(),
  agentRoleId: textParam.optional(),
  sort: z.enum(SORT_MODES).default('created'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(1024).optional(),
  fresh: booleanParam.optional(),
});

const WorkspaceQuerySchema = z.strictObject({ workspace: textParam.optional() });

function hashKey(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerAuth(keys: string[]): MiddlewareHandler<Env> {
  const digests = keys.map(hashKey);
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const presented = match?.[1] ? hashKey(match[1].trim()) : undefined;
    // Compare against every key so timing does not reveal which one matched.
    let ok = false;
    for (const digest of digests) {
      if (presented && timingSafeEqual(presented, digest)) ok = true;
    }
    if (!ok) {
      c.header('WWW-Authenticate', 'Bearer');
      throw new ApiError(401, 'unauthorized', 'Missing or invalid API key.');
    }
    await next();
  };
}

function parseQuery<T extends z.ZodType>(c: Context<Env>, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

function validationError(error: z.ZodError): ApiError {
  const message = error.issues
    .map((issue) => {
      const where = issue.path.join('.');
      if (issue.code === 'unrecognized_keys') return `unknown parameter(s): ${issue.keys.join(', ')}`;
      return where ? `${where}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return new ApiError(400, 'invalid_request', message);
}

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { logger, limits } = deps;

  const MessageBodySchema = z.strictObject({
    prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
    wait: z.boolean().default(false),
    timeoutSeconds: z.number().int().min(1).max(limits.syncWaitMaxSeconds).optional(),
  });
  const TurnQuerySchema = z.strictObject({
    workspace: textParam.optional(),
    waitSeconds: z.coerce.number().int().min(0).max(limits.pollMaxWaitSeconds).default(0),
  });

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    const startedAt = Date.now();
    await next();
    logger.info('request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    });
  });

  app.get('/healthz', (c) => c.json({ ok: true, version: deps.build.version, commit: deps.build.commit }));
  app.get('/version', (c) => c.json(deps.build));
  app.get('/readyz', async (c) => {
    const state = await deps.readiness.check();
    return c.json(state, state.ready ? 200 : 503);
  });

  app.use('/v1/*', bearerAuth(deps.apiKeys));

  app.get('/v1/sessions', async (c) => {
    const q = parseQuery(c, ListQuerySchema);
    const page = await deps.sessions.page({
      workspace: q.workspace ?? deps.defaultWorkspace,
      filters: {
        archived: q.archived,
        all: q.all,
        openedBy: q.openedBy,
        query: q.query,
        machineId: q.machineId,
        agentConfigId: q.agentConfigId,
        agentRoleId: q.agentRoleId,
      },
      sort: q.sort,
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      fresh: q.fresh === true,
    });
    return c.json(page);
  });

  app.get('/v1/sessions/:sessionId', async (c) => {
    const sessionId = assertId('session id', c.req.param('sessionId'));
    const q = parseQuery(c, WorkspaceQuerySchema.extend({ live: booleanParam.optional() }));
    const detail = await deps.details.get(sessionId, q.workspace ?? deps.defaultWorkspace, q.live === true);
    return c.json(detail);
  });

  app.post(
    '/v1/sessions/:sessionId/messages',
    bodyLimit({
      maxSize: MAX_PROMPT_LENGTH * 4 + 4096,
      onError: () => {
        throw new ApiError(413, 'payload_too_large', 'Request body is too large.');
      },
    }),
    async (c) => {
      const sessionId = assertId('session id', c.req.param('sessionId'));
      const q = parseQuery(c, WorkspaceQuerySchema);
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
      }
      const parsed = MessageBodySchema.safeParse(raw);
      if (!parsed.success) throw validationError(parsed.error);
      const idempotencyKey = c.req.header('idempotency-key');
      if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) {
        throw new ApiError(400, 'invalid_request', 'Idempotency-Key must be 1-200 printable ASCII characters.');
      }

      const result = await deps.messages.send({
        sessionId,
        workspace: q.workspace ?? deps.defaultWorkspace,
        prompt: parsed.data.prompt,
        wait: parsed.data.wait,
        timeoutSeconds: parsed.data.timeoutSeconds ?? limits.syncWaitDefaultSeconds,
        idempotencyKey,
      });
      const location = `/v1/sessions/${encodeURIComponent(result.turn.sessionId)}/turns/${encodeURIComponent(result.turn.turnId)}`;
      c.header('Location', location);
      return c.json(
        { turn: turnToJson(result.turn), waitTimedOut: result.waitTimedOut, replayed: result.replayed },
        result.status
      );
    }
  );

  app.get('/v1/sessions/:sessionId/turns/:turnId', async (c) => {
    const sessionId = assertId('session id', c.req.param('sessionId'));
    const turnId = assertId('turn id', c.req.param('turnId'));
    const q = parseQuery(c, TurnQuerySchema);
    const turn = await deps.messages.getTurn({
      sessionId,
      turnId,
      workspace: q.workspace ?? deps.defaultWorkspace,
      waitSeconds: q.waitSeconds,
    });
    return c.json({ turn: turnToJson(turn) });
  });

  app.notFound((c) => c.json(new ApiError(404, 'not_found', 'Route not found.').toBody(), 404));

  app.onError((error, c) => {
    const mapped = toApiError(error);
    if (mapped) {
      if (mapped.status >= 500) {
        logger.warn('request failed', { requestId: c.get('requestId'), code: mapped.code, message: mapped.message });
      }
      return c.json(mapped.toBody(), mapped.status as 400);
    }
    logger.error('unhandled error', { requestId: c.get('requestId'), error });
    return c.json(new ApiError(500, 'internal_error', 'Internal server error.').toBody(), 500);
  });

  return app;
}
