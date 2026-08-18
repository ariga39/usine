# Usine

Usine 是一个面向自主软件交付的确定性协调器。它的目标不是让一个 agent 更会写代码，而是让多个项目中的已授权任务在无人持续催促的情况下，有序地经过实现、验证、独立 review 和交付。

当前仓库包含第一条串行交付纵切的可运行实现：`usine run <task-contract.json>` 接收一个已授权且已提交的 Task Contract，通过 PostgreSQL/DBOS 持久化执行，在隔离 Git worktree 中调用 Codex，针对 immutable candidate SHA 运行项目检查和 fresh review，并通过 GitHub App 交付带 exact-SHA approval attestation 的 reviewed PR。它仍是仅面向一个 Task、一个 repository writer 和一个 GitHub forge 的 V0 纵切；历史实现和旧任务分解不属于当前基线。

当前实现的 Herdr/transcript lifecycle 已被真实 settled-without-observation failure证伪，不能视为可靠生产路径。Issue #76 选择以 provider-neutral Coding Session 包住当前 Codex SDK adapter，并在一个 full-refactor PR 中完成六个目标模块；真实 executable task 与 coordinator hard-kill/restart是最终 merge gate，不是其它模块开始重构的前置许可。

运行需要 Node 24、pnpm、Git、Codex CLI 和 PostgreSQL。安装依赖并构建后，通过数据库和 GitHub App 环境配置运行 CLI：

```sh
pnpm install
pnpm build
USINE_DATABASE_URL=postgresql://... \
USINE_GITHUB_APP_ID=... \
USINE_GITHUB_INSTALLATION_ID=... \
USINE_GITHUB_APP_SLUG=... \
USINE_GITHUB_PRIVATE_KEY_PATH=/path/to/app.pem \
USINE_IMPLEMENTER_MODEL=gpt-5.6-luna \
USINE_IMPLEMENTER_PROFILE=usine-implementer \
USINE_REVIEWER_MODEL=gpt-5.6-sol \
node apps/cli/dist/cli.mjs run /path/to/committed-task-contract.json
```

首条纵切只面向受信任的私有仓库。项目检查使用最小显式环境并在 disposable checkout 中运行，但当前仍共享 host 的网络与文件系统权限；更强的容器或 VM 隔离只会在实际风险证明现有 host/Codex sandbox 不足时进入。

当前权威文档只有：

- [`AGENTS.md`](AGENTS.md)：所有 coding agent 必须遵守的工程宪章与 context 恢复协议；
- [`docs/DESIGN.md`](docs/DESIGN.md)：产品目标、边界和当前架构；
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：我们开发 Usine 自身时采用的 Git、并行、依赖、测试和 review 流程；
- [`docs/DECISIONS.md`](docs/DECISIONS.md)：当前生效的技术决策与延期事项的重新进入条件。

GitHub Issue 是开发任务的事实源；每个实现任务使用独立 branch/worktree，并以一个 PR 交付。
