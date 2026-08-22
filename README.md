# Usine

Usine 是一个面向自主软件交付的确定性协调器。它的目标不是让一个 agent 更会写代码，而是让多个项目中的已授权任务在无人持续催促的情况下，有序地经过实现、验证、独立 review，并在 Task Contract 明确授权时合并 exact approved head。

当前 V0 由六个 provider-independent 行为模块组成：Task Authority、Delivery Run、Coding Session、Candidate Workspace、Quality Gate 和 Forge Delivery。PR #82/#83 是真实 Codex executable delivery 与 restart evidence；Issue #153 是使用 stubbed Codex adapter 的 server-hosted lifecycle fixture，不能证明 production Codex turn。Issue #199 增加了显式 merge authority 下的 exact-head `merged` terminal；没有该 authority 的任务仍在 `reviewed_pr` 停止。产品路径仍是单 Task、每个 repository 一个 writer lease 和一个 GitHub forge；Herdr、transcript 和 agent prose 不拥有完成 authority。

当前方向是 `correct_before_expansion`：#192/#193 已合并；#199 保留授权 exact-head merge 的 hermetic/server evidence，但不证明 production merge；#176 已关闭为 falsified——真实 pilot 需要四个 Task Contract，未证明 one-contract/same-ID acceptance，其目标 PR 已交付并手工合并；#195 已证明 bounded local app-server runtime outcome 与静态 opaque profile composition；app-server 不能取得 Task authority。其它 eligible work 以 canonical design 的当前状态 ledger 为准。

运行需要 Node 24、pnpm、Git、Codex 和 GitHub App 配置。状态默认写入目标仓库外的用户状态目录，也可用 `USINE_STATE_DIR` 覆盖。先启动 server：

```sh
vp install
vp run --filter '@usine/cli...' build
USINE_FORGE_PROFILE_RELEASE_APP_ID=123456 \
USINE_FORGE_PROFILE_RELEASE_INSTALLATION_ID=123456 \
USINE_FORGE_PROFILE_RELEASE_APP_SLUG=example-app \
USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH=./app-private-key.pem \
USINE_FORGE_PROFILE_RELEASE_REPOSITORY=example-owner/example-repository \
USINE_ROLE_OUTPUT_API_KEY=placeholder-coordinator-key \
USINE_ROLE_OUTPUT_API_URL=https://placeholder.invalid/v1 \
USINE_ROLE_OUTPUT_MODEL=placeholder-normalization-model \
node apps/cli/dist/cli.mjs server
```

另一个 CLI 进程必须先注册 Repository，再通过同一 local server 发现并跟随 Task：

```sh
node apps/cli/dist/cli.mjs register ./repository-registration.json
node apps/cli/dist/cli.mjs server health
node apps/cli/dist/cli.mjs server snapshot
node apps/cli/dist/cli.mjs repository list
node apps/cli/dist/cli.mjs repository get <repository-id>
node apps/cli/dist/cli.mjs submit ./committed-task-contract.json
node apps/cli/dist/cli.mjs task list
node apps/cli/dist/cli.mjs task get <task-id>
node apps/cli/dist/cli.mjs task history --after <sequence> <task-id>
node apps/cli/dist/cli.mjs task watch --after <sequence> <task-id>
```

Operator reads use `server health|snapshot`, `repository list|get`, and `task list|get|history|watch`. Human-readable output is the default; append `--json` for stable machine-readable resources. Watch and history accept recognized options before or after the Task ID. The existing `register` and `submit` commands remain the mutation entry points. `inspect` is a compatibility alias for `repository get`, while `status` and `follow` are compatibility aliases for `task get` and `task watch`; their output is the same safe resource projection and never includes repository paths or private policy facts.

CLI exit codes are stable: usage `2`, not-found `3`, timeout `4`, connection `5`, server `6`, and validation `7`. Invalid task contracts and server-side validation now use `7`; callers that previously treated those failures as usage must migrate their checks.

完整交付需要为每个已注册 Repository 配置其 `forgeProfile` 对应的 `USINE_FORGE_PROFILE_<PROFILE>_*` GitHub App 变量。配置只在 host runtime 使用；Repository durable facts 保存 profile 名称，不保存凭据。上面的数值、身份、路径和任务文件名都是占位符。

需要 bounded GitHub read context 的 Repository 可以另外注册 opaque `githubReadProfile`。host 使用 `USINE_GITHUB_READ_PROFILE_<PROFILE>_*` 配置解析独立的 read-only GitHub capability；其中 repository binding、implementer/reviewer tool allowlists 和 credentials 都属于 host 配置，不进入 public Repository resources 或 Task snapshots。当前 activation 的 official Streamable HTTP MCP 只绑定 frozen Repository + Issue；PR/review/check reads 只有实际 caller 提供 authorized delivered-PR fact 时才启用。read credentials 与 Forge credentials 分离，永不进入 worker environment、prompt、MCP config 或 durable observations。

以下配置是可选覆盖；Repository 注册时必须提供 implementer 与 reviewer 的 Codex profile 名称：

- `USINE_STATE_DIR`：状态目录，默认位于用户状态目录下的 `usine` 子目录；
- `USINE_SERVER_HOST`：local server 监听地址，默认 `127.0.0.1`，只接受 loopback host；
- `USINE_SERVER_PORT`：local server 监听端口，默认 `8787`；
- `USINE_SERVER_URL`：client 使用的 server URL，默认 `http://127.0.0.1:8787`；
- `USINE_FORGE_PROFILE_<PROFILE>_GIT_URL`：profile 的 forge Git URL，默认由已注册 Repository 的 owner/name 组成。
- `USINE_GITHUB_READ_PROFILE_<PROFILE>_REPOSITORY`：read profile 允许访问的 `owner/name`，必须与注册 Repository 一致；其它 `USINE_GITHUB_READ_PROFILE_<PROFILE>_*` 变量只在 host runtime 解析，具体 credential mode 与 role tool allowlists 由 profile 配置提供。
- `USINE_ROLE_OUTPUT_API_KEY`、`USINE_ROLE_OUTPUT_API_URL`、`USINE_ROLE_OUTPUT_MODEL`：协调器用于规范化非直接 JSON role output 的 OpenAI-compatible API 配置；三项必须同时提供，示例中的值均为占位符。

Repository validation uses the Vite+ command surface: `vp fmt`, `vp lint`,
`vp check --no-fmt --no-lint`, `corepack pnpm test`, and `vp run --filter '@usine/cli...' build`.
The root `corepack pnpm test` command runs the root public-seam suite and every workspace package
that declares a `test` script. `vp check` combines formatting, linting, and type-checking; the
root TypeScript project continues to include `tests/**/*.ts` in that static coverage.

首条纵切只面向受信任的私有仓库。项目检查在 candidate 的 disposable exact-SHA checkout 中以 reduced explicit environment 运行，仍共享 host 的文件系统与网络权限；只有 Forge credentials 不传入该环境。更强的容器或 VM 隔离只会在实际风险证明现有 host/Codex permissions 不足时进入。

当前权威文档只有：

- [`AGENTS.md`](AGENTS.md)：coding agent 的短入口、恢复顺序与角色约束；
- [`docs/DESIGN.md`](docs/DESIGN.md)：产品目标、边界和当前架构；
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：我们开发 Usine 自身时采用的 Git、并行、依赖、测试和 review 流程；
- [`docs/DECISIONS.md`](docs/DECISIONS.md)：当前生效的技术决策与延期事项的重新进入条件。

GitHub Issue 是开发任务的事实源；每个实现任务使用独立 branch/worktree，并以一个 PR 交付。

`.agents/skills/` 提供按需加载的 task、design、simplification、checks、prose 和 review 方法；它们不覆盖上述 authority 或当前 Issue。
