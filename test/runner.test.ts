import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import { buildChildEnv, commandLabel, ProcessLodyRunner } from '../src/lody/runner.js';
import { createLogger } from '../src/logger.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-lody.mjs', import.meta.url));

function runner(overrides: Partial<ConstructorParameters<typeof ProcessLodyRunner>[0]> = {}) {
  return new ProcessLodyRunner({
    command: process.execPath,
    prefixArgs: [FAKE],
    env: buildChildEnv(process.env, '/tmp/lody-api-test-data'),
    concurrency: 2,
    queueLimit: 2,
    defaultTimeoutMs: 10_000,
    killGraceMs: 300,
    ...overrides,
  });
}

describe('buildChildEnv', () => {
  it('forwards only allow-listed variables and pins lody settings', () => {
    const env = buildChildEnv(
      {
        PATH: '/bin',
        HOME: '/home/x',
        HTTPS_PROXY: 'http://proxy:1',
        LODY_SESSION_ID: 'leak',
        LODY_WORKSPACE_ID: 'leak',
        LODY_AGENT_CONFIG_ID: 'leak',
        LODY_MACHINE_ID: 'leak',
        LODY_CLI_API_KEY: 'secret',
        API_KEYS: 'secret',
        NODE_OPTIONS: '--inspect',
        LODY_DNS_RESULT_ORDER: 'ipv4first',
      },
      '/data/lody'
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/x',
      HTTPS_PROXY: 'http://proxy:1',
      LODY_DNS_RESULT_ORDER: 'ipv4first',
      LODY_DATA_DIR: '/data/lody',
      LODY_DISABLE_SHELL_ENV: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
  });
});

describe('commandLabel', () => {
  it('keeps subcommand words and never option values', () => {
    expect(commandLabel(['login', '--auth=lody_cli_secret', '--machine-name=x'])).toBe('login');
    expect(commandLabel(['session', 'list', '--json'])).toBe('session list');
    expect(commandLabel(['session', 'chat', 's1', '--prompt-file=-'])).toBe('session chat');
  });

  it('does not log the login key', async () => {
    const lines: string[] = [];
    const r = runner({ logger: createLogger('debug', {}, (line) => lines.push(line)) });
    await r.run(['env', '--auth=lody_cli_secret']);
    expect(lines.join('\n')).not.toContain('lody_cli_secret');
  });
});

describe('ProcessLodyRunner', () => {
  it('runs the CLI with a scrubbed environment and passes args verbatim', async () => {
    const r = new ProcessLodyRunner({
      command: process.execPath,
      prefixArgs: [FAKE],
      env: buildChildEnv({ ...process.env, LODY_SESSION_ID: 'leak', SECRET_THING: 'x' }, '/tmp/d'),
      concurrency: 1,
      queueLimit: 1,
      defaultTimeoutMs: 10_000,
    });
    const result = await r.run(['env', 'session', 'list', '--query=--all']);
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(json.args).toEqual(['session', 'list', '--query=--all']);
    expect(json.env).toEqual({
      LODY_DATA_DIR: '/tmp/d',
      LODY_DISABLE_SHELL_ENV: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
  });

  it('pipes stdin when given and closes it', async () => {
    const result = await runner().run(['stdin'], { stdin: 'hello\n-- not an option' });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, stdin: 'hello\n-- not an option' });
  });

  it('gives the child an immediately-ended stdin otherwise, so it cannot hang', async () => {
    const result = await runner().run(['stdin-ignored'], { timeoutMs: 5_000 });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, stdinLength: 0 });
  });

  it('reports failures with exit code and stderr', async () => {
    const result = await runner().run(['fail']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('something broke');
  });

  it('kills a command that exceeds its timeout', async () => {
    const started = Date.now();
    await expect(runner().run(['sleep', '10000'], { timeoutMs: 200 })).rejects.toMatchObject({
      status: 504,
      code: 'lody_cli_timeout',
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const started = Date.now();
    await expect(runner().run(['ignore-sigterm'], { timeoutMs: 200 })).rejects.toMatchObject({
      code: 'lody_cli_timeout',
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('caps stdout size', async () => {
    await expect(
      runner({ maxStdoutBytes: 10_000 }).run(['flood', '1000000'])
    ).rejects.toMatchObject({ status: 502, code: 'lody_output_too_large' });
  });

  it('limits concurrency and rejects when the queue is full', async () => {
    const r = runner({ concurrency: 1, queueLimit: 1 });
    const first = r.run(['sleep', '300']);
    const second = r.run(['sleep', '10']);
    const third = r.run(['sleep', '10']);
    await expect(third).rejects.toBeInstanceOf(ApiError);
    await expect(third).rejects.toMatchObject({ status: 429, code: 'busy' });
    await expect(first).resolves.toMatchObject({ exitCode: 0 });
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
  });

  it('runs queued commands after a slot frees, never more than the limit at once', async () => {
    const r = runner({ concurrency: 2, queueLimit: 10 });
    let peak = 0;
    const runs = Array.from({ length: 5 }, () => {
      const p = r.run(['sleep', '150']);
      peak = Math.max(peak, r.activeChildren);
      return p;
    });
    const interval = setInterval(() => (peak = Math.max(peak, r.activeChildren)), 10);
    await Promise.all(runs);
    clearInterval(interval);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('streams lines and stops the process on demand', async () => {
    const lines: string[] = [];
    const handle = runner().stream(['lines', '{"type":"ready"}', 'plain log'], (line) => lines.push(line));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await handle.stop();
    const exit = await handle.exited;
    expect(lines).toEqual(['{"type":"ready"}', 'plain log']);
    expect(exit.exitCode === null || exit.signal !== null).toBe(true);
  });
});
