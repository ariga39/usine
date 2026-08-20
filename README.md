# Usine

Usine 是一个面向自主软件交付的确定性协调器。它的目标不是让一个 agent 更会写代码，而是让多个项目中的已授权任务在无人持续催促的情况下，有序地经过实现、验证、独立 review 和交付。

当前仓库包含两类串行交付 evidence：PR #82/#83 提供真实 Codex executable delivery 与 restart recovery；Issue #153 的 server-hosted milestone fixture 使用 stubbed Codex SDK adapter，同时以真实 server process、SQLite、Git、project check、fake GitHub API/bare remote、SIGKILL、fresh activation 和 exact delivery effects 验证 server-owned lifecycle。CLI 只负责启动 server、提交 Task 与读取状态；提交 CLI 退出不会取消已 admission 的工作。它仍是仅面向一个 Task、一个 repository writer 和一个 GitHub forge 的 V0。

Herdr/transcript lifecycle 曾被真实 settled-without-observation failure证伪，现已从 production correctness path 删除。Issue #76 选择以 provider-neutral Coding Session 包住当前 Codex SDK adapter；Issue #80 的实现随后完成六个行为模块，并通过两个 executable TypeScript delivery：正常路径形成 reviewed PR；第二条路径在 durable activation 后 SIGKILL coordinator，以同一 Task ID 重启并用 fresh fence/workspace 完成交付。

运行需要 Node 24、pnpm、Git、Codex 和 GitHub App 配置。状态默认写入目标仓库外的用户状态目录，也可用 `USINE_STATE_DIR` 覆盖。先启动 server：

```sh
vp install
vp run --filter '@usine/cli...' build
USINE_FORGE_PROFILE_RELEASE_APP_ID=123456 \
USINE_FORGE_PROFILE_RELEASE_INSTALLATION_ID=123456 \
USINE_FORGE_PROFILE_RELEASE_APP_SLUG=example-app \
USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH=./app-private-key.pem \
USINE_FORGE_PROFILE_RELEASE_REPOSITORY=example-owner/example-repository \
node apps/cli/dist/cli.mjs server
```

另一个 CLI 进程通过同一 local server 提交并跟随 Task：

```sh
node apps/cli/dist/cli.mjs submit ./committed-task-contract.json
node apps/cli/dist/cli.mjs follow <task-id>
```

完整交付需要为每个已注册 Repository 配置其 `forgeProfile` 对应的 `USINE_FORGE_PROFILE_<PROFILE>_*` GitHub App 变量。配置只在 host runtime 使用；Repository durable facts 保存 profile 名称，不保存凭据。上面的数值、身份、路径和任务文件名都是占位符。

以下配置是可选覆盖；Repository 注册时必须提供 implementer 与 reviewer 的 Codex profile 名称：

- `USINE_STATE_DIR`：状态目录，默认位于用户状态目录下的 `usine` 子目录；
- `USINE_SERVER_HOST`：local server 监听地址，默认 `127.0.0.1`，只接受 loopback host；
- `USINE_SERVER_PORT`：local server 监听端口，默认 `8787`；
- `USINE_SERVER_URL`：client 使用的 server URL，默认 `http://127.0.0.1:8787`；
- `USINE_FORGE_PROFILE_<PROFILE>_GIT_URL`：profile 的 forge Git URL，默认由已注册 Repository 的 owner/name 组成。

Repository validation uses the Vite+ command surface: `vp fmt`, `vp lint`,
`vp check --no-fmt --no-lint`, `corepack pnpm test`, and `vp run --filter '@usine/cli...' build`.
The root `corepack pnpm test` command runs the root public-seam suite and every workspace package
that declares a `test` script. `vp check` combines formatting, linting, and type-checking; the
root TypeScript project continues to include `tests/**/*.ts` in that static coverage.

首条纵切只面向受信任的私有仓库。项目检查使用最小显式环境并在 disposable checkout 中运行，但当前仍共享 host 的网络与文件系统权限；更强的容器或 VM 隔离只会在实际风险证明现有 host/Codex sandbox 不足时进入。

当前权威文档只有：

- [`AGENTS.md`](AGENTS.md)：coding agent 的短入口、恢复顺序与角色约束；
- [`docs/DESIGN.md`](docs/DESIGN.md)：产品目标、边界和当前架构；
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：我们开发 Usine 自身时采用的 Git、并行、依赖、测试和 review 流程；
- [`docs/DECISIONS.md`](docs/DECISIONS.md)：当前生效的技术决策与延期事项的重新进入条件。

GitHub Issue 是开发任务的事实源；每个实现任务使用独立 branch/worktree，并以一个 PR 交付。

`.agents/skills/` 提供按需加载的 task、design、simplification、checks、prose 和 review 方法；它们不覆盖上述 authority 或当前 Issue。
