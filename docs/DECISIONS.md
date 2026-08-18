---
status: current
updated: 2026-08-18
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
| D-005 | 领域数据默认使用 Drizzle ORM + Drizzle Kit，并使用 DBOS 官方 Drizzle datasource | 减少原始 SQL、repository boilerplate、migration/transaction 重复实现，同时保留轻量、显式的 TypeScript schema。 |
| D-006 | V0 仍只允许一个 coding-agent runtime boundary，但具体 launcher/transport 暂不选择；Herdr/transcript route 已被 Issue #65 的 settled-without-observation 证据证伪。第三次实现须等待 module design 与 salvage/rewrite decision；Gas City、Cezar、ACP、OpenCode、App Server 和 direct exec 都不是默认答案 | 更换 transport 不能修复 monolithic seams、task selection 或 design authority；继续为 launcher 叠加基础设施会重复第二次失败。未来候选仍须保留 fresh worker、GPT-5.6 Luna high、default tier、no fast 与 isolated workspace policy，或由显式 decision supersede。 |
| D-007 | Coordinator-owned classification、extraction、normalization 和 short summary 继续使用 `ai` + `@ai-sdk/openai` 对配置的 OpenAI-compatible API 做 schema-constrained 调用；coding-agent lifecycle contract 在 module design 中重新定义。API key 只留在 coordinator，轻量 transform、agent prose、provider success 和 process exit 都不授予 task authority | 成熟 provider 已删除自定义 HTTP/parsing glue；该窄决定与具体 coding-agent launcher 解耦。当前不再把 rendered transcript、hook 或 terminal state 当作预选 lifecycle bridge。 |
| D-008 | 当前 `stop_and_redesign` checkpoint 不运行 implementation；reviewed module decision 恢复 eligibility 后先串行，完成 representative executable code task 与 induced live coordinator restart recovery 后才允许每 repository 一个 writer，并发只跨 repository | 先证明一条真实 delivery loop，再按天然项目边界扩容，避免用并发基础设施替代用户 outcome。 |
| D-009 | Candidate、checks、review verdict 和投影出的 attestation 全部绑定 immutable exact SHA | 防止 stale evidence 和“agent 说完成了”成为交付依据。 |
| D-010 | Reviewer 必须 fresh、可读取完整 codebase，并提交 explicit verdict；exact-SHA `approved` verdict 是 semantic approval，review run 完成与批准是两个事实 | 保留独立判断；delivery executor 只能投影 verdict，不能制造批准。需要 GitHub 原生 approval 时使用不同于 PR author/delivery identity 的 reviewer capability。 |
| D-011 | GitHub 是当前 forge/delivery surface；使用 Octokit + GitHub App 短期 installation token | 现有 private repos 已安装 App；不再把凭据和 API 轮换手写到每个 agent。 |
| D-012 | 第一项产品行为终止于带 exact-SHA semantic approval attestation 的 reviewed PR；自动 merge 位于同一 exact-head gate 后的后续 authority adapter | 先证明完整 review delivery；平台原生 approval 是仓库 ruleset 要求的额外事实，不得与 Usine verdict 混为一谈。 |
| D-013 | Codex sandbox/host permissions 是默认 isolation；worker 无 delivery credential | 在 macOS/Linux 上先使用已存在能力，容器不是默认前置。 |
| D-014 | GitHub Issue → branch/worktree → small PR 是开发 Usine 自身的唯一任务流；第一处 checkable/green state 立即以小 commit push 并开 draft PR，但只有 coherent module behavior 或 user-observable behavior 通过 merge gate 才自动 merge；当前 stop-and-redesign checkpoint 下 implementation 串行且暂停 | Git 提供恢复、可见性、所有权和 integration，而不是进展代理。分离 draft 与 merge 既避免数小时本地不可见，也防止局部 green 固化错误 seam。 |
| D-015 | Canonical files + Issue/Git bootstrap 是 context 恢复真相；主编排 profile 可使用更大 window，worker/reviewer 使用 task-sized context | Window 只减少 compact，不替代 durable principles；分角色 context 降低旧讨论污染。 |
| D-016 | 旧实现、旧 slice/task tree 和历史设计不进入新仓库 | 避免以兼容和取舍判断继续消耗注意力；clean-room archive 仅作外部历史证据。 |
| D-017 | Canonical design、第一条完整纵切后的扩展，以及重大 authority/scale 扩大前必须经过 fresh clean-room 方向审计；审计 finding 必须改变 task eligibility，而不只是生成 backlog | 主编排者不能独立证明自己没有在 compact、局部优化或实现细节中失去原目标；方向 blocker 若不能暂停错误任务，就没有控制权。 |
| D-018 | 统一使用 tsdown 编译、oxlint lint、oxfmt format；TypeScript 只执行独立的 `--noEmit` typecheck | 使用快速、低配置的工具链并避免 ESLint/Prettier/tsup 并存；build 成功不能冒充类型检查。DBOS runtime 必须使用 tsdown unbundle 模式，不把 workflow 打成 bundle。 |
| D-019 | Product milestone 可以跨多个 PR；每个 Issue 分开定义 draft checkpoint 与 merge gate。Draft checkpoint 绿后立即发布；merge gate 必须交付最小 coherent module behavior 或 user-observable behavior。纯移动只有删除旧 seam、减少 caller knowledge 或集中 change locality 时才满足 gate | 保留小 PR 和快速可见性，但不再让文件变短、机械等价或局部测试全绿获得架构支配权。 |
| D-020 | Task eligibility 顺序为 active falsifier/safety-authority defect > accepted-outcome critical path > representative real task > measured bottleneck > cleanup；局部 Issue/non-goal 不能 waive 全局 falsifier | 第二次实现证明 flat backlog 会自动偏向最容易闭合、最低价值的机械任务。 |
| D-021 | 每个 active behavior cluster 有一个临时 design owner；首次 cluster、新 package/interface、连续三次修改同一大文件、三处重复 policy 或 falsified lifecycle change 触发独立 design review。Design verdict 与 spec/correctness verdict 分离 | Module map、interface depth、test placement 和 deletion plan 需要跨 Issue 的持续责任，不能期待局部 reviewer 从被禁止的 scope 中恢复架构。 |
| D-022 | 建立 module interface 后，测试必须 replace 而不是 layer：interface behavior、adapter protocol 和少量 CLI end-to-end 分层；新 tests 覆盖旧 claim 后删除 implementation-coupled fixtures | 单一巨大 CLI suite 和不断增加的 fake modes 会冻结偶然 transport 细节，使真正重构成为最昂贵选择。 |

当前 classification 为 `stop_and_redesign`。Issue #12 / PR #38 的弱样本只证明若干 components 能连接，不证明当前 seams 值得继续承载行为。Issue #65 已触发此前定义的 route falsifier；局部 acceptance 仍覆盖该证据，证明 development control 也须修正。

当前只允许完成 canonical behavior correction，以及随后 bounded module design + salvage/rewrite decision。普通 product implementation、cleanup、package/file movement、runtime replacement、concurrency、authority expansion 和新基础设施都不 eligible。Decision 合并后，首先用 representative executable code task 验证新路线，再验证 induced live coordinator restart recovery；不得用文档复制、fixture-only task 或测试数量代替。

## 已确定的依赖方向

Domain policy 不 import DBOS、Drizzle、Git、GitHub、subprocess 或 HTTP implementation。Composition root 把成熟库组合到少量 adapter；这条 inward dependency 规则不意味着每个 adapter 都必须成为独立 package。

当前默认依赖的官方能力依据：

- [DBOS TypeScript programming guide](https://docs.dbos.dev/typescript/programming-guide)：workflow step checkpoint 与 crash recovery；
- [DBOS queues](https://docs.dbos.dev/typescript/reference/queues)：durable enqueue、并发和 rate control；
- [DBOS transactions and datasources](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial)：官方 Drizzle datasource 与 durable transaction integration；
- [DBOS application integration](https://docs.dbos.dev/typescript/integrating-dbos)：workflow registry 要求 DBOS workflow 不被 JavaScript/TypeScript bundler 合并；
- [Drizzle ORM and Kit](https://orm.drizzle.team/docs/kit-overview)：类型安全 schema、query 与 code-first SQL migration；
- [tsdown](https://tsdown.dev/guide/)：TypeScript build 与 bundleless compilation；
- [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) 与 [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html)：lint 与 format；
- [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app)：App JWT 和 installation token；
- [GitHub pull request approval](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)：PR author 不能批准自己的 PR；平台 approval 与 Usine semantic verdict 必须区分；
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
| Web dashboard | 延期 | 现有最小 operator 输出无法支持日常阻塞定位，且缺失的具体 query 已被记录。 |
