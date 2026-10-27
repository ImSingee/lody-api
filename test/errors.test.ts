import { describe, expect, it } from 'vitest';
import { ApiError, LodyCliError, mapLodyCliError, toApiError } from '../src/errors.js';

const SID = '11111111-2222-4333-8444-555555555555';

describe('mapLodyCliError', () => {
  // Messages copied from the lody CLI sources they come from.
  it.each([
    [`Session not found: ${SID}`, 404, 'session_not_found', false],
    [`Session not found in workspace ws_1: ${SID}`, 404, 'session_not_found', false],
    [`Session ${SID} is archived. Restore it before chatting.`, 409, 'session_archived', false],
    ['Machine m_1 is offline or unreachable: RPC timed out', 503, 'machine_offline', true],
    ['Machine m_1 is offline or unavailable.', 503, 'machine_offline', true],
    ['Machine m_1 is offline or unavailable: not connected', 503, 'machine_offline', true],
    ['Target machine is unavailable in this workspace', 503, 'machine_offline', true],
    ['Machine access denied for m_1: not_shared', 403, 'machine_access_denied', false],
    ['Not logged in. Run `lody login` first.', 503, 'lody_auth_failed', false],
    ['CLI token is invalid or expired. Run `lody login` again.', 503, 'lody_auth_failed', false],
    ['CLI token cannot access this workspace. Run `lody login` again.', 503, 'lody_auth_failed', false],
    ['Invalid API key. Generate a new key and retry.', 503, 'lody_auth_failed', false],
    ['Workspace not found: nope. Candidates: a (a), b (b)', 404, 'workspace_not_found', false],
    ['Workspace selector is ambiguous: x. Matches: …', 400, 'workspace_ambiguous', false],
    ['Multiple workspaces are available; pass --workspace. Candidates: a, b', 400, 'workspace_required', false],
    ['No accessible workspaces found for the current CLI login.', 403, 'workspace_unavailable', false],
    ['Prompt input is empty: -', 400, 'invalid_request', false],
    ['SqliteError: database is locked', 503, 'lody_busy', true],
    [
      'Workspace synchronization is temporarily unavailable. Retry the request and reuse the same operationId when present.',
      503,
      'lody_upstream_unavailable',
      true,
    ],
    [
      'Unable to validate API key because the auth service is unreachable: fetch failed',
      503,
      'lody_upstream_unavailable',
      true,
    ],
    ['TypeError: fetch failed', 503, 'lody_upstream_unavailable', true],
  ])('%s → %i %s', (message, status, code, retryable) => {
    const mapped = mapLodyCliError(new LodyCliError(message, 1));
    expect(mapped).toMatchObject({ status, code, retryable, message });
  });

  it('falls back to 502 lody_cli_error with the exit code', () => {
    const mapped = mapLodyCliError(new LodyCliError('Something unexpected', 3));
    expect(mapped).toMatchObject({ status: 502, code: 'lody_cli_error', details: { exitCode: 3 } });
  });

  it('does not treat a session title mentioning "archived" as an archive error', () => {
    expect(mapLodyCliError(new LodyCliError('Failed to rename: archived things', 1)).code).toBe('lody_cli_error');
  });
});

describe('toApiError', () => {
  it('passes ApiError through, maps LodyCliError and ignores others', () => {
    const apiError = new ApiError(418, 'teapot', 'short and stout');
    expect(toApiError(apiError)).toBe(apiError);
    expect(toApiError(new LodyCliError(`Session not found: ${SID}`, 1))?.status).toBe(404);
    expect(toApiError(new Error('boom'))).toBeUndefined();
  });

  it('renders the response body', () => {
    expect(new ApiError(503, 'machine_offline', 'offline', true).toBody()).toEqual({
      error: { code: 'machine_offline', message: 'offline', retryable: true },
    });
  });
});
