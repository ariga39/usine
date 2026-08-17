---
status: current
updated: 2026-08-17
issue: https://github.com/ariga39/usine/issues/1
---

# 当前决策

这里只记录当前生效且会影响实现边界的决策。历史讨论和被否决方案不与当前决策并列；要改变一项决策，必须在新 Issue/PR 中写明 `supersedes`、原因和对现有边界的影响。

| ID | 当前决定 | 理由 |
|---|---|---|
| D-001 | 优化 valid/valuable delivery outcomes 与 human attention，而不是内部产物数量 | 防止 300 PR/day 退化成刷提交、刷测试或刷 task。 |
| D-002 | 顶层是确定性 coordinator，不是永久 Lead LLM | 有序激发、恢复、权限和 gate 必须可审计；LLM 只做 bounded semantic work。 |
| D-003 | TypeScript、Node 24、pnpm monorepo | 与 Codex/DBOS/Octokit 生态一致；monorepo 便于建立明确 module ownership 和并排 worktree。 |
| D-004 | 使用 DBOS TypeScript SDK + PostgreSQL 提供 durable workflow、queue、timer 和 restart recovery | 不再手写 scheduler、outbox、retry loop 或 SQLite 恢复系统。 |
| D-005 | 领域数据默认使用 Prisma ORM + Prisma Migrate，并优先使用 DBOS Prisma datasource | 减少原始 SQL、repository boilerplate、migration/transaction 重复实现。 |
| D-006 | V0 只有 Codex runtime adapter；默认 implementation width 使用 DeepSeek V4 Flash，无法使用时选择 Luna；高杠杆 spec/诊断/review 可使用 Sol/Terra/Luna | 统一 runtime seam，保留已有订阅经济性，不让 provider 接入阻塞 coordinator。 |
| D-007 | Codex adapter 初期通过受控 subprocess + structured output 接入 | Node subprocess/Execa 是最小稳定边界；ACP 只有在稳定协议能显著改善 session resume、streaming 或 capability negotiation 时才进入。 |
| D-008 | 初期每 repository 一个 writer，跨 repository 并发 | 符合个人多项目工作形态，先消除最昂贵的冲突和 communication overhead。 |
| D-009 | Candidate、checks、review 和 approval 全部绑定 immutable exact SHA | 防止 stale evidence 和“agent 说完成了”成为交付依据。 |
| D-010 | Reviewer 必须 fresh、可读取完整 codebase，并提交 explicit verdict；review run 完成与 approval 是两个事实 | 保留独立判断，同时区分 pipeline success 和语义批准。 |
| D-011 | GitHub 是当前 forge/delivery surface；使用 Octokit + GitHub App 短期 installation token | 现有 private repos 已安装 App；不再把凭据和 API 轮换手写到每个 agent。 |
| D-012 | 第一项产品行为终止于 reviewed PR；自动 merge 位于同一 exact-head gate 后的后续 authority adapter | 先证明完整 review delivery；不把 merge 权限阻塞核心，但也不放弃最终自动 merge。 |
| D-013 | Codex sandbox/host permissions 是默认 isolation；worker 无 delivery credential | 在 macOS/Linux 上先使用已存在能力，容器不是默认前置。 |
| D-014 | GitHub Issue → branch/worktree → PR 是开发 Usine 自身的唯一任务流；主编排者最多并排两个独立 implementation PR | 让 Git 成为恢复、所有权和 integration 基础，并把并排开发变成真实工作树隔离。 |
| D-015 | Canonical files + Issue/Git bootstrap 是 context 恢复真相；主编排 profile 可使用更大 window，worker/reviewer 使用 task-sized context | Window 只减少 compact，不替代 durable principles；分角色 context 降低旧讨论污染。 |
| D-016 | 旧实现、旧 slice/task tree 和历史设计不进入新仓库 | 避免以兼容和取舍判断继续消耗注意力；clean-room archive 仅作外部历史证据。 |

## 已确定的依赖方向

Domain policy 不 import DBOS、Prisma、Git、GitHub、subprocess 或 HTTP implementation。Composition root 把成熟库组合到少量 adapter；这条 inward dependency 规则不意味着每个 adapter 都必须成为独立 package。

当前默认依赖的官方能力依据：

- [DBOS TypeScript programming guide](https://docs.dbos.dev/typescript/programming-guide)：workflow step checkpoint 与 crash recovery；
- [DBOS queues](https://docs.dbos.dev/typescript/reference/queues)：durable enqueue、并发和 rate control；
- [DBOS transactions and datasources](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial)：Prisma datasource 等现成 integration；
- [Prisma ORM](https://www.prisma.io/docs/orm)：类型安全 client、declarative model 和 migration system；
- [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app)：App JWT 和 installation token；
- [Octokit](https://github.com/octokit/octokit.js#readme)：App installation authentication strategy 与 API client。

## 延期事项与重新进入条件

延期表示“不为它预留实现”，不是“永不采用”。

| 事项 | 当前状态 | Re-entry trigger |
|---|---|---|
| ACP runtime protocol | 延期 | Codex CLI subprocess 无法可靠 resume/observe，或 ACP 已有稳定实现并能删除现有 adapter 的实质复杂度。 |
| OpenCode runtime adapter | 延期 | 必需模型无法通过 Codex Responses provider 使用，或 Codex adapter 成为可测的成本/能力瓶颈。 |
| Stop hook continuation | 非 authority 的可选优化 | DBOS 外层恢复已正确，且运行数据表明 warm continuation 能显著降低延迟/token；hook 仍不得创建 generation。 |
| 自动 merge | 后续 narrow adapter | reviewed PR exact-head gate 与 delivery reconciliation 已稳定，且 GitHub App 身份/权限已验证。 |
| Gitea/其它 forge | 延期 | GitHub API、私有仓库能力、成本或外部 contributor workflow 形成真实限制。 |
| 分布式 runner/多主机 DBOS | 延期 | 单机 CPU/RAM/IO/agent capacity 在持续运行中饱和，而非仅有理论扩容需求。 |
| 容器/轻量 VM provider | 延期 | Codex sandbox + host permissions 无法隔离某类实际 candidate，或项目依赖要求可销毁 OS image。 |
| Mem0/vector/session memory | 延期 | canonical artifact bootstrap 在多个真实 recovery 中反复缺失可复用知识，且普通文件/索引不能解决。 |
| 动态模型 router | 延期 | 静态 role/project policy 产生持续、可量化的质量或订阅容量损失。 |
| Requirement Proxy/Planner 自动 task frontier | 产品后续范围 | 手工授权 Task Contract 的 delivery loop 已可持续运行；接入时复用同一 admission seam。 |
| 穷举 Git/DB catalog hostile validation | 不进入默认路线 | 目标 deployment threat model 或真实 incident 证明当前 fresh checkout、SHA/ancestry、ORM migration 检查不够。 |
| Web dashboard | 延期 | CLI/digest 无法支持日常阻塞定位，且缺失的具体 operator query 已被记录。 |

## 被新基线取代的方向

Symphony 作为 authority、Symphony/自研 active-active、手写 SQLite control plane、DSH 作为必要 host、Gitea 双向同步、通用 event sourcing、完整插件平台、GitHub Issue 作为产品 task domain、无条件 CI approval，以及旧实现的 package/schema/task decomposition，均不属于当前设计。

若未来重新考虑其中任意方向，必须按上表的 observed trigger 新建 decision；旧 archive 不能自行恢复权威。
