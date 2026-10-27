# lody-api

把 lody CLI 的 `session list` / `session show` / `session chat` 映射成 HTTP API。服务以子进程方式调用 npm 上的 `lody`（cloud 构建，版本在 `package.json` 中锁定），不需要本机 daemon，消息通过云端 RPC 发到目标机器执行。

## 配置

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `API_KEYS` | 是 | — | 本服务的 Bearer Key，逗号分隔（便于轮换），每个至少 16 字符 |
| `LODY_CLI_API_KEY` | 首次启动必填 | — | Lody CLI API key。启动时执行 `lody login --auth`；凭据已是该 key 时跳过。不能用一次性的 `lody_pair_` token |
| `LODY_WORKSPACE` | 多 workspace 时必填 | — | 默认 workspace（id / slug / name），请求可用 `?workspace=` 覆盖 |
| `LODY_DATA_DIR` | | `/data/lody`（镜像） | lody 凭据与 Loro 缓存 |
| `API_DATA_DIR` | | `/data/api`（镜像） | turn 记录与幂等键（SQLite） |
| `PORT` / `HOST` | | `8080` / `0.0.0.0` | |
| `LODY_MACHINE_NAME` | | `lody-api` | 登录时登记的机器名 |
| `LODY_CLI_CONCURRENCY` / `LODY_CLI_QUEUE_LIMIT` | | `4` / `64` | 同时运行的 CLI 进程数 / 排队上限（满了返回 429） |
| `LODY_CLI_TIMEOUT_MS` | | `120000` | 单条 CLI 命令硬超时（同步等待另计） |
| `SESSION_LIST_CACHE_TTL_MS` / `SESSION_LIST_CACHE_MAX_ENTRIES` | | `15000` / `32` | 列表快照缓存 |
| `SYNC_WAIT_DEFAULT_SECONDS` / `SYNC_WAIT_MAX_SECONDS` | | `120` / `300` | `wait=true` 的默认 / 最大等待 |
| `TURN_POLL_MAX_WAIT_SECONDS` | | `60` | 轮次长轮询上限 |
| `TURN_TRACK_MAX_AGE_HOURS` / `MAX_OBSERVERS` | | `24` / `32` | turn 跟踪时长上限 / 同时运行的 observe 进程数 |
| `LOG_LEVEL` | | `info` | JSON 日志级别 |

## 接口

除 `/healthz`、`/readyz`、`/version` 外都需要 `Authorization: Bearer <API_KEYS 中任一>`。错误统一为 `{"error":{"code","message","retryable"}}`。所有接口都接受 `?workspace=`。

### `GET /version`、`GET /healthz`

这两个接口不需要认证。`/version` 返回 `{name, version, commit, commitTime, lodyCliVersion}`，`/healthz` 返回 `{ok, version, commit}`。`commit` 和 `commitTime` 由 CI 在构建镜像时写入（见下文「镜像」）；本地构建时为 `null`。

### `GET /v1/sessions`

过滤参数与 `lody session list` 一一对应：`archived`、`all`（二者互斥）、`openedBy`、`query`、`machineId`、`agentConfigId`、`agentRoleId`。分页：`limit`（1–200，默认 50）、`cursor`、`sort=created|activity`（默认 `created`）、`fresh=true`（跳过缓存）。未知参数返回 400。

```jsonc
{
  "workspaceId": "...",
  "sessions": [ /* lody 原样输出的 SessionMeta，含 pullRequests / pullRequestState / prLifecycle:* */ ],
  "pageInfo": { "limit": 50, "hasMore": true, "nextCursor": "eyJ2Ijox..." },
  "snapshot": { "syncedAt": "...", "cached": true, "total": 253 }
}
```

- `SessionMeta` 只保证有 `id`，真实数据里存在没有 `createdAt` 的会话。
- `pullRequests[].status` 可能落后于 `prLifecycle:{machine|webhook}:<url>`：两者都存在时取 `u` 更大者的 `s`。
- `sort=created` 按 `createdAt` 倒序、`id` 倒序。翻页期间已存在的会话不漏不重，新会话只出现在最前面。`sort=activity` 与 CLI 的顺序相同，但翻页期间产生新消息的会话可能被跳过。
- cursor 绑定了 workspace、过滤条件和排序，换了任意一项会返回 400 `cursor_mismatch`。

### `GET /v1/sessions/:id`

对应 `session show`。`live=true` 会再执行一次 `session status`，在响应里加上 `live`（`machineOnline`、`liveStatus` 等）。探测失败不影响整个请求，而是在 `liveError` 中返回原因。

### `POST /v1/sessions/:id/messages`

```jsonc
{ "prompt": "...", "wait": false, "timeoutSeconds": 120 }
```

可选请求头 `Idempotency-Key`：用相同的 key 重试，会直接返回同一轮，不会重复发送；同一个 key 换了请求内容，返回 422。

| 场景 | 状态码 | 说明 |
|---|---|---|
| `wait=false` | 202 | turn 状态为 `pending`，响应头 `Location` 指向下面的轮次查询接口 |
| `wait=true`，正常结束 | 200 | turn 为 `completed`、`failed` 或 `canceled`，`reply` 中有 `text` 和原始 `content` |
| `wait=true`，等待超时 | 202 | `waitTimedOut: true`。这一轮仍在机器上执行，服务会继续跟踪它 |

### `GET /v1/sessions/:id/turns/:turnId`

`waitSeconds=0..60` 用于长轮询：轮次进入终态就立即返回。

```jsonc
{ "turn": { "id", "sessionId", "workspace", "state": "pending|running|completed|failed|canceled|unknown",
            "assistantTurnId", "reply": { "text", "content?" } | null, "error": { "code", "message" } | null,
            "durationMs", "submittedAt", "finishedAt", "updatedAt" } }
```

- 不是通过本服务发出的轮次也能查到：最新一轮和进行中的轮次能拿到真实状态；更早的轮次 CLI 不再提供结果，返回 `unknown`，错误码为 `outcome_unavailable`。
- 异步跟踪到的 `failed` 没有具体原因，因为 CLI 只会把失败原因告诉 `--wait` 的调用方。需要失败原因时，请用 `wait=true` 发送。

### 错误码

| code | HTTP | 含义 |
|---|---|---|
| `unauthorized` | 401 | API Key 缺失或错误 |
| `invalid_request` / `invalid_json` / `invalid_cursor` / `cursor_mismatch` | 400 | 参数错误 |
| `workspace_required` / `workspace_ambiguous` | 400 | 有多个 workspace，需要传 `workspace` |
| `machine_access_denied` / `workspace_unavailable` | 403 | 没有访问权限 |
| `session_not_found` / `turn_not_found` / `workspace_not_found` | 404 | 资源不存在 |
| `session_archived` | 409 | 会话已归档，需先恢复 |
| `idempotency_key_reused` | 422 | 同一个 key 用于不同的请求 |
| `busy` | 429 | CLI 排队已满，可重试 |
| `lody_cli_error` / `lody_cli_bad_output` / `lody_output_too_large` | 502 | CLI 返回了无法识别的结果 |
| `machine_offline` | 503 | 目标机器离线，可重试 |
| `lody_auth_failed` | 503 | Lody 凭据失效，`/readyz` 同时变红 |
| `lody_busy` / `lody_upstream_unavailable` | 503 | 本地锁冲突或 Lody 云端不可用，可重试 |
| `lody_cli_timeout` | 504 | CLI 超过硬超时被 kill |

`session_not_found`、`session_archived`、`machine_access_denied`、`machine_offline` 这几个错误都发生在 CLI 写入消息之前，所以返回这些错误时一定没有发出任何消息，可以放心重试。

## 本地开发

lody 要求 Node ≥ 24.22.1（或 22.23.4 / 26.12.1），并且依赖 glibc。

```sh
pnpm install
pnpm test          # 单元测试，CLI 子进程用 mock / 假脚本替代
pnpm typecheck
pnpm build && API_KEYS=... LODY_CLI_API_KEY=... LODY_WORKSPACE=... pnpm start
```

本机 Node 版本不够时，直接用镜像运行：

## 镜像

`.github/workflows/docker.yml` 与 hatch（`ImSingee/my-space`）的镜像流程一致：

- **触发条件**：push 到 `main`/`master`、push `v*` tag、针对 `main`/`master` 的 PR，以及手动触发（`workflow_dispatch`）。
- **镜像地址**：`ghcr.io/<owner>/<repo>`，即 `ghcr.io/imsingee/lody-api`，只构建 `linux/amd64`。
- **tag 规则**：每次都会打短 commit sha。另外：
  - push 分支：打分支名，如 `main`。
  - push `v1.2.3` 这类 tag：打 `1.2.3`、`1.2` 和 `latest`。只有非预发布版本才会打 `latest`，推送 `main` 不会。
  - PR：打 `pr-<n>`。
- **PR**：来自 fork 或 dependabot 的 PR 只构建不推送，其余 PR 会推送 `pr-<n>`。认证只用内置的 `GITHUB_TOKEN`。
- **版本信息**：CI 用 `git rev-parse HEAD` 和 `git show -s --format=%cI HEAD` 取得 commit sha 和提交时间，通过 build-arg `LODY_API_BUILD_COMMIT` / `LODY_API_BUILD_COMMIT_TIME` 传入镜像。Dockerfile 在运行层把它们转成同名环境变量，由 `/version` 和 `/healthz` 返回。

本地构建：

```sh
docker build -t lody-api .
docker run -d --name lody-api -p 8080:8080 -v lody-api-data:/data \
  -e API_KEYS=... -e LODY_CLI_API_KEY=... -e LODY_WORKSPACE=... lody-api
```

- `/data` 必须挂持久卷：里面有 lody 凭据、Loro 缓存（避免每次全量同步）和 turn 记录（重启后会继续跟踪未完成的轮次）。
- 镜像以 `node` 用户（uid 1000）运行。如果挂载的是宿主机目录，需要确保这个用户有写权限。
- `pnpm-workspace.yaml` 禁止了 `better-sqlite3` 的 node-gyp 构建：它的包里已经自带各平台的预编译二进制，slim 镜像里也没有编译工具链。
