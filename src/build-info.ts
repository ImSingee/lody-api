import { readFileSync } from 'node:fs';

export type BuildInfo = {
  name: string;
  version: string;
  /** Source commit baked in by CI (`LODY_API_BUILD_COMMIT` build arg); null in local builds. */
  commit: string | null;
  /** ISO 8601 commit time (`LODY_API_BUILD_COMMIT_TIME` build arg); null in local builds. */
  commitTime: string | null;
  /** Version of the bundled lody CLI. */
  lodyCliVersion: string | null;
};

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readBuildInfo(
  env: NodeJS.ProcessEnv,
  manifest: { name?: string; version?: string },
  lodyCliVersion: string | null
): BuildInfo {
  return {
    name: manifest.name ?? 'lody-api',
    version: manifest.version ?? '0.0.0',
    commit: nonEmpty(env.LODY_API_BUILD_COMMIT),
    commitTime: nonEmpty(env.LODY_API_BUILD_COMMIT_TIME),
    lodyCliVersion,
  };
}

/** This package's manifest; `src/` and `dist/` both sit one level below it. */
export function readOwnManifest(): { name?: string; version?: string } {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name?: string;
    version?: string;
  };
}
