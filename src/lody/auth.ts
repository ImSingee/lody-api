import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toApiError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import type { LodyClient } from './client.js';

export type ReadyState =
  | { ready: true; checkedAt: string; workspaces: Array<{ id: string; slug?: string | undefined }> }
  | { ready: false; checkedAt: string; error: { code: string; message: string } };

export type LodyAuthOptions = {
  apiKey: string | undefined;
  machineName: string;
  dataDir: string;
  /** How long a readiness result is reused. */
  checkTtlMs?: number;
  now?: () => number;
  logger?: Logger;
};

/**
 * The CLI reads credentials only from `$LODY_DATA_DIR/credentials.json`; there
 * is no token environment variable. `lody login --auth` validates the key and
 * writes that file without other server-side effects, so it is safe to repeat.
 */
export class LodyAuth {
  private last: { state: ReadyState; at: number } | undefined;
  private pending: Promise<ReadyState> | undefined;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(
    private readonly client: Pick<LodyClient, 'login' | 'listWorkspaces'>,
    private readonly options: LodyAuthOptions
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  async savedToken(): Promise<string | undefined> {
    try {
      const raw = await readFile(path.join(this.options.dataDir, 'credentials.json'), 'utf8');
      const parsed = JSON.parse(raw) as { token?: unknown };
      return typeof parsed.token === 'string' ? parsed.token : undefined;
    } catch {
      return undefined;
    }
  }

  /** Logs in unless the saved credentials already hold the configured key. */
  async ensureLogin(force = false): Promise<void> {
    const { apiKey } = this.options;
    if (!apiKey) {
      if (!(await this.savedToken())) {
        throw new Error('LODY_CLI_API_KEY is not set and no saved lody credentials exist in LODY_DATA_DIR.');
      }
      return;
    }
    if (!force && (await this.savedToken()) === apiKey) return;
    this.logger.info('logging in to lody with LODY_CLI_API_KEY', { machineName: this.options.machineName });
    await this.client.login(apiKey, this.options.machineName);
  }

  async check(force = false): Promise<ReadyState> {
    const ttl = this.options.checkTtlMs ?? 30_000;
    if (!force && this.last && this.now() - this.last.at < ttl) return this.last.state;
    this.pending ??= this.runCheck().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async runCheck(): Promise<ReadyState> {
    const checkedAt = () => new Date(this.now()).toISOString();
    const attempt = async () => {
      const output = await this.client.listWorkspaces();
      return output.workspaces.map((workspace) => ({ id: workspace.id, slug: workspace.slug }));
    };
    let state: ReadyState;
    try {
      state = { ready: true, checkedAt: checkedAt(), workspaces: await attempt() };
    } catch (error) {
      const mapped = toApiError(error);
      if (mapped?.code === 'lody_auth_failed' && this.options.apiKey) {
        // Credentials were removed or replaced; log in again once.
        try {
          await this.ensureLogin(true);
          state = { ready: true, checkedAt: checkedAt(), workspaces: await attempt() };
        } catch (retryError) {
          state = this.failure(retryError, checkedAt());
        }
      } else {
        state = this.failure(error, checkedAt());
      }
    }
    this.last = { state, at: this.now() };
    return state;
  }

  private failure(error: unknown, checkedAt: string): ReadyState {
    const mapped = toApiError(error);
    const message = mapped?.message ?? (error instanceof Error ? error.message : String(error));
    this.logger.warn('lody readiness check failed', { code: mapped?.code, message });
    return { ready: false, checkedAt, error: { code: mapped?.code ?? 'lody_unavailable', message } };
  }
}
