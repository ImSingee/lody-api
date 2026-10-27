import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ApiError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';

/**
 * Parent variables forwarded to the CLI. Everything else is dropped on purpose:
 * `LODY_SESSION_ID`, `LODY_WORKSPACE_ID`, `LODY_AGENT_CONFIG_ID` and `LODY_MACHINE_ID`
 * change how the CLI resolves positional arguments and defaults, so a server
 * running inside a Lody session must never leak them into its children.
 */
const FORWARDED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'LODY_DNS_RESULT_ORDER',
  'LODY_HTTP_TRANSPORT',
  'LODY_HTTP2',
  'LODY_HTTP_CONNECT_TIMEOUT_MS',
  'LODY_LORO_RPC_CONNECT_TIMEOUT_MS',
  'LODY_LOG_TRACE',
] as const;

export function buildChildEnv(parent: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED_ENV) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.LODY_DATA_DIR = dataDir;
  // Skips spawning a login shell to capture env; one-shot commands never need it.
  env.LODY_DISABLE_SHELL_ENV = '1';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

export type RunOptions = {
  timeoutMs?: number;
  /** Written to the child's stdin, which is then closed. Without it stdin is `ignore`. */
  stdin?: string;
};

export type RunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type StreamHandle = {
  readonly pid: number | undefined;
  /** Resolves once the process has exited, for any reason. */
  readonly exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }>;
  stop(): Promise<void>;
};

export interface LodyRunner {
  run(args: string[], options?: RunOptions): Promise<RunResult>;
  stream(args: string[], onLine: (line: string) => void): StreamHandle;
}

export type ProcessLodyRunnerOptions = {
  /** Executable, normally `process.execPath`. */
  command: string;
  /** Arguments before the lody arguments, normally the lody entry script. */
  prefixArgs: string[];
  env: NodeJS.ProcessEnv;
  concurrency: number;
  queueLimit: number;
  defaultTimeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
  logger?: Logger;
};

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly queueLimit: number
  ) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      if (this.waiters.length >= this.queueLimit) {
        throw new ApiError(429, 'busy', 'Too many concurrent lody CLI requests; retry later.', true);
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

/**
 * Leading subcommand words only (`session list`). Option values never appear,
 * because `login --auth=<key>` carries the CLI API key.
 */
export function commandLabel(args: readonly string[]): string {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-') || words.length === 2) break;
    words.push(arg);
  }
  return words.join(' ');
}

/** Kills the whole process group: the CLI starts worker processes of its own. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function waitForExit(child: ChildProcess): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ exitCode: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

export class ProcessLodyRunner implements LodyRunner {
  private readonly semaphore: Semaphore;
  private readonly children = new Set<ChildProcess>();
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly killGraceMs: number;
  private readonly logger: Logger;

  constructor(private readonly options: ProcessLodyRunnerOptions) {
    this.semaphore = new Semaphore(options.concurrency, options.queueLimit);
    this.maxStdoutBytes = options.maxStdoutBytes ?? 64 * 1024 * 1024;
    this.maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
    this.killGraceMs = options.killGraceMs ?? 5_000;
    this.logger = options.logger ?? silentLogger;
  }

  private spawnChild(args: string[], withStdin: boolean): ChildProcess {
    const child = spawn(this.options.command, [...this.options.prefixArgs, ...args], {
      env: this.options.env,
      stdio: [withStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // Own process group so a timeout can take down the CLI's helpers too.
      detached: true,
    });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    child.once('error', () => this.children.delete(child));
    return child;
  }

  private terminate(child: ChildProcess): void {
    killTree(child, 'SIGTERM');
    const timer = setTimeout(() => killTree(child, 'SIGKILL'), this.killGraceMs);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }

  async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const release = await this.semaphore.acquire();
    try {
      return await this.runUnlimited(args, options);
    } finally {
      release();
    }
  }

  private async runUnlimited(args: string[], options: RunOptions): Promise<RunResult> {
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs;
    const startedAt = Date.now();
    const child = this.spawnChild(args, options.stdin !== undefined);
    const command = commandLabel(args);

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let overflow = false;
    let timedOut = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > this.maxStdoutBytes) {
        if (!overflow) {
          overflow = true;
          this.terminate(child);
        }
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > this.maxStderrBytes) stderr = stderr.slice(-this.maxStderrBytes);
    });
    if (options.stdin !== undefined && child.stdin) {
      // A child that exits before reading would otherwise raise EPIPE.
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      this.terminate(child);
    }, timeoutMs);

    let exit: { exitCode: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await waitForExit(child);
    } catch (error) {
      throw new ApiError(500, 'lody_cli_spawn_failed', `Failed to start lody CLI: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - startedAt;
    this.logger.debug('lody command finished', {
      command,
      exitCode: exit.exitCode,
      signal: exit.signal,
      durationMs,
    });
    if (timedOut) {
      throw new ApiError(504, 'lody_cli_timeout', `lody ${command} did not finish within ${timeoutMs}ms.`, true);
    }
    if (overflow) {
      throw new ApiError(502, 'lody_output_too_large', `lody ${command} output exceeded ${this.maxStdoutBytes} bytes.`);
    }
    return {
      ...exit,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr,
      durationMs,
    };
  }

  stream(args: string[], onLine: (line: string) => void): StreamHandle {
    const child = this.spawnChild(args, false);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > this.maxStderrBytes) stderr = stderr.slice(-this.maxStderrBytes);
    });
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        try {
          onLine(line);
        } catch (error) {
          this.logger.error('stream line handler failed', { error });
        }
      });
    }
    const exited = waitForExit(child)
      .catch(() => ({ exitCode: null, signal: null }))
      .then((exit) => ({ ...exit, stderr }));
    return {
      pid: child.pid,
      exited,
      stop: async () => {
        this.terminate(child);
        await exited;
      },
    };
  }

  /** Terminates every running child; used during shutdown after the grace period. */
  async killAll(): Promise<void> {
    const pending = [...this.children].map((child) => {
      this.terminate(child);
      return waitForExit(child).catch(() => undefined);
    });
    await Promise.all(pending);
  }

  get activeChildren(): number {
    return this.children.size;
  }
}
