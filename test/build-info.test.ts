import { describe, expect, it } from 'vitest';
import { readBuildInfo, readOwnManifest } from '../src/build-info.js';

describe('build info', () => {
  it('reads the commit build args from the environment', () => {
    expect(
      readBuildInfo(
        { LODY_API_BUILD_COMMIT: ' 0123abcd ', LODY_API_BUILD_COMMIT_TIME: '2026-10-27T09:00:00+00:00' },
        { name: 'lody-api', version: '1.2.3' },
        '0.108.1'
      )
    ).toEqual({
      name: 'lody-api',
      version: '1.2.3',
      commit: '0123abcd',
      commitTime: '2026-10-27T09:00:00+00:00',
      lodyCliVersion: '0.108.1',
    });
  });

  it('reports null for local builds, where the build args are empty or unset', () => {
    const info = readBuildInfo({ LODY_API_BUILD_COMMIT: '', LODY_API_BUILD_COMMIT_TIME: '  ' }, {}, null);
    expect(info).toEqual({ name: 'lody-api', version: '0.0.0', commit: null, commitTime: null, lodyCliVersion: null });
  });

  it('reads this package manifest', () => {
    expect(readOwnManifest()).toMatchObject({ name: 'lody-api' });
  });
});
