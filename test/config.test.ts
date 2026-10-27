import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEY = 'k'.repeat(16);

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ API_KEYS: KEY });
    expect(config).toMatchObject({ PORT: 8080, LODY_MACHINE_NAME: 'lody-api', SYNC_WAIT_MAX_SECONDS: 300 });
    expect(config.LODY_WORKSPACE).toBeUndefined();
  });

  it('treats empty variables as unset, as compose passes them', () => {
    const config = loadConfig({
      API_KEYS: KEY,
      LODY_WORKSPACE: '',
      LODY_CLI_API_KEY: '',
      LODY_MACHINE_NAME: '',
      PORT: '',
      LOG_LEVEL: '',
    });
    expect(config.LODY_WORKSPACE).toBeUndefined();
    expect(config.LODY_CLI_API_KEY).toBeUndefined();
    expect(config).toMatchObject({ LODY_MACHINE_NAME: 'lody-api', PORT: 8080, LOG_LEVEL: 'info' });
  });

  it('splits and validates API_KEYS', () => {
    expect(loadConfig({ API_KEYS: ` ${KEY} ,, ${KEY}x ` }).API_KEYS).toEqual([KEY, `${KEY}x`]);
    expect(() => loadConfig({})).toThrow(/API_KEYS/);
    expect(() => loadConfig({ API_KEYS: '' })).toThrow(/API_KEYS/);
    expect(() => loadConfig({ API_KEYS: 'short' })).toThrow(/at least 16/);
  });

  it('rejects a sync wait default above its maximum', () => {
    expect(() =>
      loadConfig({ API_KEYS: KEY, SYNC_WAIT_DEFAULT_SECONDS: '400', SYNC_WAIT_MAX_SECONDS: '300' })
    ).toThrow(/SYNC_WAIT_DEFAULT_SECONDS/);
  });
});
