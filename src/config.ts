import path from 'node:path';
import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const ConfigSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Comma-separated bearer keys accepted by this API. Multiple keys allow rotation. */
  API_KEYS: z
    .string({ error: 'API_KEYS is required' })
    .transform((value) =>
      value
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
    )
    .pipe(
      z
        .array(z.string().min(16, 'each API key must be at least 16 characters'))
        .min(1, 'API_KEYS must contain at least one key')
    ),

  /** Lody CLI API key; written to credentials.json via `lody login --auth` at startup. */
  LODY_CLI_API_KEY: z.string().trim().min(1).optional(),
  LODY_MACHINE_NAME: z.string().trim().min(1).default('lody-api'),
  /** Default workspace selector (id, slug or name); requests may override it. */
  LODY_WORKSPACE: z.string().trim().min(1).optional(),
  LODY_DATA_DIR: z.string().min(1).default(path.resolve('.data/lody')),
  /** Overrides the lody entry script; defaults to the installed `lody` dependency. */
  LODY_BIN: z.string().min(1).optional(),

  API_DATA_DIR: z.string().min(1).default(path.resolve('.data/api')),

  LODY_CLI_CONCURRENCY: positiveInt(4),
  LODY_CLI_QUEUE_LIMIT: positiveInt(64),
  LODY_CLI_TIMEOUT_MS: positiveInt(120_000),

  SESSION_LIST_CACHE_TTL_MS: z.coerce.number().int().min(0).default(15_000),
  SESSION_LIST_CACHE_MAX_ENTRIES: positiveInt(32),

  SYNC_WAIT_DEFAULT_SECONDS: positiveInt(120),
  SYNC_WAIT_MAX_SECONDS: positiveInt(300),
  TURN_POLL_MAX_WAIT_SECONDS: positiveInt(60),
  TURN_TRACK_MAX_AGE_HOURS: positiveInt(24),
  MAX_OBSERVERS: positiveInt(32),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;
  if (config.SYNC_WAIT_DEFAULT_SECONDS > config.SYNC_WAIT_MAX_SECONDS) {
    throw new Error('Invalid configuration: SYNC_WAIT_DEFAULT_SECONDS exceeds SYNC_WAIT_MAX_SECONDS');
  }
  return config;
}
