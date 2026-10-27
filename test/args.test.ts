import { describe, expect, it } from 'vitest';
import {
  assertId,
  loginArgs,
  sessionChatArgs,
  sessionHistoryArgs,
  sessionListArgs,
  sessionObserveFollowArgs,
  sessionObserveSnapshotArgs,
  sessionShowArgs,
  sessionStatusArgs,
} from '../src/lody/args.js';

describe('sessionListArgs', () => {
  it('builds the bare command', () => {
    expect(sessionListArgs(undefined, {})).toEqual(['session', 'list', '--json']);
  });

  it('passes every CLI filter through one to one', () => {
    expect(
      sessionListArgs('team', {
        all: true,
        openedBy: 'sess-1',
        query: 'fix bug',
        machineId: 'm-1',
        agentConfigId: 'ac-1',
        agentRoleId: 'role-1',
      })
    ).toEqual([
      'session',
      'list',
      '--json',
      '--workspace=team',
      '--all',
      '--opened-by=sess-1',
      '--query=fix bug',
      '--machine-id=m-1',
      '--agent-config-id=ac-1',
      '--agent-role-id=role-1',
    ]);
    expect(sessionListArgs(undefined, { archived: true })).toEqual(['session', 'list', '--json', '--archived']);
  });

  it('omits false booleans', () => {
    expect(sessionListArgs(undefined, { archived: false, all: false })).toEqual(['session', 'list', '--json']);
  });

  it('keeps option-looking values attached to their flag', () => {
    expect(sessionListArgs('--all', { query: '--archived' })).toEqual([
      'session',
      'list',
      '--json',
      '--workspace=--all',
      '--query=--archived',
    ]);
  });

  it('rejects empty, oversized or NUL values', () => {
    expect(() => sessionListArgs(undefined, { query: '' })).toThrow(/Invalid value for --query/);
    expect(() => sessionListArgs(undefined, { query: 'x'.repeat(513) })).toThrow(/--query/);
    expect(() => sessionListArgs(undefined, { machineId: 'a\0b' })).toThrow(/--machine-id/);
  });
});

describe('id validation', () => {
  it('accepts lody ids', () => {
    expect(assertId('session id', '11111111-2222-4333-8444-555555555555')).toBe('11111111-2222-4333-8444-555555555555');
    expect(assertId('turn id', 'msg_01H.x:y')).toBe('msg_01H.x:y');
  });

  it.each(['', '-x', '--all', 'a b', 'a/b', 'x'.repeat(201), 'é'])('rejects %j', (value) => {
    expect(() => assertId('session id', value)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_request' }));
  });
});

describe('session command args', () => {
  it('show / status / observe put the id first and the workspace as a flag', () => {
    expect(sessionShowArgs('s1', 'w')).toEqual(['session', 'show', 's1', '--json', '--workspace=w']);
    expect(sessionStatusArgs('s1', undefined)).toEqual(['session', 'status', 's1', '--json']);
    expect(sessionObserveSnapshotArgs('s1', undefined)).toEqual(['session', 'observe', 's1', '--json']);
    expect(sessionObserveFollowArgs('s1', 'w')).toEqual([
      'session',
      'observe',
      's1',
      '--jsonl',
      '--follow',
      '--workspace=w',
    ]);
  });

  it('chat reads the prompt from stdin and only waits when asked', () => {
    expect(sessionChatArgs({ sessionId: 's1', workspace: undefined })).toEqual([
      'session',
      'chat',
      's1',
      '--prompt-file=-',
      '--json',
    ]);
    expect(sessionChatArgs({ sessionId: 's1', workspace: 'w', wait: { timeoutSeconds: 120 } })).toEqual([
      'session',
      'chat',
      's1',
      '--prompt-file=-',
      '--json',
      '--workspace=w',
      '--wait',
      '--timeout=120',
    ]);
  });

  it('chat rejects a non-positive timeout', () => {
    expect(() => sessionChatArgs({ sessionId: 's1', workspace: undefined, wait: { timeoutSeconds: 0 } })).toThrow();
    expect(() => sessionChatArgs({ sessionId: 's1', workspace: undefined, wait: { timeoutSeconds: 1.5 } })).toThrow();
  });

  it('chat rejects an invalid session id before spawning', () => {
    expect(() => sessionChatArgs({ sessionId: '--help', workspace: undefined })).toThrow(/Invalid session id/);
  });

  it('history uses --limit or --all', () => {
    expect(sessionHistoryArgs('s1', undefined, { limit: 50 })).toEqual(['session', 'history', 's1', '--json', '--limit=50']);
    expect(sessionHistoryArgs('s1', 'w', { all: true })).toEqual([
      'session',
      'history',
      's1',
      '--json',
      '--workspace=w',
      '--all',
    ]);
  });

  it('login passes the key and machine name as attached flags', () => {
    expect(loginArgs('lody_cli_x', 'api')).toEqual(['login', '--auth=lody_cli_x', '--machine-name=api']);
  });
});
