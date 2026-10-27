import { toApiError } from '../errors.js';
import type { LodyClient } from '../lody/client.js';
import type { SessionMeta, SessionStatusOutput } from '../lody/schemas.js';

export type SessionDetail = {
  workspace: Record<string, unknown> & { id: string };
  session: SessionMeta;
  historyCount: number;
  latestHistoryAt: string | null;
  messageQueueCount: number;
  live?: Omit<SessionStatusOutput, 'ok' | 'workspace' | 'sessionId'>;
  liveError?: { code: string; message: string; retryable: boolean };
};

export class SessionDetailService {
  constructor(private readonly client: Pick<LodyClient, 'showSession' | 'sessionStatus'>) {}

  /**
   * `live` adds `lody session status`, which probes the session's machine over
   * RPC. A failed probe does not fail the request: the stored metadata is still
   * valid, so the probe failure is reported next to it.
   */
  async get(sessionId: string, workspace: string | undefined, live: boolean): Promise<SessionDetail> {
    const [shown, status] = await Promise.all([
      this.client.showSession(sessionId, workspace),
      live
        ? this.client.sessionStatus(sessionId, workspace).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error })
          )
        : undefined,
    ]);

    const detail: SessionDetail = {
      workspace: shown.workspace,
      session: shown.session,
      historyCount: shown.historyCount,
      latestHistoryAt: shown.latestHistoryAt ?? null,
      messageQueueCount: shown.messageQueueCount,
    };
    if (status?.ok) {
      const { ok: _ok, workspace: _workspace, sessionId: _sessionId, ...rest } = status.value;
      detail.live = rest;
    } else if (status) {
      const mapped = toApiError(status.error);
      if (!mapped) throw status.error;
      detail.liveError = { code: mapped.code, message: mapped.message, retryable: mapped.retryable };
    }
    return detail;
  }
}
