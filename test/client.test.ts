import { describe, expect, it } from 'vitest';
import { LodyCliError } from '../src/errors.js';
import { CliLodyClient, extractJsonLine, failureMessage } from '../src/lody/client.js';
import type { LodyRunner, RunOptions, RunResult } from '../src/lody/runner.js';

type Call = { args: string[]; options: RunOptions | undefined };

function fakeRunner(results: Array<Partial<RunResult>>) {
  const calls: Call[] = [];
  const runner: LodyRunner = {
    async run(args, options) {
      calls.push({ args, options });
      const next = results.shift() ?? {};
      return { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, ...next };
    },
    stream() {
      throw new Error('not used');
    },
  };
  return { runner, calls };
}

const json = (value: unknown) => `${JSON.stringify(value)}\n`;

describe('extractJsonLine', () => {
  it('returns the last JSON object line, skipping logs mixed into stdout', () => {
    const stdout = [
      'info: syncing workspace',
      '{"ok":true,"first":1}',
      '{not json',
      'warn: done',
      '{"ok":true,"last":2}',
      '',
    ].join('\n');
    expect(extractJsonLine(stdout)).toEqual({ ok: true, last: 2 });
  });

  it('ignores arrays and garbage', () => {
    expect(extractJsonLine('[1,2]\nnope')).toBeUndefined();
    expect(extractJsonLine('')).toBeUndefined();
  });
});

describe('failureMessage', () => {
  const base: RunResult = { exitCode: 1, signal: null, stdout: '', stderr: '', durationMs: 1 };
  it('prefers the JSON error, then stderr, then stdout, then the exit status', () => {
    expect(failureMessage(base, { ok: false, error: '\u001b[31mSession not found: x\u001b[39m ' })).toBe(
      'Session not found: x'
    );
    expect(failureMessage({ ...base, stderr: 'warn: a\nerror: Real cause\n\n' }, undefined)).toBe('error: Real cause');
    expect(failureMessage({ ...base, stdout: 'only stdout\n' }, undefined)).toBe('only stdout');
    expect(failureMessage(base, undefined)).toBe('lody exited with code 1');
    expect(failureMessage({ ...base, exitCode: null, signal: 'SIGKILL' }, undefined)).toBe(
      'lody exited with signal SIGKILL'
    );
  });
});

describe('CliLodyClient', () => {
  it('lists sessions and keeps SessionMeta fields untouched', async () => {
    const session = {
      id: 's1',
      createdAt: '2026-10-01T00:00:00.000Z',
      pullRequests: [{ url: 'https://github.com/o/r/pull/1', status: 'open' }],
      'prLifecycle:machine:https://github.com/o/r/pull/1': { s: 'merged', u: 5 },
    };
    const { runner, calls } = fakeRunner([
      { stdout: `info: log\n${json({ ok: true, workspaceId: 'w1', sessions: [session] })}` },
    ]);
    const result = await new CliLodyClient(runner).listSessions('w', { all: true });
    expect(calls[0]?.args).toEqual(['session', 'list', '--json', '--workspace=w', '--all']);
    expect(result).toEqual({ workspaceId: 'w1', sessions: [session] });
  });

  it('throws LodyCliError with the CLI message on ok:false', async () => {
    const { runner } = fakeRunner([{ exitCode: 1, stdout: json({ ok: false, error: 'Session not found: s1' }) }]);
    await expect(new CliLodyClient(runner).showSession('s1', undefined)).rejects.toMatchObject({
      name: 'LodyCliError',
      message: 'Session not found: s1',
      exitCode: 1,
    });
  });

  it('treats a non-zero exit without JSON as a failure using stderr', async () => {
    const { runner } = fakeRunner([{ exitCode: 1, stderr: 'Error: boom\n' }]);
    await expect(new CliLodyClient(runner).showSession('s1', undefined)).rejects.toMatchObject({
      message: 'Error: boom',
    });
  });

  it('rejects output that does not match the contract with 502', async () => {
    const { runner } = fakeRunner([{ stdout: json({ ok: true, sessions: 'nope' }) }]);
    await expect(new CliLodyClient(runner).listSessions(undefined, {})).rejects.toMatchObject({
      status: 502,
      code: 'lody_cli_bad_output',
    });
  });

  it('sends chat prompts on stdin', async () => {
    const { runner, calls } = fakeRunner([
      { stdout: json({ ok: true, sessionId: 's1', workspaceId: 'w1', machineId: 'm1', userTurnId: 'u1' }) },
    ]);
    const output = await new CliLodyClient(runner).chat({ sessionId: 's1', workspace: undefined, prompt: '-p hi' });
    expect(output.userTurnId).toBe('u1');
    expect(calls[0]).toEqual({
      args: ['session', 'chat', 's1', '--prompt-file=-', '--json'],
      options: { stdin: '-p hi' },
    });
  });

  it('chatAndWait returns the completed turn and allows extra time beyond --timeout', async () => {
    const { runner, calls } = fakeRunner([
      {
        stdout: json({
          ok: true,
          sessionId: 's1',
          workspaceId: 'w1',
          machineId: 'm1',
          userTurnId: 'u1',
          turnId: 'a1',
          content: [{ type: 'text', text: 'pong' }],
          durationMs: 1200,
        }),
      },
    ]);
    const result = await new CliLodyClient(runner).chatAndWait({
      sessionId: 's1',
      workspace: 'w',
      prompt: 'ping',
      timeoutSeconds: 30,
    });
    expect(result).toMatchObject({ kind: 'completed', output: { turnId: 'a1', durationMs: 1200 } });
    expect(calls[0]?.args).toContain('--timeout=30');
    expect(calls[0]?.options?.timeoutMs).toBe(30_000 + 90_000);
  });

  it('chatAndWait distinguishes a dispatched turn whose wait failed', async () => {
    const { runner } = fakeRunner([
      {
        exitCode: 1,
        stdout: json({
          ok: false,
          sessionId: 's1',
          userTurnId: 'u1',
          error: 'Timed out waiting for session turn completion after 30s',
        }),
      },
    ]);
    await expect(
      new CliLodyClient(runner).chatAndWait({ sessionId: 's1', workspace: undefined, prompt: 'x', timeoutSeconds: 30 })
    ).resolves.toEqual({
      kind: 'wait_failed',
      sessionId: 's1',
      userTurnId: 'u1',
      message: 'Timed out waiting for session turn completion after 30s',
    });
  });

  it('chatAndWait rethrows failures that happened before dispatch', async () => {
    const { runner } = fakeRunner([
      { exitCode: 1, stdout: json({ ok: false, error: 'Session s1 is archived. Restore it before chatting.' }) },
    ]);
    await expect(
      new CliLodyClient(runner).chatAndWait({ sessionId: 's1', workspace: undefined, prompt: 'x', timeoutSeconds: 30 })
    ).rejects.toBeInstanceOf(LodyCliError);
  });

  it('login never leaks the key in its error', async () => {
    const key = 'lody_cli_supersecret';
    const { runner } = fakeRunner([{ exitCode: 1, stdout: `error: rejected --auth=${key}\n` }]);
    const error = await new CliLodyClient(runner).login(key, 'api').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LodyCliError);
    expect((error as Error).message).not.toContain(key);
  });
});
