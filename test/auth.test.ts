import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LodyCliError } from '../src/errors.js';
import { LodyAuth } from '../src/lody/auth.js';

describe('LodyAuth', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(saved: string | undefined, apiKey: string | undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), 'lody-api-auth-'));
    dirs.push(dir);
    if (saved !== undefined) writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ version: 3, token: saved }));
    const client = {
      login: vi.fn(async () => {}),
      listWorkspaces: vi.fn(async () => ({ ok: true as const, workspaces: [{ id: 'w1', slug: 'team' }] })),
    };
    const clock = { t: 0 };
    const auth = new LodyAuth(client, { apiKey, machineName: 'api', dataDir: dir, checkTtlMs: 1_000, now: () => clock.t });
    return { auth, client, clock };
  }

  it('skips login when the saved token is the configured key', async () => {
    const { auth, client } = setup('lody_cli_a', 'lody_cli_a');
    await auth.ensureLogin();
    expect(client.login).not.toHaveBeenCalled();
  });

  it('logs in when no credentials exist or the key changed', async () => {
    const fresh = setup(undefined, 'lody_cli_a');
    await fresh.auth.ensureLogin();
    expect(fresh.client.login).toHaveBeenCalledWith('lody_cli_a', 'api');
    const rotated = setup('lody_cli_old', 'lody_cli_new');
    await rotated.auth.ensureLogin();
    expect(rotated.client.login).toHaveBeenCalledWith('lody_cli_new', 'api');
  });

  it('uses saved credentials without a key, and fails without both', async () => {
    await expect(setup('lody_cli_a', undefined).auth.ensureLogin()).resolves.toBeUndefined();
    await expect(setup(undefined, undefined).auth.ensureLogin()).rejects.toThrow(/LODY_CLI_API_KEY/);
  });

  it('reports readiness from `workspace list`, cached for the TTL', async () => {
    const { auth, client, clock } = setup('k', 'k');
    expect(await auth.check()).toMatchObject({ ready: true, workspaces: [{ id: 'w1', slug: 'team' }] });
    await auth.check();
    expect(client.listWorkspaces).toHaveBeenCalledTimes(1);
    clock.t = 1_000;
    await auth.check();
    expect(client.listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('logs in again once when the CLI says the credentials are gone', async () => {
    const { auth, client } = setup('k', 'k');
    client.listWorkspaces.mockRejectedValueOnce(new LodyCliError('Not logged in. Run `lody login` first.', 1));
    expect(await auth.check()).toMatchObject({ ready: true });
    expect(client.login).toHaveBeenCalledTimes(1);
  });

  it('reports not ready with a mapped code', async () => {
    const { auth, client } = setup('k', undefined);
    client.listWorkspaces.mockRejectedValueOnce(new LodyCliError('TypeError: fetch failed', 1));
    expect(await auth.check()).toMatchObject({
      ready: false,
      error: { code: 'lody_upstream_unavailable', message: 'TypeError: fetch failed' },
    });
  });
});
