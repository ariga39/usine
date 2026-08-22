---
status: current
updated: 2026-08-22
issue: https://github.com/ariga39/usine/issues/217
---

# 当前决策

这里只记录当前生效且会影响实现边界的决策。历史讨论和被否决方案不与当前决策并列；要改变一项决策，必须在新 Issue/PR 中写明 `supersedes`、原因和对现有边界的影响。

| ID | 当前决定 | 理由 |
|---|---|---|
| D-001 | 优化 valid/valuable delivery outcomes 与 human attention，而不是内部产物数量 | 防止 300 PR/day 退化成刷提交、刷测试或刷 task。 |
| D-002 | 顶层是确定性 coordinator，不是永久 Lead LLM | 有序激发、恢复、权限和 gate 必须可审计；LLM 只做 bounded semantic work。 |
| D-003 | TypeScript、Node 24、pnpm monorepo | 与 Codex/Drizzle/Octokit 生态一致；monorepo 便于建立明确 module ownership 和并排 worktree。 |
| D-004 | SQLite/Drizzle 保存最小领域事实；Delivery Run 以单步 deterministic reconcile loop 提供 restart recovery。每个 next action 先事务性保留 stable identity/fence，再执行并记录 observation；不维护 operation-index replay、第二套 scheduler 或 queue control plane。此决定 supersedes 先前 PostgreSQL 实现与 DBOS 选择 | 当前只有一个 Task、一个 repository writer 和一个本地 coordinator。SQLite 文件锁与进程内路径队列提供当前串行 authority 所需的原子事实；出现多个 runner、durable delayed scheduling、实测 polling/竞争瓶颈或通用 queue/timer 代码时，重新评估成熟 queue/workflow library。 |
| D-005 | 领域数据默认使用 Drizzle ORM + Drizzle Kit，并直接使用 Node 24 `node:sqlite` transaction | 减少原始 SQL、repository boilerplate、migration 重复实现，同时保留轻量、显式的 TypeScript schema；attempt fence、effect identity 和 state transition 在同一 SQLite 事实库原子提交。 |
| D-006 | Domain-facing Coding Session 保持 task-oriented `run(request) -> typed observation`；supported provider remains Codex。Static opaque profile composition 在 activation 前选择 exactly one of the official `@openai/codex-sdk` adapter or the bounded local app-server adapter；两个 adapter 都留在同一个 provider-neutral Coding Session port 后面。没有 fallback、registry、capability negotiation、automatic routing、第三个/non-Codex provider 或 app-server task authority。Herdr/transcript 不进入 production correctness path，profile 内的 model、provider、reasoning、service tier 与 credentials 不进入 durable model | #192 已证明 SDK lifecycle；#195 已证明 bounded app-server lifecycle 与静态 profile composition。provider execution semantics 由 adapter 拥有；Coding Session 不承诺非-Codex compatibility。 |
| D-007 | `ai` + `@ai-sdk/openai` 只作为 optional final role-output normalization adapter；它不承担一般 classification、extraction 或 summary，也不取得 task authority | API key 只留在 coordinator；agent prose、provider success 和 process exit 都不授予 task authority。 |
| D-008 | 当前 bounded serial product path 的 classification 为 `continue`。Coding Session、Task Authority、Delivery Run、Candidate Workspace、Quality Gate 和 Forge Delivery 已组成当前 serial path；每个 repository 只有一个 writer lease | [fund-manager Issue #52](https://github.com/ariga39/fund-manager/issues/52) 经 [PR #53](https://github.com/ariga39/fund-manager/pull/53) 完成 one-contract exact-head production merge。独立 reviewer 的 approval 经 schema-constrained normalizer 投影后，由协调器重新校验 schema 与 exact SHA。该证据不证明 retry recovery、ruleset refusal coverage、多项目 capacity、更宽的 merge policy、分布式 runner 或更广 provider support。#176 保留为 historical falsification，#199 保留为 hermetic precursor。 |
| D-009 | Candidate、checks、review verdict、投影出的 attestation 和 merge effect 全部绑定 immutable exact SHA | 防止 stale evidence、错误 merge head 和“agent 说完成了”成为交付依据。 |
| D-010 | Reviewer 必须 fresh、可读取完整 codebase，并提交 explicit verdict；exact-SHA `approved` verdict 是 semantic approval，review run 完成与批准是两个事实 | 保留独立判断；delivery executor 只能投影 verdict，不能制造批准。需要 GitHub 原生 approval 时使用不同于 PR author/delivery identity 的 reviewer capability。 |
| D-011 | GitHub 是当前 forge/delivery 与 bounded read surface；每个 Repository 选择 opaque `forgeProfile`，并可选择 opaque `githubReadProfile`。host 按 Repository 分别解析 Forge capability 与 read-only GitHub capability；read capability 只通过 role-scoped official MCP tools 暴露，并绑定 frozen Repository + Issue，PR reads 只有 caller 提供 authorized delivered-PR fact 时才可绑定；不保留 global credential selection，profile resolution failure blocks activation | Forge 与 read profile 必须使用独立 credentials；不同 Repository 必须能解析不同 capability。`githubReadProfile` 只属于 host-private Repository registration，不能进入 public Repository resources、Task snapshots、Task Contract、durable events、worker environment、prompt 或 MCP config。 |
| D-012 | 已由 D-026 supersede：第一项产品行为的终点由 Task Contract 的 immutable merge authority 决定 | 保留原 reviewed-PR pause 作为无 merge authority 的终态；授权的 exact-head merge 由同一 delivery reconciliation path 完成。 |
| D-013 | Codex sandbox/host permissions 是默认 isolation；worker 无 delivery credential | 在 macOS/Linux 上先使用已存在能力，容器不是默认前置。 |
| D-014 | GitHub Issue → branch/worktree → PR 是开发 Usine 自身的任务流；第一处 checkable/green state 以小 commit 形成可检查 checkpoint | Git 提供恢复、可见性、所有权和 integration，而不是进展代理。每个 Issue 仍需 coherent outcome；历史结构迁移不产生新的 authority。 |
| D-015 | Canonical files + Issue/Git bootstrap 是 context 恢复真相；主编排 profile 可使用更大 window，worker/reviewer 使用 task-sized context | Window 只减少 compact，不替代 durable principles；分角色 context 降低旧讨论污染。 |
| D-016 | 旧实现、旧 slice/task tree 和历史设计不进入新仓库 | 避免以兼容和取舍判断继续消耗注意力；clean-room archive 仅作外部历史证据。 |
| D-017 | Canonical design、第一条完整纵切后的扩展，以及重大 authority/scale 扩大前必须经过 fresh clean-room 方向审计；审计 finding 必须改变 task eligibility，而不只是生成 backlog | 主编排者不能独立证明自己没有在 compact、局部优化或实现细节中失去原目标；方向 blocker 若不能暂停错误任务，就没有控制权。 |
| D-018 | Vite+ 0.2.9 是 workspace 的统一命令与配置 surface：`vp fmt`、`vp lint`、`vp check`、`vp test` 和 `vp pack`；完整根测试入口是 `corepack pnpm test`，由 Vite+ 先运行 root suite，再递归运行声明 `test` script 的 workspace package；root `vite.config.ts` 的 type-aware/type-check 仍独立于 packaging，并覆盖 `tests/**/*.ts` | 使用官方 Vite+ monorepo/migration path，删除 Oxlint、Oxfmt、Vitest 与 tsdown 的 split config/command wiring；`vp pack` 成功不能冒充 `vp check` 的类型检查。 |
| D-019 | 每个 Issue/PR 交付最小 coherent module behavior；文件拆分、机械移动和行数下降不是 outcome | 删除旧 seam 只有在当前 caller、evidence 和 canonical boundary 证明它不再属于 production path 时进行。 |
| D-020 | Task eligibility 顺序为 active falsifier/safety-authority defect > accepted-outcome critical path > representative real task > measured bottleneck > cleanup；局部 Issue/non-goal 不能 waive 全局 falsifier | 第二次实现证明 flat backlog 会自动偏向最容易闭合、最低价值的机械任务。 |
| D-021 | 每个 active behavior cluster 有一个临时 design owner；首次 cluster、新 package/interface、连续三次修改同一大文件、三处重复 policy 或 falsified lifecycle change 触发独立 design review。Design verdict 与 spec/correctness verdict 分离 | Module map、interface depth、test placement 和 deletion plan 需要跨 Issue 的持续责任，不能期待局部 reviewer 从被禁止的 scope 中恢复架构。 |
| D-022 | 建立 module interface 后，测试必须 replace 而不是 layer：interface behavior、adapter protocol 和少量 CLI end-to-end 分层；新 tests 覆盖旧 claim 后删除 implementation-coupled fixtures | 单一巨大 CLI suite 和不断增加的 fake modes 会冻结偶然 transport 细节，使真正重构成为最昂贵选择。 |
| D-023 | Issue #116 将六个 canonical product modules 固定为真实 pnpm workspace packages：`@usine/task-authority`、`@usine/delivery-run`、`@usine/coding-session`、`@usine/candidate-workspace`、`@usine/quality-gate` 和 `@usine/forge-delivery`。生产代码与测试只能经声明依赖的 package exports 访问；图必须无环；CLI 与 `@usine/runtime` 是 composition root，不是第七个 behavior package。此决定 supersedes 8 节原先“模块不预先等同于 package、留在少量 workspace package 内”的可选边界方向。 | POC 将扩展，物理 package boundary 现在就是 ownership、测试 locality 和依赖图的可检查证据；Delivery Run 不再接收无关 capability bundle，旧 runtime 私有 source/dist route 也不保留兼容层。 |
| D-024 | Effect 4 RC 从不可信 durable-state decode boundary 增量进入现有 module；首个 production caller 是 Task Authority 的 SQLite `TaskResult` decoder。现有 Zod Task Contract 边界、Promise-based module ports、Drizzle persistence 和六个 package ownership 不因采用 Effect 而迁移。后续 Effect 使用必须由当前 caller 证明能删除重复 validation、错误映射或资源 lifecycle code | 用 Effect Schema 替换未经验证的 persisted JSON assertion 有直接 safety 收益；把既有 module 机械改写为 Effect services/layers 只会增加 caller knowledge 和迁移成本。RC 期间使用精确版本并通过 package source/guide确认 API。 |
| D-025 | Persistent local server 是当前 coordinator host；它拥有 Effect Scope、HTTP resource、task fibers、durable re-entry、cleanup invocation 和 AbortSignal propagation。Provider execution semantics 由 Coding Session adapter 拥有。CLI canonical command surface 为 `server health|snapshot`、`repository list|get`、`task list|get|history|watch`；`register` 与 `submit` 是 mutation entry points，`inspect`、`status`、`follow` 是 compatibility aliases；server restart 从 SQLite 重入 nonterminal Task | Effect 只接管 composition-root lifecycle，official Codex SDK、bounded local Codex App Server、Execa、Octokit、Node HTTP 与 SQLite 仍是窄 adapter。Project checks 在 disposable exact-SHA checkout 中以 reduced explicit environment 运行并共享 host filesystem/network permissions；只有 Forge credentials 不传入环境。#153 使用 stubbed Codex adapter，#192/#193 已合并，#195 已证明 bounded app-server adapter 与静态 profile composition。 |
| D-026 | **supersedes D-012**：Task Contract admission 冻结显式 `authorization.merge`。无 merge authority 的 exact-SHA reviewed delivery 持久化 `reviewed_pr` 且不调用 merge；有 authority 时 Forge 必须重新验证 live PR、attestation 和 approved SHA，并让 GitHub merge endpoint 作为最终 platform-policy gate，成功后持久化带 PR、approved head、merge commit 和 observed state 的 `merged` effect | #199 是该 outcome 的 hermetic precursor；fund-manager PR #53 boundedly proves the one-contract exact-head production path。一次成功 run 不证明 retry recovery、跨 ruleset 的 platform refusal、multi-project capacity 或 broader merge policy。changed head、attestation identity mismatch、proved refusal 和 ambiguous non-merged response 都不能产生 delivery fact。 |
| D-027 | Issue #187：Task Authority 持久化一个有序、Task-local、bounded、sanitized event stream；外部 sink 只接受 closed non-authoritative Coding Session/recovery observations，authoritative admission/activation/fact/terminal events 只能在对应 authority transaction 内创建。server 通过 cursor replay/live-follow endpoint 暴露它；TaskResult facts 仍是唯一 lifecycle authority，事件不可用于 reconciliation。Coding Session 的 provider-neutral session/outcome IDs 只由 durable activation/review cycle 与事件 identity 派生，不保存 Codex thread ID、transcript、tool input/output 或 raw error。 |

当前 bounded serial product path 的 classification 为 `continue`。#217 记录 fund-manager Issue #52 / PR #53 的 one-contract exact-head production merge evidence；#176 保留为 historical falsification，#199 保留为 hermetic precursor。#178 在出现 multi-project/measured capacity evidence 之前不 eligible，#151 在出现真实 retryable interruption sample 之前不 eligible。一次成功 run 仍不证明 retry recovery、跨 ruleset 的 platform refusal 或更宽的 merge policy。#187、#188、#189 是彼此独立的 outcomes；#188 resource CLI 已完成，不构成永久 architecture 顺序；#195 的 bounded app-server outcome 也不授权 fallback、registry、negotiation、automatic routing 或新的 provider surface。

## 已确定的依赖方向

Domain policy 不 import Drizzle、Git、GitHub、subprocess 或 HTTP implementation。六个 canonical package 通过显式 exports 形成无环依赖图；runtime/CLI composition root 把成熟库组合到它们，option/type ownership 留在消费 policy 的 module。

当前默认依赖的官方能力依据：

- [Node.js SQLite](https://nodejs.org/api/sqlite.html)：Node 24 内置 SQLite 数据库与事务 API；
- [Drizzle ORM and Kit](https://orm.drizzle.team/docs/kit-overview)：类型安全 schema、query 与 code-first SQL migration；
- [Vite+](https://viteplus.dev/guide/)：统一的 workspace runtime、format、lint、type-check、test 与 package command/config surface；
- [Vite+ migration and monorepo guides](https://viteplus.dev/guide/migrate)：官方依赖 pin、pnpm workspace 与 package-local `pack` 配置规则；
- [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app)：App JWT 和 installation token；
- [GitHub pull request approval](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)：PR author 不能批准自己的 PR；平台 approval 与 Usine semantic verdict 必须区分；
- [Octokit](https://github.com/octokit/octokit.js#readme)：App installation authentication strategy 与 API client。

## 延期事项与重新进入条件

延期表示“不为它预留实现”，不是“永不采用”。

| 事项 | 当前状态 | Re-entry trigger |
|---|---|---|
| ACP runtime protocol | 延期 | 当前 Codex adapter 无法提供所需的 turn observation/cancellation，或 ACP 已有稳定实现并能删除当前 adapter 的实质复杂度。 |
| OpenCode runtime adapter | 延期 | 必需模型无法通过 Codex Responses provider 使用，或 Codex adapter 成为可测的成本/能力瓶颈。 |
| Stop hook | 非 authority 的可选优化 | Delivery Run 外层恢复已正确，且运行数据表明 hook 能显著降低延迟/token；hook 仍不得创建 activation、fence 或 completion authority。 |
| 自动 merge | fund-manager PR #53 为 bounded serial path 提供 narrow authorized exact-head production evidence；#199 保留为 hermetic precursor；更宽的 merge policy 仍延期 | 需要更多真实 pilot 证明 GitHub App 身份/权限、仓库 ruleset 与平台 merge refusal 的生产行为，且不能扩大为 queue、merge service 或并发 writer。 |
| Gitea/其它 forge | 延期 | GitHub API、私有仓库能力、成本或外部 contributor workflow 形成真实限制。 |
| Durable queue/workflow engine 或分布式 runner | 延期 | 多个独立 runner、durable delayed scheduling、数据库 polling/竞争形成实测瓶颈，或 reconciler 开始实现通用 queue/timer/DAG。届时优先采用成熟库，不扩张自制 control plane。 |
| 容器/轻量 VM provider | 延期 | Codex sandbox + host permissions 无法隔离某类实际 candidate，或项目依赖要求可销毁 OS image。 |
| Mem0/vector/session memory | 延期 | canonical artifact bootstrap 在多个真实 recovery 中反复缺失可复用知识，且普通文件/索引不能解决。 |
| 动态模型 router | 延期 | 静态 role/project policy 产生持续、可量化的质量或订阅容量损失。 |
| Requirement Proxy/Planner 自动 task frontier | 产品后续范围 | 手工授权 Task Contract 的 delivery loop 已可持续运行；接入时复用同一 admission seam。 |
| 穷举 Git/DB catalog hostile validation | 不进入默认路线 | 目标 deployment threat model 或真实 incident 证明当前 fresh checkout、SHA/ancestry、ORM migration 检查不够。 |
| Web dashboard | 延期 | 现有最小 operator 输出无法支持日常阻塞定位，且缺失的具体 query 已被记录。 |
| OpenAI Agents SDK `SandboxAgent` / `codexTool` | donor / 延期 | 需要一个 Codex specialist 之外的 agent loop、handoff 或 provider-neutral sandbox，且能删除 Delivery Run/Codex ownership而不是形成第二套 loop。 |
| Herdr host/observer | production path 删除 | operator observation 成为实测 bottleneck，且一个 Coding Session 内部 adapter 能在不读取 pane/transcript作为 completion evidence 的前提下删除更多代码。 |
