import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { readBuildInfo, readOwnManifest } from './build-info.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { LodyAuth } from './lody/auth.js';
import { CliLodyClient } from './lody/client.js';
import { buildChildEnv, ProcessLodyRunner } from './lody/runner.js';
import { createLogger } from './logger.js';
import { SessionDetailService } from './sessions/detail-service.js';
import { SessionListService } from './sessions/list-service.js';
import { MessageService } from './turns/message-service.js';
import { SqliteTurnStore } from './turns/store.js';
import { TurnTracker } from './turns/tracker.js';

const SHUTDOWN_GRACE_MS = 30_000;
const TURN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The `lody` package has no `exports`, so its entry is read from its own package.json. */
function resolveLody(): { entry: string; version: string | null } {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('lody/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: string; version?: string };
  return {
    entry: path.join(path.dirname(manifestPath), manifest.main ?? 'dist/index.js'),
    version: manifest.version ?? null,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const lody = resolveLody();
  const build = readBuildInfo(process.env, readOwnManifest(), lody.version);
  const logger = createLogger(config.LOG_LEVEL, { service: 'lody-api' });
  logger.info('starting', { ...build });
  mkdirSync(config.LODY_DATA_DIR, { recursive: true });
  mkdirSync(config.API_DATA_DIR, { recursive: true });

  const runner = new ProcessLodyRunner({
    command: process.execPath,
    prefixArgs: [config.LODY_BIN ?? lody.entry],
    env: buildChildEnv(process.env, config.LODY_DATA_DIR),
    concurrency: config.LODY_CLI_CONCURRENCY,
    queueLimit: config.LODY_CLI_QUEUE_LIMIT,
    defaultTimeoutMs: config.LODY_CLI_TIMEOUT_MS,
    logger: logger.child({ component: 'runner' }),
  });
  const client = new CliLodyClient(runner);
  const auth = new LodyAuth(client, {
    apiKey: config.LODY_CLI_API_KEY,
    machineName: config.LODY_MACHINE_NAME,
    dataDir: config.LODY_DATA_DIR,
    logger: logger.child({ component: 'auth' }),
  });

  const store = new SqliteTurnStore(path.join(config.API_DATA_DIR, 'turns.sqlite'));
  store.pruneBefore(new Date(Date.now() - TURN_RETENTION_MS).toISOString());
  const tracker = new TurnTracker(client, store, {
    maxObservers: config.MAX_OBSERVERS,
    maxAgeMs: config.TURN_TRACK_MAX_AGE_HOURS * 60 * 60 * 1000,
    logger: logger.child({ component: 'tracker' }),
  });

  const app = createApp({
    build,
    apiKeys: config.API_KEYS,
    defaultWorkspace: config.LODY_WORKSPACE,
    sessions: new SessionListService(client, {
      ttlMs: config.SESSION_LIST_CACHE_TTL_MS,
      maxEntries: config.SESSION_LIST_CACHE_MAX_ENTRIES,
    }),
    details: new SessionDetailService(client),
    messages: new MessageService(client, store, tracker, { logger: logger.child({ component: 'messages' }) }),
    readiness: auth,
    limits: {
      syncWaitDefaultSeconds: config.SYNC_WAIT_DEFAULT_SECONDS,
      syncWaitMaxSeconds: config.SYNC_WAIT_MAX_SECONDS,
      pollMaxWaitSeconds: config.TURN_POLL_MAX_WAIT_SECONDS,
    },
    logger,
  });

  try {
    await auth.ensureLogin();
  } catch (error) {
    // Keep serving: /readyz reports the failure and retries login on each check.
    logger.error('lody login failed at startup', { error });
  }
  const resumed = tracker.resume();
  if (resumed > 0) logger.info('resumed turn tracking', { turns: resumed });

  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
    logger.info('listening', { host: info.address, port: info.port });
  });
  // `wait=true` may legitimately hold a request for SYNC_WAIT_MAX_SECONDS plus dispatch time.
  if ('requestTimeout' in server) {
    server.requestTimeout = (config.SYNC_WAIT_MAX_SECONDS + 180) * 1000;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    await tracker.shutdown();
    await Promise.race([closed, grace]);
    if ('closeAllConnections' in server) server.closeAllConnections();
    await runner.killAll();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
